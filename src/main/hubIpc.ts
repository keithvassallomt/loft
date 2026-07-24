import type { IpcMain } from 'electron';
import type { HubState, ServicePatch, GlobalPatch, RecoverOpts, OpResult } from '../shared/hubTypes';

/** What the hub:* handlers need. Each value is the fully-formed operation, so this module
 *  stays a thin registrar and remains importable under vitest (index.ts is not). Channel
 *  names + payload shapes are the renderer's contract (src/preload/hub.ts) — keep in step. */
export interface HubIpcDeps {
  getState(): HubState;
  openService(id: string): void;
  /** `kind` is a REGISTRY kind id; main allocates the instance id. */
  addService(kind: string, customUrl: string | undefined): void;
  removeService(id: string, deleteData: boolean): void;
  setServiceSetting(id: string, patch: ServicePatch): void;
  /** Can fail (the name must be unique), so it answers rather than fires and forgets. */
  renameService(id: string, name: string): Promise<OpResult>;
  /** `choice` is 'brand', a variant colour key, or 'custom' (which opens a file dialog). */
  setServiceIcon(id: string, choice: string): Promise<OpResult>;
  setGlobal(patch: GlobalPatch): void;
  recoverService(id: string, opts: RecoverOpts): void;
  quit(): void;
}

export function registerHubIpc(ipc: Pick<IpcMain, 'handle' | 'on'>, deps: HubIpcDeps): void {
  ipc.handle('hub:getState', () => deps.getState());
  ipc.on('hub:openService', (_e, id: string) => deps.openService(id));
  ipc.on('hub:addService', (_e, m: { kind: string; customUrl?: string }) => deps.addService(m.kind, m.customUrl));
  ipc.on('hub:removeService', (_e, m: { id: string; deleteData: boolean }) => deps.removeService(m.id, m.deleteData));
  ipc.on('hub:setServiceSetting', (_e, m: { id: string; patch: ServicePatch }) => deps.setServiceSetting(m.id, m.patch));
  ipc.handle('hub:renameService', (_e, m: { id: string; name: string }) => deps.renameService(m.id, m.name));
  ipc.handle('hub:setServiceIcon', (_e, m: { id: string; choice: string }) => deps.setServiceIcon(m.id, m.choice));
  ipc.on('hub:setGlobal', (_e, patch: GlobalPatch) => deps.setGlobal(patch));
  ipc.on('hub:recoverService', (_e, m: { id: string; opts: RecoverOpts }) => deps.recoverService(m.id, m.opts));
  ipc.on('hub:quit', () => deps.quit());
}
