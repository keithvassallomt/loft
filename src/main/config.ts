import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { TrayBackend } from './trayBackend';
import { clampZoom } from './zoom';

/** A window's position and size. The Loft window uses this; zoom is per service. */
export interface Bounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface WindowState extends Bounds {
  zoom: number;
}

export interface ServiceConfig {
  customUrl?: string;
  window?: WindowState;
  openOnStartup?: boolean;
  /** Per-service Do Not Disturb; persisted + reflected in the tray menu. */
  dnd?: boolean;
  /** Per-service badge indicator toggle (tray/title); GetStatus() still reports the true count when false. */
  badgesEnabled?: boolean;
  /** Reopen this service in its own window rather than the Loft window's rail (spec 09 §3). */
  detached?: boolean;
  /** Opt-in per-service .desktop launcher. Absent or false = no launcher (spec 09 §6e). */
  launcher?: boolean;
}

export interface LoftConfig {
  services: Record<string, ServiceConfig>;
  /** Global Do Not Disturb (mutes every service); persisted + reflected in the tray. */
  globalDnd?: boolean;
  /** Tray backend preference ('auto', 'gnome-panel', or 'sni'). */
  trayBackend?: TrayBackend;
  /** Schema version, gating one-shot migrations. Absent = pre-v2 (see migrate.ts). */
  configVersion?: number;
  /** The Loft window's own bounds. No zoom — zoom is per service. */
  window?: Bounds;
  /** "Reopen detached services in their own windows". Absent = true. */
  reopenDetached?: boolean;
  /** Rail order by service id. Ids not listed sort after these, in registry order. */
  railOrder?: string[];
}

export function defaultConfig(): LoftConfig {
  return { services: {} };
}

/** Absent means enabled — the setting is ticked by default (spec 09 §2). */
export function reopenDetachedEnabled(cfg: LoftConfig): boolean {
  return cfg.reopenDetached !== false;
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'loft', 'config.json');
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Bounds are usable only with finite, positive width and height — these values are
 * handed straight to BrowserWindow, and a string or a zero blanks or throws.
 * x/y are optional (absent = let the WM place it), so they are dropped individually.
 */
export function sanitizeBounds(v: unknown): Bounds | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const b = v as Record<string, unknown>;
  if (!isFiniteNumber(b.width) || !isFiniteNumber(b.height)) return undefined;
  if (b.width <= 0 || b.height <= 0) return undefined;
  const out: Bounds = { width: b.width, height: b.height };
  if (isFiniteNumber(b.x)) out.x = b.x;
  if (isFiniteNumber(b.y)) out.y = b.y;
  return out;
}

function sanitizeWindowState(v: unknown): WindowState | undefined {
  const b = sanitizeBounds(v);
  if (!b) return undefined;
  const zoom = (v as Record<string, unknown>).zoom;
  return { ...b, zoom: isFiniteNumber(zoom) ? clampZoom(zoom) : 1 };
}

/**
 * Whitelist a service entry field by field. Unknown keys are dropped: this file is
 * hand-editable and its values reach BrowserWindow and the renderer directly.
 * Absent stays absent — `badgesEnabled` and `reopenDetached` both mean "true when
 * missing", so writing a default here would change their meaning.
 */
export function sanitizeServiceConfig(v: unknown): ServiceConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const s = v as Record<string, unknown>;
  const out: ServiceConfig = {};
  if (typeof s.customUrl === 'string') out.customUrl = s.customUrl;
  const w = sanitizeWindowState(s.window);
  if (w) out.window = w;
  if (typeof s.openOnStartup === 'boolean') out.openOnStartup = s.openOnStartup;
  if (typeof s.dnd === 'boolean') out.dnd = s.dnd;
  if (typeof s.badgesEnabled === 'boolean') out.badgesEnabled = s.badgesEnabled;
  if (typeof s.detached === 'boolean') out.detached = s.detached;
  if (typeof s.launcher === 'boolean') out.launcher = s.launcher;
  return out;
}

export function loadConfig(path: string): LoftConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LoftConfig>;
    const rawServices =
      parsed.services && typeof parsed.services === 'object' && !Array.isArray(parsed.services)
        ? (parsed.services as Record<string, unknown>)
        : {};
    const services: Record<string, ServiceConfig> = {};
    for (const [id, v] of Object.entries(rawServices)) {
      // Assigning this key hits Object.prototype's __proto__ setter rather than
      // creating an entry: the service would vanish AND the map's prototype would be
      // reassigned. JSON.parse gives it to us as a normal own property, so it can
      // reach here from a hand-edited config.
      if (id === '__proto__') continue;
      services[id] = sanitizeServiceConfig(v);
    }

    const trayBackend =
      parsed.trayBackend === 'gnome-panel' || parsed.trayBackend === 'sni' || parsed.trayBackend === 'auto'
        ? parsed.trayBackend
        : undefined;

    const base: LoftConfig = { services };
    if (parsed.globalDnd === true) base.globalDnd = true;
    if (trayBackend) base.trayBackend = trayBackend;
    if (isFiniteNumber(parsed.configVersion)) base.configVersion = parsed.configVersion;
    const w = sanitizeBounds(parsed.window);
    if (w) base.window = w;
    if (typeof parsed.reopenDetached === 'boolean') base.reopenDetached = parsed.reopenDetached;
    if (Array.isArray(parsed.railOrder)) {
      base.railOrder = parsed.railOrder.filter((x): x is string => typeof x === 'string');
    }
    return base;
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(path: string, cfg: LoftConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
}
