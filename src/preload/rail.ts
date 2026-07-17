import { contextBridge, ipcRenderer, type IpcRenderer } from 'electron';
import type { RailItem } from '../main/railModel';

export interface RailBridge {
  /** Subscribe to rail state. Returns an unsubscribe — call it on teardown. */
  onState(cb: (items: RailItem[]) => void): () => void;
  select(id: string): void;
  /** Ask main to pop the native per-service context menu for this item. */
  menu(id: string): void;
}

/** Pure factory so the bridge is testable against a fake ipc (mirrors preload/hub.ts). */
export function buildRailBridge(ipc: IpcRenderer): RailBridge {
  return {
    onState(cb) {
      const h = (_e: unknown, items: RailItem[]): void => cb(items);
      ipc.on('rail:state', h);
      return () => ipc.removeListener('rail:state', h);
    },
    select: (id) => ipc.send('rail:select', id),
    menu: (id) => ipc.send('rail:menu', id),
  };
}

contextBridge.exposeInMainWorld('loftRail', buildRailBridge(ipcRenderer));
