import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageCacheEntry } from '@/lib/usageTypes';

/**
 * Smoke tests for the service worker's wiring: alarm and message handlers,
 * the storage write, and the badge update.
 *
 * `chrome` is a hand-rolled fake rather than a mocking library so the test
 * exercises the same call shapes the real API has, and the module is imported
 * fresh per test because registering listeners is a top-level side effect.
 */

interface ListenerRegistry<T> {
  listeners: T[];
  addListener: (listener: T) => void;
  removeListener: (listener: T) => void;
}

function createListenerRegistry<T>(): ListenerRegistry<T> {
  const listeners: T[] = [];
  return {
    listeners,
    addListener: (listener: T) => void listeners.push(listener),
    removeListener: () => {},
  };
}

type AlarmListener = (alarm: { name: string }) => void;
type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

const USAGE_PAYLOAD = {
  five_hour: { utilization: 42, resets_at: '2026-08-07T18:00:00Z' },
  seven_day: { utilization: 61, resets_at: '2026-08-11T09:00:00Z' },
};

function createChromeFake() {
  const storage = new Map<string, unknown>();

  const alarms = createListenerRegistry<AlarmListener>();
  const messages = createListenerRegistry<MessageListener>();
  const installed = createListenerRegistry<() => void>();
  const startup = createListenerRegistry<() => void>();

  const createdAlarms: { name: string; options: unknown }[] = [];
  const badgeText: string[] = [];
  const badgeColors: string[] = [];
  const titles: string[] = [];

  return {
    storage,
    createdAlarms,
    badgeText,
    badgeColors,
    titles,
    triggerAlarm: (name: string) => alarms.listeners.forEach((listener) => listener({ name })),
    sendMessage: (message: unknown) =>
      new Promise<unknown>((resolve) => {
        for (const listener of messages.listeners) {
          if (listener(message, {}, resolve)) return;
        }
        resolve(undefined);
      }),
    api: {
      storage: {
        local: {
          get: async (key: string) =>
            storage.has(key) ? { [key]: storage.get(key) } : ({} as Record<string, unknown>),
          set: async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) storage.set(key, value);
          },
          remove: async (key: string) => void storage.delete(key),
        },
        onChanged: createListenerRegistry(),
      },
      alarms: {
        create: (name: string, options: unknown) => createdAlarms.push({ name, options }),
        onAlarm: alarms,
      },
      runtime: {
        onInstalled: installed,
        onStartup: startup,
        onMessage: messages,
      },
      action: {
        setBadgeText: async ({ text }: { text: string }) => void badgeText.push(text),
        setBadgeBackgroundColor: async ({ color }: { color: string }) =>
          void badgeColors.push(color),
        setTitle: async ({ title }: { title: string }) => void titles.push(title),
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

let chromeFake: ReturnType<typeof createChromeFake>;

async function loadServiceWorker() {
  vi.resetModules();
  await import('./serviceWorker');
}

beforeEach(() => {
  chromeFake = createChromeFake();
  vi.stubGlobal('chrome', chromeFake.api);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('serviceWorker', () => {
  it('registers the five-minute refresh alarm on load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(USAGE_PAYLOAD)),
    );
    await loadServiceWorker();

    expect(chromeFake.createdAlarms[0]).toMatchObject({
      name: 'refreshUsage',
      options: { periodInMinutes: 5 },
    });
  });

  it('fetches, caches and badges when the refresh alarm fires', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/organizations')
          ? jsonResponse([{ uuid: 'chat-org', capabilities: ['chat'] }])
          : jsonResponse(USAGE_PAYLOAD),
      ),
    );
    await loadServiceWorker();

    chromeFake.triggerAlarm('refreshUsage');
    await vi.waitFor(() => expect(chromeFake.storage.has('usageCache')).toBe(true));

    const cached = chromeFake.storage.get('usageCache') as UsageCacheEntry;
    expect(cached.error).toBeNull();
    expect(cached.snapshot?.windows).toHaveLength(2);
    expect(cached.fetchedAt).not.toBeNull();

    // Badge shows the higher of the two utilisations.
    await vi.waitFor(() => expect(chromeFake.badgeText).toContain('61'));
    expect(chromeFake.titles.at(-1)).toContain('61%');
  });

  it('appends a history sample on every successful refresh', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/organizations')
          ? jsonResponse([{ uuid: 'chat-org', capabilities: ['chat'] }])
          : jsonResponse(USAGE_PAYLOAD),
      ),
    );
    await loadServiceWorker();

    chromeFake.triggerAlarm('refreshUsage');
    await vi.waitFor(() => expect(chromeFake.storage.has('usageHistory')).toBe(true));

    const history = chromeFake.storage.get('usageHistory') as { fiveHourPercent: number }[];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fiveHourPercent: 42, sevenDayPercent: 61 });
  });

  it('ignores alarms that are not ours', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(USAGE_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    await loadServiceWorker();

    chromeFake.triggerAlarm('someOtherAlarm');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a refresh message with the new cache entry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/organizations')
          ? jsonResponse([{ uuid: 'chat-org', capabilities: ['chat'] }])
          : jsonResponse(USAGE_PAYLOAD),
      ),
    );
    await loadServiceWorker();

    const response = (await chromeFake.sendMessage({ type: 'REFRESH_USAGE' })) as UsageCacheEntry;

    expect(response.snapshot?.windows).toHaveLength(2);
    expect(response.error).toBeNull();
  });

  it('keeps the last good snapshot when a refresh fails', async () => {
    // First refresh succeeds.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/organizations')
          ? jsonResponse([{ uuid: 'chat-org', capabilities: ['chat'] }])
          : jsonResponse(USAGE_PAYLOAD),
      ),
    );
    await loadServiceWorker();
    await chromeFake.sendMessage({ type: 'REFRESH_USAGE' });

    // Second refresh fails outright.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const response = (await chromeFake.sendMessage({ type: 'REFRESH_USAGE' })) as UsageCacheEntry;

    expect(response.error?.code).toBe('NETWORK_ERROR');
    expect(response.snapshot?.windows).toHaveLength(2);
  });

  it('reports being logged out without discarding the badge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)),
    );
    await loadServiceWorker();

    const response = (await chromeFake.sendMessage({ type: 'REFRESH_USAGE' })) as UsageCacheEntry;

    expect(response.error?.code).toBe('NOT_LOGGED_IN');
    expect(response.snapshot).toBeNull();
    // No data means an empty badge rather than a stale number.
    expect(chromeFake.badgeText.at(-1)).toBe('');
  });

  it('ignores messages it does not understand', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(USAGE_PAYLOAD)),
    );
    await loadServiceWorker();

    await expect(chromeFake.sendMessage({ type: 'SOMETHING_ELSE' })).resolves.toBeUndefined();
  });
});
