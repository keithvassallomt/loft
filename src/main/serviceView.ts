import { BrowserWindow, WebContentsView, session, shell } from 'electron';
import { join } from 'node:path';
import type { ServiceDef } from './registry';
import { effectiveUrl } from './registry';
import type { LoftConfig } from './config';
import type { Rect } from './layout';
import { configureSession } from './session';
import { dechromeCssFor } from './dechromeCss';
import { clampZoom } from './zoom';
import { createStuckWatcher, clearServiceCaches, startInitialLoad } from './recovery';
import { classifyNavigation, classifyWindowOpen, isExternallyOpenable } from './links';

/**
 * One service's web view and every policy that belongs to the service rather than
 * to a window: its partition, preload, zoom, navigation rules, and recovery overlay.
 *
 * Deliberately host-agnostic. It is mounted into a per-service window today and into
 * the Loft window's content rect in plan 09b — the same object, moved, not rebuilt.
 * That is what lets a detach keep the page's scroll position and half-typed drafts.
 */
export interface ServiceView {
  readonly def: ServiceDef;
  readonly view: WebContentsView;
  /** Add this view (and any live recovery overlay) to a window, at `rect`. */
  mount(window: BrowserWindow, rect: Rect): void;
  /** Remove from the current window WITHOUT destroying the page. */
  unmount(): void;
  /** Raise to the top of the current host's stack, keeping any live recovery overlay
   *  above the page. Electron has no raise/lower API — re-adding an existing child IS the
   *  reorder — so a host that restacks (loftWindow's grid) must come through here rather
   *  than re-adding `view` itself, which would bury the overlay under the blank page it
   *  exists to rescue. No-op while unmounted. */
  raise(): void;
  /** Set the single "page finished loading" host hook (re-push of DND/hidden). Replaces any
   *  previous one — the view's webContents outlives any one host now, so hosts must set this
   *  rather than each binding their own did-finish-load listener (which would leak per move). */
  setOnLoad(fn: () => void): void;
  /** Re-lay-out within the current window. */
  setRect(rect: Rect): void;
  /** Whether the view is drawn. JS keeps running either way (backgroundThrottling: false). */
  setVisible(visible: boolean): void;
  /** Adjust zoom by delta (rounded to 0.1, clamped 0.3–3.0) and apply it. Does NOT persist. */
  setZoom(delta: number): void;
  /** The live zoom factor — the host reads this when persisting. */
  getZoom(): number;
  /** Push Do Not Disturb to the page (gates Notification-API relays). */
  pushDnd(enabled: boolean): void;
  /** Tell the page whether it is hidden (drives document.hidden/visibilityState). */
  pushHidden(hidden: boolean): void;
  /** Ask the page to navigate to a conversation (notification click). */
  navigate(url: string): void;
  /** Replay a notification click into the page's own handler. */
  notifyClick(notifyId: number, epoch: string): void;
  /** Navigate, hiding any stale recovery overlay and re-arming stuck detection. */
  loadUrl(url: string): void;
  /** Reload and re-arm stuck detection. */
  reload(): void;
  /** Clear the service's caches (never cookies), then reload. */
  clearAndReload(): Promise<void>;
  /** True if the id belongs to this service's view or its recovery overlay. */
  ownsWebContents(id: number): boolean;
  /** Tear down the stuck watcher and any overlay. Call from the host's 'closed'. */
  dispose(): void;
}

/**
 * Sending to a view's webContents throws "Render frame was disposed before
 * WebFrameMain could be accessed" when the frame is transiently gone — e.g. a
 * Messenger call opening its popup, or any navigation — and these sends fire from
 * window focus/blur/show/hide handlers that can land in that window. Guard them;
 * dropped state is re-pushed on the view's did-finish-load (registerService).
 */
function safeSend(view: WebContentsView, channel: string, ...args: unknown[]): void {
  const wc = view.webContents;
  if (wc.isDestroyed()) return;
  try {
    wc.send(channel, ...args);
  } catch {
    /* render frame disposed transiently */
  }
}

/**
 * The caller MUST `mount()` in the same synchronous tick as this returns.
 *
 * This starts the first navigation immediately (see startInitialLoad below), which
 * arms the stuck watcher — and `showRecovery` early-returns while unmounted. The
 * watcher flips its own `showing` flag *before* calling us and never re-arms
 * (recovery.ts), so a view left unmounted across the 15s timeout would silently
 * never show its recovery overlay, and the later onRecovered() would no-op against
 * a `showing` that is stuck true. A blank, unrecoverable service view is exactly
 * what that overlay exists to prevent.
 *
 * Unreachable today: `serviceWindow` mounts synchronously and never unmounts. It
 * becomes reachable the moment anything re-parents a view, which is this file's
 * whole purpose — so before 09b calls `unmount()`, give the overlay a pending flag
 * that `mount()` re-checks, or move the initial load into an explicit start() the
 * host calls after mounting.
 */
export function createServiceView(def: ServiceDef, cfg: LoftConfig): ServiceView {
  const partition = `persist:${def.id}`;
  const ses = session.fromPartition(partition);
  configureSession(ses, partition);

  // Service view (remote URL) — the isolated per-service partition + our preload.
  const serviceView = new WebContentsView({
    webPreferences: {
      partition,
      backgroundThrottling: false,
      preload: join(__dirname, '../preload/service.js'),
      additionalArguments: [`--loft-service=${def.id}`],
      // Sandboxed (a same-origin window.open call popup shares this opener's
      // renderer process; a non-sandboxed WebRTC renderer SIGSEGVs on Intel Xe),
      // but contextIsolation:false so the (sandboxed) preload still shares the
      // page's main world and can wrap window.Notification directly.
      sandbox: true,
      contextIsolation: false,
    },
  });
  serviceView.webContents.setUserAgent(ses.getUserAgent());

  // Static de-chrome CSS (the dynamic Messenger-banner bit runs in the preload).
  const dechromeCss = dechromeCssFor(def.id);
  if (dechromeCss) {
    serviceView.webContents.on('did-finish-load', () => {
      void serviceView.webContents.insertCSS(dechromeCss);
    });
  }

  // Hand a URL to the user's default browser (never a scheme we shouldn't, e.g.
  // javascript:/file:). Used by both link-handling paths below.
  const openInBrowser = (url: string): void => {
    if (!isExternallyOpenable(url)) return;
    void shell.openExternal(url).catch((err) => console.error('openExternal failed:', url, err));
  };

  // window.open / target=_blank. A user-clicked external link opens in the browser
  // (classifyWindowOpen); calls and windowed (featured) SSO/auth popups stay in-app.
  // Same-origin ALWAYS stays in-app, which is what guarantees a Messenger call popup
  // (opened same-origin) is never flung to the browser regardless of its disposition.
  //
  // For the in-app case: a child window inherits the OPENER's webPreferences, so
  // without overriding, the popup would inherit the service view's main-world/
  // un-sandboxed prefs (contextIsolation:false, sandbox:false) + our preload +
  // --loft-service, and its renderer SIGSEGVs (exitCode 139) doing WebRTC. Force a
  // plain, sandboxed, isolated child (matching the POC's default popup) with no Loft
  // preload/arg — it needs no integration.
  serviceView.webContents.setWindowOpenHandler((details) => {
    if (
      classifyWindowOpen(serviceView.webContents.getURL(), details.url, details.disposition) === 'external'
    ) {
      openInBrowser(details.url);
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          additionalArguments: [],
        },
      },
    };
  });

  // Top-level navigation of the service view itself. The view must never leave its
  // web app: a cross-origin nav — or, for Messenger (which shares facebook.com with
  // all of Facebook), a nav out of the messaging app to a post/profile/photo — opens
  // in the browser and is prevented in-place, so the user never "loses" the service.
  // isInPlace (same-document fragment nav) is left alone; the initial loadURL and
  // same-origin app/auth navigations are not top-level document changes we hijack.
  serviceView.webContents.on('will-navigate', (e, url, isInPlace) => {
    if (isInPlace) return;
    if (classifyNavigation(def.id, serviceView.webContents.getURL(), url) !== 'external') return;
    // Only intercept schemes we can actually hand off. For anything else (ftp:, a
    // custom app scheme) let Chromium's own external-protocol handling take it rather
    // than dead-ending the click with a bare preventDefault.
    if (!isExternallyOpenable(url)) return;
    e.preventDefault();
    openInBrowser(url);
  });

  // The call popup must present as real Chrome per-webContents (not just via the
  // session default) — mirrors the POC (dev_local/electron_test/main.js), which
  // set the child UA explicitly on did-create-window.
  serviceView.webContents.on('did-create-window', (child) => {
    child.webContents.setUserAgent(ses.getUserAgent());
  });

  // Zoom: track the live factor so user changes survive in-page reloads (Electron
  // resets zoom on a full navigation).
  let currentZoom = cfg.services[def.id]?.window?.zoom ?? 1;
  serviceView.webContents.on('did-finish-load', () =>
    serviceView.webContents.setZoomFactor(currentZoom),
  );

  // Single host-owned did-finish-load hook (see setOnLoad). Bound exactly once; hosts
  // re-point the target on adoption instead of stacking their own listeners.
  let onLoad: (() => void) | undefined;
  serviceView.webContents.on('did-finish-load', () => onLoad?.());

  // Current host + rect. Both are undefined/zero until mount(); the recovery overlay
  // needs them because it is added to whichever window the service currently lives in.
  let host: BrowserWindow | undefined;
  let rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  let recoveryView: WebContentsView | undefined;
  // Mirrors the last setVisible() call. Only serviceWindow existed until now, and it
  // hosts exactly one view, so a recovery overlay could just default to visible. Now
  // that loftWindow stacks N service views in one content rect with at most one drawn
  // (setVisible(false) on attach, and in select() for every non-active tab), an overlay
  // created (or re-added on mount) while this view is the hidden one must stay hidden
  // too, or a background tab's stuck-load overlay paints over the active tab's content.
  let visible = true;

  // --- Recovery overlay -------------------------------------------------------
  // A view can end up permanently blank (e.g. a corrupt service worker aborting
  // every navigation). Detect "nothing ever committed" and offer a way out; the
  // user chooses — we never clear their data unasked.

  const showRecovery = (): void => {
    if (recoveryView || !host) return;
    const view = new WebContentsView({
      webPreferences: { preload: join(__dirname, '../preload/recovery.js') },
    });
    recoveryView = view;
    view.webContents.on('did-finish-load', () => safeSend(view, 'recovery:set-service', def.displayName));
    void view.webContents.loadFile(join(__dirname, '../renderer/recovery/index.html'));
    host.contentView.addChildView(view); // above the service view
    view.setBounds(rect);
    view.setVisible(visible); // don't paint over a window whose active tab is elsewhere
  };

  const hideRecovery = (): void => {
    if (!recoveryView) return;
    const view = recoveryView;
    recoveryView = undefined;
    // The host (and this view's webContents) may already be gone by the time this
    // runs — e.g. quit/remove-service landing during clearAndReload's await, or a
    // late did-navigate firing after quit. Never throw from a window action.
    if (host && !host.isDestroyed()) host.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  };

  const watcher = createStuckWatcher({
    timeoutMs: 15_000,
    getUrl: () => serviceView.webContents.getURL(),
    onStuck: showRecovery,
    onRecovered: hideRecovery,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  });
  serviceView.webContents.on('did-navigate', (_e, url) => watcher.navigated(url));

  // Single choke point for real navigations: hides a stale overlay and re-arms
  // stuck detection so no navigation path (initial load, customUrl change, ...)
  // can silently bypass the watcher.
  const loadUrl = (url: string): void => {
    hideRecovery();
    void serviceView.webContents.loadURL(url);
    watcher.armed();
  };

  // Ctrl+R / F5 — there is no app menu (Menu.setApplicationMenu(null)), so the
  // usual reload accelerator does not exist. Safe to reference `api` here: the
  // handler only ever fires asynchronously, long after construction returns.
  serviceView.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const isReload = input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r');
    if (isReload) api.reload();
  });

  // Kick off the first navigation. Slack (clearCachesOnStart) has its wedge-prone
  // persisted service worker cleared first so a fresh, working SW registers each
  // launch — see startInitialLoad. A clear failure still loads (never left blank).
  void startInitialLoad(def.clearCachesOnStart ?? false, {
    clearCaches: () => clearServiceCaches(ses),
    load: () => loadUrl(effectiveUrl(def, cfg.services[def.id]?.customUrl)),
    onError: (err) => console.error(`clearCachesOnStart(${def.id}) failed:`, err),
  });

  const api: ServiceView = {
    def,
    view: serviceView,
    mount: (w, r) => {
      host = w;
      rect = r;
      w.contentView.addChildView(serviceView);
      serviceView.setBounds(r);
      // addChildView doesn't carry a prior setVisible(false) across, so re-assert our own
      // state — a background tab detached into its own window must not arrive drawn over
      // whatever that window is already showing. Both of today's callers happen to be safe
      // (they setVisible immediately after), which is exactly why this is worth pinning.
      serviceView.setVisible(visible);
      // Carry a live overlay across the move — a service can be stuck *while* it is
      // re-parented, and re-adding it here keeps it above the service view.
      if (recoveryView) {
        w.contentView.addChildView(recoveryView);
        recoveryView.setBounds(r);
        recoveryView.setVisible(visible); // re-adding defaults to visible; match our own state
      }
    },
    raise: () => {
      if (!host || host.isDestroyed()) return;
      host.contentView.addChildView(serviceView);
      // Same re-assert as mount(): a re-add is not documented to carry setVisible(false)
      // across, and the grid restacks views that are deliberately hidden (everything not
      // in the tree), so a lost `false` would paint a non-gridded page over the grid.
      serviceView.setVisible(visible);
      if (recoveryView) {
        host.contentView.addChildView(recoveryView);
        recoveryView.setVisible(visible);
      }
    },
    unmount: () => {
      if (host && !host.isDestroyed()) {
        if (recoveryView) host.contentView.removeChildView(recoveryView);
        host.contentView.removeChildView(serviceView);
      }
      host = undefined;
    },
    setOnLoad: (fn) => { onLoad = fn; },
    setRect: (r) => {
      rect = r;
      serviceView.setBounds(r);
      recoveryView?.setBounds(r);
    },
    setVisible: (v) => {
      visible = v;
      serviceView.setVisible(v);
      recoveryView?.setVisible(v);
    },
    setZoom: (delta) => {
      currentZoom = clampZoom(currentZoom + delta);
      serviceView.webContents.setZoomFactor(currentZoom);
    },
    getZoom: () => currentZoom,
    pushDnd: (enabled) => safeSend(serviceView, 'service:dnd', enabled),
    pushHidden: (hidden) => safeSend(serviceView, 'service:visibility', hidden),
    navigate: (url) => safeSend(serviceView, 'service:navigate', url),
    notifyClick: (notifyId, epoch) => safeSend(serviceView, 'service:notify-click', { notifyId, epoch }),
    loadUrl,
    reload: () => {
      hideRecovery();
      serviceView.webContents.reload();
      watcher.armed();
    },
    clearAndReload: async () => {
      await clearServiceCaches(ses);
      api.reload();
    },
    ownsWebContents: (id) =>
      serviceView.webContents.id === id || recoveryView?.webContents.id === id,
    dispose: () => {
      watcher.dispose();
      hideRecovery();
    },
  };

  return api;
}
