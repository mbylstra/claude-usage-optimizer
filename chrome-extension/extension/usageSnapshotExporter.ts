import { buildUsageSnapshotExport } from '@/lib/usageSnapshotExport';
import type { AutonomousWorkSettings } from '@/lib/settingsTypes';
import type { UsageSnapshot } from '@/lib/usageTypes';
import type { JiraCredentialStatus } from '@/lib/jiraCredentialWarning';
import type { RepositorySyncResult } from '@/lib/autonomousWorkSettingsStatus';

/**
 * Hands each usage snapshot to a native-messaging host, which writes it to
 * `backend/claude-usage.json` for the autonomous-work scheduler.
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
const RUN_FULL_WORK_MESSAGE_TYPE = 'runFullAutonomousWork';
const PRIME_FOLDER_ACCESS_MESSAGE_TYPE = 'primeFolderAccess';
const SET_SETTINGS_MESSAGE_TYPE = 'setAutonomousWorkSettings';
const JIRA_STATUS_MESSAGE_TYPE = 'getJiraStatus';

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
 * "Do next todo": ask the host to run the single next queued prompt now,
 * bypassing the pace check. An explicit instruction, so second-guessing it with
 * the same gate the nightly job uses would just make the button look broken.
 *
 * Resolves as soon as the host has *launched* the run. The work itself outlives
 * this call by up to an hour and reports into `autonomous-work.log`.
 */
export async function requestAutonomousWorkRun(): Promise<{ started: boolean; error?: string }> {
  return sendRunRequest(RUN_WORK_MESSAGE_TYPE);
}

/**
 * "Trigger a full run": ask the host to start the nightly job now.
 *
 * Same launchd label the 2 AM run uses, so it stays pace-gated, works through
 * the whole queue, and schedules a 5-hour-reset resume when that setting is on.
 * Like the one above, it resolves once the run has *launched*, not finished.
 */
export async function requestFullAutonomousWorkRun(): Promise<{
  started: boolean;
  error?: string;
}> {
  return sendRunRequest(RUN_FULL_WORK_MESSAGE_TYPE);
}

async function sendRunRequest(
  messageType: typeof RUN_WORK_MESSAGE_TYPE | typeof RUN_FULL_WORK_MESSAGE_TYPE,
): Promise<{ started: boolean; error?: string }> {
  try {
    const response: unknown = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      type: messageType,
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

/**
 * Ask the host to read each protected folder, so macOS puts its dialog up now.
 *
 * Resolves once the prompting has started, not once it is answered — the user
 * may sit on those dialogs for as long as they like, and the popup closing must
 * not cancel them.
 */
export async function requestFolderAccessPrompts(): Promise<{
  started: boolean;
  error?: string;
}> {
  try {
    const response: unknown = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      type: PRIME_FOLDER_ACCESS_MESSAGE_TYPE,
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
  /**
   * What the host made of the Jira half of this save, or null when there was
   * none to do. Passed through untouched — `describeAutonomousWorkSettingsStatus`
   * is where it turns into words.
   */
  repositorySync?: RepositorySyncResult | null;
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
  // Everything except the schedule crosses unchanged, so the settings object is
  // spread rather than copied field by field. Naming each field here meant a new
  // one was silently dropped until somebody remembered this file: absent is not
  // "unchanged" on the other side, it is `parse_settings` substituting its
  // default, while the popup goes on showing the value the user chose. The
  // schedule is the one field whose shape differs — `{hour, minute}` here, two
  // flat keys in the mirrored file — so it is the one field spelled out.
  const { scheduleTime, ...directlyMirroredSettings } = settings;

  try {
    const response: unknown = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      type: SET_SETTINGS_MESSAGE_TYPE,
      settings: {
        ...directlyMirroredSettings,
        scheduleHour: scheduleTime.hour,
        scheduleMinute: scheduleTime.minute,
      },
      // Not a setting — the host logs it and stores nothing. It answers the one
      // question the settings themselves cannot: which build of the service
      // worker Chrome is actually running, as opposed to which one is on disk.
      buildStamp: BUILD_STAMP,
    });

    if (typeof response === 'object' && response !== null && 'ok' in response) {
      const { ok, launchAgentUpdated, repositorySync, error } = response as {
        ok: unknown;
        launchAgentUpdated?: unknown;
        repositorySync?: unknown;
        error?: unknown;
      };
      if (ok === true) {
        return {
          saved: true,
          launchAgentUpdated: launchAgentUpdated === true,
          repositorySync: readRepositorySync(repositorySync),
        };
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

/**
 * The host's repository-sync report, read defensively.
 *
 * `null` is a real answer here and not a missing one — it is what the host sends
 * for a save with no Jira half to do — so a reply from an older host, which
 * carries no such key at all, has to arrive as `null` too rather than as
 * something the popup would try to describe.
 */
function readRepositorySync(value: unknown): RepositorySyncResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const { ok, added, disabled, reenabled, error } = value as {
    ok?: unknown;
    added?: unknown;
    disabled?: unknown;
    reenabled?: unknown;
    error?: unknown;
  };
  return {
    ok: ok === true,
    added: readNameList(added),
    disabled: readNameList(disabled),
    reenabled: readNameList(reenabled),
    error: typeof error === 'string' ? error : null,
  };
}

function readNameList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string')
    : [];
}

/**
 * What the host's last daily probe found about the Jira credential.
 *
 * A read of a local file, not a network call: the probe itself rides the
 * snapshot message, once a day, because that is the message the host is already
 * spawned for. Null whenever there is nothing to say — no host, no credential,
 * or a queue that lives in a file.
 */
export async function readJiraCredentialStatus(): Promise<JiraCredentialStatus | null> {
  try {
    const response: unknown = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      type: JIRA_STATUS_MESSAGE_TYPE,
    });

    if (typeof response !== 'object' || response === null) return null;
    const { status } = response as { status?: unknown };
    if (typeof status !== 'object' || status === null) return null;
    return status as JiraCredentialStatus;
  } catch {
    // A missing host is the ordinary case, and it is already logged once per
    // worker lifetime by the snapshot export above.
    return null;
  }
}
