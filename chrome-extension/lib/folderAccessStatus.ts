/**
 * The state of a folder-access priming request, and the copy for it.
 *
 * Pure — no browser APIs. `PopupRoot` owns the state, `SettingsPage` renders
 * whatever this describes. Mirrors `autonomousWorkStatus` rather than sharing
 * with it: the two report the same shape of outcome but mean quite different
 * things, and the wording is the whole point of the module.
 */

export type FolderAccessStatus =
  { kind: 'idle' } | { kind: 'starting' } | { kind: 'started' } | { kind: 'failed'; error: string };

export const IDLE_FOLDER_ACCESS_STATUS: FolderAccessStatus = { kind: 'idle' };

/** Same translation as the work-run status: an absent host is the likely cause. */
function isHostMissing(error: string): boolean {
  return /not found|forbidden|not installed/i.test(error);
}

export function describeFolderAccessStatus(status: FolderAccessStatus): string | null {
  switch (status.kind) {
    case 'idle':
      return null;
    case 'starting':
      return 'Asking macOS…';
    case 'started':
      // Deliberately vague about how many dialogs: a folder already granted
      // raises none, so on a second press nothing at all may appear, and
      // promising "three dialogs" would read as a bug.
      return 'macOS will ask about any folder it has not already been told about. Allow each one.';
    case 'failed':
      return isHostMissing(status.error)
        ? 'Helper not installed. Run `just install-usage-host` in the project, then reload the extension.'
        : `Could not ask: ${status.error}`;
  }
}

export function isFolderAccessStatusError(status: FolderAccessStatus): boolean {
  return status.kind === 'failed';
}
