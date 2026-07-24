import { contextBridge, ipcRenderer, type IpcRenderer } from 'electron';
import type { HubState, ServicePatch, GlobalPatch, RecoverOpts, OpResult } from '../shared/hubTypes';

export interface LoftHub {
  getState(): Promise<HubState>;
  onStateChanged(cb: (s: HubState) => void): () => void;
  openService(id: string): void;
  addService(kind: string, customUrl?: string): void;
  removeService(id: string, deleteData: boolean): void;
  setServiceSetting(id: string, patch: ServicePatch): void;
  renameService(id: string, name: string): Promise<OpResult>;
  setServiceIcon(id: string, choice: string): Promise<OpResult>;
  setGlobal(patch: GlobalPatch): void;
  recoverService(id: string, opts: RecoverOpts): void;
  quit(): void;
  /** Main asks the manager to open a specific service's settings (rail right-click → Settings…). */
  onSelect(cb: (id: string) => void): () => void;
}

// Pure factory (testable with a mock ipc); the real bridge passes ipcRenderer.
export function buildBridge(ipc: IpcRenderer): LoftHub {
  return {
    getState: () => ipc.invoke('hub:getState'),
    onStateChanged: (cb) => {
      const handler = (_e: unknown, s: HubState) => cb(s);
      ipc.on('hub:state', handler);
      return () => ipc.removeListener('hub:state', handler);
    },
    openService: (id) => ipc.send('hub:openService', id),
    addService: (kind, customUrl) => ipc.send('hub:addService', { kind, customUrl }),
    removeService: (id, deleteData) => ipc.send('hub:removeService', { id, deleteData }),
    setServiceSetting: (id, patch) => ipc.send('hub:setServiceSetting', { id, patch }),
    renameService: (id, name) => ipc.invoke('hub:renameService', { id, name }),
    setServiceIcon: (id, choice) => ipc.invoke('hub:setServiceIcon', { id, choice }),
    setGlobal: (patch) => ipc.send('hub:setGlobal', patch),
    recoverService: (id, opts) => ipc.send('hub:recoverService', { id, opts }),
    quit: () => ipc.send('hub:quit'),
    onSelect: (cb) => {
      const handler = (_e: unknown, id: string) => cb(id);
      ipc.on('manager:select', handler);
      return () => ipc.removeListener('manager:select', handler);
    },
  };
}

contextBridge.exposeInMainWorld('loftHub', buildBridge(ipcRenderer));
