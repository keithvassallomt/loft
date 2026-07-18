import { BrowserWindow, WebContentsView, Menu } from 'electron';
import type { ServiceDef } from './registry';
import type { LoftConfig } from './config';
import { computeLayout, RAIL_WIDTH, type Rect } from './layout';
import { formatWindowTitle } from './serviceTitle';
import { createServiceView, type ServiceView } from './serviceView';
import type { ServiceHost } from './serviceHost';
import { buildRailModel, nextActiveId, type RailItem } from './railModel';

/** The window's own display name — the key the GNOME helper and KWin match on. */
export const LOFT_WINDOW_KEY = 'Loft';

/**
 * The unified host: one BrowserWindow that hosts N services at once, plus the
 * manager view. A full-height rail (left) lists every installed service; a
 * titlebar belongs to whichever service is currently selected; the manager and
 * every attached ServiceView share the content rect with exactly one visible.
 *
 * Second implementer of ServiceHost (see serviceHost.ts's doc comment) — that is
 * what finally enforces the interface stayed window-free: if this file's per-service
 * host object doesn't satisfy ServiceHost, the fix is here, never a widened interface.
 */
export interface LoftWindow {
  window: BrowserWindow;
  open(): void; // show + focus
  hide(): void;
  attach(def: ServiceDef): ServiceHost; // create+mount a view; does NOT select it
  /** Unmount and hand the still-live view back for re-mounting elsewhere.
   *  ORDERING CONTRACT: call this BEFORE writing `detached: true` to config. It picks
   *  the next tab by locating `id` in the attached list, so a config flag flipped first
   *  makes it show the manager instead of the next service. */
  detach(id: string): ServiceView | undefined;
  unload(id: string): void; // destroy the view; drop to sleeping
  select(id: string | undefined): void; // undefined = show the manager
  activeId(): string | undefined;
  hostOf(id: string): ServiceHost | undefined;
  has(id: string): boolean;
  ids(): string[];
  setBadge(id: string, count: number): void;
  refreshRail(): void;
  showManager(): void;
  /** Push to the manager view (the hub renderer). index.ts owns the `hub:*` IPC — those
   *  handlers drive main's own state (config, hosts, autostart), not this window's — but the
   *  manager is a view in here, so this is its way in. No-ops before the view has loaded;
   *  the renderer pulls its own first state over `hub:getState`, so nothing is lost. */
  sendManager(channel: string, ...args: unknown[]): void;
  popServiceMenu(id: string): void;
  ownsWebContents(id: number): boolean;
  persist(): void;
  destroy(): void;
}

export interface LoftWindowDeps {
  cfg: LoftConfig;
  services: ServiceDef[];
  /** Never true unless the app is really quitting — close-to-tray depends on it. */
  onQuit(): boolean;
  /** Live unread for a service, ungated (the rail model applies badgesEnabled itself). */
  badge(id: string): number;
  /** Is this service detached? Detached services appear in the rail but aren't tabs. */
  detached(id: string): boolean;
  /** Is this service loaded somewhere ELSE — i.e. in its own window? The rail lists every
   *  installed service, detached ones included (spec §3), and this window can only see its
   *  own views: without this it would draw a live detached service as sleeping, badge and
   *  all. */
  loadedElsewhere(id: string): boolean;
  /** Rail right-click → the per-service menu. Main owns it so it's native. */
  buildServiceMenu(id: string): Electron.MenuItemConstructorOptions[];
  /** Selection changed (or the manager took over, id undefined). */
  onActiveChanged(id: string | undefined): void;
  /** This service's page finished loading. A navigation drops everything main pushed into
   *  the page (DND, hidden), so main re-pushes it here — the shared-host twin of the
   *  per-service window's own did-finish-load binding. */
  onServiceLoad(id: string): void;
  railPreload: string;
  railHtml: string;
  titlebarPreload: string;
  titlebarHtml: string;
  managerPreload: string;
  managerHtml: string;
  iconPath: string;
}

function safeSend(view: WebContentsView, channel: string, ...args: unknown[]): void {
  const wc = view.webContents;
  if (wc.isDestroyed()) return;
  try { wc.send(channel, ...args); } catch { /* render frame disposed transiently */ }
}

export function createLoftWindow(deps: LoftWindowDeps): LoftWindow {
  const saved = deps.cfg.window;

  const window = new BrowserWindow({
    width: saved?.width ?? 1100,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    frame: false,
    show: false,
    title: LOFT_WINDOW_KEY,
    icon: deps.iconPath,
  });

  const views = new Map<string, ServiceView>();
  const hosts = new Map<string, ServiceHost>();
  let active: string | undefined;

  // --- chrome views -----------------------------------------------------------
  const rail = new WebContentsView({
    webPreferences: { preload: deps.railPreload, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  void rail.webContents.loadFile(deps.railHtml);

  const titlebar = new WebContentsView({ webPreferences: { preload: deps.titlebarPreload } });
  void titlebar.webContents.loadFile(deps.titlebarHtml);

  const manager = new WebContentsView({
    webPreferences: { preload: deps.managerPreload, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  void manager.webContents.loadFile(deps.managerHtml);

  // Insertion order is z-order. Rail and titlebar never overlap the content rect, so
  // only manager-vs-service matters, and setVisible arbitrates that.
  window.contentView.addChildView(rail);
  window.contentView.addChildView(titlebar);
  window.contentView.addChildView(manager);

  const rects = (): { rail: Rect; titlebar: Rect; content: Rect } => {
    const [w, h] = window.getContentSize();
    return computeLayout(w, h, { railWidth: RAIL_WIDTH });
  };

  const relayout = (): void => {
    const r = rects();
    rail.setBounds(r.rail);
    titlebar.setBounds(r.titlebar);
    manager.setBounds(r.content);
    for (const sv of views.values()) sv.setRect(r.content);
  };
  relayout();
  window.on('resize', relayout);

  // --- rail + titlebar state --------------------------------------------------
  const model = (): RailItem[] => buildRailModel({
    services: deps.services,
    config: deps.cfg,
    // A tab of ours, or a live view in its own window — both are loaded, and only the
    // first kind is something this window can see.
    loaded: (id) => views.has(id) || deps.loadedElsewhere(id),
    detached: deps.detached,
    badge: deps.badge,
    activeId: active,
  });

  const refreshRail = (): void =>
    safeSend(rail, 'rail:state', { items: model(), managerActive: active === undefined });

  const refreshTitlebar = (): void => {
    if (!active) { safeSend(titlebar, 'titlebar:set-service', 'Loft'); return; }
    const sv = views.get(active);
    if (!sv) return;
    const count = deps.cfg.services[active]?.badgesEnabled === false ? 0 : deps.badge(active);
    safeSend(titlebar, 'titlebar:set-service', formatWindowTitle(sv.def.displayName, count));
  };

  /**
   * The window's OS title (spec 09 §6a): "Loft", or "Loft (7)" summing unread across
   * ATTACHED, loaded, badges-enabled services. Attached-only on purpose — it names this
   * window's contents, and a detached Slack has its own "Slack (2)". The tray icon still
   * aggregates everything, so the two can legitimately disagree.
   */
  const refreshWindowTitle = (): void => {
    let total = 0;
    for (const id of views.keys()) {
      if (deps.detached(id)) continue;
      if (deps.cfg.services[id]?.badgesEnabled === false) continue;
      total += deps.badge(id);
    }
    window.setTitle(formatWindowTitle(LOFT_WINDOW_KEY, total));
  };

  const refreshAll = (): void => { refreshRail(); refreshTitlebar(); refreshWindowTitle(); };

  // Cold-start race (mirrors serviceWindow's titlebar did-finish-load binding): the
  // showManager() call at the bottom of this function runs refreshAll() in the same
  // synchronous tick as the loadFile calls above, so that first push fires before
  // either renderer's preload has registered its IPC listener — safeSend's send is a
  // no-op against a not-yet-subscribed renderer, and nothing else ever re-pushes (no
  // rail:ready handshake, no static HTML fallback). Re-push once each view's own load
  // actually finishes; this also covers a renderer that reloads for any reason, since
  // did-finish-load fires again and picks up current state. The manager view needs no
  // such binding — its state travels over the hub:* channels (hub:getState/hub:state),
  // owned by index.ts, not this file: the renderer PULLS its first state with a
  // hub:getState invoke once it's up, so it cannot miss an early push the way the rail
  // and titlebar (push-only) can.
  rail.webContents.on('did-finish-load', refreshAll);
  titlebar.webContents.on('did-finish-load', refreshAll);

  // --- selection --------------------------------------------------------------
  const select = (id: string | undefined): void => {
    // An unselectable id (sleeping ⇒ no view, or detached ⇒ its own window) must not be
    // left as `active`: that strands a dead id over a blank content rect. Fall back to the
    // manager rather than returning. select(undefined) passes the guard, so no recursion.
    if (id !== undefined && (!views.has(id) || deps.detached(id))) { select(undefined); return; }
    active = id;
    const r = rects().content;
    manager.setVisible(id === undefined);
    for (const [vid, sv] of views) {
      const on = vid === id;
      sv.setVisible(on);
      if (on) sv.setRect(r);
    }
    refreshAll();
    deps.onActiveChanged(id);
  };

  const showManager = (): void => select(undefined);

  // --- lifecycle --------------------------------------------------------------
  window.on('close', (e) => {
    if (!deps.onQuit()) { e.preventDefault(); window.hide(); }
  });

  const persist = (): void => {
    const [w, h] = window.getSize();
    const [x, y] = window.getPosition();
    deps.cfg.window = { x, y, width: w, height: h };
    // Per-service zoom belongs to the service, not this window — an attached service
    // keeps its own factor across attach/detach.
    for (const [id, sv] of views) {
      const prev = deps.cfg.services[id];
      if (prev) deps.cfg.services[id] = { ...prev, window: { ...(prev.window ?? { width: 1100, height: 800 }), zoom: sv.getZoom() } };
    }
  };
  window.on('resize', persist);
  window.on('move', persist);
  window.on('hide', persist);

  window.on('closed', () => { for (const sv of views.values()) sv.dispose(); });

  // --- rail IPC is registered by index.ts (it owns ipcMain) --------------------

  const hostFor = (id: string): ServiceHost | undefined => {
    const sv = views.get(id);
    if (!sv) { hosts.delete(id); return undefined; }
    let host = hosts.get(id);
    if (!host) {
      host = {
        def: sv.def,
        show: () => { select(id); api.open(); },
        // Spec §6b: the only way to make an attached service not-visible is to hide its
        // host — and that hides every other attached service too. Documented wart.
        hide: () => window.hide(),
        isVisible: () => window.isVisible() && active === id,
        setZoom: (d) => { sv.setZoom(d); persist(); },
        setBadge: (c) => api.setBadge(id, c),
        pushDnd: (v) => sv.pushDnd(v),
        pushHidden: (v) => sv.pushHidden(v),
        navigate: (u) => sv.navigate(u),
        loadUrl: (u) => sv.loadUrl(u),
        reload: () => sv.reload(),
        clearAndReload: () => sv.clearAndReload(),
        ownsWebContents: (wcId) => sv.ownsWebContents(wcId),
      };
      hosts.set(id, host);
    }
    return host;
  };

  const api: LoftWindow = {
    window,
    open: () => { window.show(); window.focus(); },
    hide: () => window.hide(),

    attach: (def) => {
      const existing = views.get(def.id);
      if (existing) return hostFor(def.id)!;
      const sv = createServiceView(def, deps.cfg);
      // mount() must be in the same synchronous tick as createServiceView — see its
      // doc comment: the initial load is already away and arms the stuck watcher,
      // whose showRecovery early-returns while unmounted.
      sv.mount(window, rects().content);
      sv.setVisible(false); // select() decides what's on screen
      views.set(def.id, sv);
      hosts.delete(def.id);
      // Mirrors serviceWindow's binding: a load wipes whatever main pushed into the page,
      // so main gets told to push it again. Without this an attached service never hears
      // about DND or its own hidden-ness after the first navigation.
      sv.view.webContents.on('did-finish-load', () => deps.onServiceLoad(def.id));
      refreshAll();
      return hostFor(def.id)!;
    },

    detach: (id) => {
      const sv = views.get(id);
      if (!sv) return undefined;
      // Snapshot the successor BEFORE the transition. nextActiveId locates `id` in the
      // ATTACHED list to pick its neighbour, so it must still be both loaded and
      // not-yet-detached: call it after views.delete (or after deps.detached(id) flips)
      // and it finds nothing, returns undefined, and we show the manager instead of the
      // next service. Hence also the ordering contract on this method — see the doc on
      // LoftWindow.detach: the caller must not write `detached: true` to config first.
      const next = active === id ? nextActiveId(model(), id) : undefined;
      sv.unmount();
      views.delete(id);
      hosts.delete(id);
      if (active === id) select(next);
      refreshAll();
      return sv; // still live — the caller re-mounts it into its own window
    },

    unload: (id) => {
      const sv = views.get(id);
      if (!sv) return;
      // Same rule: compute the successor while `id` is still in the attached list.
      const next = active === id ? nextActiveId(model(), id) : undefined;
      sv.unmount();
      sv.dispose();
      if (!sv.view.webContents.isDestroyed()) sv.view.webContents.close();
      views.delete(id);
      hosts.delete(id);
      if (active === id) select(next);
      refreshAll();
    },

    select,
    activeId: () => active,
    hostOf: hostFor,
    has: (id) => views.has(id),
    ids: () => [...views.keys()],

    setBadge: (id, _count) => {
      // The count itself lives in index.ts's currentBadge (deps.badge reads it), so
      // there is nothing to store here — just re-render everything that shows it.
      if (!views.has(id)) return;
      refreshAll();
    },

    refreshRail: refreshAll,
    showManager,
    sendManager: (channel, ...args) => safeSend(manager, channel, ...args),

    /** Native per-service context menu (rail right-click). Main owns it so it renders
     *  as a real menu rather than CSS, and so the actions are the same ones the tray
     *  drives. */
    popServiceMenu: (id) => {
      Menu.buildFromTemplate(deps.buildServiceMenu(id)).popup({ window });
    },

    /** The rail/titlebar/manager views belong to the WINDOW, not to any one service —
     *  no ServiceHost owns them, so index.ts must ask the window before falling back
     *  to a per-service lookup when routing titlebar IPC. */
    ownsWebContents: (wcId) =>
      rail.webContents.id === wcId ||
      titlebar.webContents.id === wcId ||
      manager.webContents.id === wcId ||
      [...views.values()].some((sv) => sv.ownsWebContents(wcId)),
    persist,
    destroy: () => window.destroy(),
  };

  showManager(); // a fresh window with nothing selected shows the manager
  return api;
}
