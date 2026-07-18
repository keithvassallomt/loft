import { describe, it, expect, vi } from 'vitest';
import { registerHubIpc, type HubIpcDeps } from '../src/main/hubIpc';

function fakeIpc() {
  const handlers = new Map<string, (...a: any[]) => any>();
  return {
    handlers,
    handle: (ch: string, cb: (...a: any[]) => any) => handlers.set(ch, cb),
    on: (ch: string, cb: (...a: any[]) => any) => handlers.set(ch, cb),
    fire: (ch: string, ...args: any[]) => handlers.get(ch)!({}, ...args),
  };
}

function deps(over: Partial<HubIpcDeps> = {}): HubIpcDeps {
  return {
    getState: vi.fn().mockReturnValue({ services: [], globals: { trayBackend: 'auto', autostartBlocked: false } }),
    openService: vi.fn(),
    addService: vi.fn(),
    removeService: vi.fn(),
    setServiceSetting: vi.fn(),
    setGlobal: vi.fn(),
    recoverService: vi.fn(),
    quit: vi.fn(),
    ...over,
  };
}

describe('registerHubIpc', () => {
  it('hub:getState returns deps.getState()', () => {
    const d = deps(); const ipc = fakeIpc();
    registerHubIpc(ipc as never, d);
    expect(ipc.fire('hub:getState')).toEqual({ services: [], globals: { trayBackend: 'auto', autostartBlocked: false } });
    expect(d.getState).toHaveBeenCalled();
  });

  it('routes each action channel to its dep with the unwrapped payload', () => {
    const d = deps(); const ipc = fakeIpc();
    registerHubIpc(ipc as never, d);
    ipc.fire('hub:openService', 'slack');
    ipc.fire('hub:addService', { id: 'talk', customUrl: 'x' });
    ipc.fire('hub:removeService', { id: 'slack', deleteData: true });
    ipc.fire('hub:setServiceSetting', { id: 'slack', patch: { dnd: true } });
    ipc.fire('hub:setGlobal', { trayBackend: 'sni' });
    ipc.fire('hub:recoverService', { id: 'slack', opts: { clearCaches: true } });
    ipc.fire('hub:quit');
    expect(d.openService).toHaveBeenCalledWith('slack');
    expect(d.addService).toHaveBeenCalledWith('talk', 'x');
    expect(d.removeService).toHaveBeenCalledWith('slack', true);
    expect(d.setServiceSetting).toHaveBeenCalledWith('slack', { dnd: true });
    expect(d.setGlobal).toHaveBeenCalledWith({ trayBackend: 'sni' });
    expect(d.recoverService).toHaveBeenCalledWith('slack', { clearCaches: true });
    expect(d.quit).toHaveBeenCalled();
  });
});
