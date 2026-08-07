import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeUsageError,
  discoverOrganizationId,
  fetchUsageSnapshot,
  normaliseUsageResponse,
  toUsageErrorInfo,
  type ClaudeUsageClientDependencies,
  type OrganizationIdCache,
} from './claudeUsageClient';

const ORGANIZATIONS_URL = 'https://claude.ai/api/organizations';
const usageUrlFor = (organizationId: string) =>
  `https://claude.ai/api/organizations/${organizationId}/usage`;

const USAGE_PAYLOAD = {
  five_hour: { utilization: 42, resets_at: '2026-08-07T18:00:00Z' },
  seven_day: { utilization: 61, resets_at: '2026-08-11T09:00:00Z' },
  seven_day_opus: { utilization: 12, resets_at: '2026-08-11T09:00:00Z' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** An in-memory stand-in for the chrome.storage-backed cache. */
function createFakeCache(initialOrganizationId: string | null = null): OrganizationIdCache & {
  currentValue: () => string | null;
} {
  let value = initialOrganizationId;
  return {
    read: async () => value,
    write: async (organizationId: string) => {
      value = organizationId;
    },
    clear: async () => {
      value = null;
    },
    currentValue: () => value,
  };
}

/** Routes requests by URL so tests declare responses rather than call order. */
function createRoutingFetch(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes[url];
    if (route === undefined) throw new Error(`Unexpected request to ${url}`);
    return route();
  }) as unknown as typeof fetch;
}

describe('discoverOrganizationId', () => {
  it('prefers the organization whose capabilities include "chat"', async () => {
    const dependencies: ClaudeUsageClientDependencies = {
      fetch: createRoutingFetch({
        [ORGANIZATIONS_URL]: () =>
          jsonResponse([
            { uuid: 'team-org', capabilities: ['api'] },
            { uuid: 'chat-org', capabilities: ['chat', 'claude_pro'] },
          ]),
      }),
      organizationIdCache: createFakeCache(),
    };

    await expect(discoverOrganizationId(dependencies)).resolves.toBe('chat-org');
  });

  it('falls back to the first organization when none advertise chat', async () => {
    const dependencies: ClaudeUsageClientDependencies = {
      fetch: createRoutingFetch({
        [ORGANIZATIONS_URL]: () => jsonResponse([{ uuid: 'first-org' }, { uuid: 'second-org' }]),
      }),
      organizationIdCache: createFakeCache(),
    };

    await expect(discoverOrganizationId(dependencies)).resolves.toBe('first-org');
  });

  it('reports NOT_LOGGED_IN for a 401', async () => {
    const dependencies: ClaudeUsageClientDependencies = {
      fetch: createRoutingFetch({
        [ORGANIZATIONS_URL]: () => jsonResponse({ error: 'unauthorized' }, 401),
      }),
      organizationIdCache: createFakeCache(),
    };

    await expect(discoverOrganizationId(dependencies)).rejects.toMatchObject({
      code: 'NOT_LOGGED_IN',
    });
  });

  it('reports NOT_LOGGED_IN for a 403', async () => {
    const dependencies: ClaudeUsageClientDependencies = {
      fetch: createRoutingFetch({
        [ORGANIZATIONS_URL]: () => jsonResponse({ error: 'forbidden' }, 403),
      }),
      organizationIdCache: createFakeCache(),
    };

    await expect(discoverOrganizationId(dependencies)).rejects.toMatchObject({
      code: 'NOT_LOGGED_IN',
    });
  });

  it('reports NO_ORGANIZATIONS for an empty list', async () => {
    const dependencies: ClaudeUsageClientDependencies = {
      fetch: createRoutingFetch({ [ORGANIZATIONS_URL]: () => jsonResponse([]) }),
      organizationIdCache: createFakeCache(),
    };

    await expect(discoverOrganizationId(dependencies)).rejects.toMatchObject({
      code: 'NO_ORGANIZATIONS',
    });
  });

  it('reports NETWORK_ERROR when the request itself fails', async () => {
    const dependencies: ClaudeUsageClientDependencies = {
      fetch: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
      organizationIdCache: createFakeCache(),
    };

    await expect(discoverOrganizationId(dependencies)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });
});

describe('normaliseUsageResponse', () => {
  it('reads the documented snake_case shape', () => {
    expect(normaliseUsageResponse(USAGE_PAYLOAD)).toEqual({
      windows: [
        {
          kind: 'fiveHour',
          utilizationPercent: 42,
          resetsAt: '2026-08-07T18:00:00Z',
          startedAt: null,
        },
        {
          kind: 'sevenDay',
          utilizationPercent: 61,
          resetsAt: '2026-08-11T09:00:00Z',
          startedAt: null,
        },
        {
          kind: 'sevenDayOpus',
          utilizationPercent: 12,
          resetsAt: '2026-08-11T09:00:00Z',
          startedAt: null,
        },
      ],
    });
  });

  it('accepts the utilization_pct and reset_at spellings', () => {
    const snapshot = normaliseUsageResponse({
      five_hour: { utilization_pct: 42, reset_at: '2026-08-07T18:00:00Z' },
    });

    expect(snapshot.windows).toEqual([
      {
        kind: 'fiveHour',
        utilizationPercent: 42,
        resetsAt: '2026-08-07T18:00:00Z',
        startedAt: null,
      },
    ]);
  });

  it('picks up a window start when the API supplies one', () => {
    const snapshot = normaliseUsageResponse({
      five_hour: {
        utilization: 42,
        resets_at: '2026-08-07T18:00:00Z',
        starts_at: '2026-08-07T13:00:00Z',
      },
    });

    expect(snapshot.windows[0]?.startedAt).toBe('2026-08-07T13:00:00Z');
  });

  it('keeps a window with no resets_at, marking it as having none', () => {
    const snapshot = normaliseUsageResponse({ five_hour: { utilization: 0 } });

    expect(snapshot.windows[0]).toMatchObject({ utilizationPercent: 0, resetsAt: null });
  });

  it('skips windows the response omits entirely', () => {
    const snapshot = normaliseUsageResponse({
      five_hour: { utilization: 42, resets_at: '2026-08-07T18:00:00Z' },
    });

    expect(snapshot.windows.map((window) => window.kind)).toEqual(['fiveHour']);
  });

  it('parses a numeric utilisation delivered as a string', () => {
    const snapshot = normaliseUsageResponse({ five_hour: { utilization: '42' } });

    expect(snapshot.windows[0]?.utilizationPercent).toBe(42);
  });

  it('rejects a payload with no recognisable windows', () => {
    expect(() => normaliseUsageResponse({ something_else: {} })).toThrow(ClaudeUsageError);
    expect(() => normaliseUsageResponse(null)).toThrow(ClaudeUsageError);
    expect(() => normaliseUsageResponse([])).toThrow(ClaudeUsageError);
  });
});

describe('fetchUsageSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('discovers and caches the organization on first run', async () => {
    const organizationIdCache = createFakeCache();
    const fetchMock = createRoutingFetch({
      [ORGANIZATIONS_URL]: () => jsonResponse([{ uuid: 'chat-org', capabilities: ['chat'] }]),
      [usageUrlFor('chat-org')]: () => jsonResponse(USAGE_PAYLOAD),
    });

    const snapshot = await fetchUsageSnapshot({ fetch: fetchMock, organizationIdCache });

    expect(snapshot.windows).toHaveLength(3);
    expect(organizationIdCache.currentValue()).toBe('chat-org');
  });

  it('skips discovery when an organization is already cached', async () => {
    const fetchMock = createRoutingFetch({
      [usageUrlFor('cached-org')]: () => jsonResponse(USAGE_PAYLOAD),
    });

    await fetchUsageSnapshot({
      fetch: fetchMock,
      organizationIdCache: createFakeCache('cached-org'),
    });

    expect(vi.mocked(fetchMock)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchMock).mock.calls[0]?.[0])).toBe(usageUrlFor('cached-org'));
  });

  it('busts a stale cached organization and retries once', async () => {
    const organizationIdCache = createFakeCache('stale-org');
    const fetchMock = createRoutingFetch({
      [usageUrlFor('stale-org')]: () => jsonResponse({ error: 'not found' }, 404),
      [ORGANIZATIONS_URL]: () => jsonResponse([{ uuid: 'fresh-org', capabilities: ['chat'] }]),
      [usageUrlFor('fresh-org')]: () => jsonResponse(USAGE_PAYLOAD),
    });

    const snapshot = await fetchUsageSnapshot({ fetch: fetchMock, organizationIdCache });

    expect(snapshot.windows).toHaveLength(3);
    expect(organizationIdCache.currentValue()).toBe('fresh-org');
    expect(vi.mocked(fetchMock)).toHaveBeenCalledTimes(3);
  });

  it('does not retry a logged-out response, and keeps the cached organization', async () => {
    const organizationIdCache = createFakeCache('cached-org');
    const fetchMock = createRoutingFetch({
      [usageUrlFor('cached-org')]: () => jsonResponse({ error: 'unauthorized' }, 401),
    });

    await expect(
      fetchUsageSnapshot({ fetch: fetchMock, organizationIdCache }),
    ).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });

    expect(vi.mocked(fetchMock)).toHaveBeenCalledTimes(1);
    expect(organizationIdCache.currentValue()).toBe('cached-org');
  });

  it('surfaces the error from the retry when re-discovery also fails', async () => {
    const fetchMock = createRoutingFetch({
      [usageUrlFor('stale-org')]: () => jsonResponse({ error: 'server' }, 500),
      [ORGANIZATIONS_URL]: () => jsonResponse({ error: 'unauthorized' }, 401),
    });

    await expect(
      fetchUsageSnapshot({ fetch: fetchMock, organizationIdCache: createFakeCache('stale-org') }),
    ).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
  });

  it('does not retry more than once', async () => {
    const fetchMock = createRoutingFetch({
      [usageUrlFor('stale-org')]: () => jsonResponse({ error: 'server' }, 500),
      [ORGANIZATIONS_URL]: () => jsonResponse([{ uuid: 'stale-org', capabilities: ['chat'] }]),
    });

    await expect(
      fetchUsageSnapshot({ fetch: fetchMock, organizationIdCache: createFakeCache('stale-org') }),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR', httpStatus: 500 });

    expect(vi.mocked(fetchMock)).toHaveBeenCalledTimes(3);
  });
});

describe('toUsageErrorInfo', () => {
  it('preserves the code and status of a ClaudeUsageError', () => {
    expect(toUsageErrorInfo(new ClaudeUsageError('HTTP_ERROR', 'boom', 500))).toEqual({
      code: 'HTTP_ERROR',
      message: 'boom',
      httpStatus: 500,
    });
  });

  it('falls back to NETWORK_ERROR for anything unrecognised', () => {
    expect(toUsageErrorInfo(new Error('kaboom'))).toEqual({
      code: 'NETWORK_ERROR',
      message: 'kaboom',
    });
  });
});
