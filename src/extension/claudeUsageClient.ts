import {
  type UsageErrorCode,
  type UsageSnapshot,
  type UsageWindowKind,
  type UsageWindowSnapshot,
} from '@/lib/usageTypes';

/**
 * Talks to the *unofficial, undocumented* claude.ai web API, riding on the
 * user's existing session cookie via `credentials: 'include'`.
 *
 * Everything here is dependency-injected: `fetch` and the org-ID cache are
 * passed in, so this module never touches `chrome.*` and is fully testable.
 * The service worker supplies the real implementations.
 */

const CLAUDE_API_BASE_URL = 'https://claude.ai/api';

export class ClaudeUsageError extends Error {
  readonly code: UsageErrorCode;
  readonly httpStatus: number | undefined;

  constructor(code: UsageErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'ClaudeUsageError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface OrganizationIdCache {
  read(): Promise<string | null>;
  write(organizationId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ClaudeUsageClientDependencies {
  fetch: typeof fetch;
  organizationIdCache: OrganizationIdCache;
}

/** Maps the two response shapes we know about onto our window kinds. */
const USAGE_RESPONSE_KEYS: Record<UsageWindowKind, readonly string[]> = {
  fiveHour: ['five_hour', 'fiveHour'],
  sevenDay: ['seven_day', 'sevenDay'],
  sevenDayOpus: ['seven_day_opus', 'sevenDayOpus'],
};

const UTILIZATION_KEYS = ['utilization', 'utilization_pct', 'utilizationPercent'] as const;
const RESETS_AT_KEYS = ['resets_at', 'reset_at', 'resetsAt'] as const;
const STARTS_AT_KEYS = ['starts_at', 'started_at', 'window_start', 'startsAt'] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First key present with a usable number, else null. */
function readNumber(source: UnknownRecord, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** First key present with a non-empty string, else null. */
function readString(source: UnknownRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

async function requestJson(
  dependencies: ClaudeUsageClientDependencies,
  path: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await dependencies.fetch(`${CLAUDE_API_BASE_URL}${path}`, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new ClaudeUsageError(
      'NETWORK_ERROR',
      'Could not reach claude.ai. Check your connection.',
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new ClaudeUsageError('NOT_LOGGED_IN', 'Not logged in to Claude.ai.', response.status);
  }

  if (!response.ok) {
    throw new ClaudeUsageError(
      'HTTP_ERROR',
      `Claude.ai returned an unexpected response (${response.status}).`,
      response.status,
    );
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ClaudeUsageError('MALFORMED_RESPONSE', 'Could not read the response from Claude.ai.');
  }
}

/**
 * Finds the organization to report on: the one that can actually chat, since
 * accounts with a team membership return several and only some are usable.
 */
export async function discoverOrganizationId(
  dependencies: ClaudeUsageClientDependencies,
): Promise<string> {
  const payload = await requestJson(dependencies, '/organizations');

  if (!Array.isArray(payload) || payload.length === 0) {
    throw new ClaudeUsageError('NO_ORGANIZATIONS', 'No Claude.ai organizations found.');
  }

  const organizations = payload.filter(isRecord);
  const chatCapable = organizations.find((organization) => {
    const capabilities = organization['capabilities'];
    return Array.isArray(capabilities) && capabilities.includes('chat');
  });

  const chosen = chatCapable ?? organizations[0];
  const uuid = chosen === undefined ? null : readString(chosen, ['uuid', 'id']);

  if (uuid === null) {
    throw new ClaudeUsageError('NO_ORGANIZATIONS', 'No Claude.ai organizations found.');
  }
  return uuid;
}

/**
 * Normalises one window out of the usage payload.
 *
 * A window with no recognisable utilisation figure is dropped entirely; one with
 * a utilisation but no reset time is kept and marked inactive by the pace engine
 * rather than being shown as resetting at the epoch.
 */
function normaliseWindow(
  payload: UnknownRecord,
  kind: UsageWindowKind,
): UsageWindowSnapshot | null {
  const container = USAGE_RESPONSE_KEYS[kind]
    .map((key) => payload[key])
    .find((value): value is UnknownRecord => isRecord(value));

  if (container === undefined) return null;

  const utilizationPercent = readNumber(container, UTILIZATION_KEYS);
  if (utilizationPercent === null) return null;

  return {
    kind,
    utilizationPercent,
    resetsAt: readString(container, RESETS_AT_KEYS),
    startedAt: readString(container, STARTS_AT_KEYS),
  };
}

export function normaliseUsageResponse(payload: unknown): UsageSnapshot {
  if (!isRecord(payload)) {
    throw new ClaudeUsageError('MALFORMED_RESPONSE', 'Unexpected usage response from Claude.ai.');
  }

  const windows = (Object.keys(USAGE_RESPONSE_KEYS) as UsageWindowKind[])
    .map((kind) => normaliseWindow(payload, kind))
    .filter((window): window is UsageWindowSnapshot => window !== null);

  if (windows.length === 0) {
    throw new ClaudeUsageError('MALFORMED_RESPONSE', 'Claude.ai did not report any usage windows.');
  }

  return { windows };
}

async function fetchUsageForOrganization(
  dependencies: ClaudeUsageClientDependencies,
  organizationId: string,
): Promise<UsageSnapshot> {
  const payload = await requestJson(
    dependencies,
    `/organizations/${encodeURIComponent(organizationId)}/usage`,
  );
  return normaliseUsageResponse(payload);
}

/**
 * The one call the rest of the extension makes.
 *
 * Uses the cached org ID when there is one. If the usage call fails with
 * anything HTTP-shaped — the usual cause being that the user left the team the
 * cached ID belongs to — the cache is busted and the whole thing retried once
 * against a freshly discovered org.
 */
export async function fetchUsageSnapshot(
  dependencies: ClaudeUsageClientDependencies,
): Promise<UsageSnapshot> {
  const cachedOrganizationId = await dependencies.organizationIdCache.read();

  if (cachedOrganizationId !== null) {
    try {
      return await fetchUsageForOrganization(dependencies, cachedOrganizationId);
    } catch (error) {
      // A stale cache cannot explain "you are logged out", so do not retry that.
      if (error instanceof ClaudeUsageError && error.code === 'NOT_LOGGED_IN') throw error;
      await dependencies.organizationIdCache.clear();
    }
  }

  const organizationId = await discoverOrganizationId(dependencies);
  const snapshot = await fetchUsageForOrganization(dependencies, organizationId);
  await dependencies.organizationIdCache.write(organizationId);
  return snapshot;
}

export function toUsageErrorInfo(error: unknown): {
  code: UsageErrorCode;
  message: string;
  httpStatus?: number;
} {
  if (error instanceof ClaudeUsageError) {
    return error.httpStatus === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, httpStatus: error.httpStatus };
  }
  return {
    code: 'NETWORK_ERROR',
    message: error instanceof Error ? error.message : 'Something went wrong fetching usage.',
  };
}
