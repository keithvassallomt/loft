import { describe, it, expect } from 'vitest';
import type { Session } from 'electron';
import { isStuckUrl, createStuckWatcher, clearServiceCaches, startInitialLoad } from '../src/main/recovery';

describe('isStuckUrl', () => {
  it('treats a view that never committed as stuck', () => {
    expect(isStuckUrl('')).toBe(true);
    expect(isStuckUrl('about:blank')).toBe(true);
  });
  it('treats a committed document as fine', () => {
    expect(isStuckUrl('https://app.slack.com/client/')).toBe(false);
    // Chromium's own error page commits the real URL -> not our problem (spec §3).
    expect(isStuckUrl('https://app.slack.com/client/T1/D2')).toBe(false);
  });
});

/** Fake-timer harness: setTimer captures the callback so the test fires it by hand. */
function harness(initialUrl = 'about:blank') {
  let pending: (() => void) | undefined;
  let url = initialUrl;
  const calls = { stuck: 0, recovered: 0, cleared: 0 };
  const w = createStuckWatcher({
    timeoutMs: 15000,
    getUrl: () => url,
    onStuck: () => { calls.stuck++; },
    onRecovered: () => { calls.recovered++; },
    setTimer: (fn) => { pending = fn; return 1; },
    clearTimer: () => { pending = undefined; calls.cleared++; },
  });
  return {
    w, calls,
    fire: () => { const f = pending; pending = undefined; f?.(); },
    setUrl: (u: string) => { url = u; },
  };
}

describe('createStuckWatcher', () => {
  it('does not report stuck when the page commits before the timeout', () => {
    const h = harness();
    h.w.armed();
    h.setUrl('https://app.slack.com/client/T1/D2');
    h.w.navigated('https://app.slack.com/client/T1/D2');
    h.fire(); // timer was cleared — no-op
    expect(h.calls.stuck).toBe(0);
  });

  it('reports stuck once when still blank at the timeout', () => {
    const h = harness();
    h.w.armed();
    h.fire();
    expect(h.calls.stuck).toBe(1);
  });

  it('ignores a navigation that is itself blank (does not disarm)', () => {
    const h = harness();
    h.w.armed();
    h.w.navigated('about:blank');
    h.fire();
    expect(h.calls.stuck).toBe(1);
  });

  it('recovers when the page commits late (slow network self-correction)', () => {
    const h = harness();
    h.w.armed();
    h.fire();
    expect(h.calls.stuck).toBe(1);
    h.setUrl('https://app.slack.com/client/T1/D2');
    h.w.navigated('https://app.slack.com/client/T1/D2');
    expect(h.calls.recovered).toBe(1);
  });

  it('does not fire onRecovered when it never reported stuck', () => {
    const h = harness();
    h.w.armed();
    h.w.navigated('https://app.slack.com/client/');
    expect(h.calls.recovered).toBe(0);
  });

  it('dispose clears a pending timer', () => {
    const h = harness();
    h.w.armed();
    h.w.dispose();
    expect(h.calls.cleared).toBeGreaterThan(0);
    h.fire();
    expect(h.calls.stuck).toBe(0);
  });
});

describe('startInitialLoad', () => {
  it('loads immediately and never clears when clearFirst is false', async () => {
    const calls: string[] = [];
    await startInitialLoad(false, {
      clearCaches: async () => { calls.push('clear'); },
      load: () => calls.push('load'),
      onError: () => calls.push('error'),
    });
    expect(calls).toEqual(['load']);
  });

  it('loads synchronously (not on a later tick) when clearFirst is false', () => {
    const calls: string[] = [];
    // No await: the load must have happened by the time this line runs — a
    // non-clearing service must keep today's synchronous first navigation.
    void startInitialLoad(false, {
      clearCaches: async () => { calls.push('clear'); },
      load: () => calls.push('load'),
      onError: () => calls.push('error'),
    });
    expect(calls).toEqual(['load']);
  });

  it('clears BEFORE loading when clearFirst is true', async () => {
    const calls: string[] = [];
    await startInitialLoad(true, {
      clearCaches: async () => { calls.push('clear'); },
      load: () => calls.push('load'),
      onError: () => calls.push('error'),
    });
    expect(calls).toEqual(['clear', 'load']);
  });

  it('does not load until the clear resolves', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const done = startInitialLoad(true, {
      clearCaches: () => gate,
      load: () => calls.push('load'),
      onError: () => calls.push('error'),
    });
    expect(calls).toEqual([]); // clear still pending → no load yet
    release();
    await done;
    expect(calls).toEqual(['load']);
  });

  it('still loads (and reports) when the clear rejects — never strands the window blank', async () => {
    const calls: string[] = [];
    const boom = new Error('clear failed');
    let seen: unknown;
    await startInitialLoad(true, {
      clearCaches: async () => { throw boom; },
      load: () => calls.push('load'),
      onError: (e) => { seen = e; calls.push('error'); },
    });
    expect(calls).toEqual(['error', 'load']);
    expect(seen).toBe(boom);
  });
});

describe('clearServiceCaches', () => {
  it('clears ONLY serviceworkers + cachestorage, never cookies/localstorage/indexdb', async () => {
    const seen: string[][] = [];
    let cacheCleared = false;
    const fake = {
      clearStorageData: async (o: { storages: string[] }) => { seen.push(o.storages); },
      clearCache: async () => { cacheCleared = true; },
    } as unknown as Session;

    await clearServiceCaches(fake);

    expect(seen).toEqual([['serviceworkers', 'cachestorage']]);
    expect(cacheCleared).toBe(true);
    const everything = seen.flat();
    for (const forbidden of ['cookies', 'localstorage', 'indexdb', 'websql', 'filesystem']) {
      expect(everything).not.toContain(forbidden);
    }
  });
});
