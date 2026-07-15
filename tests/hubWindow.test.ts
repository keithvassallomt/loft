import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture ipcMain registrations against a mock Electron.
const handlers = new Map<string, (...a: unknown[]) => unknown>();
const listeners = new Map<string, (...a: unknown[]) => void>();
const sent: Array<{ channel: string; arg: unknown }> = [];

vi.mock('electron', () => {
  const win = {
    isDestroyed: () => false,
    loadFile: vi.fn(),
    focus: vi.fn(),
    show: vi.fn(),
    on: vi.fn(),
    webContents: { send: (channel: string, arg: unknown) => sent.push({ channel, arg }) },
  };
  return {
    ipcMain: {
      handle: (c: string, fn: (...a: unknown[]) => unknown) => handlers.set(c, fn),
      removeHandler: (c: string) => handlers.delete(c),
      on: (c: string, fn: (...a: unknown[]) => void) => listeners.set(c, fn),
      removeAllListeners: (c: string) => listeners.delete(c),
    },
    // Note: must be a `function`, not an arrow function — vitest's mock can only be
    // invoked with `new` (as hubWindow.ts does) when the implementation is constructible.
    BrowserWindow: vi.fn(function () { return win; }),
  };
});

import { createHub, type HubDeps } from '../src/main/hubWindow';

function deps(over: Partial<HubDeps> = {}): HubDeps {
  return {
    buildState: () => ({ services: [], globals: { trayBackend: 'auto', startAtLogin: false } }),
    openService: vi.fn(), addService: vi.fn(), removeService: vi.fn(),
    setServiceSetting: vi.fn(), setGlobal: vi.fn(), recoverService: vi.fn(), quitApp: vi.fn(),
    preloadPath: '/p', htmlPath: '/h', iconPath: '/i',
    ...over,
  };
}

beforeEach(() => { handlers.clear(); listeners.clear(); sent.length = 0; });

describe('createHub', () => {
  it('getState handler returns buildState()', async () => {
    createHub(deps());
    const state = await handlers.get('hub:getState')!();
    expect(state).toEqual({ services: [], globals: { trayBackend: 'auto', startAtLogin: false } });
  });

  it('openService listener dispatches to the dep', () => {
    const openService = vi.fn();
    createHub(deps({ openService }));
    listeners.get('hub:openService')!({}, 'slack');
    expect(openService).toHaveBeenCalledWith('slack');
  });

  it('addService dispatches id + customUrl', () => {
    const addService = vi.fn();
    createHub(deps({ addService }));
    listeners.get('hub:addService')!({}, { id: 'talk', customUrl: 'https://x' });
    expect(addService).toHaveBeenCalledWith('talk', 'https://x');
  });

  it('recoverService dispatches id + opts', () => {
    const recoverService = vi.fn();
    createHub(deps({ recoverService }));
    listeners.get('hub:recoverService')!({}, { id: 'slack', opts: { clearCaches: true } });
    expect(recoverService).toHaveBeenCalledWith('slack', { clearCaches: true });
  });

  it('open() then notifyChanged() pushes hub:state', () => {
    const hub = createHub(deps());
    hub.open();
    hub.notifyChanged();
    expect(sent.some((m) => m.channel === 'hub:state')).toBe(true);
  });
});
