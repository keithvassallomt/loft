import type { ServiceDef } from './registry';
import type { LoftConfig } from './config';
import type { HubState, TrayBackend } from '../shared/hubTypes';

export interface HubStateDeps {
  services: readonly ServiceDef[];
  config: LoftConfig;
  running(id: string): boolean;
  visible(id: string): boolean;
  badge(id: string): number;
  trayBackend: TrayBackend;
  /** True when services asked to open at login but no autostart entry exists (e.g. the portal denied). */
  autostartBlocked: boolean;
}

export function buildHubState(deps: HubStateDeps): HubState {
  const services = deps.services.map((def) => {
    const c = deps.config.services[def.id];
    return {
      id: def.id,
      displayName: def.displayName,
      selfHosted: def.selfHosted,
      installed: c !== undefined,
      running: deps.running(def.id),
      visible: deps.visible(def.id),
      badge: deps.badge(def.id),
      badgesEnabled: c?.badgesEnabled !== false,
      dnd: c?.dnd ?? false,
      openOnStartup: c?.openOnStartup ?? false,
      customUrl: c?.customUrl ?? '',
    };
  });
  return { services, globals: { trayBackend: deps.trayBackend, autostartBlocked: deps.autostartBlocked } };
}
