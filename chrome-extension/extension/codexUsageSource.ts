import type {
  UsageErrorCode,
  UsageSnapshot,
  UsageWindowKind,
  UsageWindowSnapshot,
} from '@/lib/usageTypes';
import { ClaudeUsageError } from './claudeUsageClient';

/**
 * Talks to the native host's `getCodexUsage` message — the `chrome.*`-touching
 * half of Codex/ChatGPT usage. See `plans/codex-subscription-usage.md`.
 *
 * Reuses the *existing* native host (`com.claudeusageoptimizer.usagehost`) —
 * no new host registration, no new manifest entry. `ClaudeUsageError` is
 * reused rather than a look-alike class, because `toUsageErrorInfo` (which
 * `refreshCodexUsage` calls, same as the Claude path) branches on
 * `instanceof ClaudeUsageError`; a separate class would fall through to its
 * generic `NETWORK_ERROR` default and `HOST_UNAVAILABLE` would never reach
 * the popup.
 */

const NATIVE_HOST_NAME = 'com.claudeusageoptimizer.usagehost';
const GET_CODEX_USAGE_MESSAGE_TYPE = 'getCodexUsage';

const CODEX_WINDOW_KIND_KEYS: Record<'fiveHour' | 'sevenDay', readonly string[]> = {
  fiveHour: ['fiveHour', 'five_hour'],
  sevenDay: ['sevenDay', 'seven_day'],
};

const UTILIZATION_KEYS = [
  'utilizationPercent',
  'utilization_percent',
  'usedPercent',
  'used_percent',
];
const RESETS_AT_KEYS = ['resetsAt', 'resets_at'];
const STARTS_AT_KEYS = ['startedAt', 'started_at'];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function readString(source: UnknownRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/** `fiveHour` / `sevenDay` only — Codex never reports a `sevenDayOpus` window. */
function normaliseKind(raw: unknown): UsageWindowKind | null {
  if (CODEX_WINDOW_KIND_KEYS.fiveHour.includes(raw as string)) return 'fiveHour';
  if (CODEX_WINDOW_KIND_KEYS.sevenDay.includes(raw as string)) return 'sevenDay';
  return null;
}

/**
 * Normalises one window out of the host's reply, the same defensive way
 * `claudeUsageClient.ts`'s `normaliseWindow` treats an API response — several
 * field spellings accepted, a window with no readable utilisation dropped.
 * The host is our own code rather than a third party, but its schema can
 * still drift out of step with an unrebuilt service worker (see the
 * `BUILD_STAMP` trap in `chrome-extension/CLAUDE.md`), which is exactly the
 * failure mode this posture protects against.
 */
function normaliseCodexWindow(raw: unknown): UsageWindowSnapshot | null {
  if (!isRecord(raw)) return null;

  const kind = normaliseKind(raw.kind ?? raw.window);
  if (kind === null) return null;

  const utilizationPercent = readNumber(raw, UTILIZATION_KEYS);
  if (utilizationPercent === null) return null;

  return {
    kind,
    utilizationPercent,
    resetsAt: readString(raw, RESETS_AT_KEYS),
    startedAt: readString(raw, STARTS_AT_KEYS),
  };
}

export function normaliseCodexUsageResponse(payload: unknown): UsageSnapshot {
  if (!isRecord(payload) || !Array.isArray(payload.windows)) {
    throw new ClaudeUsageError('MALFORMED_RESPONSE', 'Unexpected Codex usage response.');
  }

  const windows = payload.windows
    .map(normaliseCodexWindow)
    .filter((window): window is UsageWindowSnapshot => window !== null);

  if (windows.length === 0) {
    throw new ClaudeUsageError('MALFORMED_RESPONSE', 'Codex did not report any usage windows.');
  }

  return { windows };
}

/** The host's `{"code", "message", "httpStatus"?}` error shape, read defensively. */
function toClaudeUsageError(error: unknown): ClaudeUsageError {
  if (isRecord(error)) {
    const code: UsageErrorCode =
      typeof error.code === 'string' ? (error.code as UsageErrorCode) : 'NETWORK_ERROR';
    const message = typeof error.message === 'string' ? error.message : 'Codex usage check failed.';
    const httpStatus = typeof error.httpStatus === 'number' ? error.httpStatus : undefined;
    return new ClaudeUsageError(code, message, httpStatus);
  }
  return new ClaudeUsageError('NETWORK_ERROR', 'Codex usage check failed.');
}

/**
 * The one call the rest of the extension makes for Codex usage.
 *
 * `HOST_UNAVAILABLE` — distinct from a host-reported failure — covers both a
 * host that isn't installed (`sendNativeMessage` rejects) and one that sent
 * no usable reply; either way the guidance is "run `just install-usage-host`"
 * rather than "check chatgpt.com".
 */
export async function fetchCodexUsageSnapshot(): Promise<UsageSnapshot> {
  let response: unknown;
  try {
    response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      type: GET_CODEX_USAGE_MESSAGE_TYPE,
    });
  } catch {
    throw new ClaudeUsageError(
      'HOST_UNAVAILABLE',
      'Could not reach the native host. Install it with `just install-usage-host`.',
    );
  }

  if (!isRecord(response)) {
    throw new ClaudeUsageError('HOST_UNAVAILABLE', 'The native host sent no usable reply.');
  }

  if (response.ok !== true) {
    throw toClaudeUsageError(response.error);
  }

  return normaliseCodexUsageResponse(response);
}
