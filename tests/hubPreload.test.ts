import { describe, it, expect, vi } from 'vitest';

// hub.ts calls contextBridge.exposeInMainWorld at import time; outside Electron
// `electron` resolves to a path string, so the API objects are undefined and the
// import would throw. Mock it. (buildBridge itself takes an injected ipc below.)
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

import { buildBridge } from '../src/preload/hub';

function mockIpc() {
  return {
    invoke: vi.fn().mockResolvedValue({ services: [], globals: { trayBackend: 'auto', autostartBlocked: false } }),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

describe('hub preload bridge', () => {
  it('getState invokes hub:getState', async () => {
    const ipc = mockIpc();
    await buildBridge(ipc as never).getState();
    expect(ipc.invoke).toHaveBeenCalledWith('hub:getState');
  });

  it('actions send the right channels + payloads', () => {
    const ipc = mockIpc();
    const b = buildBridge(ipc as never);
    b.openService('slack');
    b.addService('talk', 'https://cloud.example.com/apps/spreed/');
    b.removeService('slack', true);
    b.setServiceSetting('slack', { dnd: true });
    b.setGlobal({ trayBackend: 'sni' });
    b.recoverService('slack', { clearCaches: true });
    b.quit();
    expect(ipc.send).toHaveBeenCalledWith('hub:openService', 'slack');
    expect(ipc.send).toHaveBeenCalledWith('hub:addService', { id: 'talk', customUrl: 'https://cloud.example.com/apps/spreed/' });
    expect(ipc.send).toHaveBeenCalledWith('hub:removeService', { id: 'slack', deleteData: true });
    expect(ipc.send).toHaveBeenCalledWith('hub:setServiceSetting', { id: 'slack', patch: { dnd: true } });
    expect(ipc.send).toHaveBeenCalledWith('hub:setGlobal', { trayBackend: 'sni' });
    expect(ipc.send).toHaveBeenCalledWith('hub:recoverService', { id: 'slack', opts: { clearCaches: true } });
    expect(ipc.send).toHaveBeenCalledWith('hub:quit');
  });

  it('onStateChanged subscribes and returns an unsubscribe', () => {
    const ipc = mockIpc();
    const cb = vi.fn();
    const off = buildBridge(ipc as never).onStateChanged(cb);
    expect(ipc.on).toHaveBeenCalledWith('hub:state', expect.any(Function));
    // simulate a push
    const handler = ipc.on.mock.calls[0][1] as (e: unknown, s: unknown) => void;
    handler({}, { services: [], globals: { trayBackend: 'auto', autostartBlocked: false } });
    expect(cb).toHaveBeenCalledOnce();
    off();
    expect(ipc.removeListener).toHaveBeenCalledWith('hub:state', expect.any(Function));
  });
});
