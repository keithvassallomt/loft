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
  busName: string;
  bus: dbus.MessageBus;
}

/**
 * Export the SNI + dbusmenu objects on a unique bus name and register with
 * StatusNotifierWatcher, retrying on the ksni-proven [0,2,4,8,16]s schedule (the
 * watcher may not exist yet at login) and re-registering when it reappears.
 */
export async function connectSni(exp: SniExports): Promise<SniHandle> {
  const bus = dbus.sessionBus();
  const busName = `org.kde.StatusNotifierItem-${process.pid}-1`;
  await bus.requestName(busName, 0);
  bus.export(exp.sniPath, exp.sni);
  bus.export(exp.menuPath, exp.menu);

  const register = async (): Promise<boolean> => {
    try {
      const obj = await bus.getProxyObject(WATCHER_NAME, WATCHER_PATH);
      const iface = obj.getInterface(WATCHER_NAME) as unknown as {
        RegisterStatusNotifierItem(service: string): Promise<void>;
      };
      await iface.RegisterStatusNotifierItem(busName);
      return true;
    } catch {
      return false;
    }
  };

  let attempt = 0;
  const tryRegister = async (): Promise<void> => {
    if (await register()) return;
    const delay = nextBackoff(attempt++);
    setTimeout(() => void tryRegister(), delay * 1000);
  };
  await tryRegister();

  // Re-register when the watcher (re)appears on the bus (e.g. GNOME shell restart / suspend).
  const dbusObj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
  const dbusIface = dbusObj.getInterface('org.freedesktop.DBus');
  dbusIface.on('NameOwnerChanged', (name: string, _old: string, next: string) => {
    if (name === WATCHER_NAME && next) {
      attempt = 0;
      void register();
    }
  });

  return { busName, bus };
}
