import { describe, it, expect, vi } from 'vitest';
import { createSignalShutdown } from '../src/main/shutdown';

describe('createSignalShutdown', () => {
  it('persists then exits, in that order', () => {
    const calls: string[] = [];
    const handler = createSignalShutdown({
      persist: () => calls.push('persist'),
      exit: () => calls.push('exit'),
    });
    handler();
    expect(calls).toEqual(['persist', 'exit']);
  });

  it('runs at most once even if the signal fires repeatedly', () => {
    const persist = vi.fn();
    const exit = vi.fn();
    const handler = createSignalShutdown({ persist, exit });
    handler();
    handler();
    handler();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  // A failed config write must never strand the process — a lingering Electron is exactly
  // what aborts when the session bus dies and reports a bogus crash at next login.
  it('still exits when persist throws', () => {
    const exit = vi.fn();
    const handler = createSignalShutdown({
      persist: () => { throw new Error('EROFS'); },
      exit,
    });
    expect(() => handler()).not.toThrow();
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
