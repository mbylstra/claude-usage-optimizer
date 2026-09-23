import { useCallback, useEffect, useRef, useState } from 'react';
import { RunLogView } from '@/components/RunLogView';
import {
  buildAutonomousRunViewModel,
  isRunInFlight,
  type AutonomousRunViewModel,
} from '@/lib/autonomousRunViewModel';
import type { AutonomousRunEvent } from '@/lib/autonomousRunEvents';
import { IDLE_RUN_CANCEL_STATUS, type RunCancelStatus } from '@/lib/runCancelStatus';
import {
  INITIAL_RUN_STREAM_STATUS,
  isMissingHostError,
  type RunStreamStatus,
} from '@/lib/runStreamStatus';
import {
  connectAutonomousRunStream,
  type AutonomousRunStreamConnection,
} from '@/extension/autonomousRunStream';
import { isResetRunLogMessage } from '@/extension/messages';

/**
 * The only run-log component that talks to `extension/` — the same relationship
 * `PopupRoot` has with it.
 *
 * It holds the port for exactly as long as the window is open, and keeps the
 * raw event list; every derived figure comes from `buildAutonomousRunViewModel`.
 */

/** Fast enough that the elapsed reading looks like a stopwatch, not a clock. */
const ELAPSED_TICK_MS = 1000;
const STARTED_AFTER_QUERY_PARAMETER = 'startedAfter';

function readStartedAfterFromLocation(): string | null {
  const value = new URLSearchParams(window.location.search).get(STARTED_AFTER_QUERY_PARAMETER);
  return value !== null && Number.isFinite(Date.parse(value)) ? value : null;
}

function eventsAtOrAfter(
  events: readonly AutonomousRunEvent[],
  startedAfter: string | null,
): AutonomousRunEvent[] {
  if (startedAfter === null) return [...events];
  const threshold = Date.parse(startedAfter);
  return events.filter((event) => {
    const eventTime = Date.parse(event.at);
    return Number.isFinite(eventTime) && eventTime >= threshold;
  });
}

export function RunLogRoot() {
  const [initialStartedAfter] = useState(readStartedAfterFromLocation);
  const [events, setEvents] = useState<AutonomousRunEvent[]>([]);
  const [isWaitingForRun, setIsWaitingForRun] = useState(initialStartedAfter !== null);
  const [streamStatus, setStreamStatus] = useState<RunStreamStatus>(INITIAL_RUN_STREAM_STATUS);
  const [cancelStatus, setCancelStatus] = useState<RunCancelStatus>(IDLE_RUN_CANCEL_STATUS);
  const [now, setNow] = useState(() => new Date());
  const connectionRef = useRef<AutonomousRunStreamConnection | null>(null);
  const startedAfterRef = useRef<string | null>(initialStartedAfter);

  useEffect(() => {
    const handleMessage = (message: unknown) => {
      if (!isResetRunLogMessage(message)) return;
      if (!Number.isFinite(Date.parse(message.startedAfter))) return;

      startedAfterRef.current = message.startedAfter;
      setEvents((current) => eventsAtOrAfter(current, message.startedAfter));
      setCancelStatus(IDLE_RUN_CANCEL_STATUS);
      setIsWaitingForRun(true);
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  useEffect(() => {
    const connection = connectAutonomousRunStream({
      onEvents: (incoming, replace) => {
        const visibleIncoming = eventsAtOrAfter(incoming, startedAfterRef.current);
        setEvents((current) => (replace ? visibleIncoming : [...current, ...visibleIncoming]));
        if (visibleIncoming.length > 0) setIsWaitingForRun(false);
      },
      onConnected: () => setStreamStatus({ kind: 'streaming' }),
      onDisconnected: (error) =>
        setStreamStatus(
          // A host nobody installed is an ordinary state with an obvious fix,
          // and reconnecting to it forever would be a lie about what is wrong.
          isMissingHostError(error) ? { kind: 'unavailable', error } : { kind: 'reconnecting' },
        ),
      onError: (error) => setStreamStatus({ kind: 'failed', error }),
    });

    connectionRef.current = connection;
    return () => {
      connectionRef.current = null;
      connection.disconnect();
    };
  }, []);

  const model: AutonomousRunViewModel = buildAutonomousRunViewModel(events, now);
  const isRunning = isRunInFlight(model.status);

  // Only a live run has an elapsed reading that changes.
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setNow(new Date()), ELAPSED_TICK_MS);
    return () => clearInterval(interval);
  }, [isRunning]);

  /**
   * Two presses, not one: losing an hour of unattended work to a misclick is a
   * poor trade for one saved click. The run's own ending still arrives as a
   * `runFinished` event, so the view never has to guess that it worked.
   */
  const handleCancel = useCallback(() => {
    if (cancelStatus.kind !== 'confirming') {
      setCancelStatus({ kind: 'confirming' });
      return;
    }

    const connection = connectionRef.current;
    if (connection === null) {
      setCancelStatus({ kind: 'failed', error: 'Not connected to the helper' });
      return;
    }

    setCancelStatus({ kind: 'cancelling' });
    void connection.cancelRun().then((result) => {
      if (!result.ok) {
        setCancelStatus({ kind: 'failed', error: result.error ?? 'The helper refused' });
        return;
      }
      setCancelStatus(
        result.stopped ? { kind: 'stopped', detail: result.detail } : { kind: 'nothingRunning' },
      );
    });
  }, [cancelStatus.kind]);

  return (
    <RunLogView
      model={model}
      events={events}
      streamStatus={streamStatus}
      cancelStatus={cancelStatus}
      isWaitingForRun={isWaitingForRun}
      onCancel={handleCancel}
    />
  );
}
