import { BrowserWindow, WebContentsView, session } from 'electron';
import { join } from 'node:path';
import type { ServiceDef } from './registry';
import { effectiveUrl } from './registry';
import type { LoftConfig } from './config';
import { computeLayout } from './layout';
import { configureSession } from './session';

export interface ServiceWindow {
  def: ServiceDef;
  window: BrowserWindow;
  serviceView: WebContentsView;
  titlebarView: WebContentsView;
  show(): void;
  hide(): void;
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

  // Titlebar view (our chrome) — its own partition-free session is fine.
  const titlebar = new WebContentsView({
    webPreferences: { preload: join(__dirname, '../preload/titlebar.js') },
  });
  titlebar.webContents.on('did-finish-load', () =>
    titlebar.webContents.send('titlebar:set-service', def.displayName),
  );
  titlebar.webContents.loadFile(join(__dirname, '../renderer/titlebar/index.html'));

  // Service view (remote URL) — the isolated per-service partition.
  const serviceView = new WebContentsView({
    webPreferences: { partition, backgroundThrottling: false },
  });
  serviceView.webContents.setUserAgent(ses.getUserAgent());

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

  // Restore zoom.
  const zoom = saved?.zoom ?? 1;
  serviceView.webContents.on('did-finish-load', () => serviceView.webContents.setZoomFactor(zoom));

  // Close-to-tray: hide unless the app is actually quitting.
  window.on('close', (e) => {
    if (!opts.onQuit()) {
      e.preventDefault();
      window.hide();
    }
  });

  // Persist bounds + zoom on the way out (Stage 1: in-memory cfg object; Stage 4 wires saveConfig).
  const persist = () => {
    const [w, h] = window.getSize();
    const [x, y] = window.getPosition();
    cfg.services[def.id] = {
      ...cfg.services[def.id],
      window: { x, y, width: w, height: h, zoom: serviceView.webContents.getZoomFactor() },
    };
  };
  window.on('resize', persist);
  window.on('move', persist);

  serviceView.webContents.loadURL(effectiveUrl(def, cfg.services[def.id]?.customUrl));

  const api: ServiceWindow = {
    def,
    window,
    serviceView,
    titlebarView: titlebar,
    show: () => { window.show(); window.focus(); },
    hide: () => window.hide(),
  };

  if (!opts.minimized) api.show();
  return api;
}
