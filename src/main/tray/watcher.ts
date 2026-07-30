import * as dbus from 'dbus-next';

export const WATCHER_BACKOFF_SECONDS = [0, 2, 4, 8, 16] as const;

/** Retry delay (seconds) for the Nth StatusNotifierWatcher registration attempt; holds at the max. */
export function nextBackoff(attempt: number): number {
  return WATCHER_BACKOFF_SECONDS[Math.min(attempt, WATCHER_BACKOFF_SECONDS.length - 1)];
}

const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';
const WATCHER_PATH = '/StatusNotifierWatcher';

export interface SniExports {
  sniPath: string;
  sni: dbus.interface.Interface;
  menuPath: string;
  menu: dbus.interface.Interface;
}

export interface SniHandle {
  bus: dbus.MessageBus;
}

/**
 * Export the SNI + dbusmenu objects on this connection's unique bus name and
 * register the SNI object path with StatusNotifierWatcher, retrying on the
 * ksni-proven [0,2,4,8,16]s schedule (the watcher may not exist yet at login)
 * and re-registering when it reappears.
 *
 * Passing the object path is the sandbox-safe form of
 * RegisterStatusNotifierItem: the watcher associates it with the caller's
 * unique bus name. Do not request an org.kde.StatusNotifierItem-<pid>-* name
 * here — Flatpak cannot grant ownership of that dynamic name.
 */
export async function connectSni(exp: SniExports): Promise<SniHandle> {
  const bus = dbus.sessionBus();
  bus.export(exp.sniPath, exp.sni);
  bus.export(exp.menuPath, exp.menu);

  const register = async (): Promise<boolean> => {
    try {
      const obj = await bus.getProxyObject(WATCHER_NAME, WATCHER_PATH);
      const iface = obj.getInterface(WATCHER_NAME) as unknown as {
        RegisterStatusNotifierItem(service: string): Promise<void>;
      };
      await iface.RegisterStatusNotifierItem(exp.sniPath);
      return true;
    } catch {
      return false;
    }
  };

  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const tryRegister = async (): Promise<void> => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    if (await register()) {
      attempt = 0;
      return;
    }
    const delay = nextBackoff(attempt++);
    retryTimer = setTimeout(() => void tryRegister(), delay * 1000);
  };
  await tryRegister();

  // Re-register when the watcher (re)appears on the bus (e.g. GNOME shell restart / suspend).
  // Use the same backoff schedule — a single attempt can lose the race if the name is
  // owned a beat before RegisterStatusNotifierItem is served, and then never retry.
  const dbusObj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
  const dbusIface = dbusObj.getInterface('org.freedesktop.DBus');
  dbusIface.on('NameOwnerChanged', (name: string, _old: string, next: string) => {
    if (name === WATCHER_NAME && next) {
      attempt = 0;
      void tryRegister();
    }
  });

  return { bus };
}
