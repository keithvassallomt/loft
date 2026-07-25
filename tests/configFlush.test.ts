import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDebouncedFlush } from '../src/main/configFlush';

// Window bounds/zoom are the ONLY config state that used to reach disk at shutdown
// (everything else — DND, settings, grid, rail order — already saves on change). The
// session-end signal handler can no longer afford that write (see shutdown.ts), so the
// bounds have to be flushed while the app is alive instead. Debounced, because 'resize'
// fires continuously through a drag and a write per event would hammer the disk.
describe('createDebouncedFlush', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes once the quiet period elapses', () => {
    const save = vi.fn();
    const flush = createDebouncedFlush({ save, delayMs: 400 });

    flush.schedule();
    vi.advanceTimersByTime(400);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not write before the quiet period elapses', () => {
    const save = vi.fn();
    const flush = createDebouncedFlush({ save, delayMs: 400 });

    flush.schedule();
    vi.advanceTimersByTime(399);

    expect(save).not.toHaveBeenCalled();
  });

  // A window drag emits a burst of 'resize'/'move'; that must cost one write, not dozens.
  it('coalesces a burst of schedules into a single write', () => {
    const save = vi.fn();
    const flush = createDebouncedFlush({ save, delayMs: 400 });

    for (let i = 0; i < 50; i++) {
      flush.schedule();
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(400);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('writes again for a change made after an earlier flush settled', () => {
    const save = vi.fn();
    const flush = createDebouncedFlush({ save, delayMs: 400 });

    flush.schedule();
    vi.advanceTimersByTime(400);
    flush.schedule();
    vi.advanceTimersByTime(400);

    expect(save).toHaveBeenCalledTimes(2);
  });

  // The flush is best-effort background bookkeeping: a read-only config dir must not take
  // the app down with an unhandled exception from a timer callback.
  it('swallows a save failure rather than throwing out of the timer', () => {
    const save = vi.fn(() => { throw new Error('EROFS'); });
    const flush = createDebouncedFlush({ save, delayMs: 400 });

    flush.schedule();

    expect(() => vi.advanceTimersByTime(400)).not.toThrow();
  });
});
