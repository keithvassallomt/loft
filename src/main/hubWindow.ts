import { BrowserWindow, ipcMain } from 'electron';
import type { HubState, ServicePatch, GlobalPatch } from '../shared/hubTypes';

export interface HubDeps {
  buildState(): HubState;
  openService(id: string): void;
  addService(id: string, customUrl?: string): void;
  removeService(id: string, deleteData: boolean): void;
  setServiceSetting(id: string, patch: ServicePatch): void;
  setGlobal(patch: GlobalPatch): void;
  quitApp(): void;
  preloadPath: string;
  htmlPath: string;
  iconPath: string;
}

export interface Hub { open(): void; notifyChanged(): void; }

const CHANNELS = [
  'hub:openService', 'hub:addService', 'hub:removeService',
  'hub:setServiceSetting', 'hub:setGlobal', 'hub:quit',
];

export function createHub(deps: HubDeps): Hub {
  let win: BrowserWindow | undefined;

  const notifyChanged = (): void => {
    if (win && !win.isDestroyed()) win.webContents.send('hub:state', deps.buildState());
  };

  // Register handlers once; guard against a second createHub (dev reloads).
  ipcMain.removeHandler('hub:getState');
  for (const c of CHANNELS) ipcMain.removeAllListeners(c);

  ipcMain.handle('hub:getState', () => deps.buildState());
  ipcMain.on('hub:openService', (_e, id: string) => { deps.openService(id); notifyChanged(); });
  ipcMain.on('hub:addService', (_e, m: { id: string; customUrl?: string }) => { deps.addService(m.id, m.customUrl); notifyChanged(); });
  ipcMain.on('hub:removeService', (_e, m: { id: string; deleteData: boolean }) => { deps.removeService(m.id, m.deleteData); notifyChanged(); });
  ipcMain.on('hub:setServiceSetting', (_e, m: { id: string; patch: ServicePatch }) => { deps.setServiceSetting(m.id, m.patch); notifyChanged(); });
  ipcMain.on('hub:setGlobal', (_e, patch: GlobalPatch) => { deps.setGlobal(patch); notifyChanged(); });
  ipcMain.on('hub:quit', () => deps.quitApp());

  const open = (): void => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
    win = new BrowserWindow({
      width: 520,
      height: 640,
      title: 'Loft',
      icon: deps.iconPath,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.on('closed', () => { win = undefined; });
    void win.loadFile(deps.htmlPath);
  };

  return { open, notifyChanged };
}
