// dbus-next API used here is verified against node_modules/dbus-next@0.10.2:
// `new dbus.Message({destination,path,interface,member,signature?,body?})`,
// `bus.call(msg): Promise<Message>`, `bus.getProxyObject`, `dbus.Variant`.
import * as dbus from 'dbus-next';

const NAME = 'chat.loft.ShellHelperNext';
const PATH = '/chat/loft/ShellHelperNext';
const IFACE = 'chat.loft.ShellHelperNext';

export interface ShellHelperClient {
  setLoftWindows(keys: string[]): Promise<void>;
  focusWindow(key: string): Promise<void>;
  hideWindow(key: string): Promise<void>;
  registerCombined(iconName: string): Promise<void>;
  unregisterCombined(): Promise<void>;
  updateCombinedService(
    name: string, displayName: string, visible: boolean, badge: number, dnd: boolean, key: string,
  ): Promise<void>;
  removeCombinedService(name: string): Promise<void>;
  onHelperAppeared(cb: () => void): void;
}

export function createShellHelperClient(): ShellHelperClient {
  const bus = dbus.sessionBus();

  // Fire-and-forget low-level call: build a Message, send it, swallow errors
  // (a missing/erroring helper must never crash or hang a window action).
  const call = (member: string, signature: string | undefined, body: unknown[]): Promise<void> => {
    const msg = new dbus.Message({
      destination: NAME, path: PATH, interface: IFACE, member,
      ...(signature ? { signature } : {}),
      ...(body.length ? { body } : {}),
    });
    return bus.call(msg).then(
      () => {},
      (e) => { console.debug(`ShellHelper.${member} failed:`, e?.message ?? e); },
    );
  };

  // Watch chat.loft.ShellHelper (re)appear on the bus (suspend/resume cycles
  // disable/enable the extension, destroying its panel button — Task 7 re-registers).
  const appearedCbs: Array<() => void> = [];
  void (async () => {
    try {
      const dbo = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
      const di = dbo.getInterface('org.freedesktop.DBus') as unknown as {
        on(ev: 'NameOwnerChanged', cb: (name: string, oldOwner: string, newOwner: string) => void): void;
      };
      di.on('NameOwnerChanged', (name, oldOwner, newOwner) => {
        if (name === NAME && oldOwner === '' && newOwner !== '') for (const cb of appearedCbs) cb();
      });
    } catch (e) {
      console.debug('ShellHelper NameOwnerChanged watch unavailable:', e);
    }
  })();

  return {
    setLoftWindows: (keys) => call('SetLoftWindows', 'as', [keys]),
    focusWindow: (key) => call('FocusWindow', 's', [key]),
    hideWindow: (key) => call('HideWindow', 's', [key]),
    registerCombined: (iconName) => call('RegisterCombined', 's', [iconName]),
    unregisterCombined: () => call('UnregisterCombined', undefined, []),
    updateCombinedService: (name, displayName, visible, badge, dnd, key) =>
      call('UpdateCombinedService', 'ssbubs', [name, displayName, visible, badge, dnd, key]),
    removeCombinedService: (name) => call('RemoveCombinedService', 's', [name]),
    onHelperAppeared: (cb) => { appearedCbs.push(cb); },
  };
}
