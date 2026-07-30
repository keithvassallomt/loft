import { describe, it, expect, vi } from 'vitest';
import * as dbus from 'dbus-next';
import { WATCHER_BACKOFF_SECONDS, connectSni, nextBackoff } from '../src/main/tray/watcher';

vi.mock('dbus-next', () => ({ sessionBus: vi.fn() }));

describe('watcher backoff', () => {
  it('follows the ksni-proven schedule then holds at the max', () => {
    expect(WATCHER_BACKOFF_SECONDS).toEqual([0, 2, 4, 8, 16]);
    expect([0, 1, 2, 3, 4, 5].map(nextBackoff)).toEqual([0, 2, 4, 8, 16, 16]);
  });
});

describe('connectSni', () => {
  it('registers by object path without requesting a sandbox-forbidden bus name', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const watchNameOwners = vi.fn();
    const getProxyObject = vi.fn(async (name: string) => ({
      getInterface: () =>
        name === 'org.kde.StatusNotifierWatcher'
          ? { RegisterStatusNotifierItem: register }
          : { on: watchNameOwners },
    }));
    const exportObject = vi.fn();
    const bus = { export: exportObject, getProxyObject };
    vi.mocked(dbus.sessionBus).mockReturnValue(bus as unknown as dbus.MessageBus);

    const sni = {} as dbus.interface.Interface;
    const menu = {} as dbus.interface.Interface;
    const handle = await connectSni({
      sniPath: '/StatusNotifierItem',
      sni,
      menuPath: '/MenuBar',
      menu,
    });

    expect(exportObject).toHaveBeenCalledWith('/StatusNotifierItem', sni);
    expect(exportObject).toHaveBeenCalledWith('/MenuBar', menu);
    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith('/StatusNotifierItem');
    expect(handle).toEqual({ bus });
  });
});
