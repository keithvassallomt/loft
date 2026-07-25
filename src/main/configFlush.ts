/**
 * Debounced config flush for window bounds/zoom.
 *
 * Every other piece of config (DND, per-service settings, grid tree, rail order) already
 * reaches disk the moment it changes. Window bounds/zoom were the exception: they were
 * mutated in memory on resize/move/hide and written once, at shutdown.
 *
 * That write can no longer happen at shutdown. At a Flatpak logout the app has ~21ms
 * between SIGTERM and its D-Bus proxy dying, after which Chromium aborts the process —
 * see the measurement in shutdown.ts. The session-end handler therefore does nothing but
 * exit, and the bounds have to be on disk before the signal ever arrives.
 *
 * Debounced rather than immediate because 'resize'/'move' fire continuously through a
 * drag; one write per event would hammer the disk for no benefit.
 */
export interface FlushDeps {
  /** Write the config to disk. Synchronous; may throw (guarded). */
  save(): void;
  /** Quiet period before a scheduled write fires. */
  delayMs: number;
}

export interface DebouncedFlush {
  /** Note that config changed; write it once the quiet period elapses. */
  schedule(): void;
}

export function createDebouncedFlush(deps: FlushDeps): DebouncedFlush {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        // Best-effort: this runs from a timer, so an escaping throw is an unhandled
        // exception that takes the app down over bookkeeping. A read-only config dir
        // should cost you the remembered window size, nothing more.
        try {
          deps.save();
        } catch (e) {
          console.error('config flush failed:', (e as Error)?.message ?? e);
        }
      }, deps.delayMs);
      // Never let a pending flush hold the process open on its own.
      timer.unref?.();
    },
  };
}
