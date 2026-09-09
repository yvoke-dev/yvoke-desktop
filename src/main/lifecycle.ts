/**
 * Shutdown sequencing for the main process.
 *
 * Electron's emitters are synchronous, so a promise returned from a `before-quit` listener is
 * simply discarded: the process tears down without waiting for it, dropping exactly the
 * trailing log lines a post-mortem needs. Flushing them requires deferring the quit once and
 * re-issuing it when the flush is done.
 */
export interface QuitHooks {
  /** Releases the app's resources. Runs before the flush so its own output is captured. */
  dispose: () => void;
  /** Flushes and closes file logging. */
  flushLogs: () => Promise<void>;
  /** Re-issues the deferred quit. */
  quit: () => void;
}

export function createBeforeQuitHandler(
  hooks: QuitHooks,
): (event: { preventDefault: () => void }) => void {
  let deferred = false;

  return (event) => {
    // The second pass is the quit this handler itself asked for. Deferring that one too
    // would leave an app that can never be closed.
    if (deferred) return;
    deferred = true;

    event.preventDefault();
    hooks.dispose();

    void (async () => {
      try {
        await hooks.flushLogs();
      } catch {
        // A quit already deferred must go through even if the logs cannot be written.
      }
      hooks.quit();
    })();
  };
}
