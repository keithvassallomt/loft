import { BrowserWindow, WebContentsView, session } from 'electron';
import { join } from 'node:path';
import type { ServiceDef } from './registry';
import { effectiveUrl } from './registry';
import type { LoftConfig } from './config';
import { computeLayout } from './layout';
import { configureSession } from './session';
import { dechromeCssFor } from './dechromeCss';
import { formatWindowTitle } from './serviceTitle';

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
  /** Reflect the unread count in the window title (until the tray lands in Stage 3). */
  setBadge(count: number): void;
  /** Push the current Do Not Disturb state to the page (gates Notification-API relays). */
  pushDnd(enabled: boolean): void;
  /** Tell the page whether the window is hidden (drives document.hidden/visibilityState). */
  pushHidden(hidden: boolean): void;
  /** Ask the page to navigate to a conversation (Messenger notification click). */
  navigate(url: string): void;
}

export function createServiceWindow(
  def: ServiceDef,
  cfg: LoftConfig,
  opts: { minimized: boolean; onQuit: () => boolean },
): ServiceWindow {
  const partition = `persist:${def.id}`;
  const ses = session.fromPartition(partition);
  configureSession(ses, partition);

  const saved = cfg.services[def.id]?.window;
  const width = saved?.width ?? 1100;
  const height = saved?.height ?? 800;

  const window = new BrowserWindow({
    width,
    height,
    x: saved?.x,
    y: saved?.y,
    frame: false,
    show: false,
    title: def.displayName,
  });

  // Sending to a view's webContents throws "Render frame was disposed before
  // WebFrameMain could be accessed" when the frame is transiently gone — e.g. a
  // Messenger call opening its popup, or any navigation — and these sends fire
  // from window focus/blur/show/hide handlers that can land in that window. Guard
  // them; dropped state is re-pushed on the view's did-finish-load (registerService).
  const safeSend = (view: WebContentsView, channel: string, ...args: unknown[]): void => {
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    try { wc.send(channel, ...args); } catch { /* render frame disposed transiently */ }
  };

  // Titlebar view (our chrome) — its own partition-free session is fine.
  const titlebar = new WebContentsView({
    webPreferences: { preload: join(__dirname, '../preload/titlebar.js') },
  });
  titlebar.webContents.on('did-finish-load', () =>
    safeSend(titlebar, 'titlebar:set-service', def.displayName),
  );
  titlebar.webContents.loadFile(join(__dirname, '../renderer/titlebar/index.html'));

  // Service view (remote URL) — the isolated per-service partition + our preload.
  const serviceView = new WebContentsView({
    webPreferences: {
      partition,
      backgroundThrottling: false,
      preload: join(__dirname, '../preload/service.js'),
      additionalArguments: [`--loft-service=${def.id}`],
      // Un-sandboxed, isolation-off so the preload runs in the page's real main
      // world and can wrap window.Notification directly (Stage 3b). The
      // titlebar view is unaffected — it keeps isolation + contextBridge.
      sandbox: false,
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

  // Calls may open in a window.open popup (Messenger). Allow + inherit UA/session.
  serviceView.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { webPreferences: { partition } },
  }));

  window.contentView.addChildView(titlebar);
  window.contentView.addChildView(serviceView);

  const relayout = () => {
    const [w, h] = window.getContentSize();
    const { titlebar: t, service: s } = computeLayout(w, h);
    titlebar.setBounds(t);
    serviceView.setBounds(s);
  };
  relayout();
  window.on('resize', relayout);

  // Zoom: track the live factor so user changes survive in-page reloads (Electron
  // resets zoom on a full navigation) and so persist() records the current value.
  let currentZoom = saved?.zoom ?? 1;
  serviceView.webContents.on('did-finish-load', () =>
    serviceView.webContents.setZoomFactor(currentZoom),
  );

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
  const persist = () => {
    const [w, h] = window.getSize();
    const [x, y] = window.getPosition();
    cfg.services[def.id] = {
      ...cfg.services[def.id],
      window: { x, y, width: w, height: h, zoom: currentZoom },
    };
  };
  window.on('resize', persist);
  window.on('move', persist);
  window.on('hide', persist);

  serviceView.webContents.loadURL(effectiveUrl(def, cfg.services[def.id]?.customUrl));

  const api: ServiceWindow = {
    def,
    window,
    serviceView,
    titlebarView: titlebar,
    show: () => { window.show(); window.focus(); },
    hide: () => window.hide(),
    setZoom: (delta: number) => {
      // Round to 0.1 steps to avoid float drift; clamp to the 0.3–3.0 range.
      currentZoom = Math.min(3, Math.max(0.3, Math.round((currentZoom + delta) * 10) / 10));
      serviceView.webContents.setZoomFactor(currentZoom);
      persist();
    },
    persist,
    setBadge: (count: number) => {
      const title = formatWindowTitle(def.displayName, count);
      window.setTitle(title); // OS window title (alt-tab / taskbar / overview)
      safeSend(titlebar, 'titlebar:set-service', title); // our visible titlebar strip
    },
    pushDnd: (enabled: boolean) => safeSend(serviceView, 'service:dnd', enabled),
    pushHidden: (hidden: boolean) => safeSend(serviceView, 'service:visibility', hidden),
    navigate: (url: string) => safeSend(serviceView, 'service:navigate', url),
  };

  if (!opts.minimized) api.show();
  return api;
}
