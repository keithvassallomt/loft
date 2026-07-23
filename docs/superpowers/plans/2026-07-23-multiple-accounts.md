# Multiple Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Loft hold several accounts of the same service — two WhatsApps, two Slacks, two NextCloud Talk servers — each with its own login, badge, notifications, name and icon.

**Architecture:** The static registry splits into **kinds** (the app: URL, badge parser, brand icon) and **instances** (one account). An instance's id is the `config.services` key and is already what every subsystem keys on (`persist:<id>`, `loft://icon/<id>`, `loft-<id>.desktop`, `railOrder`, the grid tree), so instances need no new plumbing there — only an id space that admits more than one entry per kind. Three optional config fields (`kind`, `name`, `icon`) carry the difference, all absent-means-default, so no existing config needs migrating.

**Tech Stack:** TypeScript, Electron 43, Svelte 5 (runes) + Vite for the hub, `dbus-next`, Vitest, ImageMagick (build-time icon rasterisation only).

**Spec:** [docs/superpowers/specs/2026-07-23-electron-loft-multiple-accounts-design.md](../specs/2026-07-23-electron-loft-multiple-accounts-design.md)

## Global Constraints

- Every task ends green: `npm test` and `npm run build` both pass before the commit. Tasks touching `src/renderer/hub/` also run `npm run check`.
- **No config migration.** `configVersion` stays `2`. `kind` absent ⇒ the id itself; `name` absent ⇒ the kind's default; `icon` absent ⇒ `'brand'`. Any change that makes an existing `config.json` behave differently is a bug.
- **Display names are unique**: trimmed, non-empty, ≤ 64 characters, case-insensitively distinct from every *other* instance's name, and not `"Loft"` (case-insensitively). The GNOME helper and KWin match windows *by caption*, and a service window's caption is its display name.
- **D-Bus object paths never move on rename.** The segment derives from the kind's *default* name plus the instance number: `WhatsApp`, `WhatsApp2`, `NextCloudTalk`. Existing installs keep byte-identical paths.
- The service preload argument `--loft-service=` carries the **kind**, never the instance id. It selects the badge parser, the Messenger/Telegram scrape-only notification rule, the Slack avatar scanner, the Talk avatar picker and the Messenger de-chroming — all properties of the app, not the account.
- Instance ids: instance 1 of a kind is the bare kind id (`whatsapp`); instance N is `<kind>-<N>` with N the lowest integer ≥ 2 not in use. Allocated in main, never in the renderer. No cap.
- Custom icons accept raster files only (PNG/JPEG/WebP). Electron cannot rasterise SVG.
- `console.*` is the logging mechanism; there is no logger to reach for.
- Comments explain *why*, not *what* — match the density and voice of the file being edited.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `src/main/instances.ts` | The instance model: resolve, list, allocate ids and names, derive D-Bus segments, validate names. Pure — no `electron`, no fs. |
| `src/main/icons.ts` | Variant index (kind → colour keys), auto-assignment, and the icon-file fallback chain. Pure except one `readdirSync`. |
| `scripts/rasterize-icons.sh` | One-shot SVG → PNG for the icon variants (`npm run icons`). |
| `src/renderer/hub/components/IconPicker.svelte` | Brand + variant swatches + "Choose a file…". |
| `tests/instances.test.ts`, `tests/icons.test.ts` | Unit tests for the two new modules. |

**Modified**

| Path | Change |
|---|---|
| `src/main/registry.ts` | `ServiceDef` → `ServiceKind`, `SERVICES` → `KINDS`, `getService` → `getKind`, `listServices` → `listKinds`. Content unchanged. |
| `src/main/config.ts` | `kind` / `name` / `icon` on `ServiceConfig` + sanitisation. |
| `src/main/desktop.ts` | Launcher content and icon deployment take an instance. |
| `src/main/install.ts` | `addInstance` / `removeInstance`. |
| `src/main/dbus/loftService.ts` | Per-instance, dynamically exported/unexported objects. |
| `src/main/tray/{model,index,gnomePanel}.ts` | Carry the D-Bus segment; `setDisplayName`; `removeService`. |
| `gnome-shell-extension/extension.js` | Use the pushed segment instead of re-deriving from the display name. |
| `src/main/hubState.ts`, `src/main/hubIpc.ts`, `src/shared/hubTypes.ts`, `src/preload/hub.ts` | Instances vs kinds; rename/icon channels. |
| `src/main/index.ts` | Wire everything to instances. |
| `src/main/loftWindow.ts` | `services` becomes a callback so the rail sees instance changes. |
| `src/renderer/hub/**` | Add another; Name field; icon picker. |
| `package.json` | `icons` script; `copy-assets` carries the variants. |
| `CLAUDE.md`, `CHANGELOG.md` | Document the feature. |

**Moved**

`assets/icons/alt/<kind>-pastel-variants/<kind>-pastel-<colour>.svg` → `assets/icons/variants/<kind>-<colour>.svg` (+ a generated, committed `.png` beside each). `palette.json` is deleted.

---

### Task 1: Config carries kind, name and icon

**Files:**
- Modify: `src/main/config.ts:20-32` (`ServiceConfig`), `src/main/config.ts:99-112` (`sanitizeServiceConfig`)
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ServiceConfig.kind?: string`, `ServiceConfig.name?: string`, `ServiceConfig.icon?: string` — every later task reads these three.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('config', ...)` block in `tests/config.test.ts`:

```ts
  it('keeps kind, name and icon on a service entry', () => {
    const cfg = defaultConfig();
    cfg.services['whatsapp-2'] = { kind: 'whatsapp', name: 'Work', icon: 'rose' };
    const p = join(dir, 'config.json');
    saveConfig(p, cfg);
    expect(loadConfig(p).services['whatsapp-2']).toEqual({ kind: 'whatsapp', name: 'Work', icon: 'rose' });
  });

  it('drops non-string kind, name and icon rather than passing them through', () => {
    // These reach the D-Bus export, the window title and a file path; a number or an
    // object there is a crash, not a cosmetic problem.
    const p = join(dir, 'config.json');
    writeFileSync(p, JSON.stringify({
      services: { 'whatsapp-2': { kind: 7, name: { a: 1 }, icon: ['rose'], dnd: true } },
    }), 'utf8');
    expect(loadConfig(p).services['whatsapp-2']).toEqual({ dnd: true });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts -t 'kind, name and icon'`
Expected: FAIL — the round-trip test reports `{}` where it expected the three fields.

- [ ] **Step 3: Write the implementation**

In `src/main/config.ts`, add to `ServiceConfig` (above `customUrl`):

```ts
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
  // …the rest unchanged
```

and in `sanitizeServiceConfig`, immediately after the `const out: ServiceConfig = {};` line:

```ts
  if (typeof s.kind === 'string') out.kind = s.kind;
  if (typeof s.name === 'string') out.name = s.name;
  if (typeof s.icon === 'string') out.icon = s.icon;
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, no other test regresses.

- [ ] **Step 5: Commit**

```bash
git add src/main/config.ts tests/config.test.ts
git commit -m "feat(config): carry kind, name and icon per service entry"
```

---

### Task 2: The registry becomes a list of kinds

Pure rename, no behaviour change. Doing it on its own keeps the churn out of the tasks that carry real logic.

**Files:**
- Modify: `src/main/registry.ts`
- Modify (import sites): `src/main/index.ts`, `src/main/dbus/loftService.ts`, `src/main/loftWindow.ts`, `src/main/serviceView.ts`, `src/main/serviceWindow.ts`, `src/main/hubState.ts`, `src/main/railModel.ts`, `src/main/desktop.ts`, `src/main/install.ts`
- Test: `tests/registry.test.ts`, `tests/hubState.test.ts`, `tests/install.test.ts`, `tests/desktop.test.ts`, `tests/railModel.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ServiceKind` (same shape `ServiceDef` had), `KINDS: readonly ServiceKind[]`, `listKinds(): readonly ServiceKind[]`, `getKind(id: string): ServiceKind | undefined`, `effectiveUrl(kind: ServiceKind, customUrl?: string): string` (unchanged).

- [ ] **Step 1: Rename in `src/main/registry.ts`**

`ServiceDef` → `ServiceKind`; `SERVICES` → `KINDS`; `listServices` → `listKinds`; `getService` → `getKind`. Update the doc comment on the type's first line to read:

```ts
/** One supported app. A *kind*, not an account — several instances can share one. */
export interface ServiceKind {
```

`effectiveUrl`'s first parameter is renamed `kind` and its type becomes `ServiceKind`; its body and comment are unchanged.

- [ ] **Step 2: Update every import site**

Run: `rg -n 'ServiceDef|SERVICES|listServices|getService' src/`

In each hit outside `src/main/index.ts`, swap the imported names for the new ones. **In `src/main/index.ts` only**, keep the call sites untouched by adding a local shim directly below the imports — Task 10 replaces its body and nothing else in the file has to change twice:

```ts
// Instance resolution goes here in Task 10. Today a "service" is still a registry kind,
// so this shim keeps ~28 call sites stable across that switch.
const getService = (id: string): ServiceKind | undefined => getKind(id);
const listServices = (): readonly ServiceKind[] => listKinds();
```

and change index.ts's import line to `import { getKind, listKinds, KINDS, ServiceKind, effectiveUrl } from './registry';`, replacing the three bare `SERVICES` uses (grid prune, legacy-autostart sweep, `createLoftWindow`'s `services:`) with `KINDS`. Every `ServiceDef` type annotation in index.ts becomes `ServiceKind`.

- [ ] **Step 3: Update the tests**

In `tests/registry.test.ts`, `tests/hubState.test.ts`, `tests/install.test.ts`, `tests/desktop.test.ts`, swap `SERVICES`/`getService` for `KINDS`/`getKind`. `tests/railModel.test.ts` has its own local `SERVICES` fixture — leave it, but change its `ServiceDef` type import to `ServiceKind` if it has one.

- [ ] **Step 4: Verify**

Run: `npm test && npm run build`
Expected: PASS, and `tsc` clean. No behaviour changed, so no test should need its expectations edited.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(registry): a registry entry is a kind, not an account"
```

---

### Task 3: The instance model

**Files:**
- Create: `src/main/instances.ts`
- Create: `tests/instances.test.ts`

**Interfaces:**
- Consumes: `ServiceKind`, `getKind`, `KINDS` (Task 2); `LoftConfig`, `ServiceConfig` (Task 1).
- Produces:
  - `ServiceInstance` — `{ id, kind, displayName, dbusSegment, icon }` plus every `ServiceKind` field except `id`/`displayName`
  - `kindOf(id: string, cfg: LoftConfig): string`
  - `instanceNumber(id: string, kind: string): number` — 1 for a bare kind id, N for `<kind>-<N>`, 0 for anything else
  - `defaultInstanceName(kindDisplayName: string, n: number): string`
  - `dbusSegmentFor(id: string, cfg: LoftConfig): string`
  - `resolveInstance(id: string, cfg: LoftConfig): ServiceInstance | undefined`
  - `listInstances(cfg: LoftConfig): ServiceInstance[]`
  - `allocateInstanceId(kind: string, cfg: LoftConfig): string`
  - `allocateInstanceName(kindDisplayName: string, n: number, cfg: LoftConfig): string`
  - `validateInstanceName(name: string, id: string, cfg: LoftConfig): NameError | undefined`
  - `NameError = 'empty' | 'too-long' | 'reserved' | 'duplicate'`
  - `MAX_NAME_LENGTH = 64`, `BRAND_ICON = 'brand'`, `CUSTOM_ICON = 'custom'`

- [ ] **Step 1: Write the failing tests**

Create `tests/instances.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  resolveInstance, listInstances, allocateInstanceId, allocateInstanceName,
  defaultInstanceName, instanceNumber, dbusSegmentFor, validateInstanceName, kindOf,
} from '../src/main/instances';
import type { LoftConfig } from '../src/main/config';

const cfg = (services: LoftConfig['services']): LoftConfig => ({ services });

describe('kind resolution', () => {
  it('reads the kind from a legacy entry as its own id', () => {
    // Every pre-multi-account config looks like this. If this fallback ever stops
    // working, existing installs lose every service on upgrade.
    expect(kindOf('whatsapp', cfg({ whatsapp: {} }))).toBe('whatsapp');
  });

  it('reads an explicit kind when present', () => {
    expect(kindOf('whatsapp-2', cfg({ 'whatsapp-2': { kind: 'whatsapp' } }))).toBe('whatsapp');
  });

  it('resolves an instance to its kind\'s URL and its own id', () => {
    const inst = resolveInstance('whatsapp-2', cfg({ 'whatsapp-2': { kind: 'whatsapp' } }))!;
    expect(inst.id).toBe('whatsapp-2');
    expect(inst.kind).toBe('whatsapp');
    expect(inst.url).toBe('https://web.whatsapp.com/');
    expect(inst.displayName).toBe('WhatsApp 2');
  });

  it('is undefined for an entry naming no known kind', () => {
    expect(resolveInstance('nope', cfg({ nope: {} }))).toBeUndefined();
  });

  it('prefers the user\'s name over the default', () => {
    const inst = resolveInstance('whatsapp', cfg({ whatsapp: { name: 'Work' } }))!;
    expect(inst.displayName).toBe('Work');
  });

  it('lists only entries that resolve, in config order', () => {
    const list = listInstances(cfg({ slack: {}, bogus: {}, whatsapp: {} }));
    expect(list.map((i) => i.id)).toEqual(['slack', 'whatsapp']);
  });
});

describe('instance numbering', () => {
  it('numbers a bare kind id 1 and a suffixed one by its suffix', () => {
    expect(instanceNumber('whatsapp', 'whatsapp')).toBe(1);
    expect(instanceNumber('whatsapp-2', 'whatsapp')).toBe(2);
    expect(instanceNumber('whatsapp-10', 'whatsapp')).toBe(10);
  });

  it('returns 0 for an id that fits no scheme', () => {
    // Only reachable from a hand-edited config; dbusSegmentFor falls back for it.
    expect(instanceNumber('work', 'whatsapp')).toBe(0);
    expect(instanceNumber('whatsapp-x', 'whatsapp')).toBe(0);
    expect(instanceNumber('whatsapp-1', 'whatsapp')).toBe(0);
  });

  it('names instance 1 after the kind and later ones by number', () => {
    expect(defaultInstanceName('WhatsApp', 1)).toBe('WhatsApp');
    expect(defaultInstanceName('WhatsApp', 2)).toBe('WhatsApp 2');
  });
});

describe('id allocation', () => {
  it('gives the first instance the bare kind id', () => {
    expect(allocateInstanceId('whatsapp', cfg({}))).toBe('whatsapp');
  });

  it('gives the second -2 and fills gaps left by removals', () => {
    expect(allocateInstanceId('whatsapp', cfg({ whatsapp: {} }))).toBe('whatsapp-2');
    expect(allocateInstanceId('whatsapp', cfg({ whatsapp: {}, 'whatsapp-2': {} }))).toBe('whatsapp-3');
    expect(allocateInstanceId('whatsapp', cfg({ whatsapp: {}, 'whatsapp-3': {} }))).toBe('whatsapp-2');
  });

  it('reclaims the bare id when only the first instance was removed', () => {
    expect(allocateInstanceId('whatsapp', cfg({ 'whatsapp-2': { kind: 'whatsapp' } }))).toBe('whatsapp');
  });
});

describe('default names avoid collisions', () => {
  it('steps past a name the user already took', () => {
    // Without this a default could be born invalid, and the add would fail the very
    // uniqueness rule main is about to enforce.
    const c = cfg({ whatsapp: { name: 'WhatsApp 2' } });
    expect(allocateInstanceName('WhatsApp', 2, c)).toBe('WhatsApp 3');
  });

  it('returns the plain default when nothing collides', () => {
    expect(allocateInstanceName('WhatsApp', 2, cfg({ whatsapp: {} }))).toBe('WhatsApp 2');
  });
});

describe('D-Bus segments', () => {
  it('keeps today\'s paths byte-identical for existing installs', () => {
    const c = cfg({ whatsapp: {}, talk: {} });
    expect(dbusSegmentFor('whatsapp', c)).toBe('WhatsApp');
    expect(dbusSegmentFor('talk', c)).toBe('NextCloudTalk');
  });

  it('suffixes later instances by number', () => {
    expect(dbusSegmentFor('whatsapp-2', cfg({ 'whatsapp-2': { kind: 'whatsapp' } }))).toBe('WhatsApp2');
  });

  it('does not move when the service is renamed', () => {
    // The whole point of deriving from the kind's DEFAULT name: a rename must not
    // relocate a scriptable object path.
    const c = cfg({ 'whatsapp-2': { kind: 'whatsapp', name: 'Xogħol' } });
    expect(dbusSegmentFor('whatsapp-2', c)).toBe('WhatsApp2');
  });

  it('always yields a valid path segment, even for a hand-edited id', () => {
    const seg = dbusSegmentFor('my chat!', cfg({ 'my chat!': { kind: 'whatsapp' } }));
    expect(seg).toMatch(/^[A-Za-z0-9_]+$/);
  });
});

describe('name validation', () => {
  const c = cfg({ whatsapp: { name: 'Work' }, slack: {} });

  it('accepts a fresh name', () => {
    expect(validateInstanceName('Personal', 'slack', c)).toBeUndefined();
  });

  it('accepts the service keeping its own name', () => {
    expect(validateInstanceName('Work', 'whatsapp', c)).toBeUndefined();
  });

  it('rejects empty, whitespace-only and over-long names', () => {
    expect(validateInstanceName('', 'slack', c)).toBe('empty');
    expect(validateInstanceName('   ', 'slack', c)).toBe('empty');
    expect(validateInstanceName('x'.repeat(65), 'slack', c)).toBe('too-long');
  });

  it('rejects "Loft" in any case — it is the Loft window\'s own caption key', () => {
    expect(validateInstanceName('Loft', 'slack', c)).toBe('reserved');
    expect(validateInstanceName('loft', 'slack', c)).toBe('reserved');
  });

  it('rejects a duplicate regardless of case or surrounding space, including a default name', () => {
    // Window matching is by caption. Two services sharing one means Show/Hide reaches
    // whichever window matched first.
    expect(validateInstanceName(' work ', 'slack', c)).toBe('duplicate');
    expect(validateInstanceName('slack', 'whatsapp', c)).toBe('duplicate');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/instances.test.ts`
Expected: FAIL — `Cannot find module '../src/main/instances'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/instances.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/instances.test.ts && npm run build`
Expected: PASS, `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/instances.ts tests/instances.test.ts
git commit -m "feat(instances): resolve accounts from kinds, with stable D-Bus segments"
```

---

### Task 4: Icon variant assets

**Files:**
- Create: `scripts/rasterize-icons.sh`
- Move: `assets/icons/alt/<kind>-pastel-variants/<kind>-pastel-<colour>.svg` → `assets/icons/variants/<kind>-<colour>.svg`
- Create (generated, committed): `assets/icons/variants/<kind>-<colour>.png`
- Delete: `assets/icons/alt/whatsapp-pastel-variants/palette.json` and the now-empty `alt/` tree
- Modify: `package.json` (`icons` script; `copy-assets`)

**Interfaces:**
- Consumes: nothing.
- Produces: `assets/icons/variants/<kind>-<colour>.png`, 512×512, copied to `dist/assets/icons/variants/` by the build. Kind ids contain no `-`, so the first `-` separates kind from colour.

- [ ] **Step 1: Move and rename the sources**

```bash
mkdir -p assets/icons/variants
for d in assets/icons/alt/*-pastel-variants; do
  for f in "$d"/*.svg; do
    b=$(basename "$f" .svg)                 # e.g. whatsapp-pastel-rose
    git mv "$f" "assets/icons/variants/${b/-pastel-/-}.svg"
  done
done
git rm -q assets/icons/alt/whatsapp-pastel-variants/palette.json
rmdir assets/icons/alt/*-pastel-variants assets/icons/alt
ls assets/icons/variants/
```

Expected: 30 `.svg` files named `<kind>-<colour>.svg` (whatsapp, messenger, slack, telegram, element, talk × 5 colours each; the colour sets differ per kind by design — each kind omits the colour closest to its brand).

`palette.json` goes rather than moves: it omits `butter`, which five of the six kinds ship, so it is already wrong, and a capitalised colour key is a perfectly good swatch label.

- [ ] **Step 2: Write the rasterise script**

Create `scripts/rasterize-icons.sh`:

```bash
#!/usr/bin/env bash
# Rasterise the icon variants to the PNGs the runtime actually needs.
#
# .desktop Icon=, the SNI tray pixmap and org.freedesktop.Notifications all want a real
# PNG on disk, and Electron's nativeImage cannot load SVG — so this runs at build time
# and its output is committed. Contributors only need ImageMagick when they CHANGE an
# icon, never to build Loft.
set -euo pipefail

dir="$(cd "$(dirname "$0")/.." && pwd)/assets/icons/variants"
command -v magick >/dev/null || { echo "magick (ImageMagick) not found" >&2; exit 1; }

for svg in "$dir"/*.svg; do
  png="${svg%.svg}.png"
  # -density before the input: ImageMagick rasterises the SVG at that DPI and only then
  # resizes, so edges stay clean instead of being upscaled from the default 96dpi.
  magick -background none -density 384 "$svg" -resize 512x512 "$png"
  echo "  $(basename "$png")"
done
echo "Rasterised $(ls -1 "$dir"/*.png | wc -l) icon variants"
```

```bash
chmod +x scripts/rasterize-icons.sh
```

- [ ] **Step 3: Add the npm script and carry the variants into dist**

In `package.json`, add to `scripts`:

```json
    "icons": "scripts/rasterize-icons.sh",
```

and in `copy-assets`, change `mkdir -p … dist/assets/icons` to `mkdir -p … dist/assets/icons/variants` and append after `cp assets/icons/*.png dist/assets/icons/`:

```
 && cp assets/icons/variants/*.png dist/assets/icons/variants/
```

- [ ] **Step 4: Generate, verify, and confirm the build carries them**

```bash
npm run icons
npm run build
ls dist/assets/icons/variants/ | head -5
identify assets/icons/variants/whatsapp-rose.png
```

Expected: 30 PNGs in both trees; `identify` reports `PNG 512x512`.

- [ ] **Step 5: Commit**

```bash
git add -A assets scripts package.json
git commit -m "build(icons): flatten the pastel variants and rasterise them to PNG"
```

---

### Task 5: The variant index and the icon fallback chain

**Files:**
- Create: `src/main/icons.ts`
- Create: `tests/icons.test.ts`

**Interfaces:**
- Consumes: `BRAND_ICON`, `CUSTOM_ICON` (Task 3); the asset layout from Task 4.
- Produces:
  - `parseVariantFiles(files: string[]): Record<string, string[]>`
  - `scanVariants(assetsDir: string): Record<string, string[]>`
  - `variantLabel(colour: string): string`
  - `pickVariantFor(used: string[], available: string[]): string | undefined`
  - `variantPngPath(assetsDir: string, kind: string, colour: string): string`
  - `iconCandidates(l: IconLookup): string[]` where `IconLookup = { iconsDir: string; assetsDir: string; id: string; kind?: string; icon?: string }`

- [ ] **Step 1: Write the failing tests**

Create `tests/icons.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  parseVariantFiles, variantLabel, pickVariantFor, iconCandidates, variantPngPath,
} from '../src/main/icons';

describe('parseVariantFiles', () => {
  it('groups PNGs by kind, sorted, ignoring the SVG sources', () => {
    const map = parseVariantFiles([
      'whatsapp-rose.png', 'whatsapp-sky.png', 'whatsapp-rose.svg',
      'slack-mint.png', 'palette.json',
    ]);
    expect(map).toEqual({ whatsapp: ['rose', 'sky'], slack: ['mint'] });
  });

  it('splits on the first hyphen — no kind id contains one', () => {
    expect(parseVariantFiles(['talk-pastel-rose.png'])).toEqual({ talk: ['pastel-rose'] });
  });

  it('ignores a name with no hyphen at all', () => {
    expect(parseVariantFiles(['loft.png'])).toEqual({});
  });
});

describe('variantLabel', () => {
  it('capitalises the colour key', () => {
    expect(variantLabel('rose')).toBe('Rose');
    expect(variantLabel('butter')).toBe('Butter');
  });
});

describe('pickVariantFor', () => {
  it('takes the first colour no sibling is using', () => {
    expect(pickVariantFor(['rose'], ['rose', 'sky', 'mint'])).toBe('sky');
  });

  it('cycles once every colour is taken rather than returning nothing', () => {
    expect(pickVariantFor(['rose', 'sky'], ['rose', 'sky'])).toBe('rose');
  });

  it('is undefined when the kind ships no variants', () => {
    expect(pickVariantFor([], [])).toBeUndefined();
  });
});

describe('iconCandidates', () => {
  const iconsDir = '/data/icons';
  const assetsDir = '/app/assets/icons';

  it('prefers the deployed instance icon, then the variant, then the brand', () => {
    expect(iconCandidates({ iconsDir, assetsDir, id: 'whatsapp-2', kind: 'whatsapp', icon: 'rose' }))
      .toEqual([
        join(iconsDir, 'whatsapp-2.png'),
        join(assetsDir, 'variants', 'whatsapp-rose.png'),
        join(assetsDir, 'whatsapp.png'),
        join(assetsDir, 'whatsapp-2.png'),
      ]);
  });

  it('skips the variant step for brand and custom icons', () => {
    expect(iconCandidates({ iconsDir, assetsDir, id: 'whatsapp', kind: 'whatsapp', icon: 'brand' }))
      .toEqual([join(iconsDir, 'whatsapp.png'), join(assetsDir, 'whatsapp.png')]);
    expect(iconCandidates({ iconsDir, assetsDir, id: 'whatsapp-2', kind: 'whatsapp', icon: 'custom' }))
      .toEqual([
        join(iconsDir, 'whatsapp-2.png'),
        join(assetsDir, 'whatsapp.png'),
        join(assetsDir, 'whatsapp-2.png'),
      ]);
  });

  it('still resolves a name that is no instance at all', () => {
    // loft://icon/loft and the not-yet-added kinds in the Add gallery come through here.
    expect(iconCandidates({ iconsDir, assetsDir, id: 'loft' }))
      .toEqual([join(iconsDir, 'loft.png'), join(assetsDir, 'loft.png')]);
  });
});

describe('variantPngPath', () => {
  it('names the generated asset', () => {
    expect(variantPngPath('/app/assets/icons', 'whatsapp', 'rose'))
      .toBe(join('/app/assets/icons', 'variants', 'whatsapp-rose.png'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/icons.test.ts`
Expected: FAIL — `Cannot find module '../src/main/icons'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/icons.ts`:

```ts
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND_ICON, CUSTOM_ICON } from './instances';

/** Where the generated variant PNGs live, relative to the bundled icons dir. */
const VARIANTS_SUBDIR = 'variants';

/**
 * Group `<kind>-<colour>.png` filenames into kind → sorted colour keys.
 *
 * Split on the FIRST hyphen: no registry kind id contains one, so everything after it is
 * the colour. Pure so the scan can be tested without a filesystem.
 */
export function parseVariantFiles(files: string[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const f of files) {
    if (!f.endsWith('.png')) continue;
    const base = f.slice(0, -'.png'.length);
    const at = base.indexOf('-');
    if (at <= 0 || at === base.length - 1) continue;
    const kind = base.slice(0, at);
    (map[kind] ??= []).push(base.slice(at + 1));
  }
  for (const k of Object.keys(map)) map[k].sort();
  return map;
}

/**
 * Read the variant index off disk once at startup. A missing directory is not an error —
 * it means this build shipped no variants, and every instance simply keeps the brand icon.
 */
export function scanVariants(assetsDir: string): Record<string, string[]> {
  try {
    return parseVariantFiles(readdirSync(join(assetsDir, VARIANTS_SUBDIR)));
  } catch {
    return {};
  }
}

export function variantLabel(colour: string): string {
  return colour.charAt(0).toUpperCase() + colour.slice(1);
}

/** The colour to give a new instance: first one no sibling has, cycling when all are taken. */
export function pickVariantFor(used: string[], available: string[]): string | undefined {
  if (available.length === 0) return undefined;
  const taken = new Set(used);
  return available.find((c) => !taken.has(c)) ?? available[used.length % available.length];
}

export function variantPngPath(assetsDir: string, kind: string, colour: string): string {
  return join(assetsDir, VARIANTS_SUBDIR, `${kind}-${colour}.png`);
}

export interface IconLookup {
  /** ~/.local/share/loft/icons — where deployed per-instance PNGs live. */
  iconsDir: string;
  /** dist/assets/icons — the bundled brand PNGs and the variants subdir. */
  assetsDir: string;
  id: string;
  kind?: string;
  icon?: string;
}

/**
 * Every path that could serve this icon, best first. Callers take the first that exists.
 *
 * The chain is what keeps a failed or missing copy showing the right logo rather than a
 * blank: a second instance has no bundled `<id>.png` to fall back to, so without the kind
 * step its rail icon would simply be broken. The last entry is the pre-instance behaviour
 * and is what still serves `loft://icon/loft` and the not-yet-added kinds in the gallery.
 */
export function iconCandidates(l: IconLookup): string[] {
  const out = [join(l.iconsDir, `${l.id}.png`)];
  if (l.kind) {
    if (l.icon && l.icon !== BRAND_ICON && l.icon !== CUSTOM_ICON) {
      out.push(variantPngPath(l.assetsDir, l.kind, l.icon));
    }
    out.push(join(l.assetsDir, `${l.kind}.png`));
  }
  const last = join(l.assetsDir, `${l.id}.png`);
  if (!out.includes(last)) out.push(last);
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/icons.test.ts && npm run build`
Expected: PASS, `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/icons.ts tests/icons.test.ts
git commit -m "feat(icons): variant index, auto-assignment and the icon fallback chain"
```

---

### Task 6: Launchers and icon deployment take an instance

**Files:**
- Modify: `src/main/desktop.ts:37-48` (`serviceLauncherContent`), `:63-71` (`deployServiceIcon`), `:79-114`
- Test: `tests/desktop.test.ts`

**Interfaces:**
- Consumes: `ServiceInstance` (Task 3); `iconCandidates`, `variantPngPath` (Task 5).
- Produces:
  - `serviceLauncherContent(inst: ServiceInstance, exec: string, iconPath: string): string` — same signature, instance-typed
  - `deployInstanceIcon(inst: ServiceInstance, opts: { env?: Env; iconSourceDir: string }): string`
  - `removeInstanceIcon(id: string, env?: Env): void`
  - `writeServiceLauncher(inst: ServiceInstance, opts: { env?: Env; execPath?: string; iconSourceDir: string }): void` — unchanged signature, instance-typed
  - `removeServiceLauncher(inst: ServiceInstance, env?: Env): void` — unchanged signature, instance-typed

- [ ] **Step 1: Write the failing tests**

Append to `tests/desktop.test.ts` (it already has `tmp()`/`env` helpers and an `iconSrc()` fixture — reuse them; do not add new ones):

```ts
  it('names the launcher after the instance, not the kind', () => {
    const inst = { ...wa, id: 'whatsapp-2', kind: 'whatsapp', displayName: 'Work', dbusSegment: 'WhatsApp2', icon: 'rose' };
    const out = serviceLauncherContent(inst, '/usr/bin/loft', '/icons/whatsapp-2.png');
    expect(out).toContain('Name=Work\n');
    expect(out).toContain('Comment=Open Work via Loft\n');
    expect(out).toContain('Exec=/usr/bin/loft --service=whatsapp-2\n');
    expect(out).toContain('Icon=/icons/whatsapp-2.png\n');
  });

  it('deploys a variant instance icon under the INSTANCE id', () => {
    // The rail asks for loft://icon/whatsapp-2, and no bundled whatsapp-2.png exists —
    // so this copy is what stops a second account rendering a broken image.
    const data = tmp();
    const src = tmp();
    mkdirSync(join(src, 'variants'), { recursive: true });
    writeFileSync(join(src, 'variants', 'whatsapp-rose.png'), 'ROSE');
    const inst = { ...wa, id: 'whatsapp-2', kind: 'whatsapp', displayName: 'Work', dbusSegment: 'WhatsApp2', icon: 'rose' };
    const dst = deployInstanceIcon(inst, { env: { XDG_DATA_HOME: data } as NodeJS.ProcessEnv, iconSourceDir: src });
    expect(dst).toBe(join(data, 'loft', 'icons', 'whatsapp-2.png'));
    expect(readFileSync(dst, 'utf8')).toBe('ROSE');
  });

  it('deploys the brand PNG when the instance uses the brand icon', () => {
    const data = tmp();
    const src = tmp();
    writeFileSync(join(src, 'whatsapp.png'), 'BRAND');
    const inst = { ...wa, id: 'whatsapp', kind: 'whatsapp', displayName: 'WhatsApp', dbusSegment: 'WhatsApp', icon: 'brand' };
    const dst = deployInstanceIcon(inst, { env: { XDG_DATA_HOME: data } as NodeJS.ProcessEnv, iconSourceDir: src });
    expect(readFileSync(dst, 'utf8')).toBe('BRAND');
  });

  it('leaves a custom icon alone — main already wrote it, and there is no source to re-copy', () => {
    const data = tmp();
    const icons = join(data, 'loft', 'icons');
    mkdirSync(icons, { recursive: true });
    writeFileSync(join(icons, 'whatsapp-2.png'), 'MINE');
    const inst = { ...wa, id: 'whatsapp-2', kind: 'whatsapp', displayName: 'Work', dbusSegment: 'WhatsApp2', icon: 'custom' };
    deployInstanceIcon(inst, { env: { XDG_DATA_HOME: data } as NodeJS.ProcessEnv, iconSourceDir: tmp() });
    expect(readFileSync(join(icons, 'whatsapp-2.png'), 'utf8')).toBe('MINE');
  });

  it('removeInstanceIcon deletes the deployed file and tolerates its absence', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const icons = join(data, 'loft', 'icons');
    mkdirSync(icons, { recursive: true });
    writeFileSync(join(icons, 'whatsapp-2.png'), 'x');
    removeInstanceIcon('whatsapp-2', env);
    expect(existsSync(join(icons, 'whatsapp-2.png'))).toBe(false);
    expect(() => removeInstanceIcon('whatsapp-2', env)).not.toThrow();
  });
```

Add `deployInstanceIcon`, `removeInstanceIcon` to the file's import from `../src/main/desktop`, and `readFileSync`/`existsSync`/`mkdirSync`/`writeFileSync` to its `node:fs` import if missing. `wa` is the existing `getKind('whatsapp')!` fixture.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/desktop.test.ts`
Expected: FAIL — `deployInstanceIcon is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/main/desktop.ts`, replace the `ServiceDef` import with `import type { ServiceInstance } from './instances';` and add `import { BRAND_ICON, CUSTOM_ICON } from './instances';` plus `import { variantPngPath } from './icons';`. Then:

```ts
export function serviceLauncherContent(inst: ServiceInstance, exec: string, iconPath: string): string {
  return (
    `[Desktop Entry]\n` +
    `Type=Application\n` +
    `Name=${inst.displayName}\n` +
    `Comment=Open ${inst.displayName} via Loft\n` +
    `Exec=${exec} --service=${inst.id}\n` +
    `Icon=${iconPath}\n` +
    `Terminal=false\n` +
    `Categories=Network;InstantMessaging;\n`
  );
}
```

Replace `deployServiceIcon` with:

```ts
/**
 * Put this instance's icon where everything that needs a real file can find it:
 * `~/.local/share/loft/icons/<id>.png`. Returns that path either way.
 *
 * Not just for launchers any more. A second instance has no bundled `<id>.png`, so
 * without this its rail icon, its notification avatar and its `.desktop` all point at
 * nothing — which is why every add and every icon change calls it.
 *
 * A custom icon is left untouched: main wrote that file from the user's own image, and
 * there is no source left to re-copy from.
 */
export function deployInstanceIcon(
  inst: ServiceInstance,
  opts: { env?: Env; iconSourceDir: string },
): string {
  const dir = iconsDir(opts.env);
  const dst = join(dir, `${inst.id}.png`);
  if (inst.icon === CUSTOM_ICON) return dst;
  mkdirSync(dir, { recursive: true });
  const src = inst.icon === BRAND_ICON
    ? join(opts.iconSourceDir, `${inst.kind}.png`)
    : variantPngPath(opts.iconSourceDir, inst.kind, inst.icon);
  if (existsSync(src)) copyFileSync(src, dst);
  return dst;
}

/** Drop a removed instance's deployed icon. Absent is fine — the deploy may never have run. */
export function removeInstanceIcon(id: string, env: Env = process.env): void {
  const p = join(iconsDir(env), `${id}.png`);
  if (existsSync(p)) rmSync(p, { force: true });
}
```

Change `serviceLauncherPath`'s callers: `launcherPath(def, env)` becomes `launcherPath(inst, env)` with `inst: ServiceInstance`, and both `writeServiceLauncher` and `removeServiceLauncher` take `inst: ServiceInstance` instead of `def: ServiceDef`. Inside `writeServiceLauncher`, replace the `deployServiceIcon(def, …)` call with `deployInstanceIcon(inst, …)` and the log line's `def.id` with `inst.id`.

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run build`
Expected: PASS. `tsc` will flag `src/main/index.ts` and `src/main/install.ts` passing kinds where instances are wanted — a `ServiceKind` is missing `kind`/`dbusSegment`/`icon`. Fix those by giving the two call sites a temporary literal until Tasks 7 and 10 land properly:

```ts
// TEMPORARY (Task 6 → replaced in Task 10): index.ts still deals in kinds.
const asInstance = (d: ServiceKind): ServiceInstance =>
  ({ ...d, kind: d.id, dbusSegment: d.displayName.replace(/\s+/g, ''), icon: 'brand' });
```

- [ ] **Step 5: Commit**

```bash
git add src/main/desktop.ts src/main/index.ts src/main/install.ts tests/desktop.test.ts
git commit -m "feat(desktop): launchers and icons are per instance, not per kind"
```

---

### Task 7: Adding and removing an instance

**Files:**
- Modify: `src/main/install.ts`
- Test: `tests/install.test.ts`

**Interfaces:**
- Consumes: `allocateInstanceId`, `instanceNumber`, `resolveInstance`, `listInstances`, `BRAND_ICON` (Task 3); `pickVariantFor` (Task 5); `deployInstanceIcon`, `removeInstanceIcon`, `removeServiceLauncher` (Task 6).
- Produces:
  - `addInstance(kind: ServiceKind, cfg: LoftConfig, opts: { customUrl?: string; variants?: string[]; iconSourceDir: string; env?: Env }): ServiceInstance`
  - `removeInstance(inst: ServiceInstance, cfg: LoftConfig, deleteData: boolean, env?: Env): void`
  - `removePartitionData(id: string, env?: Env): void` (unchanged)

`addService` / `removeService` are replaced, not kept alongside — there is exactly one way to install an account.

- [ ] **Step 1: Write the failing tests**

Replace the existing `addService` / `removeService` cases in `tests/install.test.ts` with:

```ts
import { addInstance, removeInstance, removePartitionData } from '../src/main/install';
import { getKind } from '../src/main/registry';
import { resolveInstance } from '../src/main/instances';

const wa = getKind('whatsapp')!;

describe('install', () => {
  it('gives the first account the bare kind id, the brand icon, and no launcher', () => {
    const cfg: LoftConfig = { services: {} };
    const inst = addInstance(wa, cfg, { customUrl: 'https://x', iconSourceDir: tmp() });
    expect(inst.id).toBe('whatsapp');
    expect(cfg.services.whatsapp).toEqual({ kind: 'whatsapp', customUrl: 'https://x' });
    expect(inst.displayName).toBe('WhatsApp');
    expect(inst.icon).toBe('brand');
    expect(cfg.services.whatsapp.launcher).toBeUndefined();
  });

  it('gives the second account -2, a default name and the next unused variant', () => {
    const cfg: LoftConfig = { services: { whatsapp: { kind: 'whatsapp' } } };
    const inst = addInstance(wa, cfg, { variants: ['rose', 'sky'], iconSourceDir: tmp() });
    expect(inst.id).toBe('whatsapp-2');
    expect(inst.displayName).toBe('WhatsApp 2');
    expect(cfg.services['whatsapp-2'].icon).toBe('rose');
    // The name is NOT stored: it is the default, and deriving it keeps a future
    // registry rename propagating. The icon IS, because an auto-pick is not stable
    // as siblings come and go.
    expect(cfg.services['whatsapp-2'].name).toBeUndefined();
  });

  it('skips a variant a sibling already uses', () => {
    const cfg: LoftConfig = {
      services: { whatsapp: { kind: 'whatsapp' }, 'whatsapp-2': { kind: 'whatsapp', icon: 'rose' } },
    };
    const inst = addInstance(wa, cfg, { variants: ['rose', 'sky'], iconSourceDir: tmp() });
    expect(inst.id).toBe('whatsapp-3');
    expect(cfg.services['whatsapp-3'].icon).toBe('sky');
  });

  it('stores a name only when the default is taken', () => {
    const cfg: LoftConfig = { services: { whatsapp: { kind: 'whatsapp', name: 'WhatsApp 2' } } };
    const inst = addInstance(wa, cfg, { iconSourceDir: tmp() });
    expect(inst.displayName).toBe('WhatsApp 3');
    expect(cfg.services['whatsapp-2'].name).toBe('WhatsApp 3');
  });

  it('deploys the instance icon so the rail has something to draw', () => {
    const data = tmp();
    const src = tmp();
    writeFileSync(join(src, 'whatsapp.png'), 'BRAND');
    const cfg: LoftConfig = { services: {} };
    addInstance(wa, cfg, { iconSourceDir: src, env: { XDG_DATA_HOME: data } as NodeJS.ProcessEnv });
    expect(existsSync(join(data, 'loft', 'icons', 'whatsapp.png'))).toBe(true);
  });

  it('removeInstance drops the launcher, the deployed icon and the config entry', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { 'whatsapp-2': { kind: 'whatsapp', launcher: true } } };
    const apps = join(data, 'applications');
    const icons = join(data, 'loft', 'icons');
    mkdirSync(apps, { recursive: true });
    mkdirSync(icons, { recursive: true });
    writeFileSync(join(apps, 'loft-whatsapp-2.desktop'), '[Desktop Entry]');
    writeFileSync(join(icons, 'whatsapp-2.png'), 'x');
    const part = join(data, 'loft', 'Partitions', 'whatsapp-2');
    mkdirSync(part, { recursive: true });

    removeInstance(resolveInstance('whatsapp-2', cfg)!, cfg, true, env);
    expect(cfg.services['whatsapp-2']).toBeUndefined();
    expect(existsSync(join(apps, 'loft-whatsapp-2.desktop'))).toBe(false);
    expect(existsSync(join(icons, 'whatsapp-2.png'))).toBe(false);
    expect(existsSync(part)).toBe(false);
  });

  it('keeps the partition when the user does not ask to delete login data', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { whatsapp: { kind: 'whatsapp' } } };
    const part = join(data, 'loft', 'Partitions', 'whatsapp');
    mkdirSync(part, { recursive: true });
    removeInstance(resolveInstance('whatsapp', cfg)!, cfg, false, env);
    expect(existsSync(part)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/install.test.ts`
Expected: FAIL — `addInstance is not a function`.

- [ ] **Step 3: Write the implementation**

Replace the body of `src/main/install.ts` below `removePartitionData` with:

```ts
/**
 * Install one account of a kind and return it.
 *
 * `kind` is stored even for the first instance, where it is derivable: an explicit field
 * is what makes a hand-read config say which app an id belongs to. `name` is stored only
 * when the derived default is already taken — leaving it absent keeps a future registry
 * rename propagating. `icon` is stored whenever it is not the brand, because an
 * auto-picked colour is not stable as siblings come and go.
 *
 * New accounts are launcher-less (spec 09 Q2 / 09c-3); a `.desktop` is opt-in from the
 * service's own settings.
 */
export function addInstance(
  kind: ServiceKind,
  cfg: LoftConfig,
  opts: { customUrl?: string; variants?: string[]; iconSourceDir: string; env?: Env },
): ServiceInstance {
  const id = allocateInstanceId(kind.id, cfg);
  const n = instanceNumber(id, kind.id);

  const entry: ServiceConfig = { kind: kind.id };
  if (opts.customUrl !== undefined) entry.customUrl = opts.customUrl;

  if (n > 1) {
    // Two accounts of a kind wearing the same logo are indistinguishable in the rail,
    // the tray and the app grid — so the second one gets a colour without being asked.
    const used = listInstances(cfg).filter((i) => i.kind === kind.id).map((i) => i.icon);
    const colour = pickVariantFor(used, opts.variants ?? []);
    if (colour) entry.icon = colour;
  }

  const name = allocateInstanceName(kind.displayName, n, cfg);
  if (name !== defaultInstanceName(kind.displayName, n)) entry.name = name;

  cfg.services[id] = entry;
  const inst = resolveInstance(id, cfg)!;
  deployInstanceIcon(inst, { env: opts.env, iconSourceDir: opts.iconSourceDir });
  return inst;
}

export function removeInstance(
  inst: ServiceInstance,
  cfg: LoftConfig,
  deleteData: boolean,
  env: Env = process.env,
): void {
  removeServiceLauncher(inst, env);
  removeInstanceIcon(inst.id, env);
  delete cfg.services[inst.id];
  if (deleteData) removePartitionData(inst.id, env);
}
```

Imports at the top of the file:

```ts
import { existsSync, rmSync } from 'node:fs';
import type { ServiceKind } from './registry';
import type { LoftConfig, ServiceConfig } from './config';
import {
  allocateInstanceId, allocateInstanceName, defaultInstanceName, instanceNumber,
  listInstances, resolveInstance, type ServiceInstance,
} from './instances';
import { pickVariantFor } from './icons';
import { removeServiceLauncher, deployInstanceIcon, removeInstanceIcon } from './desktop';
import { partitionDir } from './paths';
```

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run build`
Expected: `tests/install.test.ts` PASS. `tsc` flags index.ts's `addService`/`removeService` imports — point them at the new names with the `asInstance` shim from Task 6 for `removeInstance`, and pass `{ iconSourceDir }` to `addInstance`; Task 10 replaces both properly.

- [ ] **Step 5: Commit**

```bash
git add src/main/install.ts src/main/index.ts tests/install.test.ts
git commit -m "feat(install): add and remove accounts, with an auto-assigned icon"
```

---

### Task 8: The tray carries the D-Bus segment, renames, and forgets

**Files:**
- Modify: `src/main/tray/model.ts`, `src/main/tray/index.ts`, `src/main/tray/dbusMenu.ts:10-16` (`MenuModel`), `src/main/tray/gnomePanel.ts`
- Modify: `gnome-shell-extension/extension.js:875-970`
- Modify: `src/main/index.ts` (tray seed + `addService` calls carry a segment)
- Test: `tests/trayMenuModel.test.ts`, `tests/gnomePanelDiff.test.ts`

**Interfaces:**
- Consumes: `dbusSegmentFor` (Task 3).
- Produces:
  - `ServiceTrayState` / `TrayServiceSeed` / `MenuModel` rows gain `segment: string`
  - `TrayModel.setDisplayName(id: string, name: string): void`
  - `TrayModel.removeService(id: string): void`
  - `Tray.setDisplayName(id, name)`, `Tray.removeService(id)`
  - `Tray.addService(seed: { id; displayName; dnd; segment })`

- [ ] **Step 1: Write the failing tests**

Append to `tests/trayMenuModel.test.ts`:

```ts
  it('carries each service\'s D-Bus segment into the menu model', () => {
    // The GNOME panel calls /chat/loft/<segment>; deriving it from the display name
    // breaks the moment a user renames an account.
    const m = new TrayModel();
    m.addService({ id: 'whatsapp-2', displayName: 'Work', segment: 'WhatsApp2', badge: 0, dnd: false, visible: false, running: true });
    expect(m.menuModel().running[0].segment).toBe('WhatsApp2');
  });

  it('renames a service in place', () => {
    const m = new TrayModel();
    m.addService({ id: 'whatsapp', displayName: 'WhatsApp', segment: 'WhatsApp', badge: 0, dnd: false, visible: false, running: true });
    let changes = 0;
    m.onChange = () => { changes++; };
    m.setDisplayName('whatsapp', 'Personal');
    expect(m.menuModel().running[0].label).toBe('Personal');
    expect(changes).toBe(1);
    m.setDisplayName('whatsapp', 'Personal');
    expect(changes).toBe(1); // no redundant rebuild
  });

  it('forgets a removed service instead of stranding it in the available section', () => {
    const m = new TrayModel();
    m.addService({ id: 'whatsapp', displayName: 'WhatsApp', segment: 'WhatsApp', badge: 0, dnd: false, visible: false, running: false });
    m.removeService('whatsapp');
    expect(m.menuModel().available).toHaveLength(0);
    expect(m.hasService('whatsapp')).toBe(false);
  });
```

Append to `tests/gnomePanelDiff.test.ts`:

```ts
  it('diffs on the segment, because that is the key the helper is told', () => {
    const snap = (segment: string, displayName: string) =>
      new Map([[segment, { id: segment, displayName, visible: false, badge: 0, dnd: false }]]);
    const { updates, removals } = diffPanelServices(snap('WhatsApp2', 'Work'), snap('WhatsApp2', 'Home'));
    expect(removals).toEqual([]);
    expect(updates[0].displayName).toBe('Home');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/trayMenuModel.test.ts tests/gnomePanelDiff.test.ts`
Expected: FAIL — `segment` is not a property of the model's row type; `setDisplayName` / `removeService` are not functions.

- [ ] **Step 3: Implement**

`src/main/tray/model.ts` — add `segment: string;` to `ServiceTrayState` with the comment:

```ts
  /** Stable D-Bus object-path segment — what the GNOME panel menu calls back on. */
  segment: string;
```

add to the class:

```ts
  /** A rename must reach the tray now, not at next launch — this is one of the two
   *  places (with the window caption) a user checks that a rename took. */
  setDisplayName(id: string, name: string): void {
    const s = this.find(id);
    if (s && s.displayName !== name) { s.displayName = name; this.changed(); }
  }

  /** Drop a service the user removed. Without this its row survives in the available
   *  section until the next launch — and with accounts coming and going, that stale row
   *  is now something a user will actually hit. */
  removeService(id: string): void {
    const at = this.services.findIndex((s) => s.id === id);
    if (at === -1) return;
    this.services.splice(at, 1);
    this.changed();
  }
```

and carry `segment: s.segment` into both `menuModel()` row maps.

`src/main/tray/dbusMenu.ts` — add `segment: string` to both row types in `MenuModel`. The SNI menu itself ignores it (its action ids are already `svc:<id>:…`); it rides along so the two backends share one model.

`src/main/tray/index.ts` — add `segment: string;` to `TrayServiceSeed`; add `setDisplayName(id: string, name: string): void;` and `removeService(id: string): void;` to `Tray`; add `segment` to `Tray.addService`'s seed type; pass `segment: s.segment` in `startTray`'s seed loop and `segment: seed.segment` in the returned `addService`; and return `setDisplayName: (id, name) => model.setDisplayName(id, name), removeService: (id) => model.removeService(id),`.

`src/main/tray/gnomePanel.ts` — `PanelSnapshot.id` now holds the **segment**; document it:

```ts
export interface PanelSnapshot {
  /** The D-Bus segment, which is also the helper's own key for this row. */
  id: string;
  ...
```

In `snapshot()` and `snapshotAvailable()`, key the maps on `r.segment` / `a.segment` and set `id: r.segment` / `id: a.segment`. The `model.snapshotServices()` badge merge keys on the instance id, so give `snapshotServices()` a `segment` field too and merge on that. Add the two missing methods to the returned `Tray`:

```ts
    setDisplayName: (id, name) => model.setDisplayName(id, name),
    removeService: (id) => model.removeService(id),
```

`src/main/tray/model.ts` — `snapshotServices()` becomes:

```ts
  /** Read-only per-service snapshot (segment + raw badge) for the GNOME-panel backend. */
  snapshotServices(): ReadonlyArray<{ segment: string; badge: number }> {
    return this.services.map((s) => ({ segment: s.segment, badge: s.badge }));
  }
```

`gnome-shell-extension/extension.js` — in `_updateCombinedService`'s menu builder around line 879, delete `const dbusName = svc.displayName.replace(/\s+/g, '');` and use the pushed key instead, with a comment:

```js
            // The D-Bus segment main pushed as `name`. Deriving it from the display
            // name (as this used to) breaks the moment a user renames an account:
            // the object path is pinned to the kind's default name, not the label.
            const dbusName = svc.name;
```

Do the same at the available-service launch row near line 961, replacing `const dbusName = displayName.replace(/\s+/g, '');` with the row's stored `name`. Confirm the surrounding code has that value in scope; if the available rows only keep `displayName`, store `name` alongside it when `_updateAvailableService` records the row.

`src/main/index.ts` — the tray seed and both `tray?.addService` calls gain `segment: dbusSegmentFor(id, config)` (import `dbusSegmentFor` from `./instances`).

- [ ] **Step 4: Verify**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/tray gnome-shell-extension/extension.js src/main/index.ts tests/trayMenuModel.test.ts tests/gnomePanelDiff.test.ts
git commit -m "feat(tray): carry the D-Bus segment, rename in place, forget removals"
```

---

### Task 9: D-Bus objects are per instance and dynamic

**Files:**
- Modify: `src/main/dbus/loftService.ts`
- Test: `tests/dbusNames.test.ts`

**Interfaces:**
- Consumes: `listInstances`, `dbusSegmentFor` (Task 3).
- Produces: `startLoftDbusService(deps: LoftServiceDeps & { instances(): ServiceInstance[] }): Promise<LoftDbus>` where `LoftDbus = { exportInstance(inst: ServiceInstance): void; unexportInstance(inst: ServiceInstance): void }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/dbusNames.test.ts`:

```ts
import { objectPathFor } from '../src/main/dbus/loftService';

describe('per-instance object paths', () => {
  it('keeps the documented paths for the first account of a kind', () => {
    expect(objectPathFor('WhatsApp')).toBe('/chat/loft/WhatsApp');
    expect(objectPathFor('NextCloudTalk')).toBe('/chat/loft/NextCloudTalk');
  });

  it('gives a second account its own path', () => {
    expect(objectPathFor('WhatsApp2')).toBe('/chat/loft/WhatsApp2');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/dbusNames.test.ts`
Expected: FAIL — `objectPathFor` is not exported.

- [ ] **Step 3: Implement**

In `src/main/dbus/loftService.ts`, drop the `SERVICES` import, add `import type { ServiceInstance } from '../instances';`, and export the path helper plus a dynamic export surface:

```ts
/** Where a service object lives. One function so the export, the unexport and any
 *  future consumer cannot drift. */
export function objectPathFor(segment: string): string {
  return `/chat/loft/${segment}`;
}

export interface LoftDbus {
  exportInstance(inst: ServiceInstance): void;
  unexportInstance(inst: ServiceInstance): void;
}

export interface LoftServiceDeps {
  // …existing members unchanged
  /** Installed accounts to export at startup. */
  instances(): ServiceInstance[];
}

export async function startLoftDbusService(deps: LoftServiceDeps): Promise<LoftDbus> {
  const bus = dbus.sessionBus();
  await bus.requestName(BUS, 0);
  bus.export('/chat/loft/Loft', new LoftRootObject(deps));

  // Exported paths, so a duplicate segment is reported rather than silently replacing a
  // live object. Segments are unique by construction; this catches a hand-edited config
  // that made two ids derive the same one.
  const exported = new Set<string>();

  const api: LoftDbus = {
    exportInstance(inst) {
      const path = objectPathFor(inst.dbusSegment);
      if (exported.has(path)) {
        console.warn(`Not exporting ${inst.id}: ${path} is already taken`);
        return;
      }
      exported.add(path);
      bus.export(path, new LoftServiceObject(inst.id, deps));
    },
    unexportInstance(inst) {
      const path = objectPathFor(inst.dbusSegment);
      if (!exported.delete(path)) return;
      bus.unexport(path);
    },
  };

  for (const inst of deps.instances()) api.exportInstance(inst);
  return api;
}
```

Note the behaviour change worth its own comment above the loop:

```ts
  // Per INSTANCE, not per registry entry: an uninstalled service no longer has a D-Bus
  // object, and a second account gets its own.
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run build`
Expected: PASS. `tsc` will require index.ts to pass `instances` in `loftDeps` and to keep the returned handle — do both; Task 10 uses the handle on add/remove.

- [ ] **Step 5: Commit**

```bash
git add src/main/dbus/loftService.ts src/main/index.ts tests/dbusNames.test.ts
git commit -m "feat(dbus): export one object per account, added and removed live"
```

---

### Task 10: Wire main to instances

The big one. Nothing here is new logic — it is replacing "a service is a registry entry" with "a service is an account" at every seam.

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/loftWindow.ts:90` (`services` becomes a callback), `:231`, `:243`, `:294`
- Modify: `src/main/serviceView.ts:116` (preload argument)
- Test: `tests/gridDetachPrune.test.ts`, `tests/railModel.test.ts` (type-only churn)

**Interfaces:**
- Consumes: everything from Tasks 3 and 5–9.
- Produces: no new exported API; `LoftWindowDeps.services` changes from `ServiceDef[]` to `services(): ServiceInstance[]`.

- [ ] **Step 1: Replace the Task 2 shim**

In `src/main/index.ts`, replace the shim with the real resolver and drop `asInstance`:

```ts
// A "service" is an ACCOUNT now. Every call site below reads the same fields it always
// did; what changed is that `id` names an account and `displayName` is the user's.
const getService = (id: string): ServiceInstance | undefined => resolveInstance(id, config);
const listServices = (): ServiceInstance[] => listInstances(config);
```

Import `resolveInstance`, `listInstances`, `dbusSegmentFor`, `type ServiceInstance` from `./instances`, and `scanVariants` from `./icons`. Replace every remaining `ServiceKind` type annotation on a *service* value with `ServiceInstance` (the Add gallery's kinds stay `ServiceKind`).

Add, beside `iconSourceDir`:

```ts
// Read once: the variant set is fixed for a build, and a readdir per icon lookup would
// run on every rail repaint.
const variantIndex = scanVariants(iconSourceDir);
```

- [ ] **Step 2: Point the icon protocol and notification icons at the fallback chain**

Replace `serviceIconPath` (index.ts:102-104):

```ts
/**
 * The best existing icon file for a service, for consumers that need a real path
 * (notifications). Falls back through the deployed instance icon, its variant, and the
 * kind's brand PNG — a second account has no bundled `<id>.png` of its own.
 */
function serviceIconPath(id: string): string {
  const c = config.services[id];
  const candidates = iconCandidates({
    iconsDir: iconsDir(), assetsDir: iconSourceDir, id, kind: c?.kind ?? id, icon: c?.icon,
  });
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1];
}
```

and the `protocol.handle('loft', …)` body (index.ts:1184-1192):

```ts
    protocol.handle('loft', async (req) => {
      const name = new URL(req.url).pathname.replace(/^\/+/, '') || 'loft';
      const c = config.services[name];
      for (const file of iconCandidates({
        iconsDir: iconsDir(), assetsDir: iconSourceDir, id: name,
        kind: c?.kind ?? (getKind(name) ? name : undefined), icon: c?.icon,
      })) {
        try {
          return new Response(await readFile(file), { headers: { 'content-type': 'image/png' } });
        } catch { /* try the next candidate */ }
      }
      return new Response(null, { status: 404 });
    });
```

Import `iconCandidates` from `./icons`.

- [ ] **Step 3: Make the rail see instance changes**

`src/main/loftWindow.ts`: change the dep to a callback, because the instance list now changes at runtime (add, remove, rename) and a captured array would freeze the rail at startup:

```ts
  /** Installed accounts, read fresh on every refresh — the set changes at runtime. */
  services(): ServiceInstance[];
```

Update its three uses (`deps.services` → `deps.services()`) at lines 231, 243 and 294, and swap the `ServiceDef` type import for `ServiceInstance`. In index.ts, `createLoftWindow`'s `services:` becomes `services: () => listServices()`.

- [ ] **Step 4: Hand the preload the kind**

`src/main/serviceView.ts:116`:

```ts
      // The KIND, not the instance id: this argument selects the badge parser, the
      // Messenger/Telegram scrape-only rule and the de-chroming — all properties of the
      // app, not the account. Routing back to main is by webContents, not by id.
      additionalArguments: [`--loft-service=${def.kind}`],
```

Its `def` parameter type becomes `ServiceInstance`. Check the popup-window branch further down the same file (around line 164) for a second `additionalArguments` and give it the same treatment if present.

- [ ] **Step 5: Switch the startup sweeps from kinds to instances**

In `src/main/index.ts`:

- grid prune: `validGridServices(KINDS, …)` → `validGridServices(listServices(), …)`
- phantom warning: keep `Object.keys(config.services).filter((id) => !getService(id))` (it now means "names no known kind") and reword the message to `— no such service kind`
- legacy-autostart sweep: `removeLegacyAutostart(KINDS.map((s) => s.id))` stays on kinds; v1 only ever wrote per-kind entries
- launcher self-heal (`reconcileServiceLaunchers`): unchanged shape; its `write`/`remove` closures now resolve instances through `getService`

- [ ] **Step 6: Route add and remove through the instance installers**

Replace the `addService` / `removeService` deps in `registerHubIpc`:

```ts
    addService: (kindId, customUrl) => {
      const kind = getKind(kindId);
      if (!kind) return;
      const inst = addInstance(kind, config, {
        customUrl, variants: variantIndex[kind.id] ?? [], iconSourceDir,
      });
      saveConfig(configPath(), config);
      // A new account must reach the tray and D-Bus now — not at next launch. Before
      // instances, adding a service was rare enough that waiting was invisible; adding
      // a second WhatsApp and finding it missing from the tray menu is not.
      dbusApi?.exportInstance(inst);
      tray?.addService({
        id: inst.id, displayName: inst.displayName, dnd: false, segment: inst.dbusSegment,
      });
      loft?.refreshRail();
      notifyHub();
    },
    removeService: (id, deleteData) => {
      const inst = getService(id);
      if (!inst) return;
      quitService(id);
      loft?.dropFromGrid(id);
      removeInstance(inst, config, deleteData);
      saveConfig(configPath(), config);
      dbusApi?.unexportInstance(inst);
      tray?.removeService(id);
      reconcileAutostart();
      loft?.refreshRail();
      notifyHub();
    },
```

`dbusApi` is a module-scope `let dbusApi: LoftDbus | undefined;` assigned from `startLoftDbusService`. `hub:addService`'s first argument is now a **kind id** — the preload change lands in Task 11; until then the renderer still sends the kind's id and it happens to work, because an uninstalled kind's id and its first instance's id are the same string.

Add `instances: () => listServices()` to `loftDeps`.

- [ ] **Step 7: Verify**

```bash
npm test && npm run build
env -u ELECTRON_RUN_AS_NODE npx electron .
```

Expected: tests pass; Loft starts, the rail shows the same services as before with the same icons, and the tray menu is unchanged. Nothing user-visible should differ yet — this task is the substrate.

- [ ] **Step 8: Commit**

```bash
git add -A src tests
git commit -m "feat(main): services are accounts everywhere in the main process"
```

---

### Task 11: The hub speaks instances and kinds, and can add another

**Files:**
- Modify: `src/shared/hubTypes.ts`, `src/main/hubState.ts`, `src/main/hubIpc.ts`, `src/preload/hub.ts`, `src/main/index.ts` (the `buildHubState` call)
- Modify: `src/renderer/hub/components/AddServices.svelte`, `AvailableTile.svelte`, `src/renderer/hub/App.svelte`, `src/renderer/hub/managerModel.ts`
- Test: `tests/hubState.test.ts`, `tests/hubIpc.test.ts`, `tests/hubPreload.test.ts`, `tests/managerModel.test.ts`

**Interfaces:**
- Consumes: `ServiceInstance`, `listInstances` (Task 3); `scanVariants` (Task 5).
- Produces:
  - `HubService` — existing fields minus `installed`, plus `kind: string`, `icon: string`, `variants: string[]`
  - `HubKind` — `{ id, displayName, selfHosted, serverRequired, defaultUrl, instanceCount }`
  - `HubState` — `{ services: HubService[]; kinds: HubKind[]; globals: HubGlobals }`
  - `LoftHub.addService(kind: string, customUrl?: string)`

- [ ] **Step 1: Write the failing tests**

Replace `tests/hubState.test.ts`'s fixture and its `installed` cases with:

```ts
import { KINDS } from '../src/main/registry';
import { listInstances } from '../src/main/instances';

const base = (config: LoftConfig) => ({
  instances: listInstances(config),
  kinds: KINDS,
  variants: { whatsapp: ['rose', 'sky'] },
  config,
  running: () => false,
  visible: () => false,
  badge: () => 0,
  trayBackend: 'auto' as const,
  autostartBlocked: false,
});

describe('buildHubState', () => {
  it('lists installed accounts, not registry entries', () => {
    const config: LoftConfig = { services: { whatsapp: {}, 'whatsapp-2': { kind: 'whatsapp', name: 'Work' } } };
    const s = buildHubState(base(config));
    expect(s.services.map((x) => x.id)).toEqual(['whatsapp', 'whatsapp-2']);
    expect(s.services[1].displayName).toBe('Work');
    expect(s.services[1].kind).toBe('whatsapp');
  });

  it('counts instances per kind so the gallery knows Add from Add another', () => {
    const config: LoftConfig = { services: { whatsapp: {} } };
    const s = buildHubState(base(config));
    expect(s.kinds.find((k) => k.id === 'whatsapp')!.instanceCount).toBe(1);
    expect(s.kinds.find((k) => k.id === 'slack')!.instanceCount).toBe(0);
    expect(s.kinds).toHaveLength(KINDS.length);
  });

  it('hands each account its kind\'s variant list for the swatch row', () => {
    const s = buildHubState(base({ services: { whatsapp: {}, slack: {} } }));
    expect(s.services.find((x) => x.id === 'whatsapp')!.variants).toEqual(['rose', 'sky']);
    expect(s.services.find((x) => x.id === 'slack')!.variants).toEqual([]);
  });
});
```

Keep the existing serverRequired/defaultUrl case, reading it off `s.kinds` instead of `s.services`.

In `tests/hubIpc.test.ts`, add:

```ts
  it('passes a KIND to addService, and returns rename and icon results', async () => {
    const calls: string[] = [];
    const ipc = fakeIpc();
    registerHubIpc(ipc, {
      ...deps,
      addService: (kind, url) => { calls.push(`add:${kind}:${url ?? ''}`); },
      renameService: async (id, name) => { calls.push(`rename:${id}:${name}`); return { ok: true }; },
      setServiceIcon: async (id, choice) => { calls.push(`icon:${id}:${choice}`); return { ok: false, error: 'nope' }; },
    });
    ipc.emit('hub:addService', { kind: 'whatsapp', customUrl: 'https://x' });
    expect(await ipc.invokeHandler('hub:renameService', { id: 'whatsapp', name: 'Work' })).toEqual({ ok: true });
    expect(await ipc.invokeHandler('hub:setServiceIcon', { id: 'whatsapp', choice: 'rose' }))
      .toEqual({ ok: false, error: 'nope' });
    expect(calls).toEqual(['add:whatsapp:https://x', 'rename:whatsapp:Work', 'icon:whatsapp:rose']);
  });
```

Match the file's existing fake-ipc helper rather than inventing one; if it has no `invokeHandler`, extend it in the same style.

In `tests/hubPreload.test.ts`, add a case asserting `addService('whatsapp', 'https://x')` sends `{ kind: 'whatsapp', customUrl: 'https://x' }`, and that `renameService`/`setServiceIcon` invoke `hub:renameService` / `hub:setServiceIcon`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/hubState.test.ts tests/hubIpc.test.ts tests/hubPreload.test.ts`
Expected: FAIL — `s.kinds` is undefined; `renameService` is not a dep.

- [ ] **Step 3: Implement the types, state and IPC**

`src/shared/hubTypes.ts`:

```ts
export interface HubService {
  id: string;
  /** Registry kind — what the icon swatches and the badge parser belong to. */
  kind: string;
  displayName: string;
  selfHosted: boolean;
  serverRequired: boolean;
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
export interface HubState { services: HubService[]; kinds: HubKind[]; globals: HubGlobals }

/** Result of an operation the user can get wrong. */
export interface OpResult { ok: boolean; error?: string }
```

`HubService.installed` goes — an entry in `services` *is* installed.

`src/main/hubState.ts`:

```ts
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
  return { services, kinds, globals: { trayBackend: deps.trayBackend, autostartBlocked: deps.autostartBlocked } };
}
```

`src/main/hubIpc.ts` — `addService` takes a kind; two new `handle` channels:

```ts
export interface HubIpcDeps {
  getState(): HubState;
  openService(id: string): void;
  /** `kind` is a REGISTRY kind id; main allocates the instance id. */
  addService(kind: string, customUrl: string | undefined): void;
  removeService(id: string, deleteData: boolean): void;
  setServiceSetting(id: string, patch: ServicePatch): void;
  /** Can fail (the name must be unique), so it answers rather than fires and forgets. */
  renameService(id: string, name: string): Promise<OpResult>;
  /** `choice` is 'brand', a variant colour key, or 'custom' (which opens a file dialog). */
  setServiceIcon(id: string, choice: string): Promise<OpResult>;
  setGlobal(patch: GlobalPatch): void;
  recoverService(id: string, opts: RecoverOpts): void;
  quit(): void;
}
```

```ts
  ipc.on('hub:addService', (_e, m: { kind: string; customUrl?: string }) => deps.addService(m.kind, m.customUrl));
  ipc.handle('hub:renameService', (_e, m: { id: string; name: string }) => deps.renameService(m.id, m.name));
  ipc.handle('hub:setServiceIcon', (_e, m: { id: string; choice: string }) => deps.setServiceIcon(m.id, m.choice));
```

`src/preload/hub.ts` — mirror them:

```ts
  addService(kind: string, customUrl?: string): void;
  renameService(id: string, name: string): Promise<OpResult>;
  setServiceIcon(id: string, choice: string): Promise<OpResult>;
```

```ts
    addService: (kind, customUrl) => ipc.send('hub:addService', { kind, customUrl }),
    renameService: (id, name) => ipc.invoke('hub:renameService', { id, name }),
    setServiceIcon: (id, choice) => ipc.invoke('hub:setServiceIcon', { id, choice }),
```

`src/main/index.ts` — `hubState()` passes the new deps:

```ts
  instances: listServices(),
  kinds: listKinds(),
  variants: variantIndex,
```

and stub the two new IPC deps so this task compiles on its own; Task 12 fills them in:

```ts
    // Implemented in Task 12 (rename + icon picker).
    renameService: async () => ({ ok: false, error: 'not implemented' }),
    setServiceIcon: async () => ({ ok: false, error: 'not implemented' }),
```

- [ ] **Step 4: Update the renderer**

`src/renderer/hub/managerModel.ts` — `managerNav` builds its Configure list from `state.services` directly (they are all installed now); drop the `.filter((s) => s.installed)`. `resolveSelection` is unchanged in shape. Update `tests/managerModel.test.ts` fixtures to the new `HubState`.

`src/renderer/hub/components/AvailableTile.svelte` — take a `HubKind` instead of a `HubService`:

```svelte
<script lang="ts">
  import type { HubKind } from '../../../shared/hubTypes';
  import Modal from './Modal.svelte';
  let { kind }: { kind: HubKind } = $props();

  let showUrlModal = $state(false);
  let urlDraft = $state('');

  function add() {
    if (kind.selfHosted) { urlDraft = ''; showUrlModal = true; }
    else window.loftHub.addService(kind.id);
  }
  function confirmAdd() {
    showUrlModal = false;
    window.loftHub.addService(kind.id, urlDraft.trim() || undefined);
  }
</script>

<div class="tile">
  <img class="icon" src={`loft://icon/${kind.id}`} alt="" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')} />
  <span class="name">{kind.displayName}</span>
  <button class="pill" onclick={add}>Add</button>
</div>
```

The modal block and `<style>` are unchanged except `svc.` → `kind.`.

`src/renderer/hub/components/AddServices.svelte`:

```svelte
<script lang="ts">
  import type { HubState } from '../../../shared/hubTypes';
  import AvailableTile from './AvailableTile.svelte';
  let { state }: { state: HubState } = $props();
  const fresh = $derived(state.kinds.filter((k) => k.instanceCount === 0));
  const more = $derived(state.kinds.filter((k) => k.instanceCount > 0));
</script>

<h2>Add a service</h2>
{#if fresh.length > 0}
  <p class="lead">Pick a messaging service to add to Loft.</p>
  <div class="grid">
    {#each fresh as kind (kind.id)}<AvailableTile {kind} />{/each}
  </div>
{:else}
  <section class="empty">
    <img class="logo" src="loft://icon/loft" alt="" />
    <p>You've added every service Loft supports.</p>
  </section>
{/if}

{#if more.length > 0}
  <hr />
  <h2>Add another</h2>
  <!-- Named for what it is FOR: a second account of a service you already use, each with
       its own login, name and icon. -->
  <p class="lead">Add a second account for a service you already use.</p>
  <div class="grid">
    {#each more as kind (kind.id)}<AvailableTile {kind} />{/each}
  </div>
{/if}

<style>
  h2 { margin: 8px 0 6px; }
  .lead { margin: 0 0 16px; opacity: 0.7; }
  hr { border: 0; border-top: 1px solid var(--divider); margin: 28px 0 20px; }
  /* auto-fill so the gallery fills the wide pane instead of a lonely 2-up column. */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
  .empty { text-align: center; padding: 40px 0; opacity: 0.7; }
  .empty .logo { width: 64px; height: 64px; margin-bottom: 12px; }
</style>
```

- [ ] **Step 5: Verify**

Run: `npm test && npm run build && npm run check`
Expected: all three clean.

- [ ] **Step 6: Manual check**

```bash
env -u ELECTRON_RUN_AS_NODE npx electron .
```

Expected: the manager's Add page shows uninstalled services on top and an **Add another** section below the rule for the ones you have. Adding another WhatsApp puts a second, differently-coloured WhatsApp in the rail.

- [ ] **Step 7: Commit**

```bash
git add -A src tests
git commit -m "feat(hub): instances and kinds, with an Add another gallery"
```

---

### Task 12: Rename and change an account's icon

**Files:**
- Create: `src/renderer/hub/components/IconPicker.svelte`
- Modify: `src/renderer/hub/components/ServiceDetail.svelte`
- Modify: `src/main/index.ts` (the two IPC deps stubbed in Task 11)
- Test: `tests/instances.test.ts` (name-error copy), manual for the dialog

**Interfaces:**
- Consumes: `validateInstanceName`, `NameError` (Task 3); `variantLabel` (Task 5); `deployInstanceIcon` (Task 6); `hub:renameService` / `hub:setServiceIcon` (Task 11).
- Produces: no new exported API.

- [ ] **Step 1: Write the failing test for the user-facing copy**

Main turns a `NameError` into the sentence the field shows, so the mapping is worth pinning. Append to `tests/instances.test.ts`:

```ts
import { nameErrorMessage } from '../src/main/instances';

describe('nameErrorMessage', () => {
  it('says what is wrong in the user\'s terms', () => {
    expect(nameErrorMessage('empty')).toBe('Enter a name.');
    expect(nameErrorMessage('too-long')).toBe('Use 64 characters or fewer.');
    expect(nameErrorMessage('duplicate')).toBe('Another service already uses that name.');
    expect(nameErrorMessage('reserved')).toBe('“Loft” is reserved for the main window.');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/instances.test.ts -t nameErrorMessage`
Expected: FAIL — `nameErrorMessage is not a function`.

- [ ] **Step 3: Add the message map**

Append to `src/main/instances.ts`:

```ts
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
```

- [ ] **Step 4: Implement the main-process handlers**

Replace the Task 11 stubs in `src/main/index.ts`:

```ts
    renameService: async (id, name) => {
      const inst = getService(id);
      if (!inst) return { ok: false, error: 'No such service.' };
      const err = validateInstanceName(name, id, config);
      if (err) return { ok: false, error: nameErrorMessage(err) };
      config.services[id] = { ...config.services[id], name: name.trim() };
      saveConfig(configPath(), config);
      applyIdentityChange(id);
      return { ok: true };
    },
    setServiceIcon: async (id, choice) => {
      const inst = getService(id);
      if (!inst) return { ok: false, error: 'No such service.' };
      if (choice === CUSTOM_ICON) {
        const picked = await pickCustomIcon(id);
        if (!picked) return { ok: true }; // cancelled — not an error
        if (picked.error) return { ok: false, error: picked.error };
      } else if (choice !== BRAND_ICON && !(variantIndex[inst.kind] ?? []).includes(choice)) {
        return { ok: false, error: 'Unknown icon.' };
      }
      config.services[id] = { ...config.services[id], icon: choice };
      saveConfig(configPath(), config);
      const next = getService(id);
      if (next) deployInstanceIcon(next, { iconSourceDir });
      applyIdentityChange(id);
      return { ok: true };
    },
```

Add above `registerHubIpc`:

```ts
/**
 * Push a service's new name/icon everywhere it is already displayed. A rename that only
 * reached config.json would leave the rail, the tray and the window caption disagreeing
 * with the settings page — and the caption is what the GNOME helper and KWin match on.
 *
 * The D-Bus object path is deliberately NOT touched: it is pinned to the kind's default
 * name so a rename cannot relocate a scriptable object (spec §5.2).
 */
function applyIdentityChange(id: string): void {
  const inst = getService(id);
  if (!inst) return;
  tray?.setDisplayName(id, inst.displayName);
  // Rewrite the launcher only when the user asked for one; writeServiceLauncher no-ops
  // under a dev run, and re-deploys the icon on the way through.
  if (config.services[id]?.launcher === true) {
    try { writeServiceLauncher(inst, { execPath: process.execPath, iconSourceDir }); }
    catch (err) { console.error(`Failed to rewrite ${id}'s launcher:`, err); }
  }
  windows.get(id)?.refreshIdentity(inst.displayName);
  loft?.refreshRail();
  loft?.refreshGrid();
  syncLoftWindows(); // the caption set the GNOME helper hides just changed
  notifyHub();
}

/**
 * Ask for an image and install it as this account's icon.
 *
 * Raster only: nativeImage cannot rasterise SVG, and shelling out to a converter the
 * user may not have turns "pick an icon" into a silent failure on some machines.
 */
async function pickCustomIcon(id: string): Promise<{ error?: string } | undefined> {
  const res = await dialog.showOpenDialog({
    title: 'Choose an icon',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (res.canceled || res.filePaths.length === 0) return undefined;
  const img = nativeImage.createFromPath(res.filePaths[0]);
  if (img.isEmpty()) return { error: 'That file is not an image Loft can read.' };
  try {
    mkdirSync(iconsDir(), { recursive: true });
    writeFileSync(join(iconsDir(), `${id}.png`), img.resize({ width: 512, height: 512 }).toPNG());
    return {};
  } catch (err) {
    console.error('Failed to write custom icon:', err);
    return { error: 'Could not save that icon.' };
  }
}
```

Add `dialog`, `nativeImage` to the `electron` import; `mkdirSync`, `writeFileSync` to the `node:fs` import; `validateInstanceName`, `nameErrorMessage`, `BRAND_ICON`, `CUSTOM_ICON` to the `./instances` import; `deployInstanceIcon` to the `./desktop` import.

`ServiceWindow` needs `refreshIdentity(name: string)` — add it in `src/main/serviceWindow.ts` beside the existing `setBadge` code (`:150-158`), which already builds the title with `formatWindowTitle`. It takes the new name rather than re-reading `def`, because `def` is captured by value at construction and a detached window has no other way to learn a rename:

```ts
  /** Re-render the titlebar and the OS caption after a rename. The caption is not
   *  cosmetic — the GNOME helper and KWin both match windows by it. */
  refreshIdentity(name: string): void {
    def = { ...def, displayName: name };
    setBadge(currentCount);   // reuse whatever this file already tracks as the count;
                              // it is the one place that formats and pushes the title
  },
```

If `setBadge` does not keep the last count in a variable, add one where it is assigned rather than duplicating the title-building here — two places formatting the same caption is exactly how a rename ends up half-applied.

- [ ] **Step 5: Build the icon picker**

Create `src/renderer/hub/components/IconPicker.svelte`:

```svelte
<script lang="ts">
  import type { HubService } from '../../../shared/hubTypes';
  let { svc }: { svc: HubService } = $props();

  let error = $state('');

  // Cache-busting: the deployed PNG changes under a stable loft://icon/<id> URL, so
  // without a changing query the swatch and the rail both keep the old bytes.
  let rev = $state(0);

  async function choose(choice: string) {
    error = '';
    const res = await window.loftHub.setServiceIcon(svc.id, choice);
    if (!res.ok) error = res.error ?? 'Could not change the icon.';
    else rev++;
  }

  const label = (c: string) => c.charAt(0).toUpperCase() + c.slice(1);
</script>

<div class="field">
  <span>Icon</span>
  <div class="row">
    <button class="sw" class:on={svc.icon === 'brand'} title="Default"
            onclick={() => choose('brand')} aria-label="Default icon">
      <img src={`loft://icon/${svc.kind}`} alt="" />
    </button>
    {#each svc.variants as colour (colour)}
      <button class="sw" class:on={svc.icon === colour} title={label(colour)}
              onclick={() => choose(colour)} aria-label={`${label(colour)} icon`}>
        <img src={`loft://icon/${svc.kind}?v=${colour}`} alt="" />
      </button>
    {/each}
    <button class="file" onclick={() => choose('custom')}>Choose a file…</button>
  </div>
  {#if svc.icon === 'custom'}
    <div class="row">
      <span class="sw on"><img src={`loft://icon/${svc.id}?r=${rev}`} alt="" /></span>
      <small class="hint">Using your own image.</small>
    </div>
  {/if}
  {#if error}<small class="err">{error}</small>{/if}
</div>

<style>
  .field { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .sw {
    width: 40px; height: 40px; padding: 3px; border-radius: 10px; cursor: pointer;
    border: 2px solid transparent; background: var(--card); display: grid; place-items: center;
  }
  .sw.on { border-color: var(--accent); }
  .sw img { width: 100%; height: 100%; object-fit: contain; }
  .file { border: 1px solid var(--divider); background: var(--card); color: var(--fg); border-radius: 999px; padding: 8px 16px; cursor: pointer; font: inherit; }
  .hint { color: var(--muted, #777); font-size: 12px; }
  .err { color: #c01c28; font-size: 12px; }
</style>
```

The variant swatch needs its own image source. `loft://icon/<kind>?v=<colour>` will not resolve a variant — extend the protocol handler from Task 10 to honour a `v` query parameter:

```ts
      const url = new URL(req.url);
      const name = url.pathname.replace(/^\/+/, '') || 'loft';
      const variant = url.searchParams.get('v') ?? undefined;
      const c = config.services[name];
      const kind = c?.kind ?? (getKind(name) ? name : undefined);
      // `?v=<colour>` asks for a specific variant of a KIND — the swatch row, which must
      // show colours this account is not currently wearing.
      const candidates = variant && kind
        ? [variantPngPath(iconSourceDir, kind, variant)]
        : iconCandidates({ iconsDir: iconsDir(), assetsDir: iconSourceDir, id: name, kind, icon: c?.icon });
```

Import `variantPngPath` alongside `iconCandidates`.

- [ ] **Step 6: Add the Name field and the picker to the settings page**

In `src/renderer/hub/components/ServiceDetail.svelte`, import `IconPicker`, and insert directly below the `<h2>` block:

```svelte
  <label class="field">
    <span>Name</span>
    <input bind:value={nameDraft} onchange={commitName} />
    {#if nameError}<small class="err">{nameError}</small>{/if}
  </label>

  <IconPicker {svc} />
```

with, in the `<script>`:

```ts
  let nameDraft = $state('');
  let nameError = $state('');
  $effect(() => { nameDraft = svc?.displayName ?? ''; });

  async function commitName() {
    nameError = '';
    if (nameDraft.trim() === svc.displayName) return;
    const res = await window.loftHub.renameService(id, nameDraft);
    // On rejection the field KEEPS what the user typed and says why — silently
    // reverting it reads as the app eating the keystrokes.
    if (!res.ok) nameError = res.error ?? 'Could not rename.';
  }
```

and in `<style>`: `.err { color: #c01c28; font-size: 12px; }`.

- [ ] **Step 7: Verify**

Run: `npm test && npm run build && npm run check`
Expected: all clean.

- [ ] **Step 8: Manual check**

```bash
env -u ELECTRON_RUN_AS_NODE npx electron .
```

Expected, in order:
1. Rename WhatsApp to "Work" — the rail label, the window caption and the tray menu all say Work immediately.
2. Rename a second service to "work" — the field keeps the text and shows "Another service already uses that name."
3. Try "Loft" — "“Loft” is reserved for the main window."
4. Pick a pastel swatch — the rail icon changes at once.
5. Choose a file… → pick a PNG — it becomes the icon; cancelling the dialog changes nothing and shows no error.

- [ ] **Step 9: Commit**

```bash
git add -A src tests
git commit -m "feat(hub): rename an account and change its icon"
```

---

### Task 13: Documentation

**Files:**
- Modify: `CLAUDE.md`, `CHANGELOG.md`

- [ ] **Step 1: Update CLAUDE.md**

Four edits:

1. **Architecture** — after the grid-view bullet, add a *Multiple accounts* bullet: the registry lists **kinds**; a config entry is an **instance** (one account); instance 1 of a kind keeps the bare kind id and later ones are `<kind>-<N>`; `kind`/`name`/`icon` are absent-means-default so no config migration exists; the preload argument carries the kind, everything else the instance id.
2. **D-Bus Interface** — replace "Per-service objects: `/chat/loft/<DbusName>` (display name with whitespace stripped)" with: derived from the kind's default name plus the instance number (`/chat/loft/WhatsApp`, `/chat/loft/WhatsApp2`, `/chat/loft/NextCloudTalk`), stable across renames, exported per installed account and unexported on removal.
3. **GNOME Shell helper** — note that main now pushes the D-Bus segment as the helper's `name` argument and the helper uses it rather than re-deriving from the display name; window matching is still by caption, which is why display names must be unique.
4. **File Layout** — under `~/.local/share/loft/icons/`, note the files are keyed by **instance** id (`whatsapp.png`, `whatsapp-2.png`) and are deployed on add and on every icon change; add `assets/icons/variants/<kind>-<colour>.png` as a build asset regenerated by `npm run icons`.

Also add `npm run icons` to the Development command list, with the one-line note that it needs ImageMagick and is only for changing an icon.

- [ ] **Step 2: Update CHANGELOG.md**

Add an entry in the file's existing style covering: multiple accounts per service; per-account name and icon (pastel variants + custom file); the Add another gallery; and — under a "for packagers/GNOME users" note — that the Shell helper must be updated for renames to work on the GNOME panel.

- [ ] **Step 3: Verify**

Run: `rg -n 'DbusName|display name with whitespace' CLAUDE.md`
Expected: no hits — the stale description is gone.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: record multiple accounts, instance ids and the stable D-Bus paths"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §3.1 config fields | 1 |
| §3.2 resolution, §3.3 ids, §3.4 default names | 3 |
| §4.1 Add another | 11 |
| §4.2 name + icon controls, live application | 12 |
| §5.1 name uniqueness | 3 (rule), 12 (surfaced) |
| §5.2 stable D-Bus paths | 3 (derivation), 9 (export) |
| §5.3 GNOME extension | 8 |
| §6.1 assets, §6.2 assignment | 4, 5, 7 |
| §6.3 deployment + fallback chain | 5, 6, 10 |
| §6.4 custom icons | 12 |
| §7 hub state + IPC | 11 |
| §8.1 free / §8.2 launchers | 6, 10, 12 |
| §8.3 tray, SNI, panel | 8 |
| §8.4 preload kind | 10 |
| §8.5 CLI | 10 (`--service` takes an instance id; a bare kind id still resolves because instance 1 keeps it — no code change, covered by the resolver) |
| §8.6 startup checks | 10 |
| §9 testing | every task |

**Deliberate additions beyond the spec**, both surfaced by reading the existing code:

- `TrayModel.removeService` — removing a service never dropped its tray row, so it survived in the available section until the next launch. Harmless when adding a service was rare; not harmless once accounts come and go.
- `Tray.addService` and `LoftDbus.exportInstance` on the hub's add path — an added account was previously invisible to the tray and D-Bus until it first launched.

**Known ordering constraint:** Tasks 6, 7 and 9 each leave `src/main/index.ts` compiling against a temporary shim (`asInstance`, the `renameService`/`setServiceIcon` stubs). Task 10 removes the first and Task 12 the second. A reviewer seeing those shims mid-sequence should check they are gone by Task 12, not reject them in place.
