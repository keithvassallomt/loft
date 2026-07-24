import { app, ipcMain, Menu, protocol, session } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from './cli';
import { getKind, listKinds, KINDS, ServiceKind, effectiveUrl } from './registry';
import { loadConfig, saveConfig, configPath, LoftConfig, reopenDetachedEnabled } from './config';
import { createServiceWindow, ServiceWindow } from './serviceWindow';
import { createLoftWindow, LOFT_WINDOW_KEY, type LoftWindow } from './loftWindow';
import type { ServiceHost } from './serviceHost';
import type { ServiceView } from './serviceView';
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
import { registerHubIpc } from './hubIpc';
import { addInstance, removeInstance } from './install';
import { syncAutostart, isAutostartEnabled, wantsAutostart, removeLegacyAutostart } from './autostart';
import { createSignalShutdown } from './shutdown';
import { ensureHubDesktopEntry, writeServiceLauncher, removeServiceLauncher, reconcileServiceLaunchers, serviceLauncherPath } from './desktop';
import { dbusSegmentFor, type ServiceInstance } from './instances';
import { iconsDir } from './paths';
import { migrateConfig } from './migrate';
import { RAIL_WIDTH, type Rect } from './layout';
import { railDragOutcome } from './railDrag';
import { railGestureAction, RAIL_SHOW } from './railGesture';
import { railSlotIndex, type RailSlot } from './railSlots';
import { moveInOrder } from './railOrder';
import { orderedRailIds } from './railModel';
import {
  GRID_ID, services as gridServicesOf, prune, validGridServices, autoPlace, isActiveSelection,
  type GridNode,
} from './gridTree';
import { computeGridLayout, splittableSizes, hasSplittableCell } from './gridLayout';
import { beginGutterDrag, type GutterDrag } from './gutterDrag';
import { gridDropPlan, type GridDropPlan } from './gridDrop';
import type { HubState, ServicePatch } from '../shared/hubTypes';

// Instance resolution goes here in Task 10. Today a "service" is still a registry kind,
// so this shim keeps ~28 call sites stable across that switch.
const getService = (id: string): ServiceKind | undefined => getKind(id);
const listServices = (): readonly ServiceKind[] => listKinds();

// TEMPORARY (Task 6 → replaced in Task 10): index.ts still deals in kinds, but
// writeServiceLauncher/removeServiceLauncher now want an instance (Task 6). Fake up a
// bare-kind instance (account #1: id = kind id, brand icon) so this file compiles until
// Task 10 makes index.ts instance-aware for real.
const asInstance = (d: ServiceKind): ServiceInstance =>
  ({ ...d, kind: d.id, dbusSegment: d.displayName.replace(/\s+/g, ''), icon: 'brand' });

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

/**
 * Reconcile the persisted grid against the registry, once, before anything can render it
 * (grid-view spec §6). config.json is hand-editable and the tree names services by id, so a
 * leaf outlives the service it names: removed, never installed, or since marked detached —
 * whose view belongs to its own window, leaving nothing here to tile. Such a leaf comes back
 * as a cell on every launch that the user cannot clear from the UI, so drop it here rather
 * than let it reach a view. Registry-aware, which is exactly what config.ts's load-time
 * validation cannot be: that pass knows the tree's shape, not which services exist.
 *
 * Persisted only on a real change — prune returns the tree by identity for a no-op, so a
 * config with a clean grid (or no `grid` key at all) is never rewritten.
 */
const gridBefore = config.grid ?? null;
const gridPruned = prune(
  gridBefore,
  validGridServices(KINDS, (id) => config.services[id] !== undefined, wantsOwnWindow),
);
if (gridPruned !== gridBefore) {
  config.grid = gridPruned;
  console.log('Pruned grid leaves for removed or detached services');
  // In-memory is what this launch renders; a failed write only costs the next launch the
  // same prune, so an unwritable config must not take startup down with it.
  try { saveConfig(configPath(), config); }
  catch (err) { console.error('Failed to persist pruned grid:', err); }
}

/**
 * Say so when config.json names a service the registry has never heard of. sanitizeService-
 * Config whitelists such an entry to `{}` — correct, and deliberately silent about it — so a
 * typo'd or renamed id installs a service that has no icon, no URL and no rail entry, with
 * nothing anywhere to say why. Naming the ids is the whole fix; nothing is removed, because
 * the entry is harmless and a future/rolled-back registry may well claim it again.
 */
const phantomServices = Object.keys(config.services).filter((id) => !getService(id));
if (phantomServices.length > 0) {
  console.warn(
    `Ignoring unknown service(s) in config.json: ${phantomServices.join(', ')} — no such service in the registry`,
  );
}

// Does this service live in its own window? Answered from where it ACTUALLY is whenever
// it's loaded, and only from config while it sleeps. Not the same as the config flag:
// with reopenDetached off, a `detached: true` service sits in the rail, and claiming
// otherwise would make its tab unselectable (loftWindow.select refuses a detached id).
const isDetached = (id: string): boolean => {
  if (windows.has(id)) return true;
  if (loft?.has(id)) return false;
  return wantsOwnWindow(id);
};

/**
 * Is the user looking at this service right now? — the `active` axis of the notification
 * gate, and the one term that a shared host makes non-trivial.
 *
 * True for the selected tab, for a service in its own window (nothing to be behind), and for
 * EVERY cell while the grid is the selection: they are all on screen and the user can see
 * them all, so all of them suppress (grid-view spec §7.5).
 *
 * The FOCUSED cell is deliberately absent. Cell focus is a zoom target, not an attention
 * signal; folding it in here would leave the other two cells of a three-cell grid raising
 * banners for conversations the user is looking straight at.
 */
const isActiveService = (id: string): boolean => {
  if (windows.has(id)) return true;
  if (!loft) return false;
  return isActiveSelection(loft.activeId(), config.grid ?? null, id);
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
    services: KINDS,
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
function openService(def: ServiceKind, minimized: boolean, view?: ServiceView): ServiceHost {
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
  const sw = createServiceWindow(def, config, { minimized, onQuit: () => quitting, view });
  // Keep the tray's visibility state in sync with the window (drives Show/Hide label).
  sw.window.on('show', () => tray?.setVisible(def.id, true));
  sw.window.on('hide', () => tray?.setVisible(def.id, false));
  // Notification gate: focus/visibility feed shouldNotify()/pushHidden(); a
  // fresh (re)load re-registers the service so the view gets current DND/hidden.
  sw.window.on('focus', () => notifications?.setFocused(def.id, true));
  sw.window.on('blur', () => notifications?.setFocused(def.id, false));
  sw.window.on('show', () => notifications?.setVisible(def.id, true));
  sw.window.on('hide', () => notifications?.setVisible(def.id, false));
  sw.setOnLoad(() => notifications?.registerService(def.id));
  windows.set(def.id, sw);
  // A moved view keeps its scraped count (no reload), but a fresh window title starts at the
  // plain name — seed it from currentBadge so it isn't briefly countless.
  sw.setBadge(config.services[def.id]?.badgesEnabled === false ? 0 : (currentBadge.get(def.id) ?? 0));
  syncLoftWindows();
  focusExternal(def.displayName);
  tray?.addService({ id: def.id, displayName: def.displayName, segment: dbusSegmentFor(def.id, config), dnd: config.services[def.id]?.dnd ?? false });
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
function attachService(def: ServiceKind, view?: ServiceView): ServiceHost {
  const l = loft!;
  const host = l.attach(def, view);
  tray?.addService({ id: def.id, displayName: def.displayName, segment: dbusSegmentFor(def.id, config), dnd: config.services[def.id]?.dnd ?? false });
  tray?.setRunning(def.id, true);
  tray?.setVisible(def.id, host.isVisible());
  // One window, N services: the Loft window's focus/visibility handlers only fire on
  // CHANGES from here on, so seed all three gate axes for this service now. `active` and
  // `visible` are whatever the current selection says — attach never selects, so normally
  // false, except on the grid's own wake path (ensureAttached runs with the grid already
  // selected and this service already a leaf, so it arrives on screen).
  notifications?.setVisible(def.id, host.isVisible());
  notifications?.setFocused(def.id, l.window.isFocused());
  notifications?.setActive(def.id, isActiveService(def.id));
  bgStatus?.refresh();
  notifyHub();
  return host;
}

/** Load a service into the host its config asks for. THE one place that decides where a
 *  service lives (spec §7); everything else asks hostOf where it ended up. */
function placeService(def: ServiceKind, minimized: boolean): ServiceHost {
  // First launch of a service implicitly Adds it (marks it configured and deploys its
  // icon, per opt-in-off launcher default — no launcher write here) so a directly-launched
  // service shows up as Installed in the hub (spec §6f). Here rather than in openService so
  // an attached first launch installs itself too.
  if (!config.services[def.id]) {
    addInstance(def, config, { iconSourceDir });
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
/**
 * `preferCell: false` means "switch to this service", not "bring it to my attention".
 *
 * The two are different intents and only the rail has the second one. D-Bus Show(), the
 * tray and a notification click are all saying "reveal X" — and a gridded X is already
 * revealed, so its cell is the honest answer. A rail click is the user choosing what to
 * look at, and spec D2 is explicit that grid membership and rail selection are independent
 * facts: clicking a rail icon always shows that service full-size and merely deselects the
 * grid, whose arrangement is untouched and repopulates when Grid is selected again. Routing
 * the rail through the cell branch would make removing the cell the only way to see a
 * gridded service full-size.
 */
function showService(def: ServiceKind, opts: { preferCell?: boolean } = {}): ServiceHost {
  const preferCell = opts.preferCell ?? true;
  // A gridded service already has somewhere to be shown: its cell. Select the grid and make
  // that cell the focused one instead of handing the service the whole content rect — which
  // would take the other cells off screen to show something that was already on it. The
  // deep-link navigation a notification click does runs after this returns, so it still
  // opens the right conversation.
  //
  // showGrid() wakes a sleeping leaf on the way (placeGridCells → ensureAttached), so this
  // covers "show a gridded service that is not loaded yet" too.
  if (preferCell && loft && !isDetached(def.id) && gridServicesOf(config.grid ?? null).includes(def.id)) {
    loft.showGrid();
    loft.setFocusedCell(def.id);
    loft.open();
    focusExternal(LOFT_WINDOW_KEY); // bypass focus-stealing prevention (spec §6a)
    const cell = loft.hostOf(def.id);
    if (cell) return cell;
    // ensureAttached declined — the service was uninstalled under a running grid, and the
    // leaf has not been pruned yet. Fall through and place it properly rather than return a
    // host that does not exist.
  }
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
  // A launcher toggle takes effect now, not just on next launch. writeServiceLauncher no-ops
  // under a dev run; removeServiceLauncher clears an existing file.
  if (patch.launcher !== undefined) {
    const d = getService(id);
    if (d) {
      if (patch.launcher) writeServiceLauncher(asInstance(d), { execPath: process.execPath, iconSourceDir });
      else removeServiceLauncher(asInstance(d));
    }
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
 * MOVES the live ServiceView across (09c-2a) rather than unloading + reloading, so the
 * service keeps its scroll position, half-typed drafts, and any in-progress call. The
 * view is taken out of its current host WITHOUT being disposed, then re-mounted in the
 * new one. If for any reason no live view comes back (`moved` undefined), the re-place
 * builds a fresh one — a safe degradation to the old reload behaviour, never a crash.
 */
function setDetached(id: string, v: boolean): void {
  const def = getService(id);
  // `detached` is absent-means-false: compare the normalised flag so this is a no-op when
  // nothing changes.
  if (!def || (config.services[id]?.detached === true) === v) return;
  const host = hostOf(id);
  const loaded = host !== undefined;
  const wasVisible = host?.isVisible() ?? false;

  // Take the LIVE view out of its current home, without disposing it. Do this BEFORE flipping
  // the flag (the ordering note in quitService): loft.detach locates `id` in the attached list.
  let moved: ServiceView | undefined;
  if (loaded) {
    if (loft?.has(id)) {
      moved = loft.detach(id);              // unmount, drop from the rail, re-select next tab
    } else {
      const sw = windows.get(id);
      if (sw) { moved = sw.releaseView(); windows.delete(id); } // unmount + tear down shell, keep view
    }
    syncLoftWindows();                       // the open-window set changed
  } else if (v) {
    // A SLEEPING service has no view to take out, so it never reaches loft.detach and its
    // prune. Its leaf would survive as a cell for a service that is now detached — the one
    // state grid-view spec §7.1 forbids — so drop it through the same implementation.
    loft?.dropFromGrid(id);
  }

  config.services[id] = { ...config.services[id], detached: v };
  saveConfig(configPath(), config);

  if (loaded) {
    // Place where the user just asked (reopenDetached governs STARTUP only), handing the
    // live view across so nothing reloads.
    if (v || !loft) openService(def, !wasVisible, moved); else attachService(def, moved);
    // A moved view fires no did-finish-load, so the DND/hidden re-push that binding does
    // (openService's did-finish-load → registerService, and attach's onServiceLoad) never
    // runs — do it explicitly for the new host. (visible/focused/active are already re-seeded
    // by openService/attachService.)
    notifications?.registerService(id);
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
    // RAIL_SHOW: this menu hangs off a rail icon, so "Go to X" is the same intent as clicking
    // that icon — full-size, grid merely deselected (spec D2) — not "reveal X in its cell".
    { label: `Go to ${def?.displayName ?? id}`, click: () => { if (def) showService(def, RAIL_SHOW); } },
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
 * The titlebar's ＋ menu while the grid is selected: every service that could still take a
 * cell. Three exclusions, all of them states the grid cannot represent — not installed (no
 * view to tile), already a leaf (insert refuses a duplicate, so the item would do nothing),
 * and detached (its view lives in its own window; gridded and detached are mutually
 * exclusive, grid-view spec §7.1).
 *
 * Sleeping services are deliberately IN the list: grid membership means live (§6), and
 * adding one wakes it through the grid's own ensureAttached.
 *
 * An empty result becomes a single disabled item rather than an empty menu — an empty menu
 * pops as a stray one-pixel box on some desktops and reads as a broken button.
 *
 * A grid with no legal split left gets the same treatment for the same reason: a ＋ that
 * cannot place anything has to say so, not pop a list of services and then do nothing.
 */
function buildGridAddMenu(): Electron.MenuItemConstructorOptions[] {
  const inGrid = new Set(gridServicesOf(config.grid ?? null));
  const items = KINDS
    .filter((d) => config.services[d.id] !== undefined)
    .filter((d) => !inGrid.has(d.id) && !isDetached(d.id))
    .map((d) => ({ label: d.displayName, click: () => addToGrid(d.id) }));
  if (!items.length) return [{ label: 'Every service is already in the grid', enabled: false }];
  if (!gridHasRoom()) {
    return [{ label: 'No room for another cell — resize the window', enabled: false }];
  }
  return items;
}

/** Could ＋ place anything at all right now? The rule itself lives in gridLayout, where it
 *  is testable without a window; this only supplies the geometry. */
function gridHasRoom(): boolean {
  const content = loft?.contentRect();
  if (!content) return false;
  return hasSplittableCell(computeGridLayout(config.grid ?? null, content));
}

/** Put a service in the grid where autoPlace decides — measured against the cells as they
 *  are on screen right now, so ＋ splits whatever is actually biggest. Selects the grid
 *  too: the ＋ lives in the grid's own titlebar today, but a caller that adds from
 *  elsewhere should still land the user on the thing they just changed. */
function addToGrid(id: string): void {
  const content = loft?.contentRect();
  if (!content) return;
  // splittableSizes, not the raw cell sizes: it withholds any leaf whose split would break
  // the minimum, so ＋ obeys the same rule the drag preview draws with.
  const next = autoPlace(
    config.grid ?? null,
    id,
    splittableSizes(computeGridLayout(config.grid ?? null, content)),
  );
  // autoPlace returns the tree by reference when it declined (already gridded, or nothing
  // it was allowed to measure) — don't write a no-op over config, and don't repaint for
  // nothing.
  if (next === config.grid) return;
  config.grid = next;
  saveConfig(configPath(), config);
  // Selecting the grid wakes the new leaf (placeGridCells → ensureAttached) and repaints
  // every chrome view on the way out, including the rail's cell count — nothing else to
  // refresh here. Unconditional: the grid is normally already the selection (the ＋ lives
  // in its titlebar), and re-selecting it is what re-places the cells.
  loft?.showGrid();
}

/**
 * What a drag released at this point would do — the preview rect and the tree to commit — or
 * null when there is no legal drop. The rule itself lives in gridDrop.gridDropPlan, where it
 * is testable without a window; this only supplies the geometry and the current tree, and it
 * is the ONE thing every live preview and every release calls, so they cannot disagree.
 * Both gestures that can drop into the grid go through it: a rail icon being added, and a
 * cell being moved by its ⠿ handle (which is the MOVE case — gridDropPlan measures that
 * against the post-removal tree, and refuses the cell's own rect).
 *
 * `x`/`y` are window coordinates, which is what the rail already sends: the rail view's
 * origin IS the window origin (layout.ts), so its clientX/clientY map straight through
 * and computeGridLayout's rects are already in the same space. The grid chrome's own
 * coordinates start at the content rect instead, so its callers add that origin first.
 */
function planGridDrop(x: number, y: number, draggedId: string): GridDropPlan | null {
  const content = loft?.contentRect();
  if (!content) return null;
  return gridDropPlan({ x, y }, config.grid ?? null, content, draggedId);
}

/** Identity of a previewed rectangle, for deduping the pushes. pointermove fires far faster
 *  than the preview changes, and every push is an IPC round trip plus a native view
 *  visibility flip (and a re-raise) — see LoftWindow.showDropPreview. */
const previewKey = (r: Rect | null): string =>
  r === null ? 'none' : `${r.x},${r.y},${r.width},${r.height}`;

/**
 * The selected tab changed. Nothing else can tell the notification gate: a tab switch
 * fires no window event at all, so without this every background tab keeps looking
 * focused+visible and silently stops notifying (spec §6d — it fails as absence, which is
 * why it is wired explicitly rather than left to the window handlers).
 *
 * Every attached service, not just the two ends of the switch: moving into or out of the
 * grid changes the answer for several at once, so no single id could carry it. The
 * parameter is therefore unread — isActiveService and ServiceHost.isVisible re-derive it,
 * which keeps the grid's "every cell is on screen" rule in one place.
 */
function syncActiveTab(_activeId: string | undefined): void {
  for (const id of loft?.ids() ?? []) {
    notifications?.setActive(id, isActiveService(id));
    // "Is this service on screen?" — what the tray's Show/Hide label and the gate's
    // `visible` axis both ask. Read from the host rather than compared against the selected
    // id: selecting the grid puts N services on screen at once, and that rule lives in
    // ServiceHost.isVisible so it cannot have a second, drifting copy here.
    const onScreen = loft?.hostOf(id)?.isVisible() ?? false;
    notifications?.setVisible(id, onScreen);
    tray?.setVisible(id, onScreen);
  }
  // A service in its own window has no other tab to be behind — always active.
  for (const id of windows.keys()) notifications?.setActive(id, true);
  // Which services are on screen just changed, and the manager draws exactly that.
  notifyHub();
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

function resolveServiceFromArgs(argv: string[]): ServiceKind | undefined {
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
  // In the grid, several services are on screen at once, so "the selection" is not a
  // service — GRID_ID has no host. Zoom acts on the focused cell instead (spec §7.4).
  const id = loft!.activeId() === GRID_ID ? loft!.focusedCellId() : loft!.activeId();
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
  // The ＋ is only rendered while the titlebar's context is the grid, so no sender check
  // beyond that: the per-service windows' titlebars never show the button.
  ipcMain.on('titlebar:addToGrid', () => loft?.popGridAddMenu());
  ipcMain.on('titlebar:attach', (e) => {
    const id = titlebarTarget(e.sender.id)?.def.id;
    if (id) setDetached(id, false);
  });
  // Recovery overlays belong to a service view, so findBySenderId resolves them in either
  // host kind — no active-tab fallback wanted here.
  ipcMain.on('recovery:reload', (e) => findBySenderId(e.sender.id)?.reload());
  ipcMain.on('recovery:clear-and-reload', (e) => { void findBySenderId(e.sender.id)?.clearAndReload(); });

  // Rail click = go to that service, loading it where it belongs if it is asleep and
  // raising its own window if it is detached. Right-click = the per-service menu.
  // RAIL_SHOW (preferCell: false) — a rail click is "switch to this service", so a gridded one
  // goes full-size and the grid is merely deselected (spec D2). Its arrangement survives and
  // repopulates when Grid is selected again. This channel carries KEYBOARD activation only
  // (rail.ts sends it when e.detail === 0); a mouse click is a zero-distance drag and ends at
  // rail:dragEnd, which is why both have to read the rule from the same constant.
  ipcMain.on('rail:select', (_e, id: string) => {
    const d = getService(id);
    if (d) showService(d, RAIL_SHOW);
  });
  ipcMain.on('rail:menu', (_e, id: string) => loft?.popServiceMenu(id));
  ipcMain.on('rail:showManager', () => loft?.showManager());
  ipcMain.on('rail:showGrid', () => { loft?.showGrid(); loft?.open(); });

  // --- grid:* — the grid chrome view (src/renderer/grid) -----------------------
  // A cell's ✕. Reuses LoftWindow's own prune rather than repeating the
  // identity-compare-and-write here: dropFromGrid is backed by pruneFromGrid, which also
  // clears the focused cell when it was the one removed. A second copy would drift, and
  // would miss that. It edits the tree in memory only, so persist it here.
  // Clicking a cell's header picks it as the zoom target. The click inside a cell's PAGE
  // is handled instead by that view's own webContents 'focus' event — a page swallows its
  // own clicks, so the chrome never sees them.
  ipcMain.on('grid:focusCell', (_e, service?: unknown) => {
    if (typeof service !== 'string') return;
    loft?.setFocusedCell(service);
  });

  ipcMain.on('grid:removeCell', (_e, service?: unknown) => {
    if (typeof service !== 'string') return;
    loft?.dropFromGrid(service);
    saveConfig(configPath(), config);
    // The service keeps running and stays in the rail — only its cell goes. refreshRail is
    // the whole-chrome refresh (refreshAll), which is what this needs and refreshGrid alone
    // would not give: the rail's Grid entry renders the cell COUNT, and it just changed.
    loft?.refreshRail();
  });

  // --- grid drags — resize a split, or move a cell -----------------------------
  // Same split as everywhere else in the grid: the renderer reports a pointer position and
  // computes nothing, main owns the tree and therefore owns the ratio and the drop. Both
  // gestures share grid:dragMove/dragEnd/dragCancel; which one is running is decided by the
  // *DragBegin main last saw, so exactly one of these two is ever set.
  //
  // The gutter path names the split rather than the pair of cells, so a drag survives
  // anything that does not touch that split — and reads as a no-op if the split itself has
  // gone.
  let gutterDrag: GutterDrag | undefined;
  /** The service whose ⠿ handle is being dragged, plus the last preview pushed for it. */
  let cellDrag: { id: string; lastPreview?: string } | undefined;

  const clearGridDrag = (): void => {
    // One clearer for both kinds. A second one for the next kind of drag is how the FIRST
    // kind gets left tracked: every end below already routes through here.
    gutterDrag = undefined;
    cellDrag = undefined;
    // Belt and braces, as clearRailDrag does: a gutter drag never raises a preview, but the
    // overlay has no click-through, so no end of any gesture may leave one up.
    loft?.showDropPreview(null);
  };

  ipcMain.on('grid:gutterDragBegin', (_e, p?: { path?: unknown; dir?: unknown }) => {
    // A begin of either kind ends whatever was tracked: two pointers can interleave, and a
    // move fed to a stale gesture resizes or relocates something the user is not touching.
    // Cleared before the payload check, not after — a begin means the previous gesture is
    // over whether or not this one is well-formed.
    clearGridDrag();
    // `dir` is still part of the renderer's payload and still validated — but it is not
    // stored: the axis is read back off the tree on every step (splitRectAt), so a prune
    // that reshapes the split mid-drag cannot leave the drag measuring the wrong way.
    if (typeof p?.path !== 'string' || (p.dir !== 'row' && p.dir !== 'col')) return;
    gutterDrag = beginGutterDrag(p.path);
  });

  // A cell's ⠿ handle: move that cell elsewhere in the grid. Only the dragged service is
  // tracked — where it lands is planGridDrop's answer, recomputed from the live tree on
  // every move, so a prune mid-drag cannot leave this aiming at a cell that has gone.
  ipcMain.on('grid:cellDragBegin', (_e, service?: unknown) => {
    clearGridDrag(); // same reasoning as grid:gutterDragBegin above
    if (typeof service !== 'string') return;
    cellDrag = { id: service };
  });

  /** Feed a renderer-space pointer to the tracked gesture through one of its steps and
   *  install whatever tree comes back. `undefined` means "this step changes nothing". */
  const applyGutterDrag = (
    step: (t: GridNode | null, c: Rect, x: number, y: number) => GridNode | null | undefined,
    x: number,
    y: number,
  ): void => {
    const content = loft?.contentRect();
    if (!content) return;
    // The grid renderer's coordinates start at the content rect's origin (its state carries
    // that origin so it can subtract it); every rect main holds is in window coordinates.
    const next = step(config.grid ?? null, content, x + content.x, y + content.y);
    if (next === undefined) return;
    config.grid = next;
    // Live, not on release: the pages follow the divider as it moves, and so does the grid
    // chrome — the renderer updates the existing nodes in place mid-drag rather than
    // rebuilding them, so nothing destroys the element holding pointer capture.
    loft?.refreshGrid();
  };

  /**
   * What a cell move released at this renderer-space point would do — the ONE call behind
   * both its preview and its release, so the rectangle the drag promises is the arrangement
   * the drop makes.
   *
   * A move needs something to move: if the leaf was pruned while the pointer was down (a
   * detach, an unload, a service removed from the hub), gridDropPlan would read the release
   * as a fresh INSERT and put the service back into a grid it has just left. Detached and
   * gridded are mutually exclusive (spec §7.1), and the re-inserted cell would have no page
   * behind it — placeGridCells cannot wake a detached service.
   */
  const planCellMove = (x: number, y: number, id: string): GridDropPlan | null => {
    const content = loft?.contentRect();
    if (!content || !gridServicesOf(config.grid ?? null).includes(id)) return null;
    // The grid renderer's coordinates start at the content rect's origin, as in
    // applyGutterDrag; planGridDrop works in window coordinates.
    return planGridDrop(x + content.x, y + content.y, id);
  };

  ipcMain.on('grid:dragMove', (_e, p?: { x?: unknown; y?: unknown }) => {
    if (typeof p?.x !== 'number' || typeof p?.y !== 'number') return;
    // No tracked drag means this move belongs to a gesture main never saw begin, or to one a
    // second pointer already ended — ignore it, exactly as rail:dragMove does.
    if (gutterDrag) { applyGutterDrag(gutterDrag.move, p.x, p.y); return; }
    if (!cellDrag) return;
    // Preview only — a cell move commits nothing until the release, unlike a resize, whose
    // pages follow the divider live.
    const preview = planCellMove(p.x, p.y, cellDrag.id)?.rect ?? null;
    const key = previewKey(preview);
    if (key === cellDrag.lastPreview) return;
    cellDrag.lastPreview = key;
    loft?.showDropPreview(preview);
  });

  // A release only resizes if the gesture actually moved (see GutterDrag.end), and only
  // persists on the same condition. Otherwise this is a bare CLICK on a divider, and a click
  // must leave both the tree and config.json exactly as it found them. The save is gated on
  // `moved`, not on this last step succeeding: a release whose path went stale still has the
  // earlier moves behind it, and those are what needs writing.
  ipcMain.on('grid:dragEnd', (_e, p?: { x?: unknown; y?: unknown }) => {
    const x = typeof p?.x === 'number' ? p.x : undefined;
    const y = typeof p?.y === 'number' ? p.y : undefined;
    if (gutterDrag && x !== undefined && y !== undefined) applyGutterDrag(gutterDrag.end, x, y);
    if (gutterDrag?.moved()) saveConfig(configPath(), config);
    // The cell move, committed in one step here. Releasing over a gutter or outside the grid
    // CANCELS, and so does a drop on the dragged cell itself: planCellMove returns null for
    // all of them, and null means the tree is left exactly as it was. It does not remove and
    // does not detach — removal is the ✕ and only the ✕, so a slipped drag can never silently
    // evict a service (grid-view spec §7.3).
    if (cellDrag && x !== undefined && y !== undefined) {
      const plan = planCellMove(x, y, cellDrag.id);
      if (plan) {
        config.grid = plan.next;
        saveConfig(configPath(), config);
        // refreshGrid, not showGrid: the grid is already the selection — this gesture began
        // in its own chrome view — and every leaf already has a live view, so there is
        // nothing to wake. It re-places the pages into their new cells (placeGridCells) as
        // well as re-rendering the chrome.
        loft?.refreshGrid();
      }
    }
    clearGridDrag();
  });

  // The gesture was aborted by the system (pointercancel), not released. Without this the
  // renderer ends it locally and main keeps resizing on every later pointermove over that
  // gutter — a plain hover. The moves already applied are persisted rather than reverted:
  // the user watched the pages move, so the arrangement on screen is the one that should
  // survive a restart, and leaving it unsaved only defers the write to the next unrelated
  // saveConfig — committing it later, with no gesture to explain it. A gesture that never
  // moved wrote nothing, so there is nothing to persist.
  ipcMain.on('grid:dragCancel', () => {
    if (gutterDrag?.moved()) saveConfig(configPath(), config);
    // A cancelled cell move has nothing to persist or revert: the tree is only touched on
    // release, so an aborted one leaves it untouched by construction. What it does need is
    // clearGridDrag's showDropPreview(null) — the preview overlay covers the whole content
    // rect and swallows every click while it is up.
    clearGridDrag();
  });

  // --- rail drag gestures -----------------------------------------------------
  // The renderer measures and reports; main owns every decision (see railSlots/
  // railGestureOutcome). One cached geometry snapshot serves both gesture kinds: a
  // pointer-capture drag of a rail icon, and a cross-window HTML5 drop from a detached
  // window's titlebar.
  // `id` is the dragged service, which the grid preview needs to tell a MOVE from an insert;
  // it is undefined for the cross-window HTML5 drag, whose id the browser withholds until
  // 'drop'. That is not a gap: a service arriving by attach is never already a grid leaf, so
  // "unknown" and "not a leaf" want the same answer.
  let railDrag:
    | { slots: RailSlot[]; lastIndex: number; lastPreview?: string; id?: string }
    | undefined;

  const railIds = (): string[] => orderedRailIds(listServices(), config);

  const setRailOrder = (ids: string[]): void => {
    config.railOrder = ids;
    saveConfig(configPath(), config);
    loft?.refreshRail();
  };

  const clearRailDrag = (): void => {
    railDrag = undefined;
    loft?.sendRail('rail:dropSlot', -1);
    // Every main-side end of a rail gesture goes through here — the release, the
    // cross-window drop, and the no-geometry early return in rail:dragEnd, which calls
    // this BEFORE it bails. The overlay swallows clicks in the content rect while it is
    // visible (a WebContentsView has no click-through), so leaving it up is not a cosmetic
    // bug; one owner of "the gesture is over" is what keeps that from happening.
    loft?.showDropPreview(null);
  };

  ipcMain.on('rail:dragBegin', (_e, m: { slots: RailSlot[]; id?: string }) => {
    // lastIndex starts at a value no real index can equal, so the first move always pushes.
    railDrag = { slots: m.slots, lastIndex: -2, id: m.id };
    // Belt and braces: rail:dragCancel is the channel that ends an aborted gesture, but a
    // renderer that somehow never sent one must not leave a preview up — the overlay
    // swallows clicks across the whole content rect.
    loft?.showDropPreview(null);
  });

  // The gesture was aborted by the system (pointercancel — a touch drag turning into a pan
  // is the ordinary cause), not released. Without this the renderer ends it locally and
  // main never hides the preview, leaving an invisible click-eating overlay over the grid,
  // the selected service AND the hub, with no obvious way for the user to clear it.
  ipcMain.on('rail:dragCancel', () => clearRailDrag());

  ipcMain.on('rail:dragMove', (_e, m: { clientX: number; clientY: number }) => {
    if (!railDrag) return;
    // Outside the rail band the gesture means detach, not reorder — hide the indicator
    // rather than promising a slot the release will not honour.
    const outside = railDragOutcome(m.clientX, RAIL_WIDTH) === 'detach';
    const index = outside ? -1 : railSlotIndex(m.clientY, railDrag.slots);
    // Grid drop preview. The rail's clientX/clientY are window coordinates, so the content
    // rect is reached by comparing directly — no offset arithmetic beyond the rect's own
    // origin, which computeGridLayout already works in. Sent before the slot-index
    // early-return below: the preview changes as the pointer crosses a cell's diagonals,
    // which happens with the slot index pinned at -1 the whole time. Deduped like the slot
    // index for the same reason — pointermove fires far faster than the preview changes,
    // and every push is an IPC round trip plus a view visibility flip.
    if (loft?.activeId() === GRID_ID) {
      // Only where a release would really be a drop: inside the rail's own band the
      // gesture still means reorder, so previewing there promises a cell the release will
      // not create — the mirror of why the slot indicator hides outside the band.
      const preview = outside
        ? planGridDrop(m.clientX, m.clientY, railDrag.id ?? '')?.rect ?? null
        : null;
      const key = previewKey(preview);
      if (key !== railDrag.lastPreview) {
        railDrag.lastPreview = key;
        loft.showDropPreview(preview);
      }
    }
    if (index === railDrag.lastIndex) return;
    railDrag.lastIndex = index;
    loft?.sendRail('rail:dropSlot', index);
  });

  ipcMain.on('rail:dragEnd', (_e, m: { id: string; releaseX: number; releaseY: number }) => {
    const drag = railDrag;
    clearRailDrag();
    // No cached geometry means this release does not belong to a gesture we tracked — e.g. a
    // second pointer releasing after the first already ended one. Acting anyway would measure
    // against an empty slot list, whose index is always 0, silently reordering the service to
    // the front and persisting it.
    if (!drag) return;
    const slots = drag.slots;
    const d = getService(m.id);
    if (!d) return;
    const ids = railIds();
    // Only a service that is loaded AND currently a tab of the Loft window has a view to
    // pull out; a sleeping or already-detached icon snaps back instead.
    const canDetach = loft?.has(m.id) === true && config.services[m.id]?.detached !== true;
    const toIndex = railSlotIndex(m.releaseY, slots);
    // One decision, made in railGestureAction; this switch only carries it out. The show
    // intent rides along with the action for the same reason (spec D2 — a rail gesture shows
    // full-size), so no branch here can quietly fall back to showService's default.
    const action = railGestureAction({
      releaseX: m.releaseX,
      railWidth: RAIL_WIDTH,
      canDetach,
      fromIndex: ids.indexOf(m.id),
      toIndex,
      gridSelected: loft?.activeId() === GRID_ID,
      // Detach is what a release BEYOND the window means, so the grid may only claim one
      // that landed inside the content rect. Half-open on both axes, matching gridDrop's
      // own `inside`.
      insideContent: (() => {
        const c = loft?.contentRect();
        return c !== undefined
          && m.releaseX >= c.x && m.releaseX < c.x + c.width
          && m.releaseY >= c.y && m.releaseY < c.y + c.height;
      })(),
    });
    switch (action.kind) {
      case 'grid': {
        // The same call the preview drew with, so a release the preview refused to promise
        // does nothing at all — and one it DID promise commits exactly that rectangle.
        const plan = planGridDrop(m.releaseX, m.releaseY, m.id);
        if (!plan) break;
        // Grid and detached are mutually exclusive (spec §7.1): re-attach first, which
        // hands the live view across without a reload. Safe to do after planning: attaching
        // never edits the tree (only detach/unload prune it), so plan.next is still current.
        if (isDetached(m.id)) setDetached(m.id, false);
        config.grid = plan.next;
        saveConfig(configPath(), config);
        // showGrid, not refreshGrid: re-attaching a detached service above can hand the
        // selection to that service's own tab (setDetached → showService when its window
        // was on screen), and the drop must still land the user on the grid. Re-selecting
        // the grid is also what wakes a sleeping leaf, via placeGridCells → ensureAttached.
        loft?.showGrid();
        break;
      }
      case 'detach':
        setDetached(m.id, true);
        showService(d, action.show);
        break;
      case 'reorder':
        setRailOrder(moveInOrder(ids, m.id, action.toIndex));
        break;
      case 'select':
        showService(d, action.show);
        break;
      case 'none':
        break;
    }
  });

  // A detached service dragged back onto the rail: land it in the dropped slot, move the
  // live view home (no reload), select it, and raise the Loft window — showService routes
  // through the GNOME helper / KWin because a plain focus() is refused on Wayland.
  ipcMain.on('rail:dropAttach', (_e, m: { id: string; clientY: number }) => {
    const drag = railDrag;
    clearRailDrag();
    if (!drag) return; // same reasoning as rail:dragEnd above
    const slots = drag.slots;
    const d = getService(m.id);
    if (!d || config.services[m.id]?.detached !== true) return;
    setRailOrder(moveInOrder(railIds(), m.id, railSlotIndex(m.clientY, slots)));
    setDetached(m.id, false);
    showService(d);
  });

  // --- hub:* — the manager view (src/renderer/hub). Wiring lives in hubIpc.ts so it's
  // unit-testable; the deps below are index.ts's own operations, unchanged. hub:openService
  // does exactly what rail:select does (showService(getService(id))) — the old version
  // re-emitted rail:select to avoid drift; calling the same helper keeps them identical.
  registerHubIpc(ipcMain, {
    getState: hubState,
    openService: (id) => { const d = getService(id); if (d) showService(d); },
    addService: (id, customUrl) => {
      const d = getService(id); if (!d) return;
      addInstance(d, config, { customUrl, iconSourceDir });
      saveConfig(configPath(), config);
      loft?.refreshRail();
      notifyHub();
    },
    removeService: (id, deleteData) => {
      const d = getService(id); if (!d) return;
      quitService(id);
      // quitService returns early when the service is loaded NOWHERE, so loft.unload — and
      // the prune inside it — never runs. Grid leaves are asleep in the ordinary case
      // (nothing wakes them until Grid is first selected), so without this an uninstalled
      // service keeps its leaf, it is persisted, and opening Grid draws a header strip for a
      // service that no longer exists with no page behind it. No-op by identity otherwise.
      loft?.dropFromGrid(id);
      // TEMPORARY (Task 6 → replaced in Task 10): removeService's `id` is a config key,
      // which may already name a 2nd+ account, but `d` is still a bare kind — asInstance
      // fakes up account #1 rather than resolving `id`'s real instance. Fine today because
      // nothing upstream of this hub IPC can produce an id for a 2nd+ account yet.
      removeInstance(asInstance(d), config, deleteData);
      saveConfig(configPath(), config);
      reconcileAutostart();
      loft?.refreshRail();
      notifyHub();
    },
    setServiceSetting: (id, patch) => { setServiceSetting(id, patch); notifyHub(); },
    setGlobal: (patch) => {
      if (patch.trayBackend !== undefined) { config.trayBackend = patch.trayBackend; saveConfig(configPath(), config); }
      notifyHub();
    },
    recoverService: (id, opts) => {
      const host = hostOf(id);
      if (!opts.clearCaches) { host?.reload(); return; }
      if (host) { void host.clearAndReload(); return; }
      void clearServiceCaches(session.fromPartition(`persist:${id}`));
    },
    quit: () => { quitting = true; app.quit(); },
  });

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

  ipcMain.on('service:notify', (e, p?: { title?: string; body?: string; icon?: string; href?: string; notifyId?: number; epoch?: string }) => {
    const sw = findBySenderId(e.sender.id);
    if (!sw || !p || typeof p.title !== 'string' || typeof p.body !== 'string') return;
    void notifications?.handle(sw.def.id, { title: p.title, body: p.body, icon: p.icon, href: p.href, notifyId: p.notifyId, epoch: p.epoch });
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
        .filter((d): d is ServiceKind => d !== undefined)
        .map((d) => ({
          id: d.id,
          displayName: d.displayName,
          segment: dbusSegmentFor(d.id, config),
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
        onShowWindow: () => { loft?.open(); focusExternal(LOFT_WINDOW_KEY); },
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
        if (d) tray.addService({ id, displayName: d.displayName, segment: dbusSegmentFor(id, config), dnd: config.services[id]?.dnd ?? false });
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
        click: (id, notifyId, epoch) => hostOf(id)?.notifyClick(notifyId, epoch),
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
      const removed = removeLegacyAutostart(KINDS.map((s) => s.id));
      if (removed.length) console.log(`Removed ${removed.length} legacy autostart entr${removed.length === 1 ? 'y' : 'ies'} (v1)`);
    } catch (err) { console.error('Legacy autostart cleanup failed:', err); }

    // Enforce each service's opt-in launcher flag (spec 09 Q2 / 09c-3): write a .desktop for
    // services that asked for one, remove it for those that didn't. Idempotent and cheap; it
    // also repairs a stale/deleted entry. Skipped writes under a dev run (see writeServiceLauncher)
    // so a checkout can't clobber the packaged install's entries.
    reconcileServiceLaunchers(
      Object.keys(config.services),
      (id) => config.services[id]?.launcher === true,
      {
        write: (id) => { const d = getService(id); if (d) writeServiceLauncher(asInstance(d), { execPath: process.execPath, iconSourceDir }); },
        remove: (id) => { const d = getService(id); if (d) removeServiceLauncher(asInstance(d)); },
      },
    );

    // The unified window (spec 09 §2): manager + rail + every attached service. It exists
    // on every launch path, shown or not — its startup set loads into it either way.
    // Ordering: after migrateConfig, because the rail is built from config. The manager view
    // it mounts is the hub renderer, which invokes hub:getState the moment it loads — that
    // handler is registered at module scope above, so it is already there.
    loft = createLoftWindow({
      cfg: config,
      services: [...KINDS], // the registry is readonly; the rail wants a plain array
      onQuit: () => quitting,
      badge: (id) => currentBadge.get(id) ?? 0,
      detached: isDetached,
      loadedElsewhere: (id) => windows.has(id),
      buildServiceMenu,
      buildGridAddMenu,
      onActiveChanged: syncActiveTab,
      // Everything main has pushed into this service's page, plus the gate axes that
      // describe where the page now is. Two callers, one silent failure between them: a
      // real page load drops the DND/hidden pushes, and a view MOVED into or out of a grid
      // cell fires no load at all while its visible/active answers change underneath it.
      // Neither reports an error — the symptom is a service that quietly stops raising
      // banners — so both re-seed through here. `focused` is absent on purpose: it belongs
      // to the window, and the window's own focus/blur handlers fan it across every tab.
      onServiceLoad: (id) => {
        notifications?.registerService(id);
        notifications?.setActive(id, isActiveService(id));
        notifications?.setVisible(id, hostOf(id)?.isVisible() ?? false);
      },
      ensureAttached: (id) => {
        const def = getService(id);
        // Refuse for an unknown, uninstalled or detached service — the grid tree is
        // pruned on load, but config can change under a running grid. Detached and
        // gridded are mutually exclusive: a service in its own window has no view here
        // to tile, and stealing it back is the rail's job, not a repaint's.
        if (!def || config.services[id] === undefined || isDetached(id)) return;
        // Wake only what the tree actually names. isDetached cannot carry this alone: it
        // reads false mid-teardown (view gone, own window not built, flag not yet
        // written), which is exactly when a stale leaf would make us build a duplicate
        // view. loftWindow prunes the leaf on that path, so this is belt-and-braces —
        // but it makes the wake path self-consistent instead of trusting the prune.
        if (!gridServicesOf(config.grid ?? null).includes(id)) return;
        // `!loft` is unreachable today (nothing selects the grid before this assignment
        // returns) but attachService dereferences it with `!`, so don't rely on that.
        if (!loft || loft.has(id)) return;
        attachService(def);
      },
      railPreload: join(__dirname, '..', 'preload', 'rail.js'),
      railHtml: join(__dirname, '..', 'renderer', 'rail', 'index.html'),
      gridPreload: join(__dirname, '..', 'preload', 'grid.js'),
      gridHtml: join(__dirname, '..', 'renderer', 'grid', 'index.html'),
      overlayHtml: join(__dirname, '..', 'renderer', 'gridOverlay', 'index.html'),
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
        // One definition of "on screen" for both consumers (see syncActiveTab): the window
        // being up is necessary but not sufficient — the service also has to hold the
        // content rect, which with the grid selected is true of every cell at once.
        const onScreen = loft!.hostOf(id)?.isVisible() ?? false;
        notifications?.setVisible(id, onScreen);
        tray?.setVisible(id, onScreen);
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
        // No showManager(): the window comes back on whatever tab it was on, which is the
        // whole difference from ShowHub. focusExternal is required — a plain open() is
        // subject to Wayland's focus-stealing prevention.
        showWindow: () => { loft?.open(); focusExternal(LOFT_WINDOW_KEY); },
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
