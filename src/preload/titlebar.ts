import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('loft', {
  zoomIn: () => ipcRenderer.send('titlebar:zoom-in'),
  zoomOut: () => ipcRenderer.send('titlebar:zoom-out'),
  close: () => ipcRenderer.send('titlebar:close'),
  reload: () => ipcRenderer.send('titlebar:reload'),
  onSetService: (cb: (name: string) => void) =>
    ipcRenderer.on('titlebar:set-service', (_e, name: string) => cb(name)),
  attach: () => ipcRenderer.send('titlebar:attach'),
  onSetAttachable: (cb: (on: boolean) => void) =>
    ipcRenderer.on('titlebar:set-attachable', (_e, on: boolean) => cb(on)),
});
