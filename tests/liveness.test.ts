import { describe, it, expect } from 'vitest';
import {
  createWakeDetector, healthAction, createLivenessMonitor, DEFAULT_TUNING,
  type WakeReason, type LivenessTuning,
} from '../src/main/liveness';
import type { HealthSnapshot } from '../src/shared/health';

/** A hand-driven clock + timer queue, so every test is deterministic and instant. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = (seq += 1);
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown): void => { timers.delete(h as number); },
    /** Advance the clock, firing every timer due along the way. */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        // max, never a rewind: after sleep() the clock is already past a timer's due time
        // (its deadline was computed in monotonic terms, which a suspend freezes), and
        // moving `now` back to `at` would hide the very gap the detector looks for.
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = target;
    },
    /** Jump the wall clock WITHOUT running timers — a suspend, in other words. */
    sleep(ms: number): void { now += ms; },
    pending: () => timers.size,
  };
}

const snapshot = (o: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
  lastActivityMs: 1_000,
  openSockets: 1,
  everHadSockets: true,
  uptimeMs: 10 * 60_000,
  hasDraft: false,
  online: true,
  ...o,
});

describe('createWakeDetector', () => {
  it('says nothing while ticks land on time', () => {
    const clock = fakeClock();
    const wakes: WakeReason[] = [];
    const d = createWakeDetector({
      intervalMs: 15_000, gapToleranceMs: 60_000,
      now: clock.now, isOnline: () => true, onWake: (r) => wakes.push(r),
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    d.start();
    clock.advance(10 * 60_000);
    expect(wakes).toEqual([]);
    d.stop();
  });

  it('reports a wall-clock gap as a wake', () => {
    // The case timers cannot see: on Linux CLOCK_MONOTONIC is frozen during suspend, so the
    // tick armed before a four-hour sleep fires on schedule in monotonic terms. Only
    // Date.now() shows the gap — which is why the detector compares wall clock.
    const clock = fakeClock();
    const wakes: WakeReason[] = [];
    const d = createWakeDetector({
      intervalMs: 15_000, gapToleranceMs: 60_000,
      now: clock.now, isOnline: () => true, onWake: (r) => wakes.push(r),
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    d.start();
    clock.sleep(4 * 60 * 60_000); // suspended: no timers ran
    clock.advance(15_000);        // the next tick lands
    expect(wakes).toEqual(['clock-gap']);
    d.stop();
  });

  it('tolerates a late tick within the slack', () => {
    const clock = fakeClock();
    const wakes: WakeReason[] = [];
    const d = createWakeDetector({
      intervalMs: 15_000, gapToleranceMs: 60_000,
      now: clock.now, isOnline: () => true, onWake: (r) => wakes.push(r),
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    d.start();
    clock.sleep(50_000); // a busy machine, not a suspend
    clock.advance(15_000);
    expect(wakes).toEqual([]);
    d.stop();
  });

  it('ignores a backwards clock jump', () => {
    const clock = fakeClock();
    const wakes: WakeReason[] = [];
    const d = createWakeDetector({
      intervalMs: 15_000, gapToleranceMs: 60_000,
      now: clock.now, isOnline: () => true, onWake: (r) => wakes.push(r),
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    d.start();
    clock.sleep(-3 * 60 * 60_000);
    clock.advance(60_000);
    expect(wakes).toEqual([]);
    d.stop();
  });

  it('reports only the offline -> online edge', () => {
    const clock = fakeClock();
    const wakes: WakeReason[] = [];
    let online = true;
    const d = createWakeDetector({
      intervalMs: 15_000, gapToleranceMs: 60_000,
      now: clock.now, isOnline: () => online, onWake: (r) => wakes.push(r),
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    d.start();
    online = false;
    clock.advance(15_000);
    expect(wakes).toEqual([]);       // going offline is not a moment to reload anything
    clock.advance(15_000);
    expect(wakes).toEqual([]);       // still offline — no repeat
    online = true;
    clock.advance(15_000);
    expect(wakes).toEqual(['network']);
    clock.advance(60_000);
    expect(wakes).toEqual(['network']); // staying online is not an edge
    d.stop();
  });

  it('stops ticking after stop()', () => {
    const clock = fakeClock();
    const wakes: WakeReason[] = [];
    const d = createWakeDetector({
      intervalMs: 15_000, gapToleranceMs: 60_000,
      now: clock.now, isOnline: () => true, onWake: (r) => wakes.push(r),
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    d.start();
    d.stop();
    expect(clock.pending()).toBe(0);
    clock.sleep(4 * 60 * 60_000);
    clock.advance(60_000);
    expect(wakes).toEqual([]);
  });
});

describe('healthAction', () => {
  const base = {
    audible: false,
    staleAfterMs: 90_000,
    freshMs: 30_000,
    now: 1_000_000,
    lastReloadAt: null,
    cooldownMs: 5 * 60_000,
  };

  it('leaves a page that is receiving data alone', () => {
    expect(healthAction({ ...base, snapshot: snapshot({ lastActivityMs: 2_000 }) })).toBe('healthy');
  });

  it('reloads a page that has received nothing for too long', () => {
    expect(healthAction({ ...base, snapshot: snapshot({ lastActivityMs: 4 * 60 * 60_000 }) })).toBe('reload');
  });

  it('reloads a page that has never received anything', () => {
    expect(healthAction({ ...base, snapshot: snapshot({ lastActivityMs: null }) })).toBe('reload');
  });

  it('reloads a page that did not answer at all', () => {
    expect(healthAction({ ...base, snapshot: null })).toBe('reload');
  });

  it('never reloads a page that is making sound', () => {
    // A call is worth more than a fresh connection — and this is checked even for a page
    // that never answered, since WebRTC is exactly what would make it miss a ping.
    expect(healthAction({ ...base, audible: true, snapshot: snapshot({ lastActivityMs: 9e6 }) })).toBe('skip-audible');
    expect(healthAction({ ...base, audible: true, snapshot: null })).toBe('skip-audible');
  });

  it('never reloads out from under someone typing', () => {
    expect(healthAction({ ...base, snapshot: snapshot({ lastActivityMs: 9e6, hasDraft: true }) })).toBe('skip-draft');
  });

  it('gives a just-loaded page time to connect', () => {
    expect(healthAction({ ...base, snapshot: snapshot({ lastActivityMs: null, uptimeMs: 5_000 }) })).toBe('skip-fresh');
  });

  it('refuses to reload the same service twice inside the cooldown', () => {
    expect(healthAction({
      ...base, snapshot: snapshot({ lastActivityMs: 9e6 }), lastReloadAt: base.now - 60_000,
    })).toBe('skip-cooldown');
    expect(healthAction({
      ...base, snapshot: snapshot({ lastActivityMs: 9e6 }), lastReloadAt: base.now - 6 * 60_000,
    })).toBe('reload');
  });

  it('puts the cooldown ahead of everything, so nothing can loop', () => {
    // A service wedged for a reason a reload cannot fix must be given up on, not retried
    // every round for ever.
    expect(healthAction({ ...base, snapshot: null, lastReloadAt: base.now - 1_000 })).toBe('skip-cooldown');
  });
});

// --- the monitor ---------------------------------------------------------------

function harness(opts: {
  services?: string[];
  online?: boolean;
  audible?: (id: string) => boolean;
  tuning?: Partial<LivenessTuning>;
} = {}) {
  const clock = fakeClock();
  const reloads: string[] = [];
  const pings: string[] = [];
  const logs: string[] = [];
  let online = opts.online ?? true;
  const monitor = createLivenessMonitor({
    services: () => opts.services ?? ['whatsapp', 'slack'],
    ping: (id) => pings.push(id),
    isAudible: opts.audible ?? (() => false),
    reload: (id) => reloads.push(id),
    isOnline: () => online,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (m) => logs.push(m),
  }, { ...DEFAULT_TUNING, ...opts.tuning });
  return {
    clock, monitor, reloads, pings, logs,
    setOnline: (v: boolean) => { online = v; },
  };
}

describe('createLivenessMonitor', () => {
  it('waits out the grace period before judging anything', () => {
    // Every one of these web apps reconnects on its own most of the time. Probing before
    // they get the chance would turn every lid-open into six page loads.
    const h = harness();
    h.monitor.wake('resume');
    h.clock.advance(DEFAULT_TUNING.graceMs - 1_000);
    expect(h.pings).toEqual([]);
    h.clock.advance(2_000);
    expect(h.pings).toEqual(['whatsapp', 'slack']);
  });

  it('leaves a service alone when it reconnected during the grace period', () => {
    const h = harness();
    h.monitor.wake('resume');
    h.clock.advance(DEFAULT_TUNING.graceMs);
    h.monitor.report('whatsapp', snapshot({ lastActivityMs: 1_500 }));
    h.monitor.report('slack', snapshot({ lastActivityMs: 900 }));
    expect(h.reloads).toEqual([]);
  });

  it('reloads only the service that stayed silent', () => {
    const h = harness();
    h.monitor.wake('resume');
    h.clock.advance(DEFAULT_TUNING.graceMs);
    h.monitor.report('whatsapp', snapshot({ lastActivityMs: 1_500 }));
    h.monitor.report('slack', snapshot({ lastActivityMs: 4 * 60 * 60_000 }));
    expect(h.reloads).toEqual(['slack']);
  });

  it('reloads a service that never answers the ping', () => {
    const h = harness();
    h.monitor.wake('resume');
    h.clock.advance(DEFAULT_TUNING.graceMs);
    h.monitor.report('whatsapp', snapshot({ lastActivityMs: 1_000 }));
    expect(h.reloads).toEqual([]);          // still waiting on slack
    h.clock.advance(DEFAULT_TUNING.probeTimeoutMs);
    expect(h.reloads).toEqual(['slack']);
  });

  it('acts as soon as everyone has answered, without waiting out the deadline', () => {
    const h = harness();
    h.monitor.wake('resume');
    h.clock.advance(DEFAULT_TUNING.graceMs);
    h.monitor.report('whatsapp', snapshot({ lastActivityMs: 9e6 }));
    h.monitor.report('slack', snapshot({ lastActivityMs: 1_000 }));
    expect(h.reloads).toEqual(['whatsapp']);
  });

  it('collapses a burst of wake signals into one round', () => {
    // One lid-open normally produces all three at once: powerMonitor's resume, the
    // clock gap, and the network coming back.
    const h = harness();
    h.monitor.wake('resume');
    h.clock.advance(5_000);
    h.monitor.wake('clock-gap');
    h.clock.advance(5_000);
    h.monitor.wake('network');
    h.clock.advance(DEFAULT_TUNING.graceMs);
    expect(h.pings).toEqual(['whatsapp', 'slack']);
  });

  it('waits for the network rather than reloading into an error page', () => {
    const h = harness({ online: false });
    h.monitor.wake('network');
    h.clock.advance(DEFAULT_TUNING.graceMs);
    expect(h.pings).toEqual([]);
    h.clock.advance(DEFAULT_TUNING.offlineRetryMs * 3);
    expect(h.pings).toEqual([]);
    h.setOnline(true);
    h.clock.advance(DEFAULT_TUNING.offlineRetryMs);
    expect(h.pings).toEqual(['whatsapp', 'slack']);
  });

  it('gives up waiting for the network after the retry budget', () => {
    const h = harness({ online: false, tuning: { maxOfflineRetries: 3 } });
    h.monitor.wake('network');
    h.clock.advance(DEFAULT_TUNING.graceMs + DEFAULT_TUNING.offlineRetryMs * 10);
    expect(h.pings).toEqual([]);
    expect(h.logs.join('\n')).toMatch(/giving up/);
  });

  it('never reloads a service in a call', () => {
    const h = harness({ audible: (id) => id === 'slack' });
    h.monitor.wake('resume');
    h.clock.advance(DEFAULT_TUNING.graceMs);
    h.monitor.report('whatsapp', snapshot({ lastActivityMs: 9e6 }));
    h.monitor.report('slack', snapshot({ lastActivityMs: 9e6 }));
    expect(h.reloads).toEqual(['whatsapp']);
    expect(h.logs.join('\n')).toMatch(/slack.*skip-audible/);
  });

  it('does nothing when no service is loaded', () => {
    const h = harness({ services: [] });
    h.monitor.wake('resume');
    h.clock.advance(DEFAULT_TUNING.graceMs + DEFAULT_TUNING.probeTimeoutMs);
    expect(h.pings).toEqual([]);
    expect(h.reloads).toEqual([]);
  });

  it('ignores an unsolicited or late answer', () => {
    const h = harness();
    h.monitor.report('whatsapp', snapshot({ lastActivityMs: 9e6 })); // no round running
    h.clock.advance(60_000);
    expect(h.reloads).toEqual([]);
  });

  it('sweeps on its own, with a longer patience than a wake', () => {
    const h = harness();
    h.monitor.start();
    h.clock.advance(DEFAULT_TUNING.sweepMs + DEFAULT_TUNING.graceMs);
    expect(h.pings).toEqual(['whatsapp', 'slack']);
    // Silence that would be stale right after a resume is not stale in a routine sweep.
    h.monitor.report('whatsapp', snapshot({ lastActivityMs: DEFAULT_TUNING.staleAfterWakeMs + 10_000 }));
    h.monitor.report('slack', snapshot({ lastActivityMs: DEFAULT_TUNING.staleAfterIdleMs + 10_000 }));
    expect(h.reloads).toEqual(['slack']);
    h.monitor.stop();
  });

  it('holds no timers after stop()', () => {
    const h = harness();
    h.monitor.start();
    h.monitor.wake('resume');
    h.monitor.stop();
    expect(h.clock.pending()).toBe(0);
    h.clock.advance(60 * 60_000);
    expect(h.pings).toEqual([]);
  });

  it('will not reload the same service again inside the cooldown', () => {
    const h = harness({ services: ['slack'] });
    h.monitor.wake('resume');
    h.clock.advance(DEFAULT_TUNING.graceMs);
    h.monitor.report('slack', snapshot({ lastActivityMs: 9e6 }));
    expect(h.reloads).toEqual(['slack']);

    h.monitor.wake('resume');
    h.clock.advance(DEFAULT_TUNING.graceMs);
    h.monitor.report('slack', snapshot({ lastActivityMs: 9e6 }));
    expect(h.reloads).toEqual(['slack']); // still one

    h.clock.advance(DEFAULT_TUNING.cooldownMs);
    h.monitor.wake('resume');
    h.clock.advance(DEFAULT_TUNING.graceMs);
    h.monitor.report('slack', snapshot({ lastActivityMs: 9e6 }));
    expect(h.reloads).toEqual(['slack', 'slack']);
  });

  it('says why it reloaded', () => {
    const h = harness({ services: ['slack'] });
    h.monitor.wake('resume');
    h.clock.advance(DEFAULT_TUNING.graceMs);
    h.monitor.report('slack', snapshot({ lastActivityMs: 240_000 }));
    expect(h.logs.join('\n')).toMatch(/reloading slack — nothing received for 240s/);
  });
});
