import { describe, it, expect, vi } from 'vitest';

// grid.ts calls contextBridge.exposeInMainWorld at import time; outside Electron
// `electron` resolves to a path string, so the API objects are undefined and the import
// would throw. Mock it. (buildGridBridge itself takes an injected ipc below.)
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

import { buildGridBridge } from '../src/preload/grid';

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

describe('grid bridge', () => {
  it('names the split a gutter drag resizes, then reports the pointer', () => {
    const ipc = fakeIpc();
    const b = buildGridBridge(ipc as never);
    b.gutterDragBegin('ab', 'row');
    b.dragMove(120, 240);
    b.dragEnd(130, 240);
    expect(ipc.sent).toEqual([
      ['grid:gutterDragBegin', { path: 'ab', dir: 'row' }],
      ['grid:dragMove', { x: 120, y: 240 }],
      ['grid:dragEnd', { x: 130, y: 240 }],
    ]);
  });

  it('names the dragged service on a cell drag, then shares the same move/end channels', () => {
    // Which gesture is running is decided by the begin main last saw — the moves carry no
    // kind — so a cell drag that began on the wrong channel would silently be resolved as a
    // resize (or as nothing at all).
    const ipc = fakeIpc();
    const b = buildGridBridge(ipc as never);
    b.cellDragBegin('slack');
    b.dragMove(400, 120);
    b.dragEnd(410, 130);
    expect(ipc.sent).toEqual([
      ['grid:cellDragBegin', 'slack'],
      ['grid:dragMove', { x: 400, y: 120 }],
      ['grid:dragEnd', { x: 410, y: 130 }],
    ]);
  });

  it('sends dragCancel so an aborted gesture cannot go on resizing on every hover', () => {
    const ipc = fakeIpc();
    const b = buildGridBridge(ipc as never);
    b.dragCancel();
    expect(ipc.sent).toEqual([['grid:dragCancel', undefined]]);
  });

  it('opens the ＋ menu on the titlebar’s own channel, not a second one', () => {
    // The empty state's ＋ and the titlebar's ＋ must be one behaviour. titlebar:addToGrid's
    // handler reads nothing off the sender, so reusing it is safe — and a new channel here
    // would be a second handler to keep in step.
    const ipc = fakeIpc();
    const b = buildGridBridge(ipc as never);
    b.addToGrid();
    expect(ipc.sent).toEqual([['titlebar:addToGrid', undefined]]);
  });

  it('unsubscribes so a re-render cannot stack duplicate state listeners', () => {
    const ipc = fakeIpc();
    const b = buildGridBridge(ipc as never);
    const off = b.onState(vi.fn());
    expect(ipc.listeners.has('grid:state')).toBe(true);
    off();
    expect(ipc.listeners.has('grid:state')).toBe(false);
  });
});
