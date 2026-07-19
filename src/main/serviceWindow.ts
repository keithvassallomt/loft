import { BrowserWindow, WebContentsView } from 'electron';
import { join } from 'node:path';
import type { ServiceDef } from './registry';
import type { LoftConfig } from './config';
import { computeLayout } from './layout';
import { formatWindowTitle } from './serviceTitle';
import { createServiceView, type ServiceView } from './serviceView';
import type { ServiceHost } from './serviceHost';

/**
 * A detached host: one BrowserWindow showing exactly one service, with our own
 * titlebar strip above it. Everything about the *service* lives in ServiceView;
 * this file is only about the *window* — bounds, close-to-tray, the titlebar.
 */
export interface ServiceWindow extends ServiceHost {
  def: ServiceDef;
  window: BrowserWindow;
  serviceView: WebContentsView;
  titlebarView: WebContentsView;
  /** Write current bounds + zoom into the in-memory config. Window-only: a rail
   *  entry has no bounds of its own, so this is not part of ServiceHost. */
  persist(): void;
  /** Hand this window's LIVE view back for re-mounting elsewhere (the mirror of
   *  LoftWindow.detach), and tear down just the window shell. The returned view is NOT
   *  disposed — the caller re-mounts it. */
  releaseView(): ServiceView;
  /** Route the host's page-load hook to the underlying view's single slot (see
   *  ServiceView.setOnLoad) — so re-adopting a moved view never stacks listeners. */
  setOnLoad(fn: () => void): void;
}

export function createServiceWindow(
  def: ServiceDef,
  cfg: LoftConfig,
  opts: { minimized: boolean; onQuit: () => boolean; view?: ServiceView },
): ServiceWindow {
  const saved = cfg.services[def.id]?.window;

  const window = new BrowserWindow({
    width: saved?.width ?? 1100,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    frame: false,
    show: false,
    title: def.displayName,
  });

  // Guarded send — the titlebar's frame can be transiently gone during navigation,
  // and setBadge fires from handlers that can land in that window.
  const safeSend = (view: WebContentsView, channel: string, ...args: unknown[]): void => {
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    try {
      wc.send(channel, ...args);
    } catch {
      /* render frame disposed transiently */
    }
  };

  // Titlebar view (our chrome) — its own partition-free session is fine.
  const titlebar = new WebContentsView({
    webPreferences: { preload: join(__dirname, '../preload/titlebar.js') },
  });
  titlebar.webContents.on('did-finish-load', () => {
    safeSend(titlebar, 'titlebar:set-service', def.displayName);
    // The id, not a bare flag: the renderer needs it as the drag payload so the rail
    // knows which service was dropped (dataTransfer is unreadable until 'drop').
    safeSend(titlebar, 'titlebar:set-attachable', def.id);
    // A detached window always shows a service, so it always gets the icon and controls.
    safeSend(titlebar, 'titlebar:set-context', def.id);
  });
  titlebar.webContents.loadFile(join(__dirname, '../renderer/titlebar/index.html'));

  const sv = opts.view ?? createServiceView(def, cfg);

  const relayout = (): void => {
    const [w, h] = window.getContentSize();
    const { titlebar: t, content } = computeLayout(w, h);
    titlebar.setBounds(t);
    sv.setRect(content);
  };

  window.contentView.addChildView(titlebar);
  const [w0, h0] = window.getContentSize();
  sv.mount(window, computeLayout(w0, h0).content); // above the titlebar, as before
  // This window hosts exactly ONE service, so its view is by definition the drawn one — say so
  // rather than inheriting whatever the previous host left behind. A view moved in from the Loft
  // window carries that window's TAB state: loftWindow.attach() sets visible=false and only
  // select() sets it back, so a service that was loaded but never switched to arrives hidden,
  // and mount() faithfully re-asserts that (serviceView.ts) — leaving this window drawing
  // nothing but its titlebar over an unpainted content rect. Fresh views default to visible, so
  // this only ever mattered for the moved-in case. Unconditional: `minimized` hides the WINDOW,
  // never the view inside it.
  sv.setVisible(true);
  relayout();
  window.on('resize', relayout);

  // Close-to-tray: hide unless the app is actually quitting.
  window.on('close', (e) => {
    if (!opts.onQuit()) {
      e.preventDefault();
      window.hide();
    }
  });

  // Persist bounds + zoom into the in-memory config (index.ts saveConfig runs on
  // before-quit). Bind to resize/move AND hide so a session that only zooms or never
  // moves the window still records its state.
  const persist = (): void => {
    const [w, h] = window.getSize();
    const [x, y] = window.getPosition();
    cfg.services[def.id] = {
      ...cfg.services[def.id],
      window: { x, y, width: w, height: h, zoom: sv.getZoom() },
    };
  };
  window.on('resize', persist);
  window.on('move', persist);
  window.on('hide', persist);

  // Safe only because ServiceView.dispose()'s overlay teardown guards on
  // isDestroyed() — 'closed' fires after the window (and its child views, since
  // win.destroy() doesn't tear down child WebContentsView webContents on its own)
  // is already destroyed.
  // Do NOT dispose a view we've handed to another host via releaseView().
  let released = false;
  window.on('closed', () => { if (!released) sv.dispose(); });

  const api: ServiceWindow = {
    def,
    window,
    serviceView: sv.view,
    titlebarView: titlebar,
    show: () => {
      window.show();
      window.focus();
    },
    hide: () => window.hide(),
    isVisible: () => window.isVisible(),
    setZoom: (delta: number) => {
      sv.setZoom(delta);
      persist();
    },
    persist,
    releaseView: () => {
      released = true;   // the 'closed' handler below must not dispose it now
      sv.unmount();      // take the live view out of this window
      window.destroy();  // tear down just the shell; the view lives on
      return sv;
    },
    setOnLoad: (fn) => sv.setOnLoad(fn),
    setBadge: (count: number) => {
      const title = formatWindowTitle(def.displayName, count);
      window.setTitle(title); // OS window title (alt-tab / taskbar / overview)
      safeSend(titlebar, 'titlebar:set-service', title); // our visible titlebar strip
    },
    pushDnd: (enabled: boolean) => sv.pushDnd(enabled),
    pushHidden: (hidden: boolean) => sv.pushHidden(hidden),
    navigate: (url: string) => sv.navigate(url),
    loadUrl: (url: string) => sv.loadUrl(url),
    reload: () => sv.reload(),
    clearAndReload: () => sv.clearAndReload(),
    ownsWebContents: (id: number) => titlebar.webContents.id === id || sv.ownsWebContents(id),
  };

  if (!opts.minimized) api.show();
  return api;
}
