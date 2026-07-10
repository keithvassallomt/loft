import { app, BrowserWindow } from 'electron';

app.setName('Loft');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1100, height: 800 });
  win.loadURL('about:blank');
});

app.on('window-all-closed', () => app.quit());
