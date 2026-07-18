import type { IpcMain } from 'electron';
import type { HubState, ServicePatch, GlobalPatch, RecoverOpts } from '../shared/hubTypes';

/** What the hub:* handlers need. Each value is the fully-formed operation, so this module
 *  stays a thin registrar and remains importable under vitest (index.ts is not). Channel
 *  names + payload shapes are the renderer's contract (src/preload/hub.ts) — keep in step. */
export interface HubIpcDeps {
  getState(): HubState;
  openService(id: string): void;
  addService(id: string, customUrl: string | undefined): void;
  removeService(id: string, deleteData: boolean): void;
  setServiceSetting(id: string, patch: ServicePatch): void;
  setGlobal(patch: GlobalPatch): void;
  recoverService(id: string, opts: RecoverOpts): void;
  quit(): void;
}

export function registerHubIpc(ipc: Pick<IpcMain, 'handle' | 'on'>, deps: HubIpcDeps): void {
  ipc.handle('hub:getState', () => deps.getState());
  ipc.on('hub:openService', (_e, id: string) => deps.openService(id));
  ipc.on('hub:addService', (_e, m: { id: string; customUrl?: string }) => deps.addService(m.id, m.customUrl));
  ipc.on('hub:removeService', (_e, m: { id: string; deleteData: boolean }) => deps.removeService(m.id, m.deleteData));
  ipc.on('hub:setServiceSetting', (_e, m: { id: string; patch: ServicePatch }) => deps.setServiceSetting(m.id, m.patch));
  ipc.on('hub:setGlobal', (_e, patch: GlobalPatch) => deps.setGlobal(patch));
  ipc.on('hub:recoverService', (_e, m: { id: string; opts: RecoverOpts }) => deps.recoverService(m.id, m.opts));
  ipc.on('hub:quit', () => deps.quit());
}
