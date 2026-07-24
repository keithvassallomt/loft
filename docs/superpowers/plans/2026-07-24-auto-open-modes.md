# Auto-Open Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-service binary "Open on startup" checkbox with a three-way **Auto Open** choice — **Disabled**, **On login**, **On launching Loft** — so a service can be set to load only when the user actually opens Loft, without running from login.

**Architecture:** A per-service `autoOpen` config value (`'login' | 'launch'`; absent = disabled) supersedes the legacy `openOnStartup` boolean, read through one pure helper `effectiveAutoOpen()`. The derived-autostart model is unchanged in spirit — Loft autostarts at login iff some service is **On login** (`effectiveAutoOpen === 'login'`). "On launching Loft" services load the first time the Loft window is opened non-minimized this session, which is distinguishable because the login-autostart entry runs `loft --minimized` and a manual open never does.

**Tech Stack:** TypeScript (Electron main + shared types), Svelte 5 runes (hub renderer), Vitest.

## Global Constraints

- No config migration: `configVersion` stays 2. Absent `autoOpen` + absent/false `openOnStartup` = disabled; a legacy `openOnStartup: true` reads as **On login**, preserving today's behaviour byte-for-byte until the user next touches the setting.
- Unknown config keys are dropped by `sanitizeServiceConfig` — every persisted field must be whitelisted there.
- Display copy: the three options are labelled exactly **Disabled**, **On login**, **On launching Loft**.
- `effectiveAutoOpen()` is the single source of truth for a service's mode — no code may branch on `openOnStartup` or `autoOpen` directly once it exists.

## Design decisions (confirmed with Keith 2026-07-24)

1. **When Loft is already running from a login-service** and the user opens its window, the *On launching Loft* services load then (a tray reveal counts as "opening Loft"). Rule: load them the first time the Loft window is opened non-minimized this session; the silent `--minimized` login launch does not count. Guarded so they load **once** per process — an explicit Unload within a session stays unloaded.
2. **A per-service launcher** (`loft --service=whatsapp`) counts as a manual launch, so it loads the *On launching Loft* set too (consistent with today loading the whole startup set on every launch path).

## File Structure

- `src/shared/hubTypes.ts` — add `AutoOpen` union; swap `HubService.openOnStartup: boolean` → `autoOpen: AutoOpen`; add `ServicePatch.autoOpen?: AutoOpen`.
- `src/main/config.ts` — `ServiceConfig.autoOpen?: 'login' | 'launch'`; `effectiveAutoOpen()`; sanitize + keep legacy `openOnStartup`.
- `src/main/autostart.ts` — `wantsAutostart` keyed on `effectiveAutoOpen === 'login'`.
- `src/main/hubState.ts` — emit `autoOpen: effectiveAutoOpen(c)`.
- `src/main/index.ts` — `setServiceSetting` autoOpen handling; startup + second-instance load logic; `autostartBlocked` unchanged (already via `wantsAutostart`).
- `src/renderer/hub/components/ServiceDetail.svelte` — radio group + warning gating.
- Tests: `config.test.ts`, `autostart.test.ts`, `hubState.test.ts`, `managerModel.test.ts`.
- Docs: `CHANGELOG.md`, `CLAUDE.md`, the §6f rationale comment/spec.

---

### Task 1: Config field + `effectiveAutoOpen`

**Files:**
- Modify: `src/shared/hubTypes.ts` (add `AutoOpen`)
- Modify: `src/main/config.ts` (field, helper, sanitize)
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `type AutoOpen = 'disabled' | 'login' | 'launch'` (hubTypes); `ServiceConfig.autoOpen?: 'login' | 'launch'`; `effectiveAutoOpen(c?: ServiceConfig): AutoOpen` (config.ts).

- [ ] **Step 1: Failing tests** in `tests/config.test.ts`:

```ts
import { loadConfig, saveConfig, defaultConfig, reopenDetachedEnabled, effectiveAutoOpen } from '../src/main/config';

describe('effectiveAutoOpen', () => {
  it('is disabled when nothing is set', () => { expect(effectiveAutoOpen({})).toBe('disabled'); expect(effectiveAutoOpen(undefined)).toBe('disabled'); });
  it('reads a legacy openOnStartup:true as login', () => { expect(effectiveAutoOpen({ openOnStartup: true })).toBe('login'); });
  it('returns the explicit autoOpen value', () => {
    expect(effectiveAutoOpen({ autoOpen: 'login' })).toBe('login');
    expect(effectiveAutoOpen({ autoOpen: 'launch' })).toBe('launch');
  });
  it('prefers autoOpen over the legacy boolean', () => { expect(effectiveAutoOpen({ autoOpen: 'launch', openOnStartup: true })).toBe('launch'); });
});

it('round-trips autoOpen and preserves a legacy openOnStartup', () => {
  const cfg = defaultConfig();
  cfg.services.slack = { autoOpen: 'launch' };
  cfg.services.whatsapp = { openOnStartup: true };
  const p = join(dir, 'auto-open.json');
  saveConfig(p, cfg);
  expect(loadConfig(p)).toEqual(cfg);
});
it('drops a bogus autoOpen value', () => {
  const p = join(dir, 'bad-auto.json');
  writeFileSync(p, '{"services":{"slack":{"autoOpen":"whenever"}}}', 'utf8');
  expect(loadConfig(p).services.slack.autoOpen).toBeUndefined();
});
```

- [ ] **Step 2: Run — expect FAIL** (`effectiveAutoOpen` undefined): `npx vitest run tests/config.test.ts`
- [ ] **Step 3: Implement.** In `src/shared/hubTypes.ts` add `export type AutoOpen = 'disabled' | 'login' | 'launch';`. In `src/main/config.ts`:

```ts
import type { AutoOpen } from '../shared/hubTypes';
// in ServiceConfig, alongside openOnStartup:
  /** Auto-open mode. Absent = disabled. Supersedes the legacy openOnStartup boolean, which
   *  is still read (as 'login') for back-compat — see effectiveAutoOpen. */
  autoOpen?: 'login' | 'launch';

/** The one place mode is decided: explicit autoOpen wins; a legacy openOnStartup:true means
 *  'login'; anything else is 'disabled'. */
export function effectiveAutoOpen(c?: ServiceConfig): AutoOpen {
  if (c?.autoOpen === 'login' || c?.autoOpen === 'launch') return c.autoOpen;
  if (c?.openOnStartup === true) return 'login';
  return 'disabled';
}
```
In `sanitizeServiceConfig`, keep the existing `openOnStartup` line and add:
```ts
  if (s.autoOpen === 'login' || s.autoOpen === 'launch') out.autoOpen = s.autoOpen;
```

- [ ] **Step 4: Run — expect PASS**: `npx vitest run tests/config.test.ts`
- [ ] **Step 5: Commit** `feat(config): add per-service autoOpen mode + effectiveAutoOpen`

---

### Task 2: Autostart derivation keyed on 'login'

**Files:**
- Modify: `src/main/autostart.ts` (`wantsAutostart`)
- Test: `tests/autostart.test.ts`

**Interfaces:**
- Consumes: `effectiveAutoOpen` (Task 1).

- [ ] **Step 1: Failing tests** in `tests/autostart.test.ts` (add):

```ts
import { effectiveAutoOpen } from '../src/main/config';
it('wants autostart only for On-login services', () => {
  expect(wantsAutostart({ a: { autoOpen: 'login' } })).toBe(true);
  expect(wantsAutostart({ a: { openOnStartup: true } })).toBe(true); // legacy
  expect(wantsAutostart({ a: { autoOpen: 'launch' } })).toBe(false);
  expect(wantsAutostart({ a: {} })).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL** (`launch` currently isn't distinguished; today it only checks `openOnStartup`): `npx vitest run tests/autostart.test.ts`
- [ ] **Step 3: Implement** in `src/main/autostart.ts`:
```ts
import { effectiveAutoOpen, type ServiceConfig } from './config';
export function wantsAutostart(services: Record<string, ServiceConfig | undefined>): boolean {
  return Object.values(services).some((s) => effectiveAutoOpen(s) === 'login');
}
```
- [ ] **Step 4: Run — expect PASS**: `npx vitest run tests/autostart.test.ts`
- [ ] **Step 5: Commit** `feat(autostart): derive login autostart from autoOpen==='login'`

---

### Task 3: Hub state + types

**Files:**
- Modify: `src/shared/hubTypes.ts` (`HubService.autoOpen`, `ServicePatch.autoOpen`)
- Modify: `src/main/hubState.ts`
- Test: `tests/hubState.test.ts`, `tests/managerModel.test.ts`

**Interfaces:**
- Consumes: `effectiveAutoOpen` (Task 1), `AutoOpen` (Task 1).
- Produces: `HubService.autoOpen: AutoOpen` (replaces `openOnStartup`); `ServicePatch.autoOpen?: AutoOpen`.

- [ ] **Step 1: Failing test** — update `tests/hubState.test.ts` line asserting `openOnStartup` to `autoOpen`, and add mapping:
```ts
// where the fixture sets telegram openOnStartup:true → expect it as 'login':
expect(tg).toMatchObject({ running: true, visible: true, dnd: true, autoOpen: 'login', customUrl: 'https://t' });
// add a service with autoOpen:'launch' to the fixture config and assert it maps through.
```
- [ ] **Step 2: Run — expect FAIL** (`autoOpen` missing on HubService): `npx vitest run tests/hubState.test.ts`
- [ ] **Step 3: Implement.** In `hubTypes.ts`: replace `openOnStartup: boolean;` in `HubService` with `autoOpen: AutoOpen;`; in `ServicePatch` replace `openOnStartup?: boolean;` with `autoOpen?: AutoOpen;`. In `hubState.ts` replace `openOnStartup: c.openOnStartup ?? false,` with `autoOpen: effectiveAutoOpen(c),` (import `effectiveAutoOpen`).
- [ ] **Step 4: Run — expect PASS**: `npx vitest run tests/hubState.test.ts tests/managerModel.test.ts`
- [ ] **Step 5: Commit** `feat(hub): expose per-service autoOpen mode to the renderer`

---

### Task 4: Main wiring — settings write, startup + reveal load

**Files:**
- Modify: `src/main/index.ts` (`setServiceSetting`; startup loop ~1620-1629; `second-instance` ~766)

**Interfaces:**
- Consumes: `effectiveAutoOpen` (Task 1), `placeService`, `hostOf`, `reconcileAutostart`, `parseArgs`.

- [ ] **Step 1: `setServiceSetting`** — pull `autoOpen` out of the generic merge and normalise (retire legacy `openOnStartup`, `'disabled'` → absent):
```ts
function setServiceSetting(id: string, patch: ServicePatch): void {
  const { autoOpen, ...rest } = patch;
  config.services[id] = { ...config.services[id], ...rest };
  if (autoOpen !== undefined) {
    const c = config.services[id];
    delete c.openOnStartup;                 // supersede the legacy flag on first write
    if (autoOpen === 'disabled') delete c.autoOpen; else c.autoOpen = autoOpen;
  }
  saveConfig(configPath(), config);
  // ...existing dnd/badge/launcher/customUrl blocks unchanged...
  if (autoOpen !== undefined) reconcileAutostart();   // replaces the old `patch.openOnStartup` line
}
```

- [ ] **Step 2: Startup load** — replace the loop at ~1620-1629 with login-always + launch-once-on-manual, backed by a module-level guard:
```ts
// module scope, near hostOf:
let launchSetLoaded = false;
function loadAutoOpen(kind: 'login' | 'launch'): void {
  for (const id of Object.keys(config.services)) {
    if (effectiveAutoOpen(config.services[id]) !== kind) continue;
    const d = getService(id);
    if (d && !hostOf(id)) placeService(d, true);
  }
}
function loadLaunchServices(): void { if (launchSetLoaded) return; launchSetLoaded = true; loadAutoOpen('launch'); }
```
```ts
// in whenReady, replacing the old for-loop:
loadAutoOpen('login');
if (!args.minimized) loadLaunchServices();
```

- [ ] **Step 3: Second-instance reveal** — load launch services when the user opens Loft again (unless that second launch is itself `--minimized`). At the top of the `second-instance` handler:
```ts
app.on('second-instance', (_e, argv) => {
  if (!parseArgs(argv).minimized) loadLaunchServices();
  const def = resolveServiceFromArgs(argv);
  // ...unchanged...
});
```

- [ ] **Step 4: Build + full suite** — `npm run build && npm test` — expect green (no `openOnStartup` references remain in main except the back-compat read in config.ts).
- [ ] **Step 5: Commit** `feat(startup): load On-launching-Loft services only when the window is opened`

---

### Task 5: Renderer — Auto Open radio group

**Files:**
- Modify: `src/renderer/hub/components/ServiceDetail.svelte`

- [ ] **Step 1: Replace** the "Open on startup" `<label class="toggle">` checkbox (and its warning gating) with a radio group:
```svelte
<fieldset class="autoopen">
  <legend>Auto Open</legend>
  {#each [
    { v: 'disabled', label: 'Disabled', hint: 'Never open on its own.' },
    { v: 'login', label: 'On login', hint: 'Runs in the background from login (Loft starts automatically).' },
    { v: 'launch', label: 'On launching Loft', hint: 'Loads only when you open Loft, not at login.' },
  ] as o}
    <label class="radio">
      <input type="radio" name={`autoopen-${id}`} value={o.v}
        checked={svc.autoOpen === o.v}
        onchange={() => set({ autoOpen: o.v as 'disabled' | 'login' | 'launch' })} />
      <span><strong>{o.label}</strong><em>{o.hint}</em></span>
    </label>
  {/each}
</fieldset>
{#if svc.autoOpen === 'login' && hubState.globals.autostartBlocked}
  <p class="warn">Loft isn't allowed to start at login, so this won't take effect. Turn on “Run in Background” in Settings → Apps → Loft.</p>
{/if}
```
Add styles (`.autoopen`, `.radio`, `.radio span`/`strong`/`em`) mirroring the existing `.toggle`/`.warn` look.

- [ ] **Step 2: Type-check** — `npm run check` — expect 0 errors.
- [ ] **Step 3: Commit** `feat(hub): Auto Open radio group (Disabled / On login / On launching Loft)`

---

### Task 6: Docs

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md`, the §6f rationale (comment at `src/main/index.ts` and the spec that defines it)

- [ ] **Step 1: CHANGELOG** — add under `## [1.0.0]` → Added:
  `- Auto Open modes: each service's "open on startup" is now a three-way choice — **Disabled**, **On login** (runs from login in the background), or **On launching Loft** (loads only when you open Loft). Existing "open on startup" settings become **On login**.`
- [ ] **Step 2: CLAUDE.md** — update the File Layout autostart note and any "openOnStartup" prose to describe the tri-state and that autostart is derived from `autoOpen === 'login'`.
- [ ] **Step 3: §6f** — update the rationale comment at the startup loop (currently "load the whole startup set on every launch path") to state the refinement: login set on every launch, launch set only on a non-minimized open. Update the spec file that defines §6f to match.
- [ ] **Step 4: Commit** `docs: record Auto Open modes`

---

## Self-Review

- **Spec coverage:** Disabled/login/launch config (T1) ✓; autostart derived from login (T2) ✓; renderer state (T3) ✓; write + startup + reveal semantics incl. decisions #1/#2 (T4) ✓; UI (T5) ✓; docs incl. §6f (T6) ✓.
- **Type consistency:** `AutoOpen` = `'disabled'|'login'|'launch'` used in hubTypes/patch/UI; `ServiceConfig.autoOpen` narrows to `'login'|'launch'` (disabled = absent), normalised in `setServiceSetting`. `effectiveAutoOpen` name identical across config/autostart/hubState.
- **Migration:** legacy `openOnStartup` read in `effectiveAutoOpen` + preserved in sanitize; retired on first `autoOpen` write. `configVersion` untouched.
