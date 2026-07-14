import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('loft', {
  zoomIn: () => ipcRenderer.send('titlebar:zoom-in'),
  zoomOut: () => ipcRenderer.send('titlebar:zoom-out'),
  close: () => ipcRenderer.send('titlebar:close'),
  onSetService: (cb: (name: string) => void) =>
    ipcRenderer.on('titlebar:set-service', (_e, name: string) => cb(name)),
});
