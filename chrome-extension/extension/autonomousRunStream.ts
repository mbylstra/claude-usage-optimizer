import { parseAutonomousRunEvents, type AutonomousRunEvent } from '@/lib/autonomousRunEvents';
import { isMissingHostError } from '@/lib/runStreamStatus';

/**
 * The live connection to the native host, for the run-log window.
 *
 * `sendNativeMessage` — which every other host call uses — spawns a process,
 * takes one reply and lets Chrome tear it down, so it cannot stream. This uses
 * `connectNative`, a port that keeps a host process alive for as long as the
 * page holds it open, and the host pushes events up it unasked.
 *
 * **The page opens this, not the service worker**, which is a deliberate
 * exception to "the popup asks the service worker rather than doing it itself".
 * That rule exists so network, storage and badge updates happen in one place; a
 * live stream is none of those. And an MV3 worker is killed when idle, so
 * holding a port open there for an hour of sporadic events is exactly the fight
 * `chrome.alarms` exists to avoid. A real document's lifetime matches the
 * stream's exactly: window open, port open; window closed, host exits.
 *
 * Chrome spawns a separate host process per connection, so this never interferes
 * with the five-minutely snapshot writes.
 */

const NATIVE_HOST_NAME = 'com.claudeusageoptimizer.usagehost';

const TAIL_MESSAGE_TYPE = 'tailAutonomousRun';
const CANCEL_MESSAGE_TYPE = 'cancelAutonomousWork';

/** Backoff for a host that died mid-run. A run outliving its viewer is normal. */
const FIRST_RECONNECT_DELAY_MS = 1000;
const MAXIMUM_RECONNECT_DELAY_MS = 15_000;

export interface RunStreamHandlers {
  /** `replace` means "this is the whole run": a backfill, or the file was rewritten. */
  onEvents: (events: AutonomousRunEvent[], replace: boolean) => void;
  onConnected: () => void;
  onDisconnected: (error: string) => void;
  onError: (error: string) => void;
}

export interface RunCancelResult {
  ok: boolean;
  /** False when there was simply nothing running — a different answer, not a failure. */
  stopped: boolean;
  detail: string;
  error?: string;
}

export interface AutonomousRunStreamConnection {
  /** Ask the host to stop the in-flight run, and report what it killed. */
  cancelRun: () => Promise<RunCancelResult>;
  disconnect: () => void;
}

interface HostMessage {
  type?: unknown;
  events?: unknown;
  replace?: unknown;
  error?: unknown;
  ok?: unknown;
  stopped?: unknown;
  detail?: unknown;
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Connect, and keep reconnecting until `disconnect` is called.
 *
 * The host is asked to tail on every (re)connection, and answers with a full
 * replay of the current run — so a reconnect heals itself without the caller
 * tracking what it already had.
 */
export function connectAutonomousRunStream(
  handlers: RunStreamHandlers,
): AutonomousRunStreamConnection {
  let port: chrome.runtime.Port | null = null;
  let reconnectDelayMs = FIRST_RECONNECT_DELAY_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let hasDisconnected = false;
  let pendingCancel: ((result: RunCancelResult) => void) | null = null;

  const handleHostMessage = (message: HostMessage) => {
    if (message.type === 'runEvents') {
      const events = Array.isArray(message.events) ? message.events : [];
      handlers.onEvents(parseAutonomousRunEvents(events), message.replace === true);
      return;
    }

    if (message.type === 'tailStarted') {
      // Only now is the stream really established; anything earlier is a port
      // that opened and could still fail on the host's first breath.
      reconnectDelayMs = FIRST_RECONNECT_DELAY_MS;
      handlers.onConnected();
      return;
    }

    if (message.type === 'cancelResult') {
      const resolve = pendingCancel;
      pendingCancel = null;
      const error = readString(message.error);
      resolve?.({
        ok: message.ok === true,
        stopped: message.stopped === true,
        detail: readString(message.detail),
        ...(error === '' ? {} : { error }),
      });
      return;
    }

    if (message.type === 'tailError') {
      handlers.onError(readString(message.error, 'The helper could not read the run log'));
    }
  };

  const connect = () => {
    if (hasDisconnected) return;

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      // Thrown synchronously when the extension has no nativeMessaging access at
      // all; a merely missing host surfaces through onDisconnect instead.
      handlers.onDisconnected(String(error));
      return;
    }

    port.onMessage.addListener(handleHostMessage);

    port.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message ?? 'The helper stopped responding';
      port = null;

      // A cancel in flight will never be answered now.
      const resolve = pendingCancel;
      pendingCancel = null;
      resolve?.({ ok: false, stopped: false, detail: '', error: reason });

      if (hasDisconnected) return;
      handlers.onDisconnected(reason);

      // A host nobody installed will not appear by itself, and retrying spawns a
      // process every few seconds for the life of the window. Reconnection is
      // for a host that died, which is the case worth healing.
      if (isMissingHostError(reason)) return;

      reconnectTimer = setTimeout(connect, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAXIMUM_RECONNECT_DELAY_MS);
    });

    try {
      port.postMessage({ type: TAIL_MESSAGE_TYPE });
    } catch {
      // The port was already dead — `onDisconnect` has the reason and will run.
    }
  };

  connect();

  return {
    cancelRun: () =>
      new Promise<RunCancelResult>((resolve) => {
        if (port === null) {
          resolve({ ok: false, stopped: false, detail: '', error: 'Not connected to the helper' });
          return;
        }
        pendingCancel = resolve;
        try {
          port.postMessage({ type: CANCEL_MESSAGE_TYPE });
        } catch (error) {
          pendingCancel = null;
          resolve({ ok: false, stopped: false, detail: '', error: String(error) });
        }
      }),

    disconnect: () => {
      hasDisconnected = true;
      clearTimeout(reconnectTimer);
      port?.disconnect();
      port = null;
    },
  };
}
