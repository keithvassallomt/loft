import type { TrayBackend } from '../main/trayBackend';

export type { TrayBackend };

export interface HubService {
  id: string;
  displayName: string;
  selfHosted: boolean;
  /** A server address is mandatory (no usable default). Talk yes, Element no. */
  serverRequired: boolean;
  /** The URL used when no customUrl is set — named in the "leave blank to use…" hint so
   *  the renderer never hardcodes a service's default. */
  defaultUrl: string;
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
