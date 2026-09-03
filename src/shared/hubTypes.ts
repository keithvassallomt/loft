import type { TrayBackend } from '../main/trayBackend';

export type { TrayBackend };

/** Per-service auto-open mode. Absent on disk = 'disabled'. */
export type AutoOpen = 'disabled' | 'login' | 'launch';

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
  autoOpen: AutoOpen;
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

/**
 * Which remediation the autostartBlocked warning should offer. Decided in main
 * (autostartFixFor), because only main knows whether this is a Flatpak and which desktop it
 * is running on; the wording lives in the renderer with the rest of the UI copy.
 */
export type AutostartFix = 'gnome' | 'flatpak' | 'native';

export interface HubGlobals {
  trayBackend: TrayBackend;
  autostartBlocked: boolean;
  /** Only meaningful while autostartBlocked is true. */
  autostartFix: AutostartFix;
  debug: boolean;
  iconEpoch: number;
}
export interface HubState { services: HubService[]; kinds: HubKind[]; globals: HubGlobals; }

/** Result of an operation the user can get wrong. */
export interface OpResult { ok: boolean; error?: string }

export interface ServicePatch {
  autoOpen?: AutoOpen;
  badgesEnabled?: boolean;
  dnd?: boolean;
  customUrl?: string;
  launcher?: boolean;
}
export interface GlobalPatch { trayBackend?: TrayBackend; debug?: boolean }
export interface RecoverOpts { clearCaches: boolean }
