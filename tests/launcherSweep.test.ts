import { describe, it, expect, vi } from 'vitest';
import { reconcileServiceLaunchers } from '../src/main/desktop';

describe('reconcileServiceLaunchers', () => {
  it('writes for ids that want a launcher, removes for those that do not', () => {
    const write = vi.fn(), remove = vi.fn();
    reconcileServiceLaunchers(['a', 'b', 'c'], (id) => id !== 'b', { write, remove });
    expect(write.mock.calls.map((c) => c[0])).toEqual(['a', 'c']);
    expect(remove.mock.calls.map((c) => c[0])).toEqual(['b']);
  });

  it('isolates a throwing op so the rest still run', () => {
    const write = vi.fn((id: string) => { if (id === 'a') throw new Error('boom'); });
    const remove = vi.fn();
    reconcileServiceLaunchers(['a', 'b'], () => true, { write, remove });
    expect(write).toHaveBeenCalledTimes(2); // 'b' still attempted after 'a' threw
  });
});
