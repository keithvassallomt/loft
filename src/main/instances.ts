import { getKind, type ServiceKind } from './registry';
import type { LoftConfig } from './config';

/** `icon` values that are not a variant colour key. */
export const BRAND_ICON = 'brand';
export const CUSTOM_ICON = 'custom';

/** Long enough for any real account label, short enough to stay a usable window title. */
export const MAX_NAME_LENGTH = 64;

/** The Loft window's own caption key (loftWindow.LOFT_WINDOW_KEY), lowercased. */
const RESERVED_NAME = 'loft';

/**
 * One configured account. Everything a caller used to read off a registry entry, with
 * `id` now naming the ACCOUNT and `displayName` the user's name for it.
 */
export interface ServiceInstance extends Omit<ServiceKind, 'id' | 'displayName'> {
  /** Config key, session partition, icon file, launcher filename, rail/grid key. */
  id: string;
  /** Registry kind id — what the preload, badge parser and de-chroming key on. */
  kind: string;
  displayName: string;
  /** Stable D-Bus object-path segment; never moves on rename. */
  dbusSegment: string;
  /** BRAND_ICON, a variant colour key, or CUSTOM_ICON. */
  icon: string;
}

/** Absent means the id itself — which is exactly what every pre-multi-account config says. */
export function kindOf(id: string, cfg: LoftConfig): string {
  return cfg.services[id]?.kind ?? id;
}

/**
 * Which account of its kind this is: 1 for the bare kind id, N for `<kind>-<N>`.
 *
 * 0 means "fits no scheme" — only reachable from a hand-edited config, and the one case
 * dbusSegmentFor has to derive a segment some other way.
 */
export function instanceNumber(id: string, kind: string): number {
  if (id === kind) return 1;
  if (!id.startsWith(`${kind}-`)) return 0;
  const rest = id.slice(kind.length + 1);
  if (!/^\d+$/.test(rest)) return 0;
  const n = parseInt(rest, 10);
  // `whatsapp-1` is not a legal id: instance 1 is the bare kind id, and admitting both
  // would let two entries claim the same number and therefore the same D-Bus segment.
  return n >= 2 ? n : 0;
}

export function defaultInstanceName(kindDisplayName: string, n: number): string {
  return n <= 1 ? kindDisplayName : `${kindDisplayName} ${n}`;
}

/** D-Bus path segments admit [A-Za-z0-9_] only, and may not start with a digit. */
function sanitizeSegment(s: string): string {
  const t = s.replace(/[^A-Za-z0-9_]/g, '');
  return t === '' || /^[0-9]/.test(t) ? `_${t}` : t;
}

/**
 * The object-path segment for an instance — derived from its kind's DEFAULT name plus
 * its number, never from the current display name.
 *
 * Three things follow, all load-bearing: existing installs keep byte-identical paths; a
 * rename does not relocate a scriptable object; and the result is always a valid segment
 * (registry names are ASCII, user-chosen ones are not — "Xogħol" has no valid path).
 */
export function dbusSegmentFor(id: string, cfg: LoftConfig): string {
  const kind = kindOf(id, cfg);
  const def = getKind(kind);
  const n = def ? instanceNumber(id, kind) : 0;
  if (!def || n === 0) return sanitizeSegment(id);
  const base = sanitizeSegment(def.displayName);
  return n === 1 ? base : `${base}${n}`;
}

export function resolveInstance(id: string, cfg: LoftConfig): ServiceInstance | undefined {
  const entry = cfg.services[id];
  if (!entry) return undefined;
  const kind = kindOf(id, cfg);
  const def = getKind(kind);
  if (!def) return undefined;
  const { id: _kindId, displayName: kindName, ...rest } = def;
  return {
    ...rest,
    id,
    kind,
    displayName: entry.name ?? defaultInstanceName(kindName, instanceNumber(id, kind)),
    dbusSegment: dbusSegmentFor(id, cfg),
    icon: entry.icon ?? BRAND_ICON,
  };
}

/** Installed instances in config order. Entries naming no known kind are skipped —
 *  index.ts already warns about those by name at startup. */
export function listInstances(cfg: LoftConfig): ServiceInstance[] {
  const out: ServiceInstance[] = [];
  for (const id of Object.keys(cfg.services)) {
    const inst = resolveInstance(id, cfg);
    if (inst) out.push(inst);
  }
  return out;
}

/** The lowest free id for a kind. Ids are not reserved after removal, so a gap is
 *  reused — the same thing that already happens when you remove and re-add a service. */
export function allocateInstanceId(kind: string, cfg: LoftConfig): string {
  if (cfg.services[kind] === undefined) return kind;
  for (let n = 2; ; n++) {
    const id = `${kind}-${n}`;
    if (cfg.services[id] === undefined) return id;
  }
}

/** A default name that already satisfies the uniqueness rule — a default must never be
 *  born invalid. Steps the number up until nothing collides. */
export function allocateInstanceName(kindDisplayName: string, n: number, cfg: LoftConfig): string {
  const taken = new Set(
    listInstances(cfg).map((i) => i.displayName.trim().toLowerCase()),
  );
  for (let k = Math.max(1, n); ; k++) {
    const candidate = defaultInstanceName(kindDisplayName, k);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export type NameError = 'empty' | 'too-long' | 'reserved' | 'duplicate';

/**
 * Why `name` cannot be `id`'s display name, or undefined if it can.
 *
 * Uniqueness is not tidiness: the GNOME Shell helper and KWin both locate a window by
 * its CAPTION, and a service window's caption is its display name. Two instances sharing
 * one means Show/Hide/Focus reaches whichever window matched first, and a service named
 * "Loft" hijacks the Loft window itself.
 */
export function validateInstanceName(
  name: string, id: string, cfg: LoftConfig,
): NameError | undefined {
  const t = name.trim();
  if (t === '') return 'empty';
  if (t.length > MAX_NAME_LENGTH) return 'too-long';
  const lower = t.toLowerCase();
  if (lower === RESERVED_NAME) return 'reserved';
  for (const other of listInstances(cfg)) {
    if (other.id === id) continue;
    if (other.displayName.trim().toLowerCase() === lower) return 'duplicate';
  }
  return undefined;
}

/** The sentence the Name field shows. Lives beside the rule it describes so the two
 *  cannot drift — a message that no longer matches its check is worse than none. */
export function nameErrorMessage(err: NameError): string {
  switch (err) {
    case 'empty': return 'Enter a name.';
    case 'too-long': return `Use ${MAX_NAME_LENGTH} characters or fewer.`;
    case 'duplicate': return 'Another service already uses that name.';
    case 'reserved': return '“Loft” is reserved for the main window.';
  }
}
