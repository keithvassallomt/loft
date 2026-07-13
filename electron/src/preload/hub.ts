import { contextBridge, ipcRenderer, type IpcRenderer } from 'electron';
import type { HubState, ServicePatch, GlobalPatch } from '../shared/hubTypes';

export interface LoftHub {
  getState(): Promise<HubState>;
  onStateChanged(cb: (s: HubState) => void): () => void;
  openService(id: string): void;
  addService(id: string, customUrl?: string): void;
  removeService(id: string, deleteData: boolean): void;
  setServiceSetting(id: string, patch: ServicePatch): void;
  setGlobal(patch: GlobalPatch): void;
  quit(): void;
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
    addService: (id, customUrl) => ipc.send('hub:addService', { id, customUrl }),
    removeService: (id, deleteData) => ipc.send('hub:removeService', { id, deleteData }),
    setServiceSetting: (id, patch) => ipc.send('hub:setServiceSetting', { id, patch }),
    setGlobal: (patch) => ipc.send('hub:setGlobal', patch),
    quit: () => ipc.send('hub:quit'),
  };
}

contextBridge.exposeInMainWorld('loftHub', buildBridge(ipcRenderer));
