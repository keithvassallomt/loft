import type { TrayBackend } from '../main/trayBackend';

export type { TrayBackend };

export interface HubService {
  id: string;
  displayName: string;
  selfHosted: boolean;
  installed: boolean;
  running: boolean;
  visible: boolean;
  badge: number;
  badgesEnabled: boolean;
  dnd: boolean;
  openOnStartup: boolean;
  customUrl: string;
  launcher: boolean;
}

export interface HubGlobals { trayBackend: TrayBackend; autostartBlocked: boolean }
export interface HubState { services: HubService[]; globals: HubGlobals; }

export interface ServicePatch {
  openOnStartup?: boolean;
  badgesEnabled?: boolean;
  dnd?: boolean;
  customUrl?: string;
  launcher?: boolean;
}
export interface GlobalPatch { trayBackend?: TrayBackend }
export interface RecoverOpts { clearCaches: boolean }
