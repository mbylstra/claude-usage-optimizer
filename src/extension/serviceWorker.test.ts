import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageCacheEntry } from '@/lib/usageTypes';
import type { UsageHistorySample } from './usageStorage';

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
  const titles: string[] = [];

  return {
    storage,
    createdAlarms,
    badgeText,
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

  it('clears any badge an earlier version left on the toolbar icon', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(USAGE_PAYLOAD)),
    );
    await loadServiceWorker();

    await vi.waitFor(() => expect(chromeFake.badgeText).toContain(''));
    // Nothing ever paints one back on.
    expect(chromeFake.badgeText.every((text) => text === '')).toBe(true);
  });

  it('fetches, caches and retitles the icon when the refresh alarm fires', async () => {
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

    // The tooltip names the higher of the two utilisations.
    await vi.waitFor(() => expect(chromeFake.titles.at(-1)).toContain('61%'));
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

    const history = chromeFake.storage.get('usageHistory') as UsageHistorySample[];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fiveHourPercent: 42, sevenDayPercent: 61 });
  });

  it('records the reset times alongside the percentages', async () => {
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

    const history = chromeFake.storage.get('usageHistory') as UsageHistorySample[];
    expect(history[0]).toMatchObject({
      fiveHourResetsAt: '2026-08-07T18:00:00Z',
      sevenDayResetsAt: '2026-08-11T09:00:00Z',
      // Not present in this payload, so recorded as absent rather than omitted.
      sevenDayOpusPercent: null,
      sevenDayOpusResetsAt: null,
    });
  });

  /**
   * The reason the reset times are recorded at all: a fixed window's reset holds
   * steady and then jumps, while a rolling one creeps forward. One sample cannot
   * tell them apart; a sequence can.
   */
  it('accumulates a sequence of reset times that can distinguish a window jump', async () => {
    const resetTimes = ['2026-08-07T18:00:00Z', '2026-08-07T18:00:00Z', '2026-08-07T23:00:00Z'];
    let refreshCount = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/organizations')) {
          return jsonResponse([{ uuid: 'chat-org', capabilities: ['chat'] }]);
        }
        const resetsAt = resetTimes[Math.min(refreshCount++, resetTimes.length - 1)];
        return jsonResponse({ five_hour: { utilization: 30, resets_at: resetsAt } });
      }),
    );
    await loadServiceWorker();

    for (let refresh = 0; refresh < resetTimes.length; refresh += 1) {
      await chromeFake.sendMessage({ type: 'REFRESH_USAGE' });
    }

    const history = chromeFake.storage.get('usageHistory') as UsageHistorySample[];
    expect(history.map((sample) => sample.fiveHourResetsAt)).toEqual(resetTimes);
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

  it('reports being logged out and falls back to the plain tooltip', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)),
    );
    await loadServiceWorker();

    const response = (await chromeFake.sendMessage({ type: 'REFRESH_USAGE' })) as UsageCacheEntry;

    expect(response.error?.code).toBe('NOT_LOGGED_IN');
    expect(response.snapshot).toBeNull();
    // No data means the neutral title rather than a stale percentage.
    expect(chromeFake.titles.at(-1)).toBe('Claude Usage Optimizer');
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
