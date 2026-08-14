/**
 * Injected by both Vite passes (`define`), so the code can say which build it is.
 *
 * MV3 splits an unpacked extension's freshness in two: `popup.html` and its
 * bundle are re-read from disk every time the popup opens, while the registered
 * service-worker script is replaced only when the extension is reloaded. A stale
 * worker is therefore invisible — the UI is current, the code on disk is current,
 * and only the behaviour is old. That cost a long debugging session once; the
 * stamp travels to the native host so a log line names the running build.
 */
declare const BUILD_STAMP: string;
