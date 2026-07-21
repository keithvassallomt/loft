import { connectSni } from './watcher';
import { SniItem } from './sniItem';
import { DbusMenu } from './dbusMenu';
import { TrayModel } from './model';
import { trayPixmap } from './icon';

/** A service the tray knows about at startup (configured; maybe running). */
export interface TrayServiceSeed {
  id: string;
  displayName: string;
  dnd: boolean;
  running: boolean;
  visible: boolean;
}

export interface TrayDeps {
  configuredServices: readonly TrayServiceSeed[];
  globalDnd: boolean;
  /** Running service row clicked → show if hidden, hide if visible. */
  onToggleService(id: string): void;
  /** Available (not-running) service row clicked → launch it. */
  onLaunchService(id: string): void;
  /** Per-service Quit → stop the service (destroy its window). */
  onQuitService(id: string): void;
  /** Toggle a service's DND (persist + reflect). */
  onToggleDnd(id: string, enabled: boolean): void;
  /** Toggle global DND (persist + reflect). */
  onToggleGlobalDnd(enabled: boolean): void;
  /** Show the Loft window without changing which tab it is on. */
  onShowWindow(): void;
  /** Open/focus the hub / settings (Stage 4). */
  onShowHub(): void;
  /** Quit the whole app. */
  onQuit(): void;
}

export interface Tray {
  /** Register a newly-launched service that wasn't in the startup seed. */
  addService(seed: { id: string; displayName: string; dnd: boolean }): void;
  setBadge(id: string, n: number): void;
  setRunning(id: string, running: boolean): void;
  setVisible(id: string, visible: boolean): void;
  setDnd(id: string, enabled: boolean): void;
  setGlobalDnd(enabled: boolean): void;
}

const SVC_ACTION = /^svc:(.+):(toggle|dnd|quit|launch)$/;

/**
 * Build the tray model, wire it to the SNI icon + dbusmenu, connect to
 * StatusNotifierWatcher, and return a handle for pushing state updates. On any
 * model change the icon pixmap is recomputed and the menu is rebuilt.
 */
export async function startTray(deps: TrayDeps): Promise<Tray> {
  const model = new TrayModel();
  model.setGlobalDnd(deps.globalDnd);
  for (const s of deps.configuredServices) {
    model.addService({
      id: s.id,
      displayName: s.displayName,
      badge: 0,
      dnd: s.dnd,
      visible: s.visible,
      running: s.running,
    });
  }

  const sni = new SniItem();
  const menu = new DbusMenu();

  const refresh = (): void => {
    sni.setIconPixmap(trayPixmap(model.iconOverlay()));
    menu.setModel(model.menuModel());
  };

  menu.onEvent = (actionId: string): void => {
    if (actionId === 'show-window') return deps.onShowWindow();
    if (actionId === 'global:dnd') return deps.onToggleGlobalDnd(!model.menuModel().globalDnd);
    if (actionId === 'hub' || actionId === 'settings') return deps.onShowHub();
    if (actionId === 'quit') return deps.onQuit();
    const match = SVC_ACTION.exec(actionId);
    if (!match) return;
    const [, id, kind] = match;
    if (kind === 'toggle') deps.onToggleService(id);
    else if (kind === 'launch') deps.onLaunchService(id);
    else if (kind === 'quit') deps.onQuitService(id);
    else {
      const current = model.menuModel().running.find((s) => s.id === id)?.dnd ?? false;
      deps.onToggleDnd(id, !current);
    }
  };

  // Seed the initial icon + menu, then let mutations drive updates.
  menu.setModel(model.menuModel());
  sni.setIconPixmap(trayPixmap(model.iconOverlay()));
  model.onChange = refresh;

  await connectSni({ sniPath: '/StatusNotifierItem', sni, menuPath: '/MenuBar', menu });

  return {
    addService: (seed) =>
      model.addService({ id: seed.id, displayName: seed.displayName, badge: 0, dnd: seed.dnd, visible: false, running: false }),
    setBadge: (id, n) => model.setBadge(id, n),
    setRunning: (id, running) => model.setRunning(id, running),
    setVisible: (id, visible) => model.setVisible(id, visible),
    setDnd: (id, enabled) => model.setDnd(id, enabled),
    setGlobalDnd: (enabled) => model.setGlobalDnd(enabled),
  };
}
