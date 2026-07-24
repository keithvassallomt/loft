import type { ServiceKind } from './registry';
import type { ServiceInstance } from './instances';
import type { LoftConfig } from './config';
import type { HubState, TrayBackend } from '../shared/hubTypes';

export interface HubStateDeps {
  instances: readonly ServiceInstance[];
  kinds: readonly ServiceKind[];
  /** kind id → colour keys (icons.scanVariants). */
  variants: Record<string, string[]>;
  config: LoftConfig;
  running(id: string): boolean;
  visible(id: string): boolean;
  badge(id: string): number;
  trayBackend: TrayBackend;
  /** True when services asked to open at login but no autostart entry exists (e.g. the portal denied). */
  autostartBlocked: boolean;
}

export function buildHubState(deps: HubStateDeps): HubState {
  const services = deps.instances.map((inst) => {
    const c = deps.config.services[inst.id] ?? {};
    return {
      id: inst.id,
      kind: inst.kind,
      displayName: inst.displayName,
      selfHosted: inst.selfHosted,
      serverRequired: inst.serverRequired === true,
      defaultUrl: inst.url,
      running: deps.running(inst.id),
      visible: deps.visible(inst.id),
      badge: deps.badge(inst.id),
      badgesEnabled: c.badgesEnabled !== false,
      dnd: c.dnd ?? false,
      openOnStartup: c.openOnStartup ?? false,
      customUrl: c.customUrl ?? '',
      launcher: c.launcher === true,
      icon: inst.icon,
      variants: deps.variants[inst.kind] ?? [],
    };
  });
  const kinds = deps.kinds.map((k) => ({
    id: k.id,
    displayName: k.displayName,
    selfHosted: k.selfHosted,
    serverRequired: k.serverRequired === true,
    defaultUrl: k.url,
    instanceCount: deps.instances.filter((i) => i.kind === k.id).length,
  }));
  return {
    services,
    kinds,
    globals: {
      trayBackend: deps.trayBackend,
      autostartBlocked: deps.autostartBlocked,
      debug: deps.config.debug === true,
    },
  };
}
