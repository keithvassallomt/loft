import type { HealthSnapshot } from '../shared/health';

/**
 * Keep loaded services actually connected.
 *
 * The problem: after a standby/resume or a spell offline, a service's page is still there
 * and still committed to a real URL — so nothing in recovery.ts fires (that watches for a
 * page that never LOADED) — but its websocket is dead and the app never noticed. It sits
 * showing stale messages and a stale badge until the user thinks to press F5.
 *
 * Three parts, split so that all the judgement is testable and none of it is in index.ts:
 *   - `createWakeDetector` notices that we woke up or came back online.
 *   - `healthAction` decides, for one service, what to do about one snapshot.
 *   - `createLivenessMonitor` runs the rounds: ping everything, collect, act.
 *
 * Nothing here is app-specific: see HealthSnapshot for why.
 */

/** How the monitor came to be looking. Reported so the log says why a service reloaded. */
export type WakeReason = 'resume' | 'network' | 'clock-gap' | 'sweep';

export interface WakeDetectorDeps {
  /** Heartbeat period. Cheap — one Date.now() and one net.isOnline() per tick. */
  intervalMs: number;
  /**
   * How much later than `intervalMs` a tick may land before it counts as a sleep.
   *
   * The detector compares WALL CLOCK (`Date.now()`) across ticks, and it must, because
   * timers cannot see a suspend: Node's timers run off CLOCK_MONOTONIC, which is FROZEN
   * while a Linux machine is suspended, so a 15s timer armed before a four-hour sleep
   * fires 15s of awake-time after resume — on time, as far as the timer is concerned.
   * Only the wall clock shows the gap.
   */
  gapToleranceMs: number;
  now(): number;
  /** Chromium's own network state (`net.isOnline()`). */
  isOnline(): boolean;
  onWake(reason: WakeReason): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface WakeDetector {
  start(): void;
  stop(): void;
  /** Run one heartbeat now. Exposed for tests; the timer calls it otherwise. */
  tick(): void;
}

/**
 * Watch for the two things that leave a page connected to nothing: the machine slept, and
 * the network came back.
 *
 * Both are detected WITHOUT any new permission. That matters more than it looks: Electron's
 * `powerMonitor` resume event is implemented on Linux with a `PrepareForSleep` signal from
 * `org.freedesktop.login1`, and Loft's Flatpak has no `--talk-name` for that bus name — so
 * on the shipped build powerMonitor may simply never fire, silently. index.ts still
 * subscribes to it (it is free, and correct on deb/rpm/AppImage), but this clock-gap check
 * is the one that has to work, and it works everywhere.
 */
export function createWakeDetector(deps: WakeDetectorDeps): WakeDetector {
  let handle: unknown;
  let lastTick = deps.now();
  let wasOnline = deps.isOnline();
  let running = false;

  const tick = (): void => {
    const now = deps.now();
    const elapsed = now - lastTick;
    lastTick = now;

    // A backwards jump is an NTP correction, not a sleep; ignore it rather than reporting
    // a wake for it. A forwards jump could also be NTP — but "probe the services" is a
    // harmless thing to do about a clock correction, and missing a real resume is not.
    if (elapsed > deps.intervalMs + deps.gapToleranceMs) {
      deps.onWake('clock-gap');
    }

    const online = deps.isOnline();
    // Only the offline -> online edge. Going offline is not a moment to reload anything:
    // there is nothing to reload to.
    if (online && !wasOnline) deps.onWake('network');
    wasOnline = online;

    if (running) handle = deps.setTimer(tick, deps.intervalMs);
  };

  return {
    tick,
    start(): void {
      if (running) return;
      running = true;
      lastTick = deps.now();
      wasOnline = deps.isOnline();
      handle = deps.setTimer(tick, deps.intervalMs);
    },
    stop(): void {
      running = false;
      if (handle !== undefined) deps.clearTimer(handle);
      handle = undefined;
    },
  };
}

/**
 * What to do about one service, and WHY. The reason is not decoration: this runs unattended
 * and reloads pages out from under people, so every decision has to be able to explain
 * itself in a log line.
 */
export type HealthAction =
  /** Reload: the page is receiving nothing, or did not answer at all. */
  | 'reload'
  /** Making sound — a call. Never yank one. */
  | 'skip-audible'
  /** The user is part-way through typing. The one thing a reload really destroys. */
  | 'skip-draft'
  /** The page loaded moments ago; it has not had time to connect yet. */
  | 'skip-fresh'
  /** Reloaded recently. The backstop against a reload loop against a dead network. */
  | 'skip-cooldown'
  /** Receiving data. Nothing to do. */
  | 'healthy';

export interface HealthInput {
  /** The page's answer, or null when it did not answer within the probe timeout. */
  snapshot: HealthSnapshot | null;
  audible: boolean;
  /** Silence longer than this is stale. */
  staleAfterMs: number;
  /** A page younger than this is never judged — it is still connecting. */
  freshMs: number;
  now: number;
  lastReloadAt: number | null;
  cooldownMs: number;
}

export function healthAction(input: HealthInput): HealthAction {
  const { snapshot, audible, staleAfterMs, freshMs, now, lastReloadAt, cooldownMs } = input;

  // Cooldown first, and ahead of everything including the unresponsive case: if a service
  // is wedged for a reason a reload cannot fix (the network is down, the site is down), the
  // monitor must give up rather than reload it every round forever.
  if (lastReloadAt !== null && now - lastReloadAt < cooldownMs) return 'skip-cooldown';
  // A call is the one thing worth more than a fresh connection. Checked before the
  // no-answer case too — a page busy with WebRTC is exactly one that might miss a ping.
  if (audible) return 'skip-audible';

  // No answer at all: the renderer is wedged or gone. There is no draft to protect in a
  // page that cannot reply, and nothing else will rescue it.
  if (!snapshot) return 'reload';

  if (snapshot.uptimeMs < freshMs) return 'skip-fresh';
  if (snapshot.hasDraft) return 'skip-draft';

  // Nothing has EVER arrived, and the page is past its grace period — it never connected.
  if (snapshot.lastActivityMs === null) return 'reload';
  if (snapshot.lastActivityMs > staleAfterMs) return 'reload';
  return 'healthy';
}

export interface LivenessDeps {
  /** Every service with a live page right now, by id. */
  services(): string[];
  /** Ask a service's page for a snapshot. The answer arrives at report(). */
  ping(id: string): void;
  /** Is this service's page making sound (i.e. in a call)? */
  isAudible(id: string): boolean;
  reload(id: string): void;
  /** Chromium's network state (`net.isOnline()`). */
  isOnline(): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log(msg: string): void;
}

export interface LivenessTuning {
  /**
   * How long to let the apps put themselves right before judging them. Every one of these
   * web apps reconnects on its own most of the time, and a monitor that reloads before they
   * get the chance is worse than no monitor — it would turn every lid-open into six page
   * loads.
   */
  graceMs: number;
  /** How long to wait for a page to answer a ping before calling it unresponsive. */
  probeTimeoutMs: number;
  /** Silence longer than this, in a round triggered by a wake, is stale. */
  staleAfterWakeMs: number;
  /** Silence longer than this, in a routine sweep, is stale. Longer: no wake to blame. */
  staleAfterIdleMs: number;
  /** A page younger than this is still connecting. */
  freshMs: number;
  /** Minimum gap between two reloads of the same service. */
  cooldownMs: number;
  /** How often to sweep with no wake event at all. */
  sweepMs: number;
  /** How long to keep deferring a round while the network is still down, per wake. */
  offlineRetryMs: number;
  maxOfflineRetries: number;
}

export const DEFAULT_TUNING: LivenessTuning = {
  graceMs: 25_000,
  probeTimeoutMs: 5_000,
  // 90s: every app Loft hosts exchanges keepalives, presence or a /sync long-poll far more
  // often than this — seconds to tens of seconds — so silence this long after a wake means
  // the connection is gone. Generous enough that one slow reconnect is not a false positive.
  staleAfterWakeMs: 90_000,
  // The routine sweep has no wake to explain a quiet spell, so it demands much more silence
  // before acting. A false positive here reloads a page nobody asked about.
  staleAfterIdleMs: 6 * 60_000,
  freshMs: 30_000,
  cooldownMs: 5 * 60_000,
  sweepMs: 5 * 60_000,
  offlineRetryMs: 20_000,
  maxOfflineRetries: 15, // ~5 minutes of waiting for the network before giving up
};

export interface LivenessMonitor {
  start(): void;
  stop(): void;
  /** Something happened that could have left pages connected to nothing. */
  wake(reason: WakeReason): void;
  /** A page answered a ping. */
  report(id: string, snapshot: HealthSnapshot): void;
  /** Run a round now, skipping the grace period. Exposed for tests. */
  check(reason: WakeReason): void;
}

/**
 * The monitor proper: on a wake (or on the routine sweep) wait out the grace period, ping
 * every loaded service, and reload the ones that answer with silence — or do not answer.
 *
 * Rounds do not overlap. A second wake while one is pending only restarts the grace timer,
 * so a burst of signals (powerMonitor resume AND the clock gap AND the network edge, which
 * is the normal case for one lid-open) costs exactly one round.
 */
export function createLivenessMonitor(
  deps: LivenessDeps,
  tuning: LivenessTuning = DEFAULT_TUNING,
): LivenessMonitor {
  let pending: unknown;            // grace / offline-retry timer
  let probeTimer: unknown;         // this round's probe deadline
  let round: { reason: WakeReason; waiting: Set<string>; snapshots: Map<string, HealthSnapshot> } | undefined;
  let offlineRetries = 0;
  let sweepTimer: unknown;
  const lastReload = new Map<string, number>();
  let running = false;

  const clearPending = (): void => {
    if (pending !== undefined) deps.clearTimer(pending);
    pending = undefined;
  };

  const finish = (): void => {
    if (!round) return;
    const { reason, waiting, snapshots } = round;
    round = undefined;
    if (probeTimer !== undefined) { deps.clearTimer(probeTimer); probeTimer = undefined; }

    const staleAfterMs = reason === 'sweep' ? tuning.staleAfterIdleMs : tuning.staleAfterWakeMs;
    const now = deps.now();
    for (const id of snapshots.keys()) waiting.delete(id);

    // Everything probed this round: those that answered, plus those that did not.
    const ids = [...snapshots.keys(), ...waiting];
    for (const id of ids) {
      const snapshot = snapshots.get(id) ?? null;
      const action = healthAction({
        snapshot,
        audible: deps.isAudible(id),
        staleAfterMs,
        freshMs: tuning.freshMs,
        now,
        lastReloadAt: lastReload.get(id) ?? null,
        cooldownMs: tuning.cooldownMs,
      });
      if (action === 'reload') {
        lastReload.set(id, now);
        const why = snapshot === null
          ? 'no answer to the health ping'
          : snapshot.lastActivityMs === null
          ? 'nothing ever received'
          : `nothing received for ${Math.round(snapshot.lastActivityMs / 1000)}s`;
        deps.log(`Liveness (${reason}): reloading ${id} — ${why}`);
        deps.reload(id);
      } else if (action !== 'healthy') {
        deps.log(`Liveness (${reason}): leaving ${id} alone — ${action}`);
      }
    }
  };

  const check = (reason: WakeReason): void => {
    clearPending();
    // Nothing to reload TO. Wait for the network rather than burning the cooldown on
    // reloads that can only produce Chromium's error page.
    if (!deps.isOnline()) {
      if (offlineRetries >= tuning.maxOfflineRetries) {
        deps.log(`Liveness (${reason}): still offline after ${offlineRetries} retries — giving up until the next wake`);
        offlineRetries = 0;
        return;
      }
      offlineRetries += 1;
      pending = deps.setTimer(() => check(reason), tuning.offlineRetryMs);
      return;
    }
    offlineRetries = 0;

    const ids = deps.services();
    if (ids.length === 0) return;
    round = { reason, waiting: new Set(ids), snapshots: new Map() };
    for (const id of ids) deps.ping(id);
    // One deadline for the whole round rather than one timer per service: the answers come
    // back within milliseconds when they come back at all, and a single timer cannot leak.
    probeTimer = deps.setTimer(finish, tuning.probeTimeoutMs);
  };

  const scheduleSweep = (): void => {
    if (!running) return;
    sweepTimer = deps.setTimer(() => {
      scheduleSweep();
      if (round === undefined && pending === undefined) wakeInternal('sweep');
    }, tuning.sweepMs);
  };

  const wakeInternal = (reason: WakeReason): void => {
    // A round already running keeps going; a burst of wakes just re-arms the grace timer,
    // which is what collapses "resume + clock-gap + network back" into one round.
    if (round !== undefined) return;
    clearPending();
    offlineRetries = 0;
    if (reason !== 'sweep') deps.log(`Liveness: ${reason} — checking services in ${Math.round(tuning.graceMs / 1000)}s`);
    pending = deps.setTimer(() => check(reason), tuning.graceMs);
  };

  return {
    check,
    start(): void {
      if (running) return;
      running = true;
      scheduleSweep();
    },
    stop(): void {
      running = false;
      clearPending();
      if (probeTimer !== undefined) { deps.clearTimer(probeTimer); probeTimer = undefined; }
      if (sweepTimer !== undefined) { deps.clearTimer(sweepTimer); sweepTimer = undefined; }
      round = undefined;
    },
    wake: wakeInternal,
    report(id, snapshot): void {
      if (!round || !round.waiting.has(id)) return; // a late or unsolicited answer
      round.snapshots.set(id, snapshot);
      round.waiting.delete(id);
      // Everyone answered — act now instead of sitting out the rest of the deadline.
      if (round.waiting.size === 0) {
        round.waiting = new Set(); // finish() re-reads this; keep it consistent
        finish();
      }
    },
  };
}
