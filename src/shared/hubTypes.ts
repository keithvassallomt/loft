import type { TrayBackend } from '../main/trayBackend';

export type { TrayBackend };

export interface HubService {
  id: string;
  /** Registry kind — what the icon swatches and the badge parser belong to. */
  kind: string;
  displayName: string;
  selfHosted: boolean;
  /** A server address is mandatory (no usable default). Talk yes, Element no. */
  serverRequired: boolean;
  /** The URL used when no customUrl is set — named in the "leave blank to use…" hint so
   *  the renderer never hardcodes a service's default. */
  defaultUrl: string;
  running: boolean;
  visible: boolean;
  badge: number;
  badgesEnabled: boolean;
  dnd: boolean;
  openOnStartup: boolean;
  customUrl: string;
  launcher: boolean;
  /** 'brand' | a variant colour key | 'custom'. */
  icon: string;
  /** Colour keys this account's kind ships, for the swatch row. */
  variants: string[];
}

/** A supported app, for the two Add galleries. `instanceCount` is 0 for "Add a
 *  service" and ≥1 for "Add another". */
export interface HubKind {
  id: string;
  displayName: string;
  selfHosted: boolean;
  serverRequired: boolean;
  defaultUrl: string;
  instanceCount: number;
}

export interface HubGlobals { trayBackend: TrayBackend; autostartBlocked: boolean }
export interface HubState { services: HubService[]; kinds: HubKind[]; globals: HubGlobals; }

/** Result of an operation the user can get wrong. */
export interface OpResult { ok: boolean; error?: string }

export interface ServicePatch {
  openOnStartup?: boolean;
  badgesEnabled?: boolean;
  dnd?: boolean;
  customUrl?: string;
  launcher?: boolean;
}
export interface GlobalPatch { trayBackend?: TrayBackend }
export interface RecoverOpts { clearCaches: boolean }
