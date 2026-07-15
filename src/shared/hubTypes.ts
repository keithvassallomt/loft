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
}

export interface HubGlobals { trayBackend: TrayBackend; startAtLogin: boolean; }
export interface HubState { services: HubService[]; globals: HubGlobals; }

export interface ServicePatch {
  openOnStartup?: boolean;
  badgesEnabled?: boolean;
  dnd?: boolean;
  customUrl?: string;
}
export interface GlobalPatch { trayBackend?: TrayBackend; startAtLogin?: boolean; }
export interface RecoverOpts { clearCaches: boolean }
