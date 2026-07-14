import * as dbus from 'dbus-next';

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

/**
 * Persistent connection to the freedesktop notification server (port of
 * `src/daemon/notifications.rs`). KDE closes notifications when the sender
 * disconnects, so the bus connection is kept alive for the process lifetime
 * rather than using Electron's built-in `Notification` (which does not expose
 * this control) — this is a `dbus-next` client proxy, verified against
 * `node_modules/dbus-next` 0.10.2: `bus.getProxyObject` introspects the
 * server and returns a `ProxyInterface` whose advertised methods become
 * plain async functions (`Notify` resolves the single `u` return value
 * directly, since `ProxyObject#_callMethod` unwraps a single-element output
 * signature) and whose advertised signals are re-emitted as EventEmitter
 * events (`iface.on('ActionInvoked', ...)`).
 */
export async function connectNotificationServer(): Promise<NotificationServer> {
  const bus = dbus.sessionBus();
  const obj = await bus.getProxyObject(BUS, PATH);
  const iface = obj.getInterface(BUS) as unknown as {
    Notify(...a: unknown[]): Promise<number>;
    on(ev: 'ActionInvoked', cb: (id: number, action: string) => void): void;
    on(ev: 'NotificationClosed', cb: (id: number, reason: number) => void): void;
  };

  const actionCbs: Array<(id: number) => void> = [];
  iface.on('ActionInvoked', (id, action) => {
    // Fires for every notification on the bus (other apps share it); the
    // caller filters by the ids it actually sent (parity with sent_ids() in
    // notifications.rs).
    if (action === 'default') for (const cb of actionCbs) cb(id);
  });
  iface.on('NotificationClosed', (id, reason) => {
    // Logged only — do NOT remove tracking here. It races ActionInvoked and
    // removing on close can cause a click's ActionInvoked to find nothing.
    void id;
    void reason;
  });

  return {
    async notify(p: NotifyParams): Promise<number> {
      const hints = buildHints({ imagePath: p.imagePath, desktopEntry: p.desktopEntry ?? 'chat.loft.Loft' });
      const args = buildNotifyArgs({
        appName: p.appName,
        appIcon: p.appIcon,
        summary: p.summary,
        body: p.body,
        hints,
      });
      return iface.Notify(...args);
    },
    onActionDefault(cb: (id: number) => void): void {
      actionCbs.push(cb);
    },
  };
}
