import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('loftRecovery', {
  reload: () => ipcRenderer.send('recovery:reload'),
  clearAndReload: () => ipcRenderer.send('recovery:clear-and-reload'),
  onSetService: (cb: (name: string) => void) =>
    ipcRenderer.on('recovery:set-service', (_e, name: string) => cb(name)),
});
