# Polish Grab-Bag (09c-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land three independent 09c polish fixes — per-service launchers become opt-in and enforced, Telegram notification clicks navigate, and `hostFor` stops reallocating on hot paths.

**Architecture:** Launcher becomes an opt-in flag (`launcher`) surfaced in per-service settings, applied immediately on toggle and re-enforced by a startup sweep (extracted into a pure `reconcileServiceLaunchers`). The Telegram deeplink is unblocked by generalizing `service:navigate` behind a pure `navigateAction`. `hostFor` is memoized per id.

**Tech Stack:** TypeScript (strict), Electron 43, Svelte 5 runes (hub renderer), Vitest, svelte-check.

**Spec:** `docs/superpowers/specs/2026-07-18-electron-loft-09c3-polish-design.md`

## Global Constraints

- **No new dependencies.** TypeScript strict.
- **Launcher default is opt-in OFF** for new services (spec 09 Q2). Existing services keep their launchers (migration back-filled `launcher: true`).
- **`writeServiceLauncher` keeps its dev-run guard** (`desktop.ts:100-103`): in an unpackaged dev run it writes nothing. `removeServiceLauncher` always removes an existing file.
- **The Loft launcher** (`chat.loft.Loft.desktop`, `ensureHubDesktopEntry`) is unaffected.
- **`hub:*` and `service:*` channel names/payloads are unchanged.** No `HubState` shape change beyond adding the `launcher` field.
- **Test commands:** whole suite `npm test`; one file `npx vitest run tests/<name>.test.ts`; renderer types `npm run check`; build `npm run build`.
- Frequent commits — one per task. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Manual GUI smoke is Keith's — agent steps end at automated tests + build.

## File Structure

**Create:**
- `src/preload/notify/navigate.ts` — pure `navigateAction` (Task 4).
- `tests/notifyNavigate.test.ts` (Task 4), `tests/launcherSweep.test.ts` (Task 2).

**Modify:**
- `src/shared/hubTypes.ts` — `launcher` on `HubService` + `ServicePatch` (Task 1).
- `src/main/hubState.ts` — map `launcher` (Task 1).
- `src/main/install.ts` — Add no longer writes/sets a launcher (Task 1).
- `src/main/desktop.ts` — `reconcileServiceLaunchers` helper (Task 2).
- `src/main/index.ts` — startup sweep gates on the flag; `setServiceSetting` applies a launcher change; import `removeServiceLauncher`; `addService` caller drops dead opts (Tasks 1–2).
- `src/renderer/hub/components/ServiceDetail.svelte` — the toggle (Task 3).
- `src/preload/notify/bridge.ts` — generalized `service:navigate` (Task 4).
- `src/main/loftWindow.ts` — memoized `hostFor` (Task 5).
- `tests/install.test.ts`, `tests/hubState.test.ts` (Task 1).

**Deferred (noted, not built):** collapsing the double `refreshAll` per badge tick. It only occurs for an attached, badges-on service, and both refresh sites are load-bearing elsewhere (`refreshRail` for detached rail entries; `api.setBadge`'s `refreshAll` for the `setServiceSetting` badge-toggle path). A correct dedup needs a conditional not worth the risk for one cheap repaint.

---

### Task 1: Launcher — data model + opt-in-off default

New services stop getting a launcher on Add; `HubState`/`ServicePatch` learn `launcher`.

**Files:**
- Modify: `src/shared/hubTypes.ts`, `src/main/hubState.ts`, `src/main/install.ts`, `src/main/index.ts` (the one `addService` call site), `tests/install.test.ts`, `tests/hubState.test.ts`

**Interfaces:**
- Produces: `HubService.launcher: boolean`, `ServicePatch.launcher?: boolean`; `addService(def, cfg, opts: { customUrl?: string })` (opts narrowed — `env`/`execPath`/`iconSourceDir` removed).

- [ ] **Step 1: Update the install tests (TDD — write the new expectations first)**

In `tests/install.test.ts`: remove the now-unused `iconSrc` helper, and replace the launcher-related tests. The full new test body for the launcher-touching cases:

```ts
  it('addService marks config + customUrl and writes no launcher (opt-in off)', () => {
    const cfg: LoftConfig = { services: {} };
    addService(wa, cfg, { customUrl: 'https://x' });
    expect(cfg.services.whatsapp).toBeDefined();
    expect(cfg.services.whatsapp.customUrl).toBe('https://x');
    expect(cfg.services.whatsapp.launcher).toBeUndefined();
  });

  it('removeService deletes an existing launcher + config, and partition when asked', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { whatsapp: { launcher: true } } };
    const apps = join(data, 'applications');
    mkdirSync(apps, { recursive: true });
    writeFileSync(join(apps, 'loft-whatsapp.desktop'), '[Desktop Entry]');
    const part = join(data, 'loft', 'Partitions', 'whatsapp');
    mkdirSync(part, { recursive: true });

    removeService(wa, cfg, true, env);
    expect(cfg.services.whatsapp).toBeUndefined();
    expect(existsSync(join(apps, 'loft-whatsapp.desktop'))).toBe(false);
    expect(existsSync(part)).toBe(false);
  });

  it('addService preserves existing service-config fields', () => {
    const cfg: LoftConfig = { services: { whatsapp: { dnd: true, badgesEnabled: false } } };
    addService(wa, cfg, { customUrl: 'https://x' });
    expect(cfg.services.whatsapp.dnd).toBe(true);
    expect(cfg.services.whatsapp.badgesEnabled).toBe(false);
    expect(cfg.services.whatsapp.customUrl).toBe('https://x');
  });

  it('removeService keeps the partition when deleteData is false', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { whatsapp: {} } };
    const part = join(data, 'loft', 'Partitions', 'whatsapp');
    mkdirSync(part, { recursive: true });
    removeService(wa, cfg, false, env);
    expect(existsSync(part)).toBe(true);
  });

  it('addService does not set launcher (opt-in off)', () => {
    const cfg: LoftConfig = { services: {} };
    addService(wa, cfg, {});
    expect(cfg.services.whatsapp.launcher).toBeUndefined();
  });

  it('addService does not add a launcher flag to an existing entry', () => {
    const cfg: LoftConfig = { services: { whatsapp: { dnd: true } } };
    addService(wa, cfg, {});
    expect(cfg.services.whatsapp).toEqual({ dnd: true });
  });
```

(The first two `describe('install')` tests being replaced are the old "writes launcher" and "removeService deletes launcher" cases; the `iconSrc` function and its calls go away since `addService` no longer takes `iconSourceDir`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/install.test.ts`
Expected: FAIL — `addService` still writes launchers and its opts type still requires the removed fields (type/behaviour mismatch).

- [ ] **Step 3: Narrow `addService` (drop the launcher write)**

Replace `src/main/install.ts`'s imports and `addService`:

```ts
import { existsSync, rmSync } from 'node:fs';
import type { ServiceDef } from './registry';
import type { LoftConfig } from './config';
import { removeServiceLauncher } from './desktop';
import { partitionDir } from './paths';

type Env = NodeJS.ProcessEnv;

export function removePartitionData(id: string, env: Env = process.env): void {
  const dir = partitionDir(id, env);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Idempotent: mark the service configured and set a custom URL if given. New services are
 *  launcher-less by default (spec 09 Q2 / 09c-3) — a per-service .desktop is opt-in from the
 *  service's settings, so Add no longer writes one. */
export function addService(def: ServiceDef, cfg: LoftConfig, opts: { customUrl?: string } = {}): void {
  cfg.services[def.id] = { ...cfg.services[def.id] };
  if (opts.customUrl !== undefined) cfg.services[def.id].customUrl = opts.customUrl;
}

export function removeService(
  def: ServiceDef,
  cfg: LoftConfig,
  deleteData: boolean,
  env: Env = process.env,
): void {
  removeServiceLauncher(def, env);
  delete cfg.services[def.id];
  if (deleteData) removePartitionData(def.id, env);
}
```

- [ ] **Step 4: Update the one production caller**

In `src/main/index.ts`, the `registerHubIpc` `addService` dep currently calls `addService(d, config, { execPath: process.execPath, iconSourceDir, customUrl })`. Change that inner call to:

```ts
      addService(d, config, { customUrl });
```

(Leave the surrounding `saveConfig` / `loft?.refreshRail()` / `notifyHub()` unchanged.)

- [ ] **Step 5: Add `launcher` to the types + hub state**

In `src/shared/hubTypes.ts`, add `launcher: boolean;` to `HubService` (after `customUrl`) and `launcher?: boolean;` to `ServicePatch`.

In `src/main/hubState.ts`, add to the mapped object (after `customUrl`):

```ts
      launcher: c?.launcher === true,
```

- [ ] **Step 6: Add the hubState assertion**

In `tests/hubState.test.ts`, add (adapt to that file's existing helpers/fixtures — assert on an installed service):

```ts
  it('reports launcher as configured (absent means off)', () => {
    // a service configured with launcher:true reports true; a plain one reports false
    // — adapt the fixture to that file's buildHubState call.
  });
```

Replace the placeholder body with a real assertion using the file's existing `buildHubState` fixture: build state for a config where one service has `{ launcher: true }` and another has `{}`, and assert `.launcher` is `true` and `false` respectively.

- [ ] **Step 7: Run tests + build**

Run: `npx vitest run tests/install.test.ts tests/hubState.test.ts && npm run build && npm test`
Expected: the updated tests pass; build clean; full suite green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(launcher): new services are launcher-opt-in (off by default)"
```

---

### Task 2: Launcher — enforcement (startup sweep + immediate apply)

Make the flag real: a pure `reconcileServiceLaunchers` drives the startup sweep, and toggling `launcher` writes/removes the `.desktop` immediately.

**Files:**
- Modify: `src/main/desktop.ts`, `src/main/index.ts`
- Test: `tests/launcherSweep.test.ts`

**Interfaces:**
- Consumes: `writeServiceLauncher`, `removeServiceLauncher` (existing); `ServicePatch.launcher` (Task 1).
- Produces: `reconcileServiceLaunchers(ids: string[], wants: (id: string) => boolean, ops: { write: (id: string) => void; remove: (id: string) => void }): void`.

- [ ] **Step 1: Write the failing sweep test**

Create `tests/launcherSweep.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { reconcileServiceLaunchers } from '../src/main/desktop';

describe('reconcileServiceLaunchers', () => {
  it('writes for ids that want a launcher, removes for those that do not', () => {
    const write = vi.fn(), remove = vi.fn();
    reconcileServiceLaunchers(['a', 'b', 'c'], (id) => id !== 'b', { write, remove });
    expect(write.mock.calls.map((c) => c[0])).toEqual(['a', 'c']);
    expect(remove.mock.calls.map((c) => c[0])).toEqual(['b']);
  });

  it('isolates a throwing op so the rest still run', () => {
    const write = vi.fn((id: string) => { if (id === 'a') throw new Error('boom'); });
    const remove = vi.fn();
    reconcileServiceLaunchers(['a', 'b'], () => true, { write, remove });
    expect(write).toHaveBeenCalledTimes(2); // 'b' still attempted after 'a' threw
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/launcherSweep.test.ts`
Expected: FAIL — `reconcileServiceLaunchers` not exported.

- [ ] **Step 3: Add the helper to `desktop.ts`**

In `src/main/desktop.ts`, add (near `removeServiceLauncher`):

```ts
/** Enforce each service's opt-in launcher flag: write the .desktop for services that want one,
 *  remove it for those that do not. Per-id try/catch so one unwritable entry can't skip the rest. */
export function reconcileServiceLaunchers(
  ids: string[],
  wants: (id: string) => boolean,
  ops: { write: (id: string) => void; remove: (id: string) => void },
): void {
  for (const id of ids) {
    try { (wants(id) ? ops.write : ops.remove)(id); }
    catch (err) { console.error(`Launcher self-heal failed for ${id}:`, err); }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/launcherSweep.test.ts`
Expected: PASS.

- [ ] **Step 5: Drive the startup sweep through the helper**

In `src/main/index.ts`, change the import at line 27 to also bring in `removeServiceLauncher` and `reconcileServiceLaunchers`:

```ts
import { ensureHubDesktopEntry, writeServiceLauncher, removeServiceLauncher, reconcileServiceLaunchers, serviceLauncherPath } from './desktop';
```

Replace the launcher self-heal loop (the `for (const id of Object.keys(config.services))` block that calls `writeServiceLauncher`) and its comment with:

```ts
    // Enforce each service's opt-in launcher flag (spec 09 Q2 / 09c-3): write a .desktop for
    // services that asked for one, remove it for those that didn't. Idempotent and cheap; it
    // also repairs a stale/deleted entry. Skipped writes under a dev run (see writeServiceLauncher)
    // so a checkout can't clobber the packaged install's entries.
    reconcileServiceLaunchers(
      Object.keys(config.services),
      (id) => config.services[id]?.launcher === true,
      {
        write: (id) => { const d = getService(id); if (d) writeServiceLauncher(d, { execPath: process.execPath, iconSourceDir }); },
        remove: (id) => { const d = getService(id); if (d) removeServiceLauncher(d); },
      },
    );
```

- [ ] **Step 6: Apply a launcher change immediately in `setServiceSetting`**

In `src/main/index.ts`'s `setServiceSetting`, immediately after the `if (patch.badgesEnabled !== undefined) { … }` block closes, add:

```ts
  // A launcher toggle takes effect now, not just on next launch. writeServiceLauncher no-ops
  // under a dev run; removeServiceLauncher clears an existing file.
  if (patch.launcher !== undefined) {
    const d = getService(id);
    if (d) {
      if (patch.launcher) writeServiceLauncher(d, { execPath: process.execPath, iconSourceDir });
      else removeServiceLauncher(d);
    }
  }
```

- [ ] **Step 7: Build + full suite**

Run: `npm run build && npm test`
Expected: build clean; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(launcher): enforce the opt-in flag (startup sweep + live toggle)"
```

---

### Task 3: Launcher — the settings toggle

Surface the flag in the per-service settings pane.

**Files:**
- Modify: `src/renderer/hub/components/ServiceDetail.svelte`

**Interfaces:**
- Consumes: `HubService.launcher` (Task 1); the existing `set(patch)` → `window.loftHub.setServiceSetting` path.

- [ ] **Step 1: Add the toggle**

In `src/renderer/hub/components/ServiceDetail.svelte`, after the Do Not Disturb toggle (the `<label class="toggle">…Do Not Disturb…</label>` block) and before the `<div class="trouble">`, add:

```svelte
  <label class="toggle">
    <input type="checkbox" checked={svc.launcher} onchange={(e) => set({ launcher: e.currentTarget.checked })} />
    <span>Create a desktop launcher</span>
  </label>
```

- [ ] **Step 2: Type-check the renderer**

Run: `npm run check`
Expected: PASS — `svc.launcher` resolves (Task 1 added it to `HubService`), `set({ launcher })` type-checks (`ServicePatch.launcher`).

- [ ] **Step 3: Build + full suite**

Run: `npm run build && npm test`
Expected: build clean; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(hub): per-service 'Create a desktop launcher' toggle"
```

> **Manual (Keith):** in a packaged/installed run, toggling the box adds/removes the service's app-menu launcher; a newly added service starts with the box off and no launcher.

---

### Task 4: Telegram deeplink — unblock `service:navigate`

Drop the Messenger-only gate; the anchor-click is shared, the fallback is per-service, both behind a pure `navigateAction`.

**Files:**
- Create: `src/preload/notify/navigate.ts`, `tests/notifyNavigate.test.ts`
- Modify: `src/preload/notify/bridge.ts`

**Interfaces:**
- Produces: `type NavigateAction = { kind: 'click' } | { kind: 'href'; url: string } | { kind: 'hash'; url: string } | { kind: 'none' }`; `navigateAction(serviceId: string, url: string, hasAnchor: boolean): NavigateAction`.

- [ ] **Step 1: Write the failing helper test**

Create `tests/notifyNavigate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { navigateAction } from '../src/preload/notify/navigate';

describe('navigateAction', () => {
  it('clicks the matched anchor for any service', () => {
    expect(navigateAction('messenger', '/t/123', true)).toEqual({ kind: 'click' });
    expect(navigateAction('telegram', '#123', true)).toEqual({ kind: 'click' });
  });
  it('messenger falls back to a full facebook navigation', () => {
    expect(navigateAction('messenger', '/t/123', false)).toEqual({ kind: 'href', url: 'https://www.facebook.com/t/123' });
  });
  it('telegram falls back to the hash route when the key is one', () => {
    expect(navigateAction('telegram', '#123', false)).toEqual({ kind: 'hash', url: '#123' });
  });
  it('telegram with a non-hash key does nothing — no wrong navigation', () => {
    expect(navigateAction('telegram', 'peer-42', false)).toEqual({ kind: 'none' });
  });
  it('an unknown service with no anchor does nothing', () => {
    expect(navigateAction('slack', '/x', false)).toEqual({ kind: 'none' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/notifyNavigate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the helper**

Create `src/preload/notify/navigate.ts`:

```ts
export type NavigateAction =
  | { kind: 'click' }
  | { kind: 'href'; url: string }
  | { kind: 'hash'; url: string }
  | { kind: 'none' };

/** How to act on a notification-click navigation. The chat row is a live `<a href>` for both
 *  Messenger and Telegram, so an anchor match is the shared path; otherwise a per-service
 *  fallback (Messenger → full facebook nav, Telegram → hash route, anything else → nothing). */
export function navigateAction(serviceId: string, url: string, hasAnchor: boolean): NavigateAction {
  if (hasAnchor) return { kind: 'click' };
  if (serviceId === 'messenger') return { kind: 'href', url: `https://www.facebook.com${url}` };
  if (serviceId === 'telegram') return url.startsWith('#') ? { kind: 'hash', url } : { kind: 'none' };
  return { kind: 'none' };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/notifyNavigate.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire the bridge handler**

In `src/preload/notify/bridge.ts`, add the import at the top (with the other `./` imports):

```ts
import { navigateAction } from './navigate';
```

Replace the `service:navigate` handler (the `ipc.on('service:navigate', …)` block with its `serviceId !== 'messenger'` gate) with:

```ts
  // Notification click routes here from main. The chat row is a live <a href> for both
  // Messenger and Telegram, so try an anchor-click first; otherwise a per-service fallback.
  ipc.on('service:navigate', (_e: unknown, url?: unknown) => {
    if (typeof url !== 'string') return;
    let anchor: Element | null = null;
    try {
      anchor = doc.querySelector(`a[href="${url}"]`);
    } catch {
      // Malformed url (e.g. a stray `"`) breaks the attribute selector; treat as no anchor.
      anchor = null;
    }
    const action = navigateAction(serviceId, url, anchor !== null);
    switch (action.kind) {
      case 'click': (anchor as HTMLElement).click(); break;
      case 'href': win.location.href = action.url; break;
      case 'hash': win.location.hash = action.url; break;
      case 'none': break;
    }
  });
```

- [ ] **Step 6: Build + full suite**

Run: `npm run build && npm test`
Expected: build clean (esbuild bundles the new `navigate.ts` into the preload); all tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(notify): navigate on Telegram notification clicks, not just Messenger"
```

> **Manual (Keith):** clicking a Telegram notification switches to the Telegram tab and opens that chat; Messenger click-to-navigate still works.

---

### Task 5: Memoize `hostFor`

Stop rebuilding the ~13-closure host object on every `hostFor(id)` call.

**Files:**
- Modify: `src/main/loftWindow.ts`

**Interfaces:**
- No signature change — `hostFor`/`hostOf` behaviour is identical, just cached.

- [ ] **Step 1: Add the per-id cache and invalidation**

In `src/main/loftWindow.ts`, add a cache map alongside `views`:

```ts
  const hosts = new Map<string, ServiceHost>();
```

Change `hostFor` to build lazily and cache. Replace the current `const hostFor = (id) => { const sv = views.get(id); if (!sv) return undefined; return { … }; };` with:

```ts
  const hostFor = (id: string): ServiceHost | undefined => {
    const sv = views.get(id);
    if (!sv) { hosts.delete(id); return undefined; }
    let host = hosts.get(id);
    if (!host) {
      host = {
        def: sv.def,
        show: () => { select(id); api.open(); },
        hide: () => window.hide(),
        isVisible: () => window.isVisible() && active === id,
        setZoom: (d) => { sv.setZoom(d); persist(); },
        setBadge: (c) => api.setBadge(id, c),
        pushDnd: (v) => sv.pushDnd(v),
        pushHidden: (v) => sv.pushHidden(v),
        navigate: (u) => sv.navigate(u),
        loadUrl: (u) => sv.loadUrl(u),
        reload: () => sv.reload(),
        clearAndReload: () => sv.clearAndReload(),
        ownsWebContents: (wcId) => sv.ownsWebContents(wcId),
      };
      hosts.set(id, host);
    }
    return host;
  };
```

Then invalidate the cache wherever a view is created or torn down so a re-attached service never keeps a host bound to its old `ServiceView`:
- In `attach`, right after `views.set(def.id, sv);`, add `hosts.delete(def.id);`.
- In `detach`, right after `views.delete(id);`, add `hosts.delete(id);`.
- In `unload`, right after `views.delete(id);`, add `hosts.delete(id);`.

- [ ] **Step 2: Build + full suite**

Run: `npm run build && npm test`
Expected: build clean; all tests pass (behaviour is unchanged — the same host object shape, now cached).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "perf(loft-window): memoize hostFor per id"
```

---

## Self-Review

**Spec coverage:**
- Launcher opt-in default (new adds launcher-off) → Task 1. ✓
- Launcher `HubState`/`ServicePatch` field → Task 1. ✓
- Launcher enforcement sweep (write iff `launcher===true`, else remove) → Task 2. ✓
- Launcher immediate apply on toggle → Task 2. ✓
- Launcher settings toggle → Task 3. ✓
- Telegram navigate unblock + per-service fallback → Task 4. ✓
- `hostFor` memoization → Task 5. ✓
- Badge double-refresh dedup → **deferred** with rationale (see File Structure note); flagged, not silently dropped.
- Existing services keep launchers (migration back-fill) → preserved (Task 1 doesn't touch migrate; Task 2 sweep writes for `launcher===true`). ✓

**Placeholder scan:** one intentional adapt-to-fixture note in Task 1 Step 6 (the `hubState.test.ts` assertion must match that file's existing `buildHubState` fixture shape) — the step spells out exactly what to assert (a `launcher:true` service → `true`, a plain one → `false`). No other placeholders.

**Type consistency:** `launcher` is `boolean` on `HubService` (Task 1) and read as `svc.launcher` (Task 3); `ServicePatch.launcher?: boolean` (Task 1) written by `set({ launcher })` (Task 3) and consumed by `setServiceSetting` (Task 2). `reconcileServiceLaunchers` signature matches between `desktop.ts` (Task 2), its test (Task 2), and the index.ts call (Task 2). `navigateAction`/`NavigateAction` match between `navigate.ts`, its test, and `bridge.ts` (Task 4). `addService(def, cfg, { customUrl? })` matches its one caller (Task 1 Step 4) and all `install.test.ts` call sites (Task 1 Step 1).

## Manual Verification Checklist (Keith, after all tasks)

- Add a new service → it has no app-menu launcher; tick "Create a desktop launcher" in its settings → the launcher appears; untick → it's gone.
- Existing services still have their launchers after this ships (migration back-fill + sweep).
- Click a Telegram notification → its tab opens the right chat; Messenger click-to-navigate still works.
- No behavioural change from the `hostFor` memoization (badges, show/hide, navigate all still work).
