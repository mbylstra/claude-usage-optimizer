import { buildUsageSnapshotExport } from '@/lib/usageSnapshotExport';
import type { AutonomousWorkSettings } from '@/lib/settingsTypes';
import type { UsageSnapshot } from '@/lib/usageTypes';

/**
 * Hands each usage snapshot to a native-messaging host, which writes it to
 * `.claude-scripts/claude-usage.json` for the autonomous-work scheduler.
 *
 * This replaces an earlier `chrome.downloads` approach. Downloads were the only
 * filesystem route that needs no host installed, but Chrome can put a
 * confirmation dialog in front of one — fatal for something firing every five
 * minutes unattended — and each write churned the download history. Native
 * messaging costs a one-time host registration and in exchange never prompts,
 * never touches `~/Downloads`, and can write inside the repo.
 *
 * The host is optional. Most users will never install it, so a missing host is
 * an ordinary state rather than an error, and is logged once per worker lifetime
 * instead of every refresh.
 */

const NATIVE_HOST_NAME = 'com.claudeusageoptimizer.usagehost';

let hasLoggedExportFailure = false;

function logExportFailureOnce(error: unknown): void {
  if (hasLoggedExportFailure) return;
  hasLoggedExportFailure = true;
  console.info(
    `Usage snapshot not exported (native host "${NATIVE_HOST_NAME}" unavailable). ` +
      'This is expected unless you installed it with `just install-usage-host`. ' +
      `Reason: ${String(error)}`,
  );
}

/** Message envelopes the host understands; mirrored in `usage-host.py`. */
const SNAPSHOT_MESSAGE_TYPE = 'snapshot';
const RUN_WORK_MESSAGE_TYPE = 'runAutonomousWork';
const SET_SETTINGS_MESSAGE_TYPE = 'setAutonomousWorkSettings';

export async function exportUsageSnapshot(snapshot: UsageSnapshot, fetchedAt: Date): Promise<void> {
  try {
    const exported = buildUsageSnapshotExport(snapshot, fetchedAt);
    const response: unknown = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      type: SNAPSHOT_MESSAGE_TYPE,
      snapshot: exported,
    });

    // The host reports its own write failures in the reply; Chrome only tells us
    // whether the process could be spoken to at all.
    if (typeof response === 'object' && response !== null && 'error' in response) {
      logExportFailureOnce((response as { error: unknown }).error);
      return;
    }

    hasLoggedExportFailure = false;
  } catch (error) {
    logExportFailureOnce(error);
  }
}

/**
 * Asks the host to start a work run now, bypassing the pace check — the button
 * that triggers this is an explicit instruction, so second-guessing it with the
 * same gate the nightly job uses would just make the button look broken.
 *
 * Resolves as soon as the host has *launched* the run. The work itself outlives
 * this call by up to an hour and reports into `autonomous-work.log`.
 */
export async function requestAutonomousWorkRun(): Promise<{ started: boolean; error?: string }> {
  try {
    const response: unknown = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      type: RUN_WORK_MESSAGE_TYPE,
    });

    if (typeof response === 'object' && response !== null && 'ok' in response) {
      const { ok, error } = response as { ok: unknown; error?: unknown };
      if (ok === true) return { started: true };
      return {
        started: false,
        error: error === undefined ? 'Host refused the request' : String(error),
      };
    }

    return { started: false, error: 'Host sent no reply' };
  } catch (error) {
    return { started: false, error: String(error) };
  }
}

export interface AutonomousWorkSettingsSyncResult {
  saved: boolean;
  launchAgentUpdated: boolean;
  error?: string;
}

/**
 * Mirror the autonomous-work settings to disk, and reschedule the launchd job.
 *
 * Only the host can do either — `chrome.storage` is invisible to launchd, and
 * MV3 has no filesystem. A machine with no host installed simply keeps the
 * settings in the browser, which is the honest outcome: there is no nightly job
 * there to reschedule.
 */
export async function syncAutonomousWorkSettings(
  settings: AutonomousWorkSettings,
): Promise<AutonomousWorkSettingsSyncResult> {
  try {
    const response: unknown = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      type: SET_SETTINGS_MESSAGE_TYPE,
      settings: {
        scheduleHour: settings.scheduleTime.hour,
        scheduleMinute: settings.scheduleTime.minute,
        newProjectsDirectory: settings.newProjectsDirectory,
      },
    });

    if (typeof response === 'object' && response !== null && 'ok' in response) {
      const { ok, launchAgentUpdated, error } = response as {
        ok: unknown;
        launchAgentUpdated?: unknown;
        error?: unknown;
      };
      if (ok === true) {
        return { saved: true, launchAgentUpdated: launchAgentUpdated === true };
      }
      return {
        saved: false,
        launchAgentUpdated: false,
        error: error === undefined ? 'Host refused the settings' : String(error),
      };
    }

    return { saved: false, launchAgentUpdated: false, error: 'Host sent no reply' };
  } catch (error) {
    return { saved: false, launchAgentUpdated: false, error: String(error) };
  }
}
