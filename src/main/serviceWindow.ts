import { BrowserWindow, WebContentsView } from 'electron';
import { join } from 'node:path';
import type { ServiceDef } from './registry';
import type { LoftConfig } from './config';
import { computeLayout } from './layout';
import { formatWindowTitle } from './serviceTitle';
import { createServiceView } from './serviceView';

/**
 * A detached host: one BrowserWindow showing exactly one service, with our own
 * titlebar strip above it. Everything about the *service* lives in ServiceView;
 * this file is only about the *window* — bounds, close-to-tray, the titlebar.
 */
export interface ServiceWindow {
  def: ServiceDef;
  window: BrowserWindow;
  serviceView: WebContentsView;
  titlebarView: WebContentsView;
  show(): void;
  hide(): void;
  /** Adjust the service view's zoom by delta (clamped 0.3–3.0), apply, and persist. */
  setZoom(delta: number): void;
  /** Write current bounds + zoom into the in-memory config. */
  persist(): void;
  /** Reflect the unread count in the window title. */
  setBadge(count: number): void;
  /** Push the current Do Not Disturb state to the page (gates Notification-API relays). */
  pushDnd(enabled: boolean): void;
  /** Tell the page whether the window is hidden (drives document.hidden/visibilityState). */
  pushHidden(hidden: boolean): void;
  /** Ask the page to navigate to a conversation (Messenger notification click). */
  navigate(url: string): void;
  /** Navigate the service view, hiding any stale recovery overlay and re-arming stuck detection. */
  loadUrl(url: string): void;
  /** Reload the service view and re-arm stuck detection. */
  reload(): void;
  /** Clear the service's caches (never cookies), then reload. */
  clearAndReload(): Promise<void>;
  /** True if the given webContents id belongs to this window (titlebar, service, or recovery overlay). */
  ownsWebContents(id: number): boolean;
}

export function createServiceWindow(
  def: ServiceDef,
  cfg: LoftConfig,
  opts: { minimized: boolean; onQuit: () => boolean },
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
  titlebar.webContents.on('did-finish-load', () =>
    safeSend(titlebar, 'titlebar:set-service', def.displayName),
  );
  titlebar.webContents.loadFile(join(__dirname, '../renderer/titlebar/index.html'));

  const sv = createServiceView(def, cfg);

  const relayout = (): void => {
    const [w, h] = window.getContentSize();
    const { titlebar: t, content } = computeLayout(w, h);
    titlebar.setBounds(t);
    sv.setRect(content);
  };

  window.contentView.addChildView(titlebar);
  const [w0, h0] = window.getContentSize();
  sv.mount(window, computeLayout(w0, h0).content); // above the titlebar, as before
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
  window.on('closed', () => sv.dispose());

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
    setZoom: (delta: number) => {
      sv.setZoom(delta);
      persist();
    },
    persist,
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
