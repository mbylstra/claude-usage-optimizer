/**
 * Opens the detached window that streams an autonomous run.
 *
 * A window rather than a tab: it is a monitor for something happening
 * elsewhere, so it wants to sit beside the browser rather than inside it.
 * `chrome.windows.create` needs no permission of its own — only *reading* tab
 * URLs would.
 */

const RUN_LOG_PAGE = 'run-log.html';

/** Roughly the proportions of a terminal running `just autonomous-log`. */
const WINDOW_WIDTH_PX = 520;
const WINDOW_HEIGHT_PX = 680;

/**
 * The open window's id, kept in session storage rather than a module variable.
 *
 * The service worker is torn down whenever it goes idle, which is most of the
 * time, so a variable would forget the window between one button press and the
 * next — and pressing a run button twice would leave two windows streaming the
 * same run. Session storage lives as long as the browser profile session does, which
 * is exactly as long as the window can.
 */
const RUN_LOG_WINDOW_ID_KEY = 'runLogWindowId';

async function readRunLogWindowId(): Promise<number | null> {
  const stored = await chrome.storage.session.get(RUN_LOG_WINDOW_ID_KEY);
  const windowId = stored[RUN_LOG_WINDOW_ID_KEY];
  return typeof windowId === 'number' ? windowId : null;
}

async function focusExistingWindow(windowId: number): Promise<boolean> {
  try {
    await chrome.windows.update(windowId, { focused: true, drawAttention: true });
    return true;
  } catch {
    // Closed since we last looked — the ordinary case, not a failure.
    return false;
  }
}

/**
 * Show the run log, focusing the window that is already open rather than
 * opening a second one.
 */
export async function openRunLogWindow(): Promise<void> {
  const existingWindowId = await readRunLogWindowId();
  if (existingWindowId !== null && (await focusExistingWindow(existingWindowId))) return;

  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(RUN_LOG_PAGE),
    type: 'popup',
    width: WINDOW_WIDTH_PX,
    height: WINDOW_HEIGHT_PX,
  });

  if (created?.id !== undefined) {
    await chrome.storage.session.set({ [RUN_LOG_WINDOW_ID_KEY]: created.id });
  }
}

/** Forget a window the user closed, so the next press opens a fresh one. */
export function trackRunLogWindowClosure(closedWindowId: number): void {
  void readRunLogWindowId().then((windowId) => {
    if (windowId === closedWindowId) void chrome.storage.session.remove(RUN_LOG_WINDOW_ID_KEY);
  });
}
