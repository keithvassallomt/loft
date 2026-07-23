import { BrowserWindow, WebContentsView, Menu } from 'electron';
import type { ServiceDef } from './registry';
import type { LoftConfig } from './config';
import { computeLayout, RAIL_WIDTH, type Rect } from './layout';
import { formatWindowTitle } from './serviceTitle';
import { createServiceView, type ServiceView } from './serviceView';
import type { ServiceHost } from './serviceHost';
import { buildRailModel, buildRailState, nextActiveId, type RailItem } from './railModel';
import { computeGridLayout, type GridViewState } from './gridLayout';
import { GRID_ID, remove as removeFromGrid, reseedFocus, services as gridServices } from './gridTree';

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
  /** create+mount a view; does NOT select it. Pass a pre-built (live) view to MOVE it in
   *  from a detached window without reloading; omit it to build a fresh one. */
  attach(def: ServiceDef, view?: ServiceView): ServiceHost;
  /** Unmount and hand the still-live view back for re-mounting elsewhere.
   *  ORDERING CONTRACT: call this BEFORE writing `detached: true` to config. It picks
   *  the next tab by locating `id` in the attached list, so a config flag flipped first
   *  makes it show the manager instead of the next service.
   *  SIDE EFFECT: mutates `deps.cfg.grid` in memory (drops this service's leaf — see
   *  dropFromGrid). Nothing here saves config; callers that care must persist. */
  detach(id: string): ServiceView | undefined;
  /** Destroy the view; drop to sleeping. Same `deps.cfg.grid` side effect as detach(). */
  unload(id: string): void;
  /** Drop a service's leaf from the grid tree without touching its view. For the teardown
   *  paths that never reach detach/unload — a SLEEPING service being detached has no view
   *  to unmount, but its leaf must still go, or it stays as a cell that nothing can clear.
   *  In memory only, like detach/unload. */
  dropFromGrid(id: string): void;
  select(id: string | undefined): void; // undefined = show the manager, GRID_ID = the grid
  activeId(): string | undefined;
  hostOf(id: string): ServiceHost | undefined;
  has(id: string): boolean;
  ids(): string[];
  setBadge(id: string, count: number): void;
  refreshRail(): void;
  showManager(): void;
  /** Select the grid view. */
  showGrid(): void;
  /** Re-push the grid chrome state (layout, names, badges, focus). */
  refreshGrid(): void;
  /** Make this cell the zoom target. Ignored for a service that is not a leaf, so a stale
   *  id from the renderer cannot strand focus on a cell that no longer exists. */
  setFocusedCell(service: string): void;
  /** The focused cell, or undefined when the grid is not the selection or is empty. Zoom
   *  reads this instead of activeId() while the grid is up — GRID_ID is not a service and
   *  hostOf() would find nothing for it. */
  focusedCellId(): string | undefined;
  /** Push to the manager view (the hub renderer). index.ts owns the `hub:*` IPC — those
   *  handlers drive main's own state (config, hosts, autostart), not this window's — but the
   *  manager is a view in here, so this is its way in. No-ops before the view has loaded;
   *  the renderer pulls its own first state over `hub:getState`, so nothing is lost. */
  sendManager(channel: string, ...args: unknown[]): void;
  /** Push to the rail view (e.g. the live drop-slot index during a drag). */
  sendRail(channel: string, ...args: unknown[]): void;
  popServiceMenu(id: string): void;
  /** Native menu of services not yet in the grid (grid-view spec §3). */
  popGridAddMenu(): void;
  /** The content rect, so main can compute grid geometry without owning the window. */
  contentRect(): Rect;
  /** Show the drop preview at `rect` (window coordinates), or hide it with null. Drawn by
   *  a transparent overlay view above every service view, because a page cannot be drawn
   *  on from outside it. */
  showDropPreview(rect: Rect | null): void;
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
  /** Menu template listing services that can still be added to the grid. Built by main for
   *  the same reason buildServiceMenu is: the ＋ menu must be a real native menu, and the
   *  "which services qualify" rule (installed, not gridded, not detached) belongs where the
   *  registry and config live, not in here. */
  buildGridAddMenu(): Electron.MenuItemConstructorOptions[];
  /** Selection changed (or the manager took over, id undefined). */
  onActiveChanged(id: string | undefined): void;
  /** This service's page finished loading. A navigation drops everything main pushed into
   *  the page (DND, hidden), so main re-pushes it here — the shared-host twin of the
   *  per-service window's own did-finish-load binding. */
  onServiceLoad(id: string): void;
  /** A grid cell needs a view that does not exist yet — build and attach it. Grid
   *  membership means live (grid-view spec §6), so selecting the grid wakes its
   *  sleeping leaves. Must be synchronous-safe: it may be called during select(). */
  ensureAttached(id: string): void;
  railPreload: string;
  railHtml: string;
  gridPreload: string;
  gridHtml: string;
  /** The drop-preview overlay's page. Shares gridPreload — it only needs `grid:preview`. */
  overlayHtml: string;
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
  /** Which grid cell the titlebar's zoom buttons act on (grid-view spec §7.4). */
  let focusedCell: string | undefined;

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

  // The grid's chrome: header strips, gutters and the empty state. Deliberately at the
  // BOTTOM of the grid's own stack — service views mount on top of it in their body
  // rects, so headers and gutters are simply the regions no page covers. A transparent
  // view over the pages would swallow every click in its rect (electron#49039, open).
  const grid = new WebContentsView({
    webPreferences: { preload: deps.gridPreload, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  void grid.webContents.loadFile(deps.gridHtml);

  // The drop preview, drawn over the live pages: a WebContentsView cannot be painted on
  // from outside, so the only way to show a rectangle across the cells is another view on
  // top of them. Transparent, and ALWAYS PRESENT — created once here and toggled with
  // setVisible rather than built per drag, because a freshly created view does not cover
  // the views below it until its page has finished loading (electron#47351, open), which
  // would flicker in the middle of the gesture.
  //
  // Two silent failures live in the next line: the alpha byte comes FIRST (AARRGGBB, not
  // RRGGBBAA), and the string 'transparent' is not a valid colour here — it is accepted
  // and ignored, leaving an opaque view over the grid.
  const overlay = new WebContentsView({
    webPreferences: { preload: deps.gridPreload, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  overlay.setBackgroundColor('#00000000');
  void overlay.webContents.loadFile(deps.overlayHtml);
  overlay.setVisible(false);

  // Insertion order is z-order. Rail and titlebar never overlap the content rect, so
  // only manager-vs-service matters, and setVisible arbitrates that. The grid's chrome
  // goes in before the manager so the service views added later land above it.
  window.contentView.addChildView(rail);
  window.contentView.addChildView(titlebar);
  window.contentView.addChildView(grid);
  window.contentView.addChildView(manager);
  window.contentView.addChildView(overlay);

  const rects = (): { rail: Rect; titlebar: Rect; content: Rect } => {
    const [w, h] = window.getContentSize();
    return computeLayout(w, h, { railWidth: RAIL_WIDTH });
  };

  // Reads placeGridCells/refreshGrid, both defined below — so its first CALL (and the
  // resize binding) sits after them, near showGrid. `const` arrows are not hoisted:
  // invoking this here would throw "Cannot access 'placeGridCells' before
  // initialization", and tsc does not catch it.
  const relayout = (): void => {
    const r = rects();
    rail.setBounds(r.rail);
    titlebar.setBounds(r.titlebar);
    manager.setBounds(r.content);
    grid.setBounds(r.content);
    overlay.setBounds(r.content);
    // The grid owns the content rect while it is the selection: giving every view the
    // full rect here would undo the cell placement one line later.
    if (active === GRID_ID) { placeGridCells(); refreshGrid(); return; }
    for (const sv of views.values()) sv.setRect(r.content);
  };

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
    safeSend(rail, 'rail:state', buildRailState({
      services: deps.services,
      config: deps.cfg,
      loaded: (id) => views.has(id) || deps.loadedElsewhere(id),
      detached: deps.detached,
      badge: deps.badge,
      activeId: active,
      grid: deps.cfg.grid ?? null,
    }));

  const refreshTitlebar = (): void => {
    // set-context tells the titlebar which service it is showing, or null for the manager
    // view — which is what hides the service-only controls (reload/zoom) and the icon.
    //
    // The grid is the third context: it owns no single service, so it gets ＋ instead of
    // reload. It is deliberately announced as the plain string 'grid', NOT GRID_ID — the
    // renderer cannot import the sentinel, and a hand-copied U+0000 in renderer source is
    // eaten by editors and copy-paste, leaving a comparison that silently never matches.
    // The sentinel stays on this side of the IPC boundary; only a service whose id were
    // literally 'grid' could collide, and registry.ts is where that is kept true.
    if (active === GRID_ID) {
      safeSend(titlebar, 'titlebar:set-service', 'Grid');
      safeSend(titlebar, 'titlebar:set-context', 'grid');
      return;
    }
    if (!active) {
      safeSend(titlebar, 'titlebar:set-service', 'Loft');
      safeSend(titlebar, 'titlebar:set-context', null);
      return;
    }
    const sv = views.get(active);
    if (!sv) return;
    const count = deps.cfg.services[active]?.badgesEnabled === false ? 0 : deps.badge(active);
    safeSend(titlebar, 'titlebar:set-service', formatWindowTitle(sv.def.displayName, count));
    safeSend(titlebar, 'titlebar:set-context', active);
  };

  const refreshGrid = (): void => {
    // The tree may have changed (split, drop, close, resize) — the pages have to follow
    // their cells, not just the chrome. placeGridCells re-enters this via attach()'s
    // refreshAll when it wakes a leaf; its own re-entrancy guard breaks the cycle.
    if (active === GRID_ID) placeGridCells();
    // Reseed here rather than at each of the routes that can invalidate focus (✕, detach,
    // unload, move, the startup prune): they all end in this push, so one rule here cannot
    // be the one someone forgets to call. pruneFromGrid still clears focus eagerly so the
    // cleared value never reaches a consumer between the two.
    focusedCell = reseedFocus(deps.cfg.grid ?? null, focusedCell);
    const content = rects().content;
    const layout = computeGridLayout(deps.cfg.grid ?? null, content);
    const names: Record<string, string> = {};
    const badges: Record<string, number> = {};
    for (const c of layout.cells) {
      const def = deps.services.find((d) => d.id === c.service);
      names[c.service] = def?.displayName ?? c.service;
      badges[c.service] =
        deps.cfg.services[c.service]?.badgesEnabled === false ? 0 : deps.badge(c.service);
    }
    const state: GridViewState = {
      layout,
      origin: { x: content.x, y: content.y },
      names,
      badges,
      focused: focusedCell,
    };
    safeSend(grid, 'grid:state', state);
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

  const refreshAll = (): void => { refreshRail(); refreshTitlebar(); refreshGrid(); refreshWindowTitle(); };

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
  grid.webContents.on('did-finish-load', refreshAll);

  // --- selection --------------------------------------------------------------
  /**
   * Re-establish the grid's z-order: chrome at the bottom, service views above it.
   * `addChildView` appends, and appending a view that is ALREADY a child re-raises it
   * to topmost — that is the documented, maintainer-endorsed way to reorder, and there
   * is no raise/lower API. Index-to-depth direction is not documented, so nothing here
   * passes an index.
   *
   * Needed because attaching a service while the grid is on screen appends its view
   * above everything, including views that must stay on top.
   *
   * Goes through ServiceView.raise rather than adding `sv.view` directly: a stuck cell's
   * recovery overlay has to come back up with its page, or a badge tick would bury it.
   */
  const restack = (): void => {
    window.contentView.addChildView(grid);
    for (const sv of views.values()) sv.raise();
    // Last, unconditionally: the drop preview describes where a page WILL go, so it has
    // to sit above every page it is describing. Re-raising a hidden view is free.
    window.contentView.addChildView(overlay);
  };

  /**
   * Waking a leaf calls out to index.ts, which attaches — and attach() ends in
   * refreshAll() → refreshGrid() → back in here, once per sleeping leaf. It terminates
   * (each round attaches one more service) but it re-places a half-built grid N times
   * and fires N² chrome pushes on the way. The outermost call is the one that sees the
   * complete view set, so let it finish the job alone.
   */
  let placingCells = false;

  /**
   * Has a view been added since the last restack? Only an ADD can disturb the z-order —
   * addChildView appends, so the newcomer lands above everything, including the views that
   * must stay on top. Nothing else does: a resize moves rects, a removal leaves the
   * survivors' relative order alone.
   *
   * Gating restack on this is what keeps a divider drag cheap. placeGridCells runs on every
   * pointermove of a resize, and an unconditional restack there is a native view re-order
   * per view per frame — hundreds a second — the first of which re-parents the grid chrome
   * view that is holding pointer capture for the very gesture driving it.
   *
   * Set in api.attach, the one place THIS file mounts a view, so it covers both the grid's
   * own wake path (ensureAttached → attachService → attach) and an attach from anywhere
   * else. It is not the only addChildView in the app: ServiceView.showRecovery mounts a
   * stuck cell's recovery overlay on a 15s timer, above everything. Nothing here tracks
   * that — restack already brings a recovery overlay back up with its own page (see
   * ServiceView.raise), and the one ordering it could still break, "the drop preview sits
   * above every page it describes", is enforced by showDropPreview itself rather than by a
   * flag a second file has to remember to set.
   * Starts true: the construction-time addChildView order below puts the overlay on top,
   * but any service attached before the grid is first selected lands above it.
   */
  let stackDirty = true;

  /**
   * Put every gridded service's view in its cell's BODY rect — below that cell's header
   * strip, which the chrome view underneath owns. Non-gridded views are hidden: the grid
   * is the selection, so nothing else is on screen.
   */
  const placeGridCells = (): void => {
    if (placingCells) return;
    placingCells = true;
    try {
      const content = rects().content;
      // Wake any leaf that has no view yet. Done before the placement loop so the view
      // exists by the time we position it — attach() mounts synchronously.
      for (const service of new Set(
        computeGridLayout(deps.cfg.grid ?? null, content).cells.map((c) => c.service),
      )) {
        if (!views.has(service)) deps.ensureAttached(service);
      }

      // Re-read the tree: waking a leaf re-enters index.ts, and that path can edit
      // deps.cfg.grid (detach/unload prune). Placing from a pre-wake layout would put the
      // pages where the nested refreshGrid has already told the chrome they are not.
      const layout = computeGridLayout(deps.cfg.grid ?? null, content);
      const inGrid = new Set(layout.cells.map((c) => c.service));

      for (const [vid, sv] of views) sv.setVisible(inGrid.has(vid));
      for (const c of layout.cells) {
        const sv = views.get(c.service);
        if (!sv) continue; // ensureAttached declined (service removed or detached)
        // Also moves any live recovery overlay (ServiceView.setRect carries it), so a
        // stuck cell recovers inside its own body rect with its header still on screen.
        sv.setRect(c.body);
      }
      // Nothing was added, so nothing moved in the stack — see stackDirty.
      if (stackDirty) { stackDirty = false; restack(); }
    } finally {
      placingCells = false;
    }
  };

  /**
   * Drop a service's leaf from the grid tree. Both teardown paths (detach, unload) call
   * this before their own refreshAll().
   *
   * It cannot live in the caller instead. refreshAll → refreshGrid → placeGridCells runs
   * MID-teardown, at the one moment index.ts's isDetached(id) is contractually still
   * false: the view is already out of `views`, the service's own window does not exist
   * yet, and detach's ordering contract forbids writing `detached: true` to config first.
   * A leaf still naming the service therefore reads as "gridded, awake, but viewless" and
   * ensureAttached builds a SECOND live view of it — same partition, duplicate badge
   * scraper and notification relay. Pruning here makes "gridded and detached are mutually
   * exclusive" (grid-view spec §7.1) hold for every path THROUGH this window without the
   * caller having to order anything, and an unloaded service stops being a cell, which
   * §6's "grid membership means live" already requires. It is not by construction: a
   * SLEEPING service is detached without ever entering detach/unload, so index.ts's
   * setDetached has to call dropFromGrid itself for that one case.
   *
   * In-memory only, like persist(): config is flushed on quit.
   */
  const pruneFromGrid = (id: string): void => {
    // The zoom target is a cell reference, so it cannot outlive the cell — a stale one
    // would aim the titlebar's zoom buttons at a service that is no longer on screen.
    if (focusedCell === id) focusedCell = undefined;
    const tree = deps.cfg.grid ?? null;
    const next = removeFromGrid(tree, id);
    // remove() returns the same object when the service was not a leaf — leave config
    // alone rather than writing a no-op edit over it.
    if (next === tree) return;
    deps.cfg.grid = next;
  };

  const select = (id: string | undefined): void => {
    // GRID_ID is a reserved selection, not a service: it has no entry in `views`, so it
    // must be admitted before the selectable-id guard below rejects it.
    if (id === GRID_ID) {
      active = GRID_ID;
      manager.setVisible(false);
      grid.setVisible(true);
      placeGridCells();
      refreshAll();
      deps.onActiveChanged(GRID_ID);
      return;
    }
    // An unselectable id (sleeping ⇒ no view, or detached ⇒ its own window) must not be
    // left as `active`: that strands a dead id over a blank content rect. Fall back to the
    // manager rather than returning. select(undefined) passes the guard, so no recursion.
    if (id !== undefined && (!views.has(id) || deps.detached(id))) { select(undefined); return; }
    active = id;
    const r = rects().content;
    manager.setVisible(id === undefined);
    grid.setVisible(false);
    for (const [vid, sv] of views) {
      const on = vid === id;
      sv.setVisible(on);
      if (on) sv.setRect(r);
    }
    refreshAll();
    deps.onActiveChanged(id);
  };

  // Deferred to here, past placeGridCells/refreshGrid, purely to stay out of their TDZ
  // (see relayout's own comment). Still ahead of the `persist` resize binding below, so
  // the handler order is unchanged: lay out first, then record the new size.
  relayout();
  window.on('resize', relayout);

  const showManager = (): void => select(undefined);
  const showGrid = (): void => select(GRID_ID);

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
        get def() { return sv.def; },
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
        notifyClick: (n, e) => sv.notifyClick(n, e),
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

    attach: (def, view) => {
      const existing = views.get(def.id);
      if (existing) return hostFor(def.id)!;
      // A pre-built view is a LIVE view moving in from a detached window — mount it as-is
      // (no reload ⇒ scroll + drafts survive). Otherwise build a fresh one.
      const sv = view ?? createServiceView(def, deps.cfg);
      sv.mount(window, rects().content);
      sv.setVisible(false); // select() decides what's on screen
      views.set(def.id, sv);
      // mount() appended this view above everything, the overlay included — the grid's
      // z-order has to be re-established before it next paints. See stackDirty.
      stackDirty = true;
      // Which sibling view the user last clicked into. Electron documents this as the
      // supported way to tell them apart: "The focus and blur events of WebContents should
      // only be used to detect focus change between different WebContents ... in the same
      // window." Its macOS caveat does not apply on Linux. Only meaningful while the grid
      // is up — in single-view mode there is one visible page and zoom follows the
      // selection, not the click.
      sv.view.webContents.on('focus', () => {
        if (active !== GRID_ID || focusedCell === def.id) return;
        if (!gridServices(deps.cfg.grid ?? null).includes(def.id)) return;
        focusedCell = def.id;
        refreshGrid();
      });
      hosts.delete(def.id);
      // Mirrors serviceWindow's binding: a load wipes whatever main pushed into the page,
      // so main gets told to push it again. Without this an attached service never hears
      // about DND or its own hidden-ness after the first navigation.
      sv.setOnLoad(() => deps.onServiceLoad(def.id));
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
      // After the snapshot above (which needs `id` still in the attached list) and before
      // anything repaints: a detached service is not a cell, and leaving the leaf up would
      // have the very next refresh wake a duplicate view of it — see pruneFromGrid.
      pruneFromGrid(id);
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
      // Grid membership means live (grid-view spec §6), so an unloaded service is not a
      // cell. Before the repaint, or refreshGrid resurrects it behind the caller's back —
      // see pruneFromGrid.
      pruneFromGrid(id);
      if (active === id) select(next);
      refreshAll();
    },

    dropFromGrid: pruneFromGrid,

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
    showGrid,
    refreshGrid,

    setFocusedCell: (service) => {
      if (!gridServices(deps.cfg.grid ?? null).includes(service)) return;
      if (focusedCell === service) return;
      focusedCell = service;
      refreshGrid();
    },
    focusedCellId: () => (active === GRID_ID ? focusedCell : undefined),
    sendManager: (channel, ...args) => safeSend(manager, channel, ...args),
    sendRail: (channel, ...args) => safeSend(rail, channel, ...args),

    /** Native per-service context menu (rail right-click). Main owns it so it renders
     *  as a real menu rather than CSS, and so the actions are the same ones the tray
     *  drives. */
    popServiceMenu: (id) => {
      Menu.buildFromTemplate(deps.buildServiceMenu(id)).popup({ window });
    },

    /** The titlebar's ＋ while the grid is selected. The template is rebuilt on every pop —
     *  its contents depend on what is installed, gridded and detached right now. */
    popGridAddMenu: () => {
      Menu.buildFromTemplate(deps.buildGridAddMenu()).popup({ window });
    },

    contentRect: () => rects().content,

    /** Hidden while there is nothing to preview, so the overlay never sits over the pages
     *  outside a drag — it has no click-through, and neither does anything else in a
     *  WebContentsView stack. The rect is pushed in window coordinates with the content
     *  rect's origin alongside it, exactly as the grid chrome's own state is: the renderer
     *  positions what it is told and computes nothing. */
    showDropPreview: (r) => {
      // Raised here, by the code that shows it, so "the preview is above every page it
      // describes" holds without anyone else remembering to say so: a view mounted outside
      // api.attach — a stuck cell's recovery overlay, which appears on a timer — appends
      // above this one and no restack is due until the next attach. Re-adding an existing
      // child is how a view is raised (see restack) and costs nothing per drag.
      if (r !== null) window.contentView.addChildView(overlay);
      overlay.setVisible(r !== null);
      const content = rects().content;
      safeSend(overlay, 'grid:preview',
        r === null ? null : { ...r, originX: content.x, originY: content.y });
    },

    /** The rail/titlebar/grid/manager views belong to the WINDOW, not to any one service —
     *  no ServiceHost owns them, so index.ts must ask the window before falling back
     *  to a per-service lookup when routing titlebar IPC. */
    ownsWebContents: (wcId) =>
      rail.webContents.id === wcId ||
      titlebar.webContents.id === wcId ||
      grid.webContents.id === wcId ||
      overlay.webContents.id === wcId ||
      manager.webContents.id === wcId ||
      [...views.values()].some((sv) => sv.ownsWebContents(wcId)),
    persist,
    destroy: () => window.destroy(),
  };

  showManager(); // a fresh window with nothing selected shows the manager
  return api;
}
