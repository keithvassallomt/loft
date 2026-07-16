/**
 * Session-end fast-exit handler (see the wiring + rationale in index.ts).
 *
 * At GNOME/systemd logout the process is SIGTERM'd ~1s before the session bus is torn
 * down, and Chromium aborts (LOG(FATAL), dbus/bus.cc) the instant its D-Bus connection
 * disconnects while alive. So on the signal we must persist synchronously and exit
 * immediately — no graceful teardown to race. Extracted here as a pure factory so the
 * ordering/idempotency guarantees are unit-testable without Electron or real signals.
 */
export interface ShutdownDeps {
  /** Flush window bounds/zoom + config. Synchronous; may throw (guarded). */
  persist(): void;
  /** Terminate the process immediately (app.exit(0) in production). */
  exit(): void;
}

/**
 * Returns a signal handler that persists then exits, exactly once. A persist failure
 * must NOT prevent the exit — an unwritten config is far better than a lingering process
 * that aborts when the bus dies and cries "crash" at the next login.
 */
export function createSignalShutdown(deps: ShutdownDeps): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      deps.persist();
    } catch (e) {
      console.error('shutdown persist failed:', (e as Error)?.message ?? e);
    }
    deps.exit();
  };
}
