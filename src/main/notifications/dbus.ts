import * as dbus from 'dbus-next';

import { nextBackoff } from '../dbusRetry';

const BUS = 'org.freedesktop.Notifications';
const PATH = '/org/freedesktop/Notifications';

/** Build the `a{sv}` hints dict for `Notify`. Port of the `hints` map in notifications.rs. */
export function buildHints(o: { imagePath?: string; desktopEntry: string }): Record<string, unknown> {
  const hints: Record<string, unknown> = { 'desktop-entry': new dbus.Variant('s', o.desktopEntry) };
  if (o.imagePath) hints['image-path'] = new dbus.Variant('s', o.imagePath);
  return hints;
}

/** Build the positional `Notify` args in the exact order/shape notifications.rs sends. */
export function buildNotifyArgs(p: {
  appName: string;
  appIcon: string;
  summary: string;
  body: string;
  hints: Record<string, unknown>;
}): unknown[] {
  return [p.appName, 0, p.appIcon, p.summary, p.body, ['default', 'Open'], p.hints, -1];
}

export interface NotifyParams {
  appName: string;
  appIcon: string;
  summary: string;
  body: string;
  imagePath?: string;
  desktopEntry?: string;
}

export interface NotificationServer {
  notify(p: NotifyParams): Promise<number>;
  onActionDefault(cb: (id: number) => void): void;
}

/** The only part of the notification server's interface this module uses. */
export interface NotifyInterface {
  Notify(...a: unknown[]): Promise<number>;
  on(ev: 'ActionInvoked', cb: (id: number, action: string) => void): void;
  on(ev: 'NotificationClosed', cb: (id: number, reason: number) => void): void;
}

export interface NotificationServerDeps {
  /** Bind the server's interface. MUST reject while the bus name has no owner. */
  bind(): Promise<NotifyInterface>;
  /** Subscribe to bus-name ownership changes, so a server that appears late is picked up
   *  at the moment it arrives rather than at the end of the backoff. */
  onNameOwnerChanged(cb: (name: string, newOwner: string) => void): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  log(msg: string, err?: unknown): void;
}

/**
 * The notification client's connection state machine, separated from the live bus so the
 * retry can be tested without one.
 *
 * WHY THIS RETRIES AT ALL. `getProxyObject` introspects the destination, so it fails whenever
 * `org.freedesktop.Notifications` has no owner yet — and the old code took that single failure
 * as final, leaving `server` undefined and every notification silently dropped for the rest of
 * the session. That is not a hypothetical: measured on a Hyprland/Caelestia login
 * (2026-09-09), Loft started at 07:15:57, the shell restarted itself at 07:16:00.455, and
 * Loft's one attempt landed at 07:16:01.114 — inside the ~100ms gap, where the broker tried
 * to activate a masked swaync and returned an error. Badges and the in-page ding kept working
 * all day, so the only symptom was notifications that never appeared. The tray had already
 * been given this exact cure for StatusNotifierWatcher; the notification client had not.
 *
 * ONE successful bind is kept for the process lifetime, deliberately. dbus-next addresses
 * method calls to the well-known name and filters signals against the owner it tracks from
 * NameOwnerChanged, so a server that later restarts is followed with no rebind. Rebinding
 * would be an outright bug: the previous proxy's ActionInvoked listener stays attached, and
 * every banner click would route twice.
 */
export function createNotificationServer(deps: NotificationServerDeps): NotificationServer {
  const actionCbs: Array<(id: number) => void> = [];
  let iface: NotifyInterface | null = null;
  let inFlight: Promise<NotifyInterface | null> | null = null;
  let attempt = 0;
  let timer: unknown;

  const cancelRetry = (): void => {
    if (timer === undefined) return;
    deps.clearTimer(timer);
    timer = undefined;
  };

  const attach = (i: NotifyInterface): NotifyInterface => {
    i.on('ActionInvoked', (id, action) => {
      // Fires for every notification on the bus (other apps share it); the caller filters by
      // the ids it actually sent (parity with sent_ids() in notifications.rs).
      if (action === 'default') for (const cb of actionCbs) cb(id);
    });
    i.on('NotificationClosed', (id, reason) => {
      // Logged only - do NOT remove tracking here. It races ActionInvoked and removing on
      // close can cause a click's ActionInvoked to find nothing.
      void id;
      void reason;
    });
    return i;
  };

  const bind = async (): Promise<NotifyInterface | null> => {
    if (iface) return iface;
    if (inFlight) return inFlight;
    inFlight = (async (): Promise<NotifyInterface | null> => {
      try {
        const bound = attach(await deps.bind());
        iface = bound;
        cancelRetry();
        if (attempt > 0) deps.log(`connected to ${BUS} after ${attempt} failed attempt(s)`);
        attempt = 0;
        return bound;
      } catch (err) {
        deps.log(`${BUS} not available yet; will retry`, err);
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const tryBind = async (): Promise<void> => {
    if (iface) return;
    if (await bind()) return;
    cancelRetry();
    timer = deps.setTimer(() => { timer = undefined; void tryBind(); }, nextBackoff(attempt++) * 1000);
  };

  deps.onNameOwnerChanged((name, newOwner) => {
    // Only while unbound: an owner change on an established proxy is followed by dbus-next
    // itself, and re-binding there would double every click.
    if (name !== BUS || !newOwner || iface) return;
    attempt = 0;
    void tryBind();
  });

  void tryBind();

  return {
    async notify(p: NotifyParams): Promise<number> {
      // One more attempt on the way past: a real message is worth not waiting out the rest
      // of the backoff for, and it covers a NameOwnerChanged we were not yet subscribed for.
      const i = iface ?? await bind();
      if (!i) throw new Error(`${BUS} is not available`);
      const hints = buildHints({ imagePath: p.imagePath, desktopEntry: p.desktopEntry ?? 'chat.loft.Loft' });
      const args = buildNotifyArgs({
        appName: p.appName,
        appIcon: p.appIcon,
        summary: p.summary,
        body: p.body,
        hints,
      });
      return i.Notify(...args);
    },
    onActionDefault(cb: (id: number) => void): void {
      actionCbs.push(cb);
    },
  };
}

/**
 * Persistent connection to the freedesktop notification server (port of
 * `src/daemon/notifications.rs`). KDE closes notifications when the sender
 * disconnects, so the bus connection is kept alive for the process lifetime
 * rather than using Electron's built-in `Notification` (which does not expose
 * this control) - this is a `dbus-next` client proxy, verified against
 * `node_modules/dbus-next` 0.10.2: `bus.getProxyObject` introspects the
 * server and returns a `ProxyInterface` whose advertised methods become
 * plain async functions (`Notify` resolves the single `u` return value
 * directly, since `ProxyObject#_callMethod` unwraps a single-element output
 * signature) and whose advertised signals are re-emitted as EventEmitter
 * events (`iface.on('ActionInvoked', ...)`).
 *
 * Resolves as soon as the SESSION BUS is reachable, without waiting for the notification
 * server to exist - binding to it is retried in the background (see createNotificationServer).
 * Only a missing session bus rejects here, because that is the one failure nothing can
 * recover from.
 */
export async function connectNotificationServer(): Promise<NotificationServer> {
  const bus = dbus.sessionBus();
  // org.freedesktop.DBus is the bus itself: it is always owned, so this cannot lose the race
  // the notification server can. Subscribing also installs the NameOwnerChanged match rule
  // dbus-next needs to keep its owner table current, which is what lets an established proxy
  // survive a shell restart.
  const dbusObj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
  const dbusIface = dbusObj.getInterface('org.freedesktop.DBus');

  return createNotificationServer({
    bind: async () => {
      const obj = await bus.getProxyObject(BUS, PATH);
      return obj.getInterface(BUS) as unknown as NotifyInterface;
    },
    onNameOwnerChanged: (cb) => {
      dbusIface.on('NameOwnerChanged', (name: string, _old: string, next: string) => cb(name, next));
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    log: (msg, err) => (err === undefined ? console.log(`Loft: ${msg}`) : console.debug(`Loft: ${msg}:`, (err as Error)?.message ?? err)),
  });
}
