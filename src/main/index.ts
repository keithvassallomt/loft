import { app, ipcMain, Menu, protocol, session } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from './cli';
import { getService, SERVICES, ServiceDef, effectiveUrl } from './registry';
import { loadConfig, saveConfig, configPath, LoftConfig, reopenDetachedEnabled } from './config';
import { createServiceWindow, ServiceWindow } from './serviceWindow';
import { createLoftWindow, LOFT_WINDOW_KEY, type LoftWindow } from './loftWindow';
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
import { buildHubState } from './hubState';
import { addService, removeService } from './install';
import { syncAutostart, isAutostartEnabled, wantsAutostart, removeLegacyAutostart } from './autostart';
import { createSignalShutdown } from './shutdown';
import { ensureHubDesktopEntry, writeServiceLauncher, serviceLauncherPath } from './desktop';
import { iconsDir } from './paths';
import { migrateConfig } from './migrate';
import type { HubState, ServicePatch, GlobalPatch, RecoverOpts } from '../shared/hubTypes';

app.setName('Loft');
app.setAppUserModelId('chat.loft.Loft');
// No app menu — every Loft window is frameless now (the manager is a view inside the Loft
// window, not its own decorated window), so the default Electron menu bar is just empty
// chrome with nowhere to render.
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
// DETACHED services only — one window each. An attached service's host is `loft`.
const windows = new Map<string, ServiceWindow>();
// The unified window (spec 09 §2): manager + rail + every attached service. Created on
// app-ready, before anything is placed, and never destroyed until quit.
let loft: LoftWindow | undefined;

// Where a service currently lives, across BOTH host kinds. This is the seam: when a
// service moves between the rail and its own window, only this function knows.
const hostOf = (id: string): ServiceHost | undefined => windows.get(id) ?? loft?.hostOf(id);

// Every loaded service, wherever it lives. hostOf is per-id and cannot answer this;
// the background-status sweep needs it.
const allHosts = (): ServiceHost[] => [
  ...windows.values(),
  ...(loft?.ids().map((id) => loft!.hostOf(id)!) ?? []),
];

// Would this service load into its own window? `reopenDetached: false` parks every
// detached service in the rail at startup (spec §7) without forgetting the flag.
const wantsOwnWindow = (id: string): boolean =>
  config.services[id]?.detached === true && reopenDetachedEnabled(config);

// Does this service live in its own window? Answered from where it ACTUALLY is whenever
// it's loaded, and only from config while it sleeps. Not the same as the config flag:
// with reopenDetached off, a `detached: true` service sits in the rail, and claiming
// otherwise would make its tab unselectable (loftWindow.select refuses a detached id).
const isDetached = (id: string): boolean => {
  if (windows.has(id)) return true;
  if (loft?.has(id)) return false;
  return wantsOwnWindow(id);
};

// The WM key (window title) of the host a service lives in — 'Loft' when attached, its
// own display name when detached (spec §6a). What focusExternal/hideExternal match on.
const hostKey = (id: string): string | undefined => {
  const sw = windows.get(id);
  if (sw) return sw.def.displayName;
  return loft?.has(id) ? LOFT_WINDOW_KEY : undefined;
};

// Latest badge count per service, independent of whether the badge indicator
// is currently enabled — GetStatus() always reports the true count.
const currentBadge = new Map<string, number>();

// Display-name keys for every Loft-owned WINDOW (open = shown or hidden-to-tray) — what
// the GNOME helper hides from alt-tab/overview/dock when minimized (`SetLoftWindows`).
// Deliberately not allHosts(): an attached service is not a window, it is a tab inside
// the one keyed 'Loft'.
function windowKeys(): string[] {
  const keys = [...windows.values()].map((sw) => sw.def.displayName);
  if (loft) keys.push(LOFT_WINDOW_KEY);
  return keys;
}
function syncLoftWindows(): void { helper?.setLoftWindows(windowKeys()); }

/** Everything the manager renderer draws. Read fresh on every call — it is derived from
 *  config plus wherever the services actually live, and nothing caches it. */
function hubState(): HubState {
  return buildHubState({
    services: SERVICES,
    config,
    running: (id) => hostOf(id) !== undefined,
    visible: (id) => hostOf(id)?.isVisible() ?? false,
    badge: (id) => currentBadge.get(id) ?? 0,
    trayBackend: config.trayBackend ?? 'auto',
    autostartBlocked: wantsAutostart(config.services) && !isAutostartEnabled(),
  });
}

/**
 * Push fresh state to the manager view. The old standalone hub window pushed only while it
 * existed, which made every one of these a no-op on the launch paths that never opened it;
 * the manager is a view inside the Loft window now, created on app-ready and alive for the
 * process, so these land — including while a service tab is on top of it. That is the point:
 * a hidden-but-subscribed manager stays current, so showManager() has nothing to re-fetch.
 */
function notifyHub(): void { loft?.sendManager('hub:state', hubState()); }

/** Create (or reuse) a service's OWN window. Reached only through placeService — go via
 *  that (or showService), so nothing can duplicate an attached service into a window. */
function openService(def: ServiceDef, minimized: boolean): ServiceHost {
  // The reuse check goes through hostOf, not the windows map: a service can live in a
  // shared host now, so "is it already open?" must consult every host.
  const existing = hostOf(def.id);
  // focusExternal (GNOME helper or KWin) bypasses focus-stealing prevention; fire
  // it in parallel with the native show — never await (a missing/erroring backend
  // must never block or crash a window action).
  if (existing) {
    existing.show();
    const key = hostKey(def.id);
    if (key) focusExternal(key);
    return existing;
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
  tray?.setVisible(def.id, sw.isVisible());
  notifications?.setVisible(def.id, sw.isVisible());
  notifications?.setFocused(def.id, sw.window.isFocused());
  // Its own window: no other tab it can be sitting behind, so always the active one.
  notifications?.setActive(def.id, true);
  bgStatus?.refresh();
  loft?.refreshRail(); // the rail lists it as living in its own window now
  notifyHub();
  return sw;
}

/** Load a service into the Loft window's rail. Does NOT select it — attaching is not
 *  showing (the open-on-startup set attaches without stealing the manager's place). */
function attachService(def: ServiceDef): ServiceHost {
  const l = loft!;
  const host = l.attach(def);
  tray?.addService({ id: def.id, displayName: def.displayName, dnd: config.services[def.id]?.dnd ?? false });
  tray?.setRunning(def.id, true);
  tray?.setVisible(def.id, host.isVisible());
  // One window, N services: the Loft window's focus/visibility handlers only fire on
  // CHANGES from here on, so seed all three gate axes for this service now. `active` is
  // whatever the current selection says — attach never selects, so normally false.
  notifications?.setVisible(def.id, l.window.isVisible());
  notifications?.setFocused(def.id, l.window.isFocused());
  notifications?.setActive(def.id, l.activeId() === def.id);
  bgStatus?.refresh();
  notifyHub();
  return host;
}

/** Load a service into the host its config asks for. THE one place that decides where a
 *  service lives (spec §7); everything else asks hostOf where it ended up. */
function placeService(def: ServiceDef, minimized: boolean): ServiceHost {
  // First launch of a service implicitly Adds it (writes its launcher + icon) so a
  // directly-launched service shows up as Installed in the hub (spec §6f). Here rather
  // than in openService so an attached first launch installs itself too.
  if (!config.services[def.id]) {
    addService(def, config, { execPath: process.execPath, iconSourceDir });
    saveConfig(configPath(), config);
  }
  // No Loft window yet ⇒ its own window is the only host that exists. Reachable for real:
  // `second-instance` is bound at module scope, while whenReady can sit for minutes on
  // ensureGnomeHelper's install dialog — so a launcher click during first-run setup lands
  // here. That service then keeps its own window for the session even though it isn't
  // configured detached (the rail draws it ⧉ and the menu's checkbox reads unticked, since
  // that follows config). Recoverable: Unload it, then click it again. Degrading to a real
  // window beats refusing to open the service at all.
  if (wantsOwnWindow(def.id) || !loft) return openService(def, minimized);
  return attachService(def);
}

/** Make a service visible wherever it lives, loading it if it is asleep. The single entry
 *  point for "show me X" — CLI, second-instance, tray, hub, D-Bus and notification clicks
 *  all land here, so none of them can spawn a second window for an attached service. */
function showService(def: ServiceDef): ServiceHost {
  const host = hostOf(def.id) ?? placeService(def, false);
  host.show();
  // Bypass focus-stealing prevention on the window it actually lives in (spec §6a).
  const key = hostKey(def.id);
  if (key) focusExternal(key);
  return host;
}

// Tray menu "Show/Hide" for a service: show if hidden, hide if visible.
function toggleService(id: string): void {
  const host = hostOf(id);
  // Attached: "visible" means the Loft window is up AND this is the selected tab, so an
  // unselected tab toggles to selected rather than hiding the window it is sitting in.
  if (host && host.isVisible()) {
    host.hide();
    const key = hostKey(id);
    if (key) hideExternal(key);
    return;
  }
  const def = getService(id);
  if (def) showService(def);
}

// Persist a service's DND to config immediately (survives a kill before before-quit).
function setServiceDnd(id: string, enabled: boolean): void {
  config.services[id] = { ...config.services[id], dnd: enabled };
  saveConfig(configPath(), config);
  loft?.refreshRail();
  notifyHub();
}

/** Apply + persist a per-service settings patch, then re-push everything it changes.
 *  Shared by the hub's IPC and the rail's context menu, so the two cannot drift: a menu
 *  that only wrote config would leave the tray icon and the notification gate stale. */
function setServiceSetting(id: string, patch: ServicePatch): void {
  config.services[id] = { ...config.services[id], ...patch };
  saveConfig(configPath(), config);
  // No hostOf(id)?.pushDnd(patch.dnd) here: setServiceDnd already pushes the EFFECTIVE
  // value (system || global || this service) into the page, and re-pushing the raw flag
  // on top of it would tell a page that global DND is off whenever a service's own DND
  // is — main still swallows the banner, but the web app's in-page ding would play.
  if (patch.dnd !== undefined) { tray?.setDnd(id, patch.dnd); notifications?.setServiceDnd(id, patch.dnd); }
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
  loft?.refreshRail();
  notifyHub();
}

/** Stop a service: unload its view (attached) or destroy its window (detached). It stays
 *  configured, so it drops to sleeping in the rail and into the tray's available section.
 *  This is D-Bus Quit(), the tray's per-service Quit, and the rail menu's Unload — spec
 *  §6b: Quit() already meant exactly "unload", so the rail needed no new verb. */
function quitService(id: string): void {
  // ORDERING: loft.unload picks the next tab by locating `id` in the ATTACHED list, so it
  // must run before anything flips this service's `detached` flag — see the ordering
  // contract on LoftWindow.detach.
  if (loft?.has(id)) loft.unload(id);
  else {
    const sw = windows.get(id);
    if (!sw) return; // not loaded anywhere — nothing to stop
    windows.delete(id);
    sw.window.destroy();
  }
  syncLoftWindows();
  tray?.setRunning(id, false);
  tray?.setVisible(id, false);
  // Spec §7: an unloaded view has no unread count. A stale one would leave the tray
  // overlay (and `Loft (7)`) claiming messages nothing is watching for any more.
  currentBadge.delete(id);
  tray?.setBadge(id, 0);
  bgStatus?.refresh();
  loft?.refreshRail();
  notifyHub();
}

/**
 * Move a service between the rail and its own window, and remember which (spec §3).
 *
 * FALLBACK (09b, explicitly permitted by the plan): this unloads and reloads rather than
 * moving the live view, so the service loses its scroll position and any half-typed
 * draft. `LoftWindow.detach()` does hand back a still-live `ServiceView`, but nothing can
 * accept one — `createServiceWindow` always builds its own, and there is no re-attach
 * path at all — so a live move would work in one direction only and still reload coming
 * back. 09c owns the gesture-driven version: give `createServiceWindow` an optional
 * pre-built view and `LoftWindow.attach` the same, and this becomes detach()/attach(view).
 */
function setDetached(id: string, v: boolean): void {
  const def = getService(id);
  // `detached` is absent-means-false, so compare the normalised flag, not the raw one:
  // `undefined === false` is false, and this must be a no-op when nothing changes.
  if (!def || (config.services[id]?.detached === true) === v) return;
  const host = hostOf(id);
  const loaded = host !== undefined;
  const wasVisible = host?.isVisible() ?? false;
  // Take the view out FIRST, while config still says what it said (see the ordering note
  // in quitService), THEN flip the flag, THEN re-place it in its new home.
  if (loaded) quitService(id);
  config.services[id] = { ...config.services[id], detached: v };
  saveConfig(configPath(), config);
  if (loaded) {
    // Place it where the user just asked, rather than letting placeService derive it:
    // `reopenDetached: false` governs STARTUP only (spec §7), so deriving here would
    // silently re-attach the very service they asked to pop out — and leave a ticked
    // "Open in its own window" next to a service that is visibly still a tab.
    if (v || !loft) openService(def, true); else attachService(def);
    if (wasVisible) showService(def); // it was on screen — keep it there
  }
  loft?.refreshRail();
  notifyHub();
}

/** The per-service menu (rail right-click). Spec §7: every per-service action lives here.
 *  Built in main so it renders as a real menu and drives the same code the tray does. */
function buildServiceMenu(id: string): Electron.MenuItemConstructorOptions[] {
  const def = getService(id);
  const cfg = config.services[id] ?? {};
  return [
    { label: `Go to ${def?.displayName ?? id}`, click: () => { if (def) showService(def); } },
    { type: 'separator' },
    { label: 'Do Not Disturb', type: 'checkbox', checked: cfg.dnd === true,
      click: (mi) => setServiceSetting(id, { dnd: mi.checked }) },
    { label: 'Show badge', type: 'checkbox', checked: cfg.badgesEnabled !== false,
      click: (mi) => setServiceSetting(id, { badgesEnabled: mi.checked }) },
    { type: 'separator' },
    { label: 'Open in its own window', type: 'checkbox', checked: cfg.detached === true,
      click: (mi) => setDetached(id, mi.checked) },
    { label: 'Unload', enabled: hostOf(id) !== undefined, click: () => quitService(id) },
    { type: 'separator' },
    { label: 'Settings…', click: () => { loft?.showManager(); loft?.open(); loft?.sendManager('manager:select', id); } },
  ];
}

/**
 * The selected tab changed. Nothing else can tell the notification gate: a tab switch
 * fires no window event at all, so without this every background tab keeps looking
 * focused+visible and silently stops notifying (spec §6d — it fails as absence, which is
 * why it is wired explicitly rather than left to the window handlers).
 */
function syncActiveTab(activeId: string | undefined): void {
  for (const id of loft?.ids() ?? []) {
    notifications?.setActive(id, id === activeId);
    // The tray's Show/Hide label asks "is this service on screen?" — for a tab that means
    // the window is up AND it is the selected one.
    tray?.setVisible(id, (loft?.window.isVisible() ?? false) && id === activeId);
  }
  // A service in its own window has no other tab to be behind — always active.
  for (const id of windows.keys()) notifications?.setActive(id, true);
}

// Global DND: persist + reflect in the tray (notification gating is Stage 3b).
function setGlobalDnd(enabled: boolean): void {
  config.globalDnd = enabled;
  saveConfig(configPath(), config);
  tray?.setGlobalDnd(enabled);
  notifyHub();
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
  // IPC handler's own notifyHub()) can read a not-yet-written autostart entry
  // and show a spurious "Loft was denied permission to start at login" warning
  // while the portal dialog is still pending. Safe: syncAutostart is documented to
  // never reject.
  void syncAutostart(wants, { execPath: process.execPath, iconSourceDir })
    .then(() => notifyHub());
}

function resolveServiceFromArgs(argv: string[]): ServiceDef | undefined {
  const { service } = parseArgs(argv);
  return service ? getService(service) : undefined;
}

// Titlebar/badge/notify IPC comes from a view's preload; map the sender's webContents id
// back to the ServiceHost that owns it — either kind of host.
function findBySenderId(senderId: number): ServiceHost | undefined {
  for (const sw of windows.values()) {
    if (sw.ownsWebContents(senderId)) return sw;
  }
  const id = loft?.ids().find((i) => loft!.hostOf(i)!.ownsWebContents(senderId));
  return id ? loft!.hostOf(id) : undefined;
}

// The Loft window's rail/titlebar/manager views belong to the WINDOW, not to any one
// service, so no ServiceHost owns them and findBySenderId cannot see them. Checked
// after findBySenderId, never before: loft.ownsWebContents is also true for its own
// attached service views, and those must resolve to their own host.
const isLoftChrome = (senderId: number): boolean =>
  loft !== undefined && loft.ownsWebContents(senderId) && findBySenderId(senderId) === undefined;

// Where a titlebar action lands: a per-service window's titlebar acts on its own service;
// the Loft window's single titlebar acts on whichever service is SELECTED.
function titlebarTarget(senderId: number): ServiceHost | undefined {
  if (!isLoftChrome(senderId)) return findBySenderId(senderId);
  const id = loft!.activeId();
  return id ? loft!.hostOf(id) : undefined;
}

// Single-instance: a second launch routes its --service to us; the second process
// hits app.quit() below and never registers the owner handlers.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const def = resolveServiceFromArgs(argv);
    // Same two branches as the CLI below — a second launch must never build a duplicate
    // window for a service that is already living somewhere.
    if (def) { showService(def); return; }
    // Raise the Loft window WITHOUT touching its selection — unlike the CLI's no-service
    // branch further down, this is "bring it back", not "start fresh". showManager() is
    // only correct there (a brand-new window has nothing selected, so the manager IS the
    // right first face); here it would silently throw away whatever tab was selected
    // before the window got hidden to the tray — and hiding-then-relaunching is the
    // normal way back (the GNOME helper deliberately hides hidden Loft windows from the
    // dock). Only fall back to the manager when nothing IS selected (e.g. every service
    // is asleep), so raising still shows something sensible.
    if (!loft?.activeId()) loft?.showManager();
    loft?.open();
    focusExternal(LOFT_WINDOW_KEY); // bypass focus-stealing prevention (spec §6a), same as showService.
  });

  ipcMain.on('titlebar:zoom-in', (e) => titlebarTarget(e.sender.id)?.setZoom(+0.1));
  ipcMain.on('titlebar:zoom-out', (e) => titlebarTarget(e.sender.id)?.setZoom(-0.1));
  // Close IS hide (CLAUDE.md). On the Loft window that means the window itself: routing it
  // to the active service's host.hide() would do the same thing today, but reads as a
  // per-service action and stops working the moment nothing is selected (the manager).
  ipcMain.on('titlebar:close', (e) => {
    if (isLoftChrome(e.sender.id)) { loft!.hide(); return; }
    findBySenderId(e.sender.id)?.hide();
  });
  ipcMain.on('titlebar:reload', (e) => titlebarTarget(e.sender.id)?.reload());
  // Recovery overlays belong to a service view, so findBySenderId resolves them in either
  // host kind — no active-tab fallback wanted here.
  ipcMain.on('recovery:reload', (e) => findBySenderId(e.sender.id)?.reload());
  ipcMain.on('recovery:clear-and-reload', (e) => { void findBySenderId(e.sender.id)?.clearAndReload(); });

  // Rail click = go to that service, loading it where it belongs if it is asleep and
  // raising its own window if it is detached. Right-click = the per-service menu.
  ipcMain.on('rail:select', (_e, id: string) => { const d = getService(id); if (d) showService(d); });
  ipcMain.on('rail:menu', (_e, id: string) => loft?.popServiceMenu(id));
  ipcMain.on('rail:showManager', () => loft?.showManager());

  // --- hub:* — the manager view (src/renderer/hub) ----------------------------------
  // Owned here, not by the window hosting the manager: these drive main's own state
  // (config, hosts, autostart, the app's lifetime), which is why they outlived the
  // standalone hub window they used to ship with. Registered at module scope with the rest
  // of the IPC on purpose — the manager view loads during whenReady and invokes
  // hub:getState the moment it does, so the handler has to be there already. Channel names
  // and payload shapes are the renderer's contract (src/preload/hub.ts) — don't reshape
  // them here.
  ipcMain.handle('hub:getState', () => hubState());

  // Select the tab rather than open a window: the manager is a tab in the same window as
  // the services now, so its "Open" means exactly what a rail click means. Routed through
  // rail:select so the two cannot drift into two answers for one question.
  ipcMain.on('hub:openService', (_e, id: string) => { ipcMain.emit('rail:select', null, id); });

  ipcMain.on('hub:addService', (_e, m: { id: string; customUrl?: string }) => {
    const d = getService(m.id); if (!d) return;
    addService(d, config, { execPath: process.execPath, iconSourceDir, customUrl: m.customUrl });
    saveConfig(configPath(), config);
    loft?.refreshRail(); // the rail lists every INSTALLED service

    // Deliberately no reconcileAutostart() here: addService only ever sets
    // customUrl and never touches openOnStartup, so wantsAutostart() cannot
    // change as a result of an add — the call would be a guaranteed no-op.
    // Under Flatpak it would still fire a real RequestBackground portal
    // request (and can pop an unwanted "let Loft run in the background?"
    // dialog) on every "Add service" click, including the first service
    // added to a fresh install. Don't add it back.
    notifyHub();
  });

  ipcMain.on('hub:removeService', (_e, m: { id: string; deleteData: boolean }) => {
    const d = getService(m.id); if (!d) return;
    quitService(m.id); // tear down a running view/window first
    removeService(d, config, m.deleteData);
    saveConfig(configPath(), config);
    reconcileAutostart();
    loft?.refreshRail(); // it is no longer installed, so it leaves the rail
    notifyHub();
  });

  ipcMain.on('hub:setServiceSetting', (_e, m: { id: string; patch: ServicePatch }) => {
    setServiceSetting(m.id, m.patch);
    notifyHub();
  });

  ipcMain.on('hub:setGlobal', (_e, patch: GlobalPatch) => {
    if (patch.trayBackend !== undefined) { config.trayBackend = patch.trayBackend; saveConfig(configPath(), config); }
    notifyHub();
  });

  ipcMain.on('hub:recoverService', (_e, m: { id: string; opts: RecoverOpts }) => {
    const host = hostOf(m.id);
    // clearCaches:false with no running host (host undefined) is a deliberate
    // no-op: there's nothing to reload and nothing to clear. Unreachable today
    // (the hub only ever sends true), kept for API completeness.
    if (!m.opts.clearCaches) { host?.reload(); return; }
    // Works whether or not the service is running: with no host we still clear,
    // so the next launch loads clean.
    if (host) { void host.clearAndReload(); return; }
    void clearServiceCaches(session.fromPartition(`persist:${m.id}`));
  });

  ipcMain.on('hub:quit', () => { quitting = true; app.quit(); });

  ipcMain.on('service:badge', (e, payload?: { count?: number }) => {
    if (typeof payload?.count !== 'number') return;
    const sw = findBySenderId(e.sender.id);
    if (!sw) return;
    currentBadge.set(sw.def.id, payload.count);
    bgStatus?.refresh();
    // The rail draws a count for every LOADED service, detached ones included, and
    // sw.setBadge below only reaches the rail when the service is attached — a detached
    // service's rail entry would otherwise sit stale until something else repainted it.
    // Above the badgesEnabled return on purpose: the rail model does its own gating.
    loft?.refreshRail();
    notifyHub();
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
          // Route through hostOf() so reimplementing for a shared host requires only one change
          running: hostOf(d.id) !== undefined,
          visible: hostOf(d.id)?.isVisible() ?? false,
        }));
      const deps: TrayDeps = {
        configuredServices: configured,
        globalDnd: config.globalDnd ?? false,
        onToggleService: (id) => toggleService(id),
        onLaunchService: (id) => { const d = getService(id); if (d) showService(d); },
        onQuitService: (id) => quitService(id),
        onToggleDnd: (id, enabled) => { setServiceDnd(id, enabled); tray?.setDnd(id, enabled); notifications?.setServiceDnd(id, enabled); },
        onToggleGlobalDnd: (enabled) => { setGlobalDnd(enabled); notifications?.setGlobalDnd(enabled); },
        // "Settings…" = show the manager tab, not a window of its own — same as the rail
        // menu's Settings… and the D-Bus ShowHub().
        onShowHub: () => { loft?.showManager(); loft?.open(); focusExternal(LOFT_WINDOW_KEY); },
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
        tray.setVisible(id, sw.isVisible());
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
        // Spec §6d: resolve the host → load it where it belongs if sleeping → select the
        // tab or raise the window. Never openService: a click on an attached service's
        // notification would then spawn a second, detached window for it.
        focusService: (id) => { const d = getService(id); if (d) showService(d); },
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
        notifications.setVisible(id, sw.isVisible());
        notifications.setFocused(id, sw.window.isFocused());
        notifications.setActive(id, true); // its own window: nothing to be behind
      }
    } catch (err) {
      console.error('Failed to start notifications:', err);
    }

    // GNOME Settings → Apps status line ("N services running" / "X: N unread"
    // via org.freedesktop.portal.Background). GNOME only — no equivalent on
    // other DEs.
    if (gnome) {
      bgStatus = startBackgroundStatus({
        // Every loaded service, attached or detached: the status line describes the app,
        // not one window (spec §6a — same reasoning as the tray's aggregate overlay).
        collect: () => allHosts().map((h) => ({
          displayName: h.def.displayName,
          // A badges-disabled service doesn't contribute its unread count to the
          // aggregate status line (still counts as a running service).
          badge: config.services[h.def.id]?.badgesEnabled === false ? 0 : (currentBadge.get(h.def.id) ?? 0),
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

    // The unified window (spec 09 §2): manager + rail + every attached service. It exists
    // on every launch path, shown or not — its startup set loads into it either way.
    // Ordering: after migrateConfig, because the rail is built from config. The manager view
    // it mounts is the hub renderer, which invokes hub:getState the moment it loads — that
    // handler is registered at module scope above, so it is already there.
    loft = createLoftWindow({
      cfg: config,
      services: [...SERVICES], // the registry is readonly; the rail wants a plain array
      onQuit: () => quitting,
      badge: (id) => currentBadge.get(id) ?? 0,
      detached: isDetached,
      loadedElsewhere: (id) => windows.has(id),
      buildServiceMenu,
      onActiveChanged: syncActiveTab,
      onServiceLoad: (id) => notifications?.registerService(id),
      railPreload: join(__dirname, '..', 'preload', 'rail.js'),
      railHtml: join(__dirname, '..', 'renderer', 'rail', 'index.html'),
      titlebarPreload: join(__dirname, '..', 'preload', 'titlebar.js'),
      titlebarHtml: join(__dirname, '..', 'renderer', 'titlebar', 'index.html'),
      managerPreload: join(__dirname, '..', 'preload', 'hub.js'),
      managerHtml: join(__dirname, '..', 'renderer', 'hub', 'index.html'),
      iconPath: join(iconSourceDir, 'loft.png'),
    });
    // 'Loft' is now one of the windows the GNOME helper hides while minimized.
    syncLoftWindows();
    // One window, N services: its focus and visibility belong to every attached service at
    // once, so fan each event out across the whole tab set. These fire on CHANGES only —
    // attachService seeds a newly-attached service — and a tab SWITCH fires none of them,
    // which is what syncActiveTab exists for.
    loft.window.on('focus', () => { for (const id of loft!.ids()) notifications?.setFocused(id, true); });
    loft.window.on('blur', () => { for (const id of loft!.ids()) notifications?.setFocused(id, false); });
    loft.window.on('show', () => {
      for (const id of loft!.ids()) {
        notifications?.setVisible(id, true);
        tray?.setVisible(id, loft!.activeId() === id); // on screen = shown AND selected
      }
    });
    loft.window.on('hide', () => {
      for (const id of loft!.ids()) { notifications?.setVisible(id, false); tray?.setVisible(id, false); }
    });

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
    // Load every service flagged open-on-startup, each into the host its config asks for.
    // DELIBERATE CHANGE (spec §6f): this loop used to live in the `--service`-less branch, so
    // launching WhatsApp from its own launcher started only WhatsApp. The Loft window now
    // exists on every launch path, so its startup set loads on every launch path too.
    // Users who relied on a per-service launcher starting only that service will notice.
    for (const id of Object.keys(config.services)) {
      if (!config.services[id]?.openOnStartup) continue;
      const d = getService(id);
      if (d && !hostOf(id)) placeService(d, true);
    }
    if (def) {
      // "Go to X", not "open a window for X" — X may already be a tab in the rail.
      if (!hostOf(def.id)) placeService(def, args.minimized);
      if (!args.minimized) showService(def);
    } else if (!args.minimized) {
      // No --service: the Loft window is the app's home surface, showing the manager.
      loft!.showManager();
      loft!.open();
    }

    // chat.loft.Loft D-Bus service (parity/scripting; also the target of the
    // GNOME-panel tray menu callbacks). A busy bus name (a leftover/second
    // instance) must not crash startup.
    try {
      const loftDeps: LoftServiceDeps = {
        // Spec §6b: only the referent of "this service" widens to "this service's host" —
        // Show() on an attached service selects its tab and raises Loft; Hide() hides the
        // Loft window, and with it every other attached service (the documented wart).
        show: (id) => { const d = getService(id); if (d) showService(d); },
        hide: (id) => {
          const host = hostOf(id);
          if (!host) return;
          host.hide();
          const key = hostKey(id);
          if (key) hideExternal(key);
        },
        toggle: (id) => toggleService(id),
        quitService: (id) => quitService(id),
        getStatus: (id) => {
          const sw = hostOf(id);
          const visible = sw?.isVisible() ?? false;
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
        showHub: () => { loft?.showManager(); loft?.open(); focusExternal(LOFT_WINDOW_KEY); },
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
    releaseOsResources();
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
  const fastExit = createSignalShutdown({
    persist: () => { persistAll(); releaseOsResources(); },
    exit: () => app.exit(0),
  });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, fastExit);
}

/** Persist every open window's bounds/zoom and flush config. Shared by the in-app quit
 *  path (before-quit) and the session-end signal handler. Not allHosts(): persist() is
 *  window-shaped (bounds), so it is deliberately off ServiceHost — a tab has no bounds
 *  of its own, and the Loft window persists its own plus every attached service's zoom. */
function persistAll(): void {
  for (const sw of windows.values()) sw.persist();
  loft?.persist();
  saveConfig(configPath(), config);
}

/**
 * Kill OS resources that outlive the process. Runs on BOTH exit paths: before-quit does
 * not fire for app.exit(0), which is exactly what the session-end handler above uses.
 *
 * Currently just the system-DND watcher, whose GNOME backend spawns a `gsettings monitor`
 * child. Node does not reap spawned children on exit, and `gsettings monitor` only notices
 * its closed stdout when it next writes — which may be never. Leaking it is not cosmetic:
 * under Flatpak the surviving child holds bwrap open, so the app's flatpak instance never
 * exits. GNOME Shell then still sees Loft as running and ACTIVATES it on an icon click
 * rather than launching it — the app becomes unstartable until the corpse is killed by
 * hand, with nothing on screen to explain why.
 *
 * Best-effort and never throws: an exit path must always reach its exit().
 */
function releaseOsResources(): void {
  try {
    notifications?.close();
  } catch (e) {
    console.error('releaseOsResources failed:', (e as Error)?.message ?? e);
  }
}
