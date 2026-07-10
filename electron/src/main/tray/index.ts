import type { ServiceDef } from '../registry';
import { connectSni } from './watcher';
import { SniItem } from './sniItem';
import { DbusMenu } from './dbusMenu';
import { TrayModel } from './model';
import { trayPixmap } from './icon';

export interface TrayDeps {
  services: readonly ServiceDef[];
  /** Saved per-service DND, seeded into the model at startup. */
  savedDnd?: Record<string, boolean>;
  /** Toggle a service window's visibility (show if hidden, hide if visible). */
  onToggleService(id: string): void;
  /** Set a service's DND to `enabled` (persist + reflect). */
  onToggleDnd(id: string, enabled: boolean): void;
  /** Open/focus the hub (Stage 4). */
  onShowHub(): void;
  /** Quit the whole app. */
  onQuit(): void;
}

export interface Tray {
  setBadge(id: string, n: number): void;
  setVisible(id: string, visible: boolean): void;
  setDnd(id: string, enabled: boolean): void;
}

const SVC_ACTION = /^svc:(.+):(toggle|dnd)$/;

/**
 * Build the tray model, wire it to the SNI icon + dbusmenu, connect to
 * StatusNotifierWatcher, and return a handle for pushing badge/visible/DND
 * updates. On any model change the icon pixmap is recomputed and the menu is
 * rebuilt.
 */
export async function startTray(deps: TrayDeps): Promise<Tray> {
  const model = new TrayModel();
  for (const svc of deps.services) {
    model.addService({
      id: svc.id,
      displayName: svc.displayName,
      badge: 0,
      dnd: deps.savedDnd?.[svc.id] ?? false,
      visible: false,
    });
  }

  const sni = new SniItem();
  const menu = new DbusMenu();

  const refresh = (): void => {
    sni.setIconPixmap(trayPixmap(model.iconOverlay()));
    menu.setModel(model.menuModel());
  };

  menu.onEvent = (actionId: string): void => {
    if (actionId === 'hub' || actionId === 'settings') return deps.onShowHub();
    if (actionId === 'quit') return deps.onQuit();
    const match = SVC_ACTION.exec(actionId);
    if (!match) return;
    const [, id, kind] = match;
    if (kind === 'toggle') {
      deps.onToggleService(id);
    } else {
      const current = model.menuModel().services.find((s) => s.id === id)?.dnd ?? false;
      deps.onToggleDnd(id, !current);
    }
  };

  // Seed the initial icon + menu, then let mutations drive updates.
  menu.setModel(model.menuModel());
  sni.setIconPixmap(trayPixmap(model.iconOverlay()));
  model.onChange = refresh;

  await connectSni({ sniPath: '/StatusNotifierItem', sni, menuPath: '/MenuBar', menu });

  return {
    setBadge: (id, n) => model.setBadge(id, n),
    setVisible: (id, visible) => model.setVisible(id, visible),
    setDnd: (id, enabled) => model.setDnd(id, enabled),
  };
}
