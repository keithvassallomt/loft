import { app, dialog, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from './cli';
import { getService, ServiceDef } from './registry';
import { loadConfig, saveConfig, configPath, LoftConfig } from './config';
import { createServiceWindow, ServiceWindow } from './serviceWindow';
import { startTray, Tray, TrayServiceSeed } from './tray';
import { startNotifications, Notifications } from './notifications';
import { createShellHelperClient } from './gnome/shellHelper';
import { startLoftDbusService, type LoftServiceDeps } from './dbus/loftService';
import { deployGnomeExtension } from './gnome/deploy';
import { isGnome } from './trayBackend';

app.setName('Loft');
app.setAppUserModelId('chat.loft.Loft');

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
app.setPath('userData', join(dataHome, 'loft'));

let quitting = false;
let tray: Tray | undefined;
let notifications: Notifications | undefined;

// GNOME-only: bypasses focus-stealing prevention (FocusWindow/HideWindow) and
// hides minimized Loft windows from alt-tab/overview/dock (SetLoftWindows).
// The factory opens a session-bus connection synchronously and can throw if no
// bus daemon exists at all (not just "helper absent") — never let that crash
// startup (Task 3 review finding).
const gnome = isGnome(process.env);
let helper: ReturnType<typeof createShellHelperClient> | undefined;
if (gnome) {
  try {
    helper = createShellHelperClient();
  } catch (err) {
    console.error('Failed to create GNOME Shell helper client:', err);
  }
}

// dist/main → dist/assets/icons/<id>.png (copied by copy-assets; same deployed
// dir the tray's dbusMenu/icon modules read from — those live one directory
// deeper, under dist/main/tray, hence their extra '..').
function serviceIconPath(id: string): string {
  return join(__dirname, '..', 'assets', 'icons', `${id}.png`);
}

const config: LoftConfig = loadConfig(configPath());
const windows = new Map<string, ServiceWindow>();
// Latest badge count per service, independent of whether the badge indicator
// is currently enabled — GetStatus() always reports the true count.
const currentBadge = new Map<string, number>();

// Display-name keys for every currently-open service window (open = present in
// `windows`, regardless of shown/hidden) — what the GNOME helper hides from
// alt-tab/overview/dock when minimized (`SetLoftWindows`).
function windowKeys(): string[] {
  return [...windows.values()].map((sw) => sw.def.displayName);
}
function syncLoftWindows(): void { helper?.setLoftWindows(windowKeys()); }

function openService(def: ServiceDef, minimized: boolean): void {
  const existing = windows.get(def.id);
  // helper?.focusWindow bypasses GNOME's focus-stealing prevention; fire it in
  // parallel with the native show — never await (a missing/erroring helper
  // must never block or crash a window action).
  if (existing) { existing.show(); helper?.focusWindow(def.displayName); return; }
  // Launching marks the service "configured" so it persists in the tray's
  // available section after Quit (until the Stage-4 hub manages this explicitly).
  if (!config.services[def.id]) config.services[def.id] = {};
  const sw = createServiceWindow(def, config, { minimized, onQuit: () => quitting });
  // Keep the tray's visibility state in sync with the window (drives Show/Hide label).
  sw.window.on('show', () => tray?.setVisible(def.id, true));
  sw.window.on('hide', () => tray?.setVisible(def.id, false));
  // Notification gate: focus/visibility feed shouldNotify()/pushHidden(); a
  // fresh (re)load re-registers the service so the view gets current DND/hidden.
  sw.window.on('focus', () => notifications?.setFocused(def.id, true));
  sw.window.on('blur', () => notifications?.setFocused(def.id, false));
  sw.window.on('show', () => notifications?.setVisible(def.id, true));
  sw.window.on('hide', () => notifications?.setVisible(def.id, false));
  sw.serviceView.webContents.on('did-finish-load', () => notifications?.registerService(def.id));
  windows.set(def.id, sw);
  syncLoftWindows();
  helper?.focusWindow(def.displayName);
  tray?.addService({ id: def.id, displayName: def.displayName, dnd: config.services[def.id]?.dnd ?? false });
  tray?.setRunning(def.id, true);
  tray?.setVisible(def.id, sw.window.isVisible());
  notifications?.setVisible(def.id, sw.window.isVisible());
  notifications?.setFocused(def.id, sw.window.isFocused());
}

// Tray menu "Show/Hide" for a service: show if hidden, hide if visible.
function toggleService(id: string): void {
  const sw = windows.get(id);
  if (sw && sw.window.isVisible()) { sw.hide(); helper?.hideWindow(sw.def.displayName); return; }
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
  syncLoftWindows();
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
    currentBadge.set(sw.def.id, payload.count);
    // SetBadgesEnabled(false) keeps the true count in currentBadge (GetStatus
    // still reports it) but suppresses the visible tray/title indicator.
    if (config.services[sw.def.id]?.badgesEnabled === false) return;
    sw.setBadge(payload.count);
    tray?.setBadge(sw.def.id, payload.count);
  });

  ipcMain.on('service:notify', (e, p?: { title?: string; body?: string; icon?: string; href?: string }) => {
    const sw = findBySenderId(e.sender.id);
    if (!sw || !p || typeof p.title !== 'string' || typeof p.body !== 'string') return;
    void notifications?.handle(sw.def.id, { title: p.title, body: p.body, icon: p.icon, href: p.href });
  });

  app.whenReady().then(async () => {
    // GNOME Shell only loads new extension JS at session start, so (re)deploying
    // the bundled helper (missing, or an EGO build not newer than ours) requires
    // telling the user to log out — port of daemon/mod.rs notify_gnome_helper_relogin.
    if (gnome) {
      try {
        const wrote = deployGnomeExtension({
          dataHome,
          resourcesDir: join(__dirname, '..', 'assets'),
          runGnomeExtensionsEnable: () => {
            try { require('node:child_process').execFileSync('gnome-extensions', ['enable', 'loft-shell-helper@loft.chat']); }
            catch { /* CLI absent or already enabled — best effort */ }
          },
        });
        if (wrote) {
          void dialog.showMessageBox({
            type: 'info',
            title: 'Log out to finish updating Loft',
            message: 'Log out to finish updating Loft',
            detail: 'Loft updated its GNOME integration. Log out and back in for window management (show/hide, panel icons) to work correctly.',
            buttons: ['Got it'],
          });
        }
      } catch (err) {
        console.error('GNOME helper deploy failed:', err);
      }
    }

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
        onToggleDnd: (id, enabled) => { setServiceDnd(id, enabled); tray?.setDnd(id, enabled); notifications?.setServiceDnd(id, enabled); },
        onToggleGlobalDnd: (enabled) => { setGlobalDnd(enabled); notifications?.setGlobalDnd(enabled); },
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

    // Desktop notification delivery + DND gating (Stage 3b).
    try {
      notifications = await startNotifications({
        displayName: (id) => getService(id)?.displayName ?? id,
        serviceIconPath,
        sessionFetch: (id, url) => session.fromPartition(`persist:${id}`).fetch(url),
        focusService: (id) => { const d = getService(id); if (d) openService(d, false); },
        navigate: (id, url) => windows.get(id)?.navigate(url),
        pushDnd: (id, v) => windows.get(id)?.pushDnd(v),
        pushHidden: (id, hidden) => windows.get(id)?.pushHidden(hidden),
      });
      // Seed the gate from persisted config so DND holds across a restart,
      // even for services not yet running (effectiveDnd is read back on
      // registerService once/if they do launch).
      for (const id of Object.keys(config.services)) {
        notifications.setServiceDnd(id, config.services[id]?.dnd ?? false);
      }
      notifications.setGlobalDnd(config.globalDnd ?? false);
      // Reflect windows already open before notifications came up (same
      // bootstrap-ordering gap the tray loop above works around: the initial
      // service window's focus/show fired during construction, before its
      // listeners — and this variable — existed).
      for (const [id, sw] of windows) {
        notifications.setVisible(id, sw.window.isVisible());
        notifications.setFocused(id, sw.window.isFocused());
      }
    } catch (err) {
      console.error('Failed to start notifications:', err);
    }

    // chat.loft.Loft D-Bus service (parity/scripting; also the target of the
    // GNOME-panel tray menu callbacks). A busy bus name (a leftover/second
    // instance) must not crash startup.
    try {
      const loftDeps: LoftServiceDeps = {
        show: (id) => { const d = getService(id); if (d) openService(d, false); },
        hide: (id) => {
          const sw = windows.get(id);
          if (!sw) return;
          sw.hide();
          helper?.hideWindow(sw.def.displayName);
        },
        toggle: (id) => toggleService(id),
        quitService: (id) => quitService(id),
        getStatus: (id) => {
          const sw = windows.get(id);
          const visible = sw?.window.isVisible() ?? false;
          const badge = currentBadge.get(id) ?? 0;
          const dnd = config.services[id]?.dnd ?? false;
          return [visible, badge, dnd];
        },
        setDnd: (id, enabled) => { setServiceDnd(id, enabled); tray?.setDnd(id, enabled); notifications?.setServiceDnd(id, enabled); },
        setBadgesEnabled: (id, enabled) => {
          config.services[id] = { ...config.services[id], badgesEnabled: enabled };
          saveConfig(configPath(), config);
        },
        quitApp: () => { quitting = true; app.quit(); },
      };
      await startLoftDbusService(loftDeps);
    } catch (err) {
      console.error('Failed to start chat.loft.Loft D-Bus service:', err);
    }
  });

  app.on('window-all-closed', () => { /* stay alive (tray comes in Stage 3); quit only via before-quit */ });

  app.on('before-quit', () => {
    quitting = true; // fires before window 'close' events, so close-to-tray yields to a real quit
    for (const sw of windows.values()) sw.persist();
    saveConfig(configPath(), config);
  });
}
