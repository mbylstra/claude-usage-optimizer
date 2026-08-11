import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RunLogView } from '@/components/RunLogView';
import { buildAutonomousRunViewModel } from '@/lib/autonomousRunViewModel';
import type { AutonomousRunEvent } from '@/lib/autonomousRunEvents';
import { IDLE_RUN_CANCEL_STATUS, type RunCancelStatus } from '@/lib/runCancelStatus';
import type { RunStreamStatus } from '@/lib/runStreamStatus';
import {
  CANCELLED_RUN_EVENTS,
  COMPLETED_RUN_EVENTS,
  RUNNING_RUN_EVENTS,
  SKIPPED_RUN_EVENTS,
} from './fixtureRunEvents';
import '@/index.css';

/**
 * Throwaway visual harness for the run-log window — not part of the build.
 *
 * The whole UI is developed here, with `just run-log-preview`, against fixture
 * events: no extension loaded, no native host installed, and no billable run.
 * The first panel replays its events on a timer, which is the only way to see
 * whether the auto-scroll actually behaves while lines are arriving.
 */

const REPLAY_INTERVAL_MS = 900;

function useReplayedEvents(events: AutonomousRunEvent[]): AutonomousRunEvent[] {
  const [visibleCount, setVisibleCount] = useState(1);

  useEffect(() => {
    const interval = setInterval(
      () => setVisibleCount((count) => (count >= events.length ? 1 : count + 1)),
      REPLAY_INTERVAL_MS,
    );
    return () => clearInterval(interval);
  }, [events.length]);

  return events.slice(0, visibleCount);
}

function Panel({
  label,
  events,
  streamStatus = { kind: 'streaming' },
  cancelStatus = IDLE_RUN_CANCEL_STATUS,
}: {
  label: string;
  events: readonly AutonomousRunEvent[];
  streamStatus?: RunStreamStatus;
  cancelStatus?: RunCancelStatus;
}) {
  // A fresh clock each render keeps the elapsed reading moving as events arrive.
  const model = buildAutonomousRunViewModel(events, new Date());

  return (
    <div style={{ width: 460 }}>
      <div style={{ font: '11px system-ui', color: '#888', padding: '10px 4px 4px' }}>{label}</div>
      <div style={{ height: 520, border: '1px solid #8884', borderRadius: 8, overflow: 'hidden' }}>
        <RunLogView
          model={model}
          events={events}
          streamStatus={streamStatus}
          cancelStatus={cancelStatus}
          onCancel={() => {}}
        />
      </div>
    </div>
  );
}

function LivePanel() {
  const events = useReplayedEvents(RUNNING_RUN_EVENTS);
  return <Panel label="running — replaying live" events={events} />;
}

function Column({ dark }: { dark: boolean }) {
  return (
    <div
      className={dark ? 'dark' : ''}
      style={{ background: dark ? '#111' : '#fff', padding: 12, display: 'grid', gap: 12 }}
    >
      <LivePanel />
      <Panel label="completed" events={COMPLETED_RUN_EVENTS} />
      <Panel
        label="cancelled, with the cancel confirmed"
        events={CANCELLED_RUN_EVENTS}
        cancelStatus={{ kind: 'stopped', detail: 'Stopped 40122  claude -p …' }}
      />
      <Panel label="skipped by the pace gate" events={SKIPPED_RUN_EVENTS} />
      <Panel
        label="no runs recorded, helper missing"
        events={[]}
        streamStatus={{ kind: 'unavailable', error: 'Specified native messaging host not found.' }}
      />
      <Panel
        label="reconnecting mid-run"
        events={RUNNING_RUN_EVENTS}
        streamStatus={{ kind: 'reconnecting' }}
        cancelStatus={{ kind: 'confirming' }}
      />
    </div>
  );
}

const container = document.getElementById('root');
if (container === null) throw new Error('missing root');

createRoot(container).render(
  <StrictMode>
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      <Column dark={false} />
      <Column dark={true} />
    </div>
  </StrictMode>,
);

export { Column };
