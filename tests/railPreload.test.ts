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

  it('delivers rail state (items + managerActive) to the subscriber', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    const cb = vi.fn();
    b.onState(cb);
    const state = { items: [{ id: 'slack' }], managerActive: true };
    ipc.listeners.get('rail:state')!(null, state);
    expect(cb).toHaveBeenCalledWith(state);
  });

  it('showManager asks main to open the manager', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    b.showManager();
    expect(ipc.sent).toEqual([['rail:showManager', undefined]]);
  });

  it('showGrid asks main to open the grid', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    b.showGrid();
    expect(ipc.sent).toEqual([['rail:showGrid', undefined]]);
  });

  it('unsubscribes so a re-render cannot stack duplicate listeners', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    const off = b.onState(vi.fn());
    off();
    expect(ipc.listeners.has('rail:state')).toBe(false);
  });
});

describe('rail bridge — drag channels', () => {
  it('sends drag geometry, movement, end and cross-window drop', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    const slots = [{ id: 'slack', top: 50, height: 34 }];
    b.dragBegin(slots, 'slack');
    b.dragMove(10, 120);
    b.dragEnd('slack', -140, 120);
    b.dropAttach('slack', 96);
    expect(ipc.sent).toEqual([
      ['rail:dragBegin', { slots, id: 'slack' }],
      ['rail:dragMove', { clientX: 10, clientY: 120 }],
      ['rail:dragEnd', { id: 'slack', releaseX: -140, releaseY: 120 }],
      ['rail:dropAttach', { id: 'slack', clientY: 96 }],
    ]);
  });

  it('omits the id for the cross-window drag, which does not know it yet', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    const slots = [{ id: 'slack', top: 50, height: 34 }];
    b.dragBegin(slots);
    expect(ipc.sent).toEqual([['rail:dragBegin', { slots, id: undefined }]]);
  });

  it('sends dragCancel so an aborted gesture cannot strand the drop preview', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    b.dragCancel();
    expect(ipc.sent).toEqual([['rail:dragCancel', undefined]]);
  });

  it('delivers the drop-slot index and unsubscribes cleanly', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    const cb = vi.fn();
    const off = b.onDropSlot(cb);
    ipc.listeners.get('rail:dropSlot')!(null, 2);
    expect(cb).toHaveBeenCalledWith(2);
    off();
    expect(ipc.listeners.has('rail:dropSlot')).toBe(false);
  });
});
