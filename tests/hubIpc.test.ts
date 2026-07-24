import { describe, it, expect, vi } from 'vitest';
import { registerHubIpc, type HubIpcDeps } from '../src/main/hubIpc';

function fakeIpc() {
  const handlers = new Map<string, (...a: any[]) => any>();
  return {
    handlers,
    handle: (ch: string, cb: (...a: any[]) => any) => handlers.set(ch, cb),
    on: (ch: string, cb: (...a: any[]) => any) => handlers.set(ch, cb),
    fire: (ch: string, ...args: any[]) => handlers.get(ch)!({}, ...args),
    emit: (ch: string, ...args: any[]) => handlers.get(ch)!({}, ...args),
    invokeHandler: (ch: string, ...args: any[]) => handlers.get(ch)!({}, ...args),
  };
}

function deps(over: Partial<HubIpcDeps> = {}): HubIpcDeps {
  return {
    getState: vi.fn().mockReturnValue({ services: [], kinds: [], globals: { trayBackend: 'auto', autostartBlocked: false } }),
    openService: vi.fn(),
    addService: vi.fn(),
    removeService: vi.fn(),
    setServiceSetting: vi.fn(),
    renameService: vi.fn(async () => ({ ok: false, error: 'not implemented' })),
    setServiceIcon: vi.fn(async () => ({ ok: false, error: 'not implemented' })),
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
    expect(ipc.fire('hub:getState')).toEqual({ services: [], kinds: [], globals: { trayBackend: 'auto', autostartBlocked: false } });
    expect(d.getState).toHaveBeenCalled();
  });

  it('routes each action channel to its dep with the unwrapped payload', () => {
    const d = deps(); const ipc = fakeIpc();
    registerHubIpc(ipc as never, d);
    ipc.fire('hub:openService', 'slack');
    ipc.fire('hub:addService', { kind: 'talk', customUrl: 'x' });
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

  it('passes a KIND to addService, and returns rename and icon results', async () => {
    const calls: string[] = [];
    const ipc = fakeIpc();
    registerHubIpc(ipc as never, {
      ...deps(),
      addService: (kind, url) => { calls.push(`add:${kind}:${url ?? ''}`); },
      renameService: async (id, name) => { calls.push(`rename:${id}:${name}`); return { ok: true }; },
      setServiceIcon: async (id, choice) => { calls.push(`icon:${id}:${choice}`); return { ok: false, error: 'nope' }; },
    });
    ipc.emit('hub:addService', { kind: 'whatsapp', customUrl: 'https://x' });
    expect(await ipc.invokeHandler('hub:renameService', { id: 'whatsapp', name: 'Work' })).toEqual({ ok: true });
    expect(await ipc.invokeHandler('hub:setServiceIcon', { id: 'whatsapp', choice: 'rose' }))
      .toEqual({ ok: false, error: 'nope' });
    expect(calls).toEqual(['add:whatsapp:https://x', 'rename:whatsapp:Work', 'icon:whatsapp:rose']);
  });
});
