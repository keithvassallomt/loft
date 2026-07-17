import { describe, it, expect, vi } from 'vitest';

// rail.ts calls contextBridge.exposeInMainWorld at import time; outside Electron
// `electron` resolves to a path string, so the API objects are undefined and the
// import would throw. Mock it. (buildRailBridge itself takes an injected ipc below.)
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

import { buildRailBridge } from '../src/preload/rail';

function fakeIpc() {
  const sent: Array<[string, unknown]> = [];
  const listeners = new Map<string, (e: unknown, ...a: unknown[]) => void>();
  return {
    sent,
    listeners,
    send: (ch: string, payload: unknown) => { sent.push([ch, payload]); },
    on(ch: string, cb: (e: unknown, ...a: unknown[]) => void) { listeners.set(ch, cb); },
    removeListener(ch: string) { listeners.delete(ch); },
  };
}

describe('rail bridge', () => {
  it('sends select and menu on the expected channels', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    b.select('slack');
    b.menu('whatsapp');
    expect(ipc.sent).toEqual([['rail:select', 'slack'], ['rail:menu', 'whatsapp']]);
  });

  it('delivers state to the subscriber', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    const cb = vi.fn();
    b.onState(cb);
    ipc.listeners.get('rail:state')!(null, [{ id: 'slack' }]);
    expect(cb).toHaveBeenCalledWith([{ id: 'slack' }]);
  });

  it('unsubscribes so a re-render cannot stack duplicate listeners', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    const off = b.onState(vi.fn());
    off();
    expect(ipc.listeners.has('rail:state')).toBe(false);
  });
});
