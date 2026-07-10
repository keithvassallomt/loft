import { app, ipcMain } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from './cli';
import { getService, ServiceDef } from './registry';
import { loadConfig, saveConfig, configPath, LoftConfig } from './config';
import { createServiceWindow, ServiceWindow } from './serviceWindow';

app.setName('Loft');
app.setAppUserModelId('chat.loft.Loft');

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
app.setPath('userData', join(dataHome, 'loft'));

let quitting = false;

const config: LoftConfig = loadConfig(configPath());
const windows = new Map<string, ServiceWindow>();

function openService(def: ServiceDef, minimized: boolean): void {
  const existing = windows.get(def.id);
  if (existing) { existing.show(); return; }
  const sw = createServiceWindow(def, config, { minimized, onQuit: () => quitting });
  windows.set(def.id, sw);
}

function resolveServiceFromArgs(argv: string[]): ServiceDef | undefined {
  const { service } = parseArgs(argv);
  return service ? getService(service) : undefined;
}

// Single-instance: a second launch routes its --service to us.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const def = resolveServiceFromArgs(argv);
    if (def) openService(def, false);
  });

  ipcMain.on('titlebar:zoom-in', (e) => adjustZoom(e.sender.id, +0.1));
  ipcMain.on('titlebar:zoom-out', (e) => adjustZoom(e.sender.id, -0.1));
  ipcMain.on('titlebar:close', (e) => hideOwningWindow(e.sender.id));

  app.whenReady().then(() => {
    const args = parseArgs(process.argv);
    const def = args.service ? getService(args.service) : undefined;
    if (def) openService(def, args.minimized);
    // With no --service, Stage 1 opens WhatsApp so there is always a window to see.
    else openService(getService('whatsapp')!, args.minimized);
  });

  app.on('window-all-closed', () => { /* stay alive (tray comes in Stage 3); quit only via before-quit */ });
}

// Titlebar IPC events come from the titlebar view's preload; map the sender's
// webContents id back to its ServiceWindow (match titlebar or service view).
function findBySenderId(senderId: number): ServiceWindow | undefined {
  for (const sw of windows.values()) {
    if (sw.titlebarView.webContents.id === senderId || sw.serviceView.webContents.id === senderId) {
      return sw;
    }
  }
  return undefined;
}

function adjustZoom(senderId: number, delta: number): void {
  const sw = findBySenderId(senderId);
  if (!sw) return;
  const wc = sw.serviceView.webContents;
  const next = Math.min(3, Math.max(0.3, wc.getZoomFactor() + delta));
  wc.setZoomFactor(next);
}

function hideOwningWindow(senderId: number): void {
  findBySenderId(senderId)?.hide();
}

app.on('before-quit', () => {
  quitting = true; // fires before window 'close' events, so close-to-tray yields to a real quit
  saveConfig(configPath(), config);
});
