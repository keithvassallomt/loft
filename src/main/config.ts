import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { TrayBackend } from './trayBackend';
import type { AutoOpen } from '../shared/hubTypes';
import { clampZoom } from './zoom';
import { services as gridServices, RATIO_MIN, RATIO_MAX, type GridNode } from './gridTree';
import { sanitizeBubbles, type Bubble } from './bubbles';

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
  /**
   * Auto-open mode. Absent = disabled. Supersedes the legacy `openOnStartup` boolean, which
   * is still read (as 'login') for back-compat and retired on the first `autoOpen` write —
   * see effectiveAutoOpen. 'disabled' is never written; it is represented by the field's
   * absence, keeping the config free of no-op keys.
   */
  autoOpen?: 'login' | 'launch';
  /** @deprecated Legacy pre-tri-state flag; read via effectiveAutoOpen, never written anew. */
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
  /** Developer mode: Shift+right-click a service view opens the Chromium developer menu
   *  (inspect element / DevTools). Absent or false = off. */
  debug?: boolean;
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
  /** Pinned conversations, in pin order. Absent means none — an empty list is never written. */
  bubbles?: Bubble[];
}

export function defaultConfig(): LoftConfig {
  return { services: {} };
}

/** Absent means enabled — the setting is ticked by default (spec 09 §2). */
export function reopenDetachedEnabled(cfg: LoftConfig): boolean {
  return cfg.reopenDetached !== false;
}

/**
 * The single place a service's auto-open mode is decided. An explicit `autoOpen` wins; a
 * legacy `openOnStartup: true` means 'login' (so pre-tri-state configs behave exactly as
 * before); anything else is 'disabled'. No code should branch on the raw fields.
 */
export function effectiveAutoOpen(c?: ServiceConfig): AutoOpen {
  if (c?.autoOpen === 'login' || c?.autoOpen === 'launch') return c.autoOpen;
  if (c?.openOnStartup === true) return 'login';
  return 'disabled';
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
  if (s.autoOpen === 'login' || s.autoOpen === 'launch') out.autoOpen = s.autoOpen;
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

/**
 * Turn already-parsed JSON into a LoftConfig, dropping everything that is not a value this
 * app is prepared to hand to BrowserWindow, the tray or a renderer.
 *
 * Throws only for `services` present as a non-object. Every OTHER bad value is dropped and
 * the rest of the config is kept, which is the long-standing convention here — but a
 * `services` that is a string or an array is the one shape whose "drop it" outcome is
 * indistinguishable from a wiped install, so it is a load FAILURE and not a repair. See
 * loadConfigResult: a failure never becomes writable state.
 */
export function parseConfigValue(parsed: Partial<LoftConfig>): LoftConfig {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config root is not a JSON object');
  }
  const rawServices =
    parsed.services === undefined || parsed.services === null
      ? {}
      : parsed.services && typeof parsed.services === 'object' && !Array.isArray(parsed.services)
      ? (parsed.services as Record<string, unknown>)
      : undefined;
  if (rawServices === undefined) throw new Error('config "services" is not an object');

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
  if (parsed.debug === true) base.debug = true;
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
  // Absent rather than `[]` when empty, keeping the file free of no-op keys — the same
  // convention `autoOpen` and `globalDnd` follow.
  const bubbles = sanitizeBubbles(parsed.bubbles);
  if (bubbles.length) base.bubbles = bubbles;
  return base;
}

/** Parse config JSON text. Throws on malformed JSON or an unusable `services`. */
export function parseConfig(text: string): LoftConfig {
  return parseConfigValue(JSON.parse(text) as Partial<LoftConfig>);
}

/**
 * Read and parse a config file.
 *
 * A MISSING file is the only failure that yields defaults — that is genuinely a first run.
 * Anything else (malformed JSON, EACCES, EIO, a directory where the file should be) THROWS,
 * because the config that exists on disk could not be read and the caller must not go on to
 * treat an empty in-memory config as the user's settings. Doing exactly that is what once
 * let a single unreadable read overwrite every service, every per-service setting and the
 * whole top level with `{"services":{}}` on the next window move.
 *
 * Callers that need to keep running past a failure want loadConfigResult + the config store,
 * which turns a failure into explicitly NON-WRITABLE state rather than into defaults.
 */
export function loadConfig(path: string): LoftConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
    throw err;
  }
  return parseConfig(text);
}

/** Where the known-good copy of `path` lives. */
export function backupConfigPath(path: string): string {
  return `${path}.bak`;
}

/** Where an unreadable `path` is set aside when a backup takes over from it. */
export function corruptConfigPath(path: string): string {
  return `${path}.corrupt`;
}

export type ConfigLoadResult =
  /** Read and parsed from the primary file. `text` is the exact bytes that parsed. */
  | { status: 'loaded'; config: LoftConfig; text: string }
  /** No config file exists — a genuine first run. */
  | { status: 'missing'; config: LoftConfig }
  /** The primary was unusable and the backup was not. `text` is the backup's bytes. */
  | { status: 'recovered'; config: LoftConfig; text: string; source: 'backup'; originalError: Error }
  /** Neither the primary nor the backup could be used. There is NO config to write. */
  | { status: 'error'; error: Error };

type Candidate =
  | { ok: true; config: LoftConfig; text: string }
  | { ok: false; missing: boolean; error: Error };

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function readCandidate(path: string): Candidate {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return { ok: false, missing, error: asError(err) };
  }
  try {
    return { ok: true, config: parseConfig(text), text };
  } catch (err) {
    return { ok: false, missing: false, error: asError(err) };
  }
}

/**
 * Read the config, distinguishing the four materially different outcomes the old
 * catch-everything-return-defaults could not tell apart.
 *
 * The backup is consulted for EVERY primary failure, including ENOENT: a config that
 * vanished is not a first run if we have a known-good copy of it, and treating it as one
 * is precisely how a recoverable state becomes permanent loss. 'missing' is therefore
 * reserved for "no primary AND no backup", which really is a fresh install.
 */
export function loadConfigResult(
  path: string,
  backupPath: string = backupConfigPath(path),
): ConfigLoadResult {
  const primary = readCandidate(path);
  if (primary.ok) return { status: 'loaded', config: primary.config, text: primary.text };

  const backup = readCandidate(backupPath);
  if (backup.ok) {
    return {
      status: 'recovered',
      config: backup.config,
      text: backup.text,
      source: 'backup',
      originalError: primary.error,
    };
  }
  if (primary.missing) return { status: 'missing', config: defaultConfig() };
  return { status: 'error', error: primary.error };
}

/** Distinguishes our own abandoned temp files from anything else beside the config. */
const TMP_SUFFIX = '.tmp';
let tmpSeq = 0;

/**
 * The mode to create the replacement file with: whatever the live file already has, so an
 * atomic save cannot silently loosen or tighten permissions the user set. 0o666 for a file
 * that does not exist yet is what plain writeFileSync would have used (umask applies).
 */
function fileMode(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o666;
  }
}

/**
 * fsync the directory so the rename itself is durable. Not every filesystem permits this
 * (and it is a no-op on some), so a failure here is ignored — the rename has still landed
 * in the page cache and is atomic with respect to any reader.
 */
function syncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* best effort */
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * Write the config ATOMICALLY: a full copy into a temp file in the same directory, flushed
 * and closed, then rename()d over the destination.
 *
 * The direct writeFileSync this replaces truncated the live file before writing a byte, so
 * a crash, a logout (~21ms of budget under Flatpak — see shutdown.ts), a full disk or a
 * concurrent reader could all see an empty or half-written config. rename() within one
 * directory is atomic: a reader sees the old file or the new one, never a partial one, and
 * a failure anywhere before the rename leaves the original completely untouched.
 *
 * Serialization happens BEFORE anything is opened, so even a throw from JSON.stringify
 * cannot leave a temp file behind, let alone damage the destination.
 */
export function saveConfig(path: string, cfg: LoftConfig): void {
  const json = JSON.stringify(cfg, null, 2);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  tmpSeq += 1;
  // pid + counter: two Loft processes should never both be writing (the single-instance
  // lock is taken before the config is ever touched), but a temp name that could collide
  // would turn "should never" into silent corruption.
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${tmpSeq}${TMP_SUFFIX}`);
  let fd: number | undefined;
  try {
    // 'wx' — never write through an existing name; a leftover temp is a bug, not a target.
    fd = openSync(tmp, 'wx', fileMode(path));
    writeFileSync(fd, json, 'utf8');
    // Before the rename, not after: rename orders the *name* change, it does not flush the
    // data. Without this a crash can leave the new name pointing at zero bytes — the exact
    // outcome the temp file exists to prevent.
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    try { unlinkSync(tmp); } catch { /* never created, or already gone */ }
    throw err;
  }
  syncDir(dir);
}

/**
 * Remove temp files a previous run abandoned (killed between open and rename). Only our own
 * naming is touched, and only entries older than an hour, so a save racing this cannot have
 * its temp file pulled out from under it. Best effort throughout: failing to tidy up is
 * never a reason to fail a launch.
 */
export function cleanupConfigTemps(path: string, now: number = Date.now()): string[] {
  const dir = dirname(path);
  const prefix = `.${basename(path)}.`;
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(TMP_SUFFIX)) continue;
    const full = join(dir, name);
    try {
      if (now - statSync(full).mtimeMs < 60 * 60 * 1000) continue;
      unlinkSync(full);
      removed.push(full);
    } catch {
      /* raced or unreadable — leave it */
    }
  }
  return removed;
}
