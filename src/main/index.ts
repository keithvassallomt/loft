import { app, ipcMain, Menu, protocol, session } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from './cli';
import { getService, SERVICES, ServiceDef, effectiveUrl } from './registry';
import { loadConfig, saveConfig, configPath, LoftConfig } from './config';
import { createServiceWindow, ServiceWindow } from './serviceWindow';
import type { ServiceHost } from './serviceHost';
import { clearServiceCaches } from './recovery';
import { Tray, TrayDeps, TrayServiceSeed } from './tray';
import { startTrayBackend } from './tray/backend';
import { startNotifications, Notifications } from './notifications';
import { createShellHelperClient } from './gnome/shellHelper';
import { startLoftDbusService, type LoftServiceDeps } from './dbus/loftService';
import { ensureGnomeHelper, defaultHelperInstallDeps } from './gnome/helperInstall';
import { isGnome, isKde, resolveTrayBackend } from './trayBackend';
import { createKwinClient, type KwinClient } from './kde/kwin';
import { startBackgroundStatus } from './gnome/backgroundStatus';
import { createHub, type HubDeps } from './hubWindow';
import { buildHubState } from './hubState';
import { addService, removeService } from './install';
import { syncAutostart, isAutostartEnabled, wantsAutostart, removeLegacyAutostart } from './autostart';
import { createSignalShutdown } from './shutdown';
import { ensureHubDesktopEntry, writeServiceLauncher, serviceLauncherPath } from './desktop';
import { iconsDir } from './paths';
import { migrateConfig } from './migrate';
import type { ServicePatch, GlobalPatch, RecoverOpts } from '../shared/hubTypes';

app.setName('Loft');
app.setAppUserModelId('chat.loft.Loft');
// No app menu — the hub is a plain utility window and the service windows are
// frameless, so the default Electron menu bar is just empty chrome. Removing it
// app-wide hides the menu bar on the decorated hub window.
Menu.setApplicationMenu(null);

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
app.setPath('userData', join(dataHome, 'loft'));

// Custom scheme the hub renderer uses for service/app icons (keeps img-src 'self'
// clean and avoids file:// path juggling). Registered as privileged so it can load
// from the renderer under CSP.
protocol.registerSchemesAsPrivileged([
  { scheme: 'loft', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let quitting = false;
let tray: Tray | undefined;
let notifications: Notifications | undefined;
let bgStatus: { refresh(): void } | undefined;
let hub: ReturnType<typeof createHub> | undefined;
// Bundled PNGs live in dist/assets/icons (copy-assets); one dir up from dist/main.
const iconSourceDir = join(__dirname, '..', 'assets', 'icons');

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
// KDE: KWin scripting bypasses focus-stealing prevention (the KDE analog of the
// GNOME helper's FocusWindow/HideWindow). Only when not GNOME. Never let a missing
// bus crash startup.
const kde = !gnome && isKde(process.env);
let kwin: KwinClient | undefined;
if (kde) {
  try { kwin = createKwinClient(); }
  catch (err) { console.error('Failed to create KWin client:', err); }
}

// Route window focus/hide to whichever WM integration is active (GNOME helper xor
// KWin xor nothing). Only one is ever set; both are optional-chained + never-throw.
function focusExternal(key: string): void { helper?.focusWindow(key); kwin?.focusWindow(key); }
function hideExternal(key: string): void { helper?.hideWindow(key); kwin?.hideWindow(key); }

// dist/main → dist/assets/icons/<id>.png (copied by copy-assets; same deployed
// dir the tray's dbusMenu/icon modules read from — those live one directory
// deeper, under dist/main/tray, hence their extra '..').
function serviceIconPath(id: string): string {
  return join(__dirname, '..', 'assets', 'icons', `${id}.png`);
}

const config: LoftConfig = loadConfig(configPath());
const windows = new Map<string, ServiceWindow>();
// Where a service currently lives, as the narrow contract consumers should use.
// Today every host is a ServiceWindow; in 09b an attached service's host is the
// Loft window instead, and nothing below this line has to care.
const hostOf = (id: string): ServiceHost | undefined => windows.get(id);
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
  // The reuse check goes through hostOf, not the windows map: once a service can
  // live in a shared host, "is it already open?" must consult every host, and
  // reimplementing hostOf is then the only change needed here. The create path
  // below still needs the map directly — hostOf deliberately cannot create.
  const existing = hostOf(def.id);
  // focusExternal (GNOME helper or KWin) bypasses focus-stealing prevention; fire
  // it in parallel with the native show — never await (a missing/erroring backend
  // must never block or crash a window action).
  if (existing) { existing.show(); focusExternal(def.displayName); return; }
  // First launch of a service implicitly Adds it (writes its launcher + icon) so a
  // directly-launched service shows up as Installed in the hub.
  if (!config.services[def.id]) {
    addService(def, config, { execPath: process.execPath, iconSourceDir });
    saveConfig(configPath(), config);
  }
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
  focusExternal(def.displayName);
  tray?.addService({ id: def.id, displayName: def.displayName, dnd: config.services[def.id]?.dnd ?? false });
  tray?.setRunning(def.id, true);
  tray?.setVisible(def.id, sw.window.isVisible());
  notifications?.setVisible(def.id, sw.window.isVisible());
  notifications?.setFocused(def.id, sw.window.isFocused());
  bgStatus?.refresh();
  hub?.notifyChanged();
}

// Tray menu "Show/Hide" for a service: show if hidden, hide if visible.
function toggleService(id: string): void {
  const sw = windows.get(id);
  if (sw && sw.window.isVisible()) { sw.hide(); hideExternal(sw.def.displayName); return; }
  const def = getService(id);
  if (def) openService(def, false);
}

// Persist a service's DND to config immediately (survives a kill before before-quit).
function setServiceDnd(id: string, enabled: boolean): void {
  config.services[id] = { ...config.services[id], dnd: enabled };
  saveConfig(configPath(), config);
  hub?.notifyChanged();
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
  bgStatus?.refresh();
  hub?.notifyChanged();
}

// Global DND: persist + reflect in the tray (notification gating is Stage 3b).
function setGlobalDnd(enabled: boolean): void {
  config.globalDnd = enabled;
  saveConfig(configPath(), config);
  tray?.setGlobalDnd(enabled);
  hub?.notifyChanged();
}

// Autostart is derived, not a setting: the entry exists iff some service asked to
// open at login. Called after anything that can change that answer.
function reconcileAutostart(): void {
  // Gated on out-of-sync (wants vs. isAutostartEnabled()) so every call site gets
  // this for free — this debounces the *success* case only: ticking a second
  // service's "open on startup" when a first one already granted autostart is a
  // no-op, with no portal round-trip and no re-notify (nothing changed). A
  // *denial* leaves wants=true/enabled=false permanently out-of-sync, so it is
  // deliberately retried on every call (including every app launch) until it's
  // granted — never gate that case away.
  const wants = wantsAutostart(config.services);
  if (wants === isAutostartEnabled()) return;
  // Under Flatpak this goes through the XDG Background portal, which is async and
  // can leave a permission dialog on screen for up to 120s; natively it resolves
  // immediately. Re-notify the hub once the sync actually settles — otherwise a
  // buildState() taken right after this call returns (e.g. the setServiceSetting
  // IPC handler's own notifyChanged()) can read a not-yet-written autostart entry
  // and show a spurious "Loft was denied permission to start at login" warning
  // while the portal dialog is still pending. Safe: syncAutostart is documented to
  // never reject.
  void syncAutostart(wants, { execPath: process.execPath, iconSourceDir })
    .then(() => hub?.notifyChanged());
}

function resolveServiceFromArgs(argv: string[]): ServiceDef | undefined {
  const { service } = parseArgs(argv);
  return service ? getService(service) : undefined;
}

// Titlebar IPC events come from the titlebar view's preload; map the sender's
// webContents id back to its ServiceWindow (match titlebar or service view).
function findBySenderId(senderId: number): ServiceWindow | undefined {
  for (const sw of windows.values()) {
    if (sw.ownsWebContents(senderId)) return sw;
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
    else hub?.open();
  });

  ipcMain.on('titlebar:zoom-in', (e) => findBySenderId(e.sender.id)?.setZoom(+0.1));
  ipcMain.on('titlebar:zoom-out', (e) => findBySenderId(e.sender.id)?.setZoom(-0.1));
  ipcMain.on('titlebar:close', (e) => findBySenderId(e.sender.id)?.hide());
  ipcMain.on('titlebar:reload', (e) => findBySenderId(e.sender.id)?.reload());
  ipcMain.on('recovery:reload', (e) => findBySenderId(e.sender.id)?.reload());
  ipcMain.on('recovery:clear-and-reload', (e) => { void findBySenderId(e.sender.id)?.clearAndReload(); });

  ipcMain.on('service:badge', (e, payload?: { count?: number }) => {
    if (typeof payload?.count !== 'number') return;
    const sw = findBySenderId(e.sender.id);
    if (!sw) return;
    currentBadge.set(sw.def.id, payload.count);
    bgStatus?.refresh();
    hub?.notifyChanged();
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
    // loft://icon/<id> -> the deployed icon (added services) or the bundled asset
    // (available/not-yet-added services + the 'loft' app icon). Read from disk and
    // return the bytes: the main-process global fetch() does NOT support file://.
    protocol.handle('loft', async (req) => {
      const name = new URL(req.url).pathname.replace(/^\/+/, '') || 'loft';
      for (const file of [join(iconsDir(), `${name}.png`), join(iconSourceDir, `${name}.png`)]) {
        try {
          return new Response(await readFile(file), { headers: { 'content-type': 'image/png' } });
        } catch { /* try the next candidate */ }
      }
      return new Response(null, { status: 404 });
    });

    // On GNOME, ensure the Shell helper is present. It's no longer bundled: we
    // install it from extensions.gnome.org on the user's OK (GNOME's own dialog
    // does the download+install+enable, loading it in-process — no relogin). If
    // declined or GNOME Shell is unavailable, Loft falls back to the SNI tray.
    if (gnome) {
      await ensureGnomeHelper(defaultHelperInstallDeps({
        dataHome,
        resourcesDir: join(__dirname, '..', 'assets'),
      }));
    }

    // One combined "Loft" tray icon for all services — SNI (Stage 3a) or, on
    // GNOME with a live helper, a native panel button (Stage 3c).
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
      const deps: TrayDeps = {
        configuredServices: configured,
        globalDnd: config.globalDnd ?? false,
        onToggleService: (id) => toggleService(id),
        onLaunchService: (id) => { const d = getService(id); if (d) openService(d, false); },
        onQuitService: (id) => quitService(id),
        onToggleDnd: (id, enabled) => { setServiceDnd(id, enabled); tray?.setDnd(id, enabled); notifications?.setServiceDnd(id, enabled); },
        onToggleGlobalDnd: (enabled) => { setGlobalDnd(enabled); notifications?.setGlobalDnd(enabled); },
        onShowHub: () => hub?.open(),
        onQuit: () => { quitting = true; app.quit(); },
      };
      // gnome-panel requires a live helper; force sni when the helper factory
      // was skipped (non-GNOME) or threw (Task 3 review finding) so
      // startTrayBackend never needs to dereference an absent helper.
      const backend = helper ? resolveTrayBackend(config.trayBackend, process.env) : 'sni';
      tray = await startTrayBackend(deps, { backend, helper: helper! });
      // Reflect any windows already open before the tray came up. Since the
      // CLI/open-on-startup launch now runs *after* this block, `windows` is
      // normally empty here and this loop is a defensive no-op — kept for
      // symmetry with the notifications loop below and to cover any future
      // path that opens a window before tray init.
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
        navigate: (id, url) => hostOf(id)?.navigate(url),
        pushDnd: (id, v) => hostOf(id)?.pushDnd(v),
        pushHidden: (id, hidden) => hostOf(id)?.pushHidden(hidden),
      });
      // Seed the gate from persisted config so DND holds across a restart,
      // even for services not yet running (effectiveDnd is read back on
      // registerService once/if they do launch).
      for (const id of Object.keys(config.services)) {
        notifications.setServiceDnd(id, config.services[id]?.dnd ?? false);
      }
      notifications.setGlobalDnd(config.globalDnd ?? false);
      // Reflect any windows already open before notifications came up. Since the
      // CLI/open-on-startup launch now runs *after* this block, this is normally
      // a defensive no-op — kept for symmetry with the tray loop and to cover any
      // future path that opens a window before notifications init.
      for (const [id, sw] of windows) {
        notifications.setVisible(id, sw.window.isVisible());
        notifications.setFocused(id, sw.window.isFocused());
      }
    } catch (err) {
      console.error('Failed to start notifications:', err);
    }

    // GNOME Settings → Apps status line ("N services running" / "X: N unread"
    // via org.freedesktop.portal.Background). GNOME only — no equivalent on
    // other DEs.
    if (gnome) {
      bgStatus = startBackgroundStatus({
        collect: () => [...windows.values()].map((sw) => ({
          displayName: sw.def.displayName,
          // A badges-disabled service doesn't contribute its unread count to the
          // aggregate status line (still counts as a running service).
          badge: config.services[sw.def.id]?.badgesEnabled === false ? 0 : (currentBadge.get(sw.def.id) ?? 0),
        })),
      });
      bgStatus.refresh();
    }

    // Ensure the hub's own launcher exists for dev/AppImage (packaged/Flatpak ship it).
    try {
      ensureHubDesktopEntry({ execPath: process.execPath, iconSourceDir });
    } catch (err) { console.error('ensureHubDesktopEntry failed:', err); }

    // Config migration (spec 09 §8). Must run before the launcher self-heal below:
    // that loop is what would otherwise act on an unmigrated config. Save only when
    // something actually changed, so a migrated install doesn't rewrite on every start.
    try {
      const { changed } = migrateConfig(config, (id) => existsSync(serviceLauncherPath(id)));
      if (changed) {
        saveConfig(configPath(), config);
        console.log('Migrated config to v2 (per-service launchers are now opt-in)');
      }
    } catch (err) { console.error('Config migration failed:', err); }

    // Drop v1's per-service autostart entries. They're not merely stale: today's CLI
    // still parses their `--service <id>` form, so they launch the service at login
    // even when "Open on startup" is unticked — inverting the setting the hub shows.
    try {
      const removed = removeLegacyAutostart(SERVICES.map((s) => s.id));
      if (removed.length) console.log(`Removed ${removed.length} legacy autostart entr${removed.length === 1 ? 'y' : 'ies'} (v1)`);
    } catch (err) { console.error('Legacy autostart cleanup failed:', err); }

    // Re-assert every installed service's launcher + icon. Idempotent and cheap, and it
    // repairs a deleted or stale entry with no user action — notably v1-era launchers,
    // which share our filenames but point Icon= at an XDG theme name we no longer
    // install, leaving a blank icon in the launcher. Skipped under a dev run (see
    // writeServiceLauncher) so a checkout can't clobber the packaged install's entries.
    // Per-service try: one unwritable entry must not skip the rest (removeLegacyAutostart
    // isolates per-file for the same reason).
    for (const id of Object.keys(config.services)) {
      try {
        const d = getService(id);
        if (d) writeServiceLauncher(d, { execPath: process.execPath, iconSourceDir });
      } catch (err) { console.error(`Launcher self-heal failed for ${id}:`, err); }
    }

    const hubDeps: HubDeps = {
      buildState: () => buildHubState({
        services: SERVICES,
        config,
        running: (id) => windows.has(id),
        visible: (id) => windows.get(id)?.window.isVisible() ?? false,
        badge: (id) => currentBadge.get(id) ?? 0,
        trayBackend: config.trayBackend ?? 'auto',
        autostartBlocked: wantsAutostart(config.services) && !isAutostartEnabled(),
      }),
      openService: (id) => { const d = getService(id); if (d) openService(d, false); },
      addService: (id, customUrl) => {
        const d = getService(id); if (!d) return;
        addService(d, config, { execPath: process.execPath, iconSourceDir, customUrl });
        saveConfig(configPath(), config);
        // Deliberately no reconcileAutostart() here: addService only ever sets
        // customUrl and never touches openOnStartup, so wantsAutostart() cannot
        // change as a result of an add — the call would be a guaranteed no-op.
        // Under Flatpak it would still fire a real RequestBackground portal
        // request (and can pop an unwanted "let Loft run in the background?"
        // dialog) on every "Add service" click, including the first service
        // added to a fresh install. Don't add it back.
      },
      removeService: (id, deleteData) => {
        const d = getService(id); if (!d) return;
        quitService(id); // tear down a running window first
        removeService(d, config, deleteData);
        saveConfig(configPath(), config);
        reconcileAutostart();
      },
      setServiceSetting: (id, patch: ServicePatch) => {
        config.services[id] = { ...config.services[id], ...patch };
        saveConfig(configPath(), config);
        if (patch.dnd !== undefined) { tray?.setDnd(id, patch.dnd); notifications?.setServiceDnd(id, patch.dnd); hostOf(id)?.pushDnd(patch.dnd); }
        if (patch.badgesEnabled !== undefined) {
          const host = hostOf(id);
          const count = currentBadge.get(id) ?? 0;
          // Re-push the current badge so enabling shows it immediately; disabling clears the indicator.
          host?.setBadge(patch.badgesEnabled ? count : 0);
          tray?.setBadge(id, patch.badgesEnabled ? count : 0);
          bgStatus?.refresh();
        }
        if (patch.customUrl !== undefined) {
          const d = getService(id); const host = hostOf(id);
          if (d && host) host.loadUrl(effectiveUrl(d, patch.customUrl || undefined));
        }
        if (patch.openOnStartup !== undefined) reconcileAutostart();
      },
      setGlobal: (patch: GlobalPatch) => {
        if (patch.trayBackend !== undefined) { config.trayBackend = patch.trayBackend; saveConfig(configPath(), config); }
      },
      recoverService: (id, opts) => {
        const host = hostOf(id);
        // clearCaches:false with no running host (host undefined) is a deliberate
        // no-op: there's nothing to reload and nothing to clear. Unreachable today
        // (the hub only ever sends true), kept for API completeness.
        if (!opts.clearCaches) { host?.reload(); return; }
        // Works whether or not the service is running: with no host we still clear,
        // so the next launch loads clean.
        if (host) { void host.clearAndReload(); return; }
        void clearServiceCaches(session.fromPartition(`persist:${id}`));
      },
      quitApp: () => { quitting = true; app.quit(); },
      preloadPath: join(__dirname, '..', 'preload', 'hub.js'),
      htmlPath: join(__dirname, '..', 'renderer', 'hub', 'index.html'),
      iconPath: join(iconSourceDir, 'loft.png'),
    };
    hub = createHub(hubDeps);

    const args = parseArgs(process.argv);
    const def = args.service ? getService(args.service) : undefined;
    // Self-heal installs whose entry doesn't match their flags (e.g. upgrades from
    // the old global-toggle model, or a hand-deleted entry). Hoisted above the
    // --service branch so it runs on *every* launch path, not just the no-service
    // one: a user who only ever launches services via the per-service .desktop
    // launchers Loft itself writes (the common case) would otherwise never
    // self-heal and never see the warning. reconcileAutostart() itself gates on
    // out-of-sync (see its comment), so this costs one existsSync on the common
    // already-in-sync path.
    reconcileAutostart();
    if (def) {
      openService(def, args.minimized);
    } else {
      // No --service: open every service flagged open-on-startup (minimized to tray),
      // and show the hub as the app's home surface.
      for (const id of Object.keys(config.services)) {
        if (config.services[id]?.openOnStartup) { const d = getService(id); if (d) openService(d, true); }
      }
      if (!args.minimized) hub!.open();
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
          hideExternal(sw.def.displayName);
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
        showHub: () => hub?.open(),
        setGlobalDnd: (enabled) => { setGlobalDnd(enabled); notifications?.setGlobalDnd(enabled); },
      };
      await startLoftDbusService(loftDeps);
    } catch (err) {
      console.error('Failed to start chat.loft.Loft D-Bus service:', err);
    }
  });

  app.on('window-all-closed', () => { /* stay alive (tray comes in Stage 3); quit only via before-quit */ });

  app.on('before-quit', () => {
    quitting = true; // fires before window 'close' events, so close-to-tray yields to a real quit
    persistAll();
  });

  // Session-end (logout/shutdown): systemd SIGTERMs our scope ~1s BEFORE it tears down
  // the session bus (measured on GNOME: loft scope Stopping at T, dbus-broker Stopping at
  // T+~940ms). Chromium calls LOG(FATAL) (dbus/bus.cc) the instant its D-Bus connection
  // disconnects while the process is alive — so if we're still shutting down when the bus
  // dies, the process aborts (SIGTRAP) and the user gets an "Electron crashed" notice at
  // the next login. Electron's default graceful teardown (~600ms, longer with several
  // services + our own dbus-next connections open) can lose that race.
  //
  // Fix: persist synchronously and app.exit(0) IMMEDIATELY — collapsing shutdown to a few
  // ms, well inside the pre-bus-death window. app.quit() is the graceful path that loses
  // the race; app.exit(0) is deliberate. Reproduced the abort directly by killing a private
  // bus under a running Electron; verified the exact FATAL:dbus/bus.cc:1245 message, and
  // that this drops SIGTERM exit from ~600ms to ~116ms. (createSignalShutdown is unit-tested.)
  const fastExit = createSignalShutdown({ persist: persistAll, exit: () => app.exit(0) });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, fastExit);
}

/** Persist every open window's bounds/zoom and flush config. Shared by the in-app quit
 *  path (before-quit) and the session-end signal handler. */
function persistAll(): void {
  for (const sw of windows.values()) sw.persist();
  saveConfig(configPath(), config);
}
