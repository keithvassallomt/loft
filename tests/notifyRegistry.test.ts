import { describe, it, expect } from 'vitest';
import { createNotifyRegistry } from '../src/preload/notify/notifyRegistry';

describe('createNotifyRegistry', () => {
  it('hands back an increasing id and retrieves what was stored', () => {
    const r = createNotifyRegistry<string>();
    const a = r.remember('a');
    const b = r.remember('b');
    expect(b).toBeGreaterThan(a);
    expect(r.take(a)).toBe('a');
    expect(r.take(b)).toBe('b');
  });

  it('take removes, so a second take finds nothing', () => {
    const r = createNotifyRegistry<string>();
    const id = r.remember('once');
    expect(r.take(id)).toBe('once');
    expect(r.take(id)).toBeUndefined();
  });

  it('take of an id it never issued is undefined, not a throw', () => {
    const r = createNotifyRegistry<string>();
    expect(r.take(9999)).toBeUndefined();
  });

  it('removes an entry even when the stored value is legitimately undefined', () => {
    const r = createNotifyRegistry<string | undefined>();
    const id = r.remember(undefined);
    expect(r.take(id)).toBeUndefined();
    // The point: it really went, rather than merely returning undefined while still stored.
    expect(r.size()).toBe(0);
    expect(r.take(id)).toBeUndefined();
  });

  it('forget drops an entry without retrieving it', () => {
    const r = createNotifyRegistry<string>();
    const id = r.remember('x');
    r.forget(id);
    expect(r.take(id)).toBeUndefined();
    expect(r.size()).toBe(0);
  });

  it('evicts the OLDEST once the cap is exceeded', () => {
    const r = createNotifyRegistry<string>(3);
    const first = r.remember('1');
    r.remember('2');
    r.remember('3');
    expect(r.size()).toBe(3);
    const fourth = r.remember('4');
    expect(r.size()).toBe(3);
    expect(r.take(first)).toBeUndefined(); // the oldest went
    expect(r.take(fourth)).toBe('4');      // the newest stayed
  });

  it('defaults to a cap of 50', () => {
    const r = createNotifyRegistry<number>();
    const ids = Array.from({ length: 60 }, (_, i) => r.remember(i));
    expect(r.size()).toBe(50);
    expect(r.take(ids[0])).toBeUndefined();
    expect(r.take(ids[59])).toBe(59);
  });
});
