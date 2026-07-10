import { app, ipcMain } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from './cli';
import { getService, ServiceDef } from './registry';
import { loadConfig, saveConfig, configPath, LoftConfig } from './config';
import { createServiceWindow, ServiceWindow } from './serviceWindow';
import { startTray, Tray, TrayServiceSeed } from './tray';

app.setName('Loft');
app.setAppUserModelId('chat.loft.Loft');

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
app.setPath('userData', join(dataHome, 'loft'));

let quitting = false;
let tray: Tray | undefined;

const config: LoftConfig = loadConfig(configPath());
const windows = new Map<string, ServiceWindow>();

function openService(def: ServiceDef, minimized: boolean): void {
  const existing = windows.get(def.id);
  if (existing) { existing.show(); return; }
  // Launching marks the service "configured" so it persists in the tray's
  // available section after Quit (until the Stage-4 hub manages this explicitly).
  if (!config.services[def.id]) config.services[def.id] = {};
  const sw = createServiceWindow(def, config, { minimized, onQuit: () => quitting });
  // Keep the tray's visibility state in sync with the window (drives Show/Hide label).
  sw.window.on('show', () => tray?.setVisible(def.id, true));
  sw.window.on('hide', () => tray?.setVisible(def.id, false));
  windows.set(def.id, sw);
  tray?.addService({ id: def.id, displayName: def.displayName, dnd: config.services[def.id]?.dnd ?? false });
  tray?.setRunning(def.id, true);
  tray?.setVisible(def.id, sw.window.isVisible());
}

// Tray menu "Show/Hide" for a service: show if hidden, hide if visible.
function toggleService(id: string): void {
  const sw = windows.get(id);
  if (sw && sw.window.isVisible()) { sw.hide(); return; }
  const def = getService(id);
  if (def) openService(def, false);
}

// Persist a service's DND to config immediately (survives a kill before before-quit).
function setServiceDnd(id: string, enabled: boolean): void {
  config.services[id] = { ...config.services[id], dnd: enabled };
  saveConfig(configPath(), config);
}

// Tray per-service "Quit": stop the service (destroy its window). It stays
// configured, so it drops into the tray's available section and can be relaunched.
function quitService(id: string): void {
  const sw = windows.get(id);
  if (!sw) return;
  windows.delete(id);
  tray?.setRunning(id, false);
  tray?.setVisible(id, false);
  sw.window.destroy();
}

// Global DND: persist + reflect in the tray (notification gating is Stage 3b).
function setGlobalDnd(enabled: boolean): void {
  config.globalDnd = enabled;
  saveConfig(configPath(), config);
  tray?.setGlobalDnd(enabled);
}

function resolveServiceFromArgs(argv: string[]): ServiceDef | undefined {
  const { service } = parseArgs(argv);
  return service ? getService(service) : undefined;
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

// Single-instance: a second launch routes its --service to us; the second process
// hits app.quit() below and never registers the owner handlers.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const def = resolveServiceFromArgs(argv);
    if (def) openService(def, false);
  });

  ipcMain.on('titlebar:zoom-in', (e) => findBySenderId(e.sender.id)?.setZoom(+0.1));
  ipcMain.on('titlebar:zoom-out', (e) => findBySenderId(e.sender.id)?.setZoom(-0.1));
  ipcMain.on('titlebar:close', (e) => findBySenderId(e.sender.id)?.hide());

  ipcMain.on('service:badge', (e, payload?: { count?: number }) => {
    if (typeof payload?.count !== 'number') return;
    const sw = findBySenderId(e.sender.id);
    if (!sw) return;
    sw.setBadge(payload.count);
    tray?.setBadge(sw.def.id, payload.count);
  });

  app.whenReady().then(async () => {
    const args = parseArgs(process.argv);
    const def = args.service ? getService(args.service) : undefined;
    if (def) openService(def, args.minimized);
    // With no --service, Stage 1 opens WhatsApp so there is always a window to see.
    else openService(getService('whatsapp')!, args.minimized);

    // One combined "Loft" SNI tray icon for all services (Stage 3a).
    try {
      const configured: TrayServiceSeed[] = Object.keys(config.services)
        .map((id) => getService(id))
        .filter((d): d is ServiceDef => d !== undefined)
        .map((d) => ({
          id: d.id,
          displayName: d.displayName,
          dnd: config.services[d.id]?.dnd ?? false,
          running: windows.has(d.id),
          visible: windows.get(d.id)?.window.isVisible() ?? false,
        }));
      tray = await startTray({
        configuredServices: configured,
        globalDnd: config.globalDnd ?? false,
        onToggleService: (id) => toggleService(id),
        onLaunchService: (id) => { const d = getService(id); if (d) openService(d, false); },
        onQuitService: (id) => quitService(id),
        onToggleDnd: (id, enabled) => { setServiceDnd(id, enabled); tray?.setDnd(id, enabled); },
        onToggleGlobalDnd: (enabled) => setGlobalDnd(enabled),
        onShowHub: () => { for (const sw of windows.values()) { sw.show(); break; } }, // Stage 4: real hub
        onQuit: () => { quitting = true; app.quit(); },
      });
      // Reflect windows already open before the tray came up.
      for (const [id, sw] of windows) {
        const d = getService(id);
        if (d) tray.addService({ id, displayName: d.displayName, dnd: config.services[id]?.dnd ?? false });
        tray.setRunning(id, true);
        tray.setVisible(id, sw.window.isVisible());
      }
    } catch (err) {
      console.error('Failed to start tray:', err);
    }
  });

  app.on('window-all-closed', () => { /* stay alive (tray comes in Stage 3); quit only via before-quit */ });

  app.on('before-quit', () => {
    quitting = true; // fires before window 'close' events, so close-to-tray yields to a real quit
    for (const sw of windows.values()) sw.persist();
    saveConfig(configPath(), config);
  });
}
