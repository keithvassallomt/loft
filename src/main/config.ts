import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { TrayBackend } from './trayBackend';
import { clampZoom } from './zoom';
import { services as gridServices, RATIO_MIN, RATIO_MAX, type GridNode } from './gridTree';

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
  /**
   * Registry kind. Absent means the id itself, which is what every pre-multi-account
   * config says — that fallback is why this feature needs no migration.
   */
  kind?: string;
  /** User's display name. Absent means the kind's default (or "WhatsApp 2" for instance 2). */
  name?: string;
  /** 'brand' | a variant colour key ('rose', …) | 'custom'. Absent means 'brand'. */
  icon?: string;
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
  /** Grid view arrangement (grid-view spec §5/§6). Absent or null means an empty grid. */
  grid?: GridNode | null;
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
  if (typeof s.kind === 'string') out.kind = s.kind;
  if (typeof s.name === 'string') out.name = s.name;
  if (typeof s.icon === 'string') out.icon = s.icon;
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

/**
 * Recursion cap for sanitizeGridNodeShape (below). A real grid cannot nest this deep —
 * gridLayout's minimum cell size refuses splits well before 10 levels — so 64 is generous
 * headroom for any legitimate arrangement, while still far short of the actual call-stack
 * limit: past that, a pathological chain or a cyclic node (e.g. `node.b = node`, genuinely
 * reachable once a tree can arrive over IPC via structured clone, not just hand-edited
 * JSON) would throw RangeError instead of the null this file promises to return.
 */
const MAX_GRID_DEPTH = 64;

/**
 * Validate a persisted grid tree. Recursive because a half-valid tree is worse than no
 * tree: a split with one malformed child would break the "always exactly two children"
 * invariant every operation in gridTree.ts relies on. Anything malformed collapses to
 * null rather than throwing — a corrupt grid must cost the user their arrangement, never
 * their ability to start Loft. That guarantee is enforced here via MAX_GRID_DEPTH, not
 * borrowed from loadConfig's try/catch, which is what makes this safe against the
 * pathological *depth* and cycles that JSON.parse output — the only input this function
 * actually sees today — can contain.
 *
 * It does not bound total *work*. MAX_GRID_DEPTH caps how deep the recursion can go, not
 * how many times it's called: a node whose `a` and `b` slots both point at the same child
 * object is a DAG, not a cycle, so there is no self-reference for the depth cap to catch —
 * yet this unmemoized traversal revisits that shared child from both branches at every
 * level, so call count doubles per level and hits roughly 2^depth well inside the depth-64
 * budget (depth 24 alone is ~33.5M calls). The cap does eventually stop it — but not before
 * V8 runs out of memory around depth ~25, an uncatchable fatal error, not the RangeError
 * the cap exists to turn into a catchable null.
 *
 * JSON cannot express that aliasing, so it can't reach loadConfig's call into this
 * function today. But structured clone can — the IPC transport this comment used to invoke
 * as proof of safety. A future caller handing this function IPC-cloned or otherwise
 * attacker-controlled data must bound its input itself (e.g. reject aliased/oversized
 * input before it gets here); the depth cap alone does not make that call site safe. Don't
 * add a node-visit counter to close this gap until such a caller actually exists — there
 * isn't one today, and hardening against a hazard nothing can yet trigger is the wrong
 * trade.
 */
export function sanitizeGridNode(v: unknown): GridNode | null {
  const node = sanitizeGridNodeShape(v, 0);
  if (!node) return null;
  // One ServiceView cannot render in two cells, so a duplicate is not a recoverable
  // typo — there is no correct way to pick which occurrence wins.
  const ids = gridServices(node);
  if (new Set(ids).size !== ids.length) return null;
  return node;
}

function sanitizeGridNodeShape(v: unknown, depth: number): GridNode | null {
  if (depth > MAX_GRID_DEPTH) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const n = v as Record<string, unknown>;

  if (n.kind === 'leaf') {
    return typeof n.service === 'string' && n.service.length > 0
      ? { kind: 'leaf', service: n.service }
      : null;
  }

  if (n.kind !== 'split') return null;
  if (n.dir !== 'row' && n.dir !== 'col') return null;
  if (!isFiniteNumber(n.ratio) || n.ratio <= 0 || n.ratio >= 1) return null;
  // 0/1/out-of-range/non-finite are structurally invalid — no cell to draw — and are
  // rejected above. Anything inside (0,1) but outside gridTree's own interactive bounds
  // is instead a legible intent to make one pane small, so clamp it into the same range
  // a resize drag would have produced rather than rejecting a merely extreme ratio.
  const ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, n.ratio));
  const a = sanitizeGridNodeShape(n.a, depth + 1);
  const b = sanitizeGridNodeShape(n.b, depth + 1);
  if (!a || !b) return null;
  return { kind: 'split', dir: n.dir, ratio, a, b };
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
    const grid = sanitizeGridNode(parsed.grid);
    if (grid) base.grid = grid;
    return base;
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(path: string, cfg: LoftConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
}
