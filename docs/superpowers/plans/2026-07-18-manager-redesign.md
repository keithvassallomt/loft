# Manager Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the manager into a master–detail surface that fits inside the unified Loft window, reachable from a Loft "home" button on the rail.

**Architecture:** The rail is the installed-service list + switcher; the manager becomes an "add + settings" surface with a left nav (Add a service · Configure list · Settings/About/Quit) and a right detail pane. A Loft "home" button at the top of the rail opens it. Per-service settings are also reachable by right-clicking a rail icon → "Settings…". Renderer logic lives in a pure, unit-tested `managerModel.ts`; the Svelte stays thin. Main's `hub:*` IPC wiring is extracted into a testable `registerHubIpc`.

**Tech Stack:** TypeScript (strict), Electron 43, Svelte 5 runes (hub renderer, Vite-built), plain-TS rail renderer (tsc-built), Vitest (+ jsdom via per-file docblock), svelte-check.

**Spec:** `docs/superpowers/specs/2026-07-18-electron-loft-09c-manager-redesign-design.md`

## Global Constraints

- **No new dependencies.** Everything ships with what's already in `package.json`.
- **Do not reshape the `hub:*` channel names or payload shapes** — they are the renderer's contract in `src/preload/hub.ts`. Same for `rail:*`.
- **`buildHubState` stays the single source of `HubState`** (already in `src/main/hubState.ts`, already tested).
- **Follow the system theme.** The hub renderer uses CSS vars (`--bg/--card/--divider/--accent/--fg`) that flip on `prefers-color-scheme`; keep using them. The rail has its own light/dark block in `rail.css`.
- **TDD where a unit boundary exists** (pure models, preload bridges, IPC registrars): failing test first. The Svelte renderer redesign (Task 2) has no clean unit seam and is gated by `npm run check` + `npm run build` + Keith's manual smoke.
- **Test commands:** whole suite `npm test` (`vitest run`); one file `npx vitest run tests/<name>.test.ts`; renderer types `npm run check`; full build `npm run build`.
- **Frequent commits** — one per task.
- **Manual GUI smoke is Keith's**, not an agent step (a dev `electron .` launch needs his logged-in session). Agent steps end at automated tests + build.

## File Structure

**Create:**
- `src/renderer/hub/managerModel.ts` — pure nav model + selection resolver (Task 1).
- `tests/managerModel.test.ts` — its unit test (Task 1).
- `src/renderer/hub/components/AddServices.svelte` — the "Add a service" pane (Task 2).
- `src/main/hubIpc.ts` — `registerHubIpc(ipc, deps)` (Task 5).
- `tests/hubIpc.test.ts` — its unit test (Task 5).

**Modify:**
- `src/renderer/hub/App.svelte` — becomes the master–detail shell (Task 2); gains the `manager:select` listener (Task 4).
- `src/renderer/hub/components/ServiceDetail.svelte` — `onBack` → `onDone`; it's a pane, not a pushed page (Task 2).
- `src/main/railModel.ts` — add `RailState` (Task 3).
- `src/main/loftWindow.ts` — `refreshRail` emits `RailState` (Task 3).
- `src/renderer/rail/rail.ts` + `rail.css` + `index.html` — Loft "home" button + CSP `img-src loft:` (Task 3).
- `src/preload/rail.ts` — `onState` takes `RailState`; add `showManager()` (Task 3).
- `tests/railPreload.test.ts` — new state shape + `showManager` (Task 3).
- `src/preload/hub.ts` + `src/renderer/hub/lib/hub.d.ts` — add `onSelect` (Task 4).
- `tests/hubPreload.test.ts` — cover `onSelect` (Task 4).
- `src/main/index.ts` — `rail:showManager` handler (Task 3); `buildServiceMenu` "Settings…" pushes `manager:select` (Task 4); `hub:*` handlers → `registerHubIpc` (Task 5).

**Delete:**
- `src/renderer/hub/components/ServiceList.svelte` (its available-grid moves to `AddServices`; its installed-list is the rail's job now) — Task 2.
- `src/renderer/hub/components/ServiceRow.svelte` + `tests/serviceRow.test.ts` (the installed-list row is gone) — Task 2.

`AvailableTile.svelte` is **kept** (reused by `AddServices`) and `Modal.svelte`, `GlobalSettings.svelte`, `About.svelte` are reused as-is.

---

### Task 1: Pure manager model (`managerModel.ts`)

The nav's Configure list and the "a service you were viewing got removed" edge, as pure functions the Svelte can lean on — mirrors the `railModel.ts` pattern.

**Files:**
- Create: `src/renderer/hub/managerModel.ts`
- Test: `tests/managerModel.test.ts`

**Interfaces:**
- Consumes: `HubState` from `src/shared/hubTypes`.
- Produces:
  - `type ManagerSelection = 'add' | 'settings' | 'about' | { service: string }`
  - `interface ManagerNav { configure: { id: string; displayName: string }[] }`
  - `function managerNav(state: HubState): ManagerNav`
  - `function resolveSelection(sel: ManagerSelection, state: HubState): ManagerSelection`

- [ ] **Step 1: Write the failing test**

Create `tests/managerModel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { managerNav, resolveSelection } from '../src/renderer/hub/managerModel';
import type { HubState } from '../src/shared/hubTypes';

const svc = (id: string, installed: boolean) => ({
  id, displayName: id[0].toUpperCase() + id.slice(1), selfHosted: false,
  installed, running: false, visible: false, badge: 0, badgesEnabled: true,
  dnd: false, openOnStartup: false, customUrl: '',
});
const state = (over: Partial<HubState> = {}): HubState => ({
  services: [svc('whatsapp', true), svc('slack', true), svc('telegram', false)],
  globals: { trayBackend: 'auto', autostartBlocked: false }, ...over,
});

describe('managerNav', () => {
  it('lists only installed services as the Configure list, in order', () => {
    expect(managerNav(state()).configure.map((c) => c.id)).toEqual(['whatsapp', 'slack']);
  });
  it('is empty when nothing is installed', () => {
    expect(managerNav(state({ services: [svc('whatsapp', false)] })).configure).toEqual([]);
  });
});

describe('resolveSelection', () => {
  it('passes the string panes through unchanged', () => {
    for (const s of ['add', 'settings', 'about'] as const)
      expect(resolveSelection(s, state())).toBe(s);
  });
  it('keeps a service selection that is still installed', () => {
    expect(resolveSelection({ service: 'slack' }, state())).toEqual({ service: 'slack' });
  });
  it('folds a removed service back to add', () => {
    expect(resolveSelection({ service: 'slack' }, state({ services: [svc('whatsapp', true)] }))).toBe('add');
  });
  it('folds a not-installed (available) service back to add', () => {
    expect(resolveSelection({ service: 'telegram' }, state())).toBe('add');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/managerModel.test.ts`
Expected: FAIL — cannot find module `../src/renderer/hub/managerModel`.

- [ ] **Step 3: Write minimal implementation**

Create `src/renderer/hub/managerModel.ts`:

```ts
import type { HubState } from '../../shared/hubTypes';

/** What the manager's right pane is showing. `{ service }` is a per-service settings pane. */
export type ManagerSelection = 'add' | 'settings' | 'about' | { service: string };

export interface ManagerNav {
  /** Installed services, in the order HubState lists them — the Configure list. */
  configure: { id: string; displayName: string }[];
}

export function managerNav(state: HubState): ManagerNav {
  return {
    configure: state.services
      .filter((s) => s.installed)
      .map((s) => ({ id: s.id, displayName: s.displayName })),
  };
}

/**
 * Normalise a selection against current state. A `{ service }` whose service is no longer
 * installed (removed here or elsewhere) folds back to 'add', so the detail pane never
 * renders a service that isn't there. Every other selection passes through.
 */
export function resolveSelection(sel: ManagerSelection, state: HubState): ManagerSelection {
  if (typeof sel === 'object') {
    const ok = state.services.some((s) => s.id === sel.service && s.installed);
    return ok ? sel : 'add';
  }
  return sel;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/managerModel.test.ts`
Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/hub/managerModel.ts tests/managerModel.test.ts
git commit -m "feat(hub): pure manager nav model + selection resolver"
```

---

### Task 2: Master–detail manager renderer

Rewrite `App.svelte` into the master–detail shell, add the `AddServices` pane, adapt `ServiceDetail` into a pane, and delete the old page-router pieces. No unit seam — gated by `npm run check` + `npm run build`.

**Files:**
- Create: `src/renderer/hub/components/AddServices.svelte`
- Modify: `src/renderer/hub/App.svelte`, `src/renderer/hub/components/ServiceDetail.svelte`
- Delete: `src/renderer/hub/components/ServiceList.svelte`, `src/renderer/hub/components/ServiceRow.svelte`, `tests/serviceRow.test.ts`

**Interfaces:**
- Consumes: `managerNav`, `resolveSelection`, `ManagerSelection` (Task 1); `HubService`/`HubState` (`src/shared/hubTypes`); `AvailableTile`, `GlobalSettings`, `About` (existing).
- Produces: `AddServices` (prop `state: HubState`); `ServiceDetail` now takes `onDone: () => void` in place of `onBack`.

- [ ] **Step 1: Create `AddServices.svelte`**

Create `src/renderer/hub/components/AddServices.svelte`:

```svelte
<script lang="ts">
  import type { HubState } from '../../../shared/hubTypes';
  import AvailableTile from './AvailableTile.svelte';
  let { state }: { state: HubState } = $props();
  const available = $derived(state.services.filter((s) => !s.installed));
</script>

<h2>Add a service</h2>
{#if available.length > 0}
  <p class="lead">Pick a messaging service to add to Loft.</p>
  <div class="grid">
    {#each available as svc (svc.id)}<AvailableTile {svc} />{/each}
  </div>
{:else}
  <section class="empty">
    <img class="logo" src="loft://icon/loft" alt="" />
    <p>You've added every service Loft supports.</p>
  </section>
{/if}

<style>
  h2 { margin: 8px 0 6px; }
  .lead { margin: 0 0 16px; opacity: 0.7; }
  /* auto-fill so the gallery fills the wide pane instead of a lonely 2-up column. */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
  .empty { text-align: center; padding: 40px 0; opacity: 0.7; }
  .empty .logo { width: 64px; height: 64px; margin-bottom: 12px; }
</style>
```

- [ ] **Step 2: Adapt `ServiceDetail.svelte` — `onBack` → `onDone`**

In `src/renderer/hub/components/ServiceDetail.svelte`, change the prop declaration (line ~10):

```ts
  let { state: hubState, id, onDone }: { state: HubState; id: string; onDone: () => void } = $props();
```

and the call inside `confirmRemove` (line ~25):

```ts
  function confirmRemove() {
    showRemove = false;
    window.loftHub.removeService(id, deleteData);
    onDone();
  }
```

(Nothing else in the file references `onBack`.)

- [ ] **Step 3: Rewrite `App.svelte` as the master–detail shell**

Replace the entire contents of `src/renderer/hub/App.svelte` with:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { hubState, initStore } from './lib/store';
  import { managerNav, resolveSelection, type ManagerSelection } from './managerModel';
  import AddServices from './components/AddServices.svelte';
  import ServiceDetail from './components/ServiceDetail.svelte';
  import GlobalSettings from './components/GlobalSettings.svelte';
  import About from './components/About.svelte';

  let selection = $state<ManagerSelection>('add');
  onMount(initStore);

  // A service can vanish while its detail is open (removed here or elsewhere); fold an
  // orphaned selection back to Add so the pane never renders a missing service.
  const view = $derived($hubState ? resolveSelection(selection, $hubState) : 'add');
  const nav = $derived($hubState ? managerNav($hubState) : { configure: [] });
  const isService = (s: ManagerSelection): s is { service: string } => typeof s === 'object';
</script>

{#if $hubState}
  <div class="shell">
    <nav class="side" aria-label="Manager">
      <button class="n" class:on={view === 'add'} onclick={() => (selection = 'add')}>Add a service</button>

      {#if nav.configure.length > 0}
        <p class="sec">Configure</p>
        {#each nav.configure as c (c.id)}
          <button class="n" class:on={isService(view) && view.service === c.id}
                  onclick={() => (selection = { service: c.id })}>{c.displayName}</button>
        {/each}
      {/if}

      <div class="foot">
        <button class="n" class:on={view === 'settings'} onclick={() => (selection = 'settings')}>Settings</button>
        <button class="n" class:on={view === 'about'} onclick={() => (selection = 'about')}>About</button>
        <button class="n" onclick={() => window.loftHub.quit()}>Quit Loft</button>
      </div>
    </nav>

    <section class="pane">
      {#if view === 'add'}
        <AddServices state={$hubState} />
      {:else if view === 'settings'}
        <GlobalSettings state={$hubState} />
      {:else if view === 'about'}
        <About version={__LOFT_VERSION__} />
      {:else if isService(view)}
        <ServiceDetail state={$hubState} id={view.service} onDone={() => (selection = 'add')} />
      {/if}
    </section>
  </div>
{/if}

<style>
  .shell { flex: 1 1 auto; display: flex; min-height: 0; }
  .side {
    flex: 0 0 208px; display: flex; flex-direction: column; gap: 2px;
    padding: 12px 10px; border-right: 1px solid var(--divider); overflow-y: auto;
  }
  .side .n {
    text-align: left; border: 0; background: transparent; color: var(--fg);
    font: inherit; padding: 8px 10px; border-radius: 8px; cursor: pointer;
  }
  .side .n:hover { background: var(--card); }
  .side .n.on { background: var(--accent); color: #fff; }
  .side .sec {
    font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.05em;
    opacity: 0.5; margin: 12px 10px 2px;
  }
  .side .foot { margin-top: auto; }
  .pane { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; padding: 18px 22px; }
</style>
```

- [ ] **Step 4: Delete the retired components + their test**

```bash
git rm src/renderer/hub/components/ServiceList.svelte \
       src/renderer/hub/components/ServiceRow.svelte \
       tests/serviceRow.test.ts
```

- [ ] **Step 5: Type-check the renderer**

Run: `npm run check`
Expected: PASS — no svelte-check errors. (If it flags an unused import or the `{:else if isService(view)}` narrowing, fix inline; the guard is there precisely so `view.service` narrows.)

- [ ] **Step 6: Build and run the whole test suite**

Run: `npm run build && npm test`
Expected: build succeeds; all tests pass (the deleted `serviceRow.test.ts` is gone, `managerModel.test.ts` passes).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(hub): master-detail manager (add + per-service settings + about)"
```

> **Manual (Keith):** `npm run build`, run the app, open the manager — Add a service fills the pane; the Configure list shows installed services and each opens its settings; Settings/About/Quit work from the footer; no duplicate header; light + dark both read correctly.

---

### Task 3: Rail "home" button — reach the manager

A Loft-branded button at the top of the rail that opens the manager and shows as current when the manager is the active view. Requires widening `rail:state` to carry `managerActive`.

**Files:**
- Modify: `src/main/railModel.ts`, `src/main/loftWindow.ts`, `src/renderer/rail/rail.ts`, `src/renderer/rail/rail.css`, `src/renderer/rail/index.html`, `src/preload/rail.ts`, `src/main/index.ts`
- Test: `tests/railPreload.test.ts`

**Interfaces:**
- Consumes: `RailItem` (existing).
- Produces: `interface RailState { items: RailItem[]; managerActive: boolean }` (`railModel.ts`); `RailBridge.onState(cb: (state: RailState) => void)` and `RailBridge.showManager(): void` (`preload/rail.ts`); `rail:showManager` IPC channel.

- [ ] **Step 1: Add `RailState` to `railModel.ts`**

Append to `src/main/railModel.ts` (after the `RailItem` interface):

```ts
/** The rail renderer's full state: the service items plus whether the manager tab is the
 *  active selection, so the rail's Loft "home" button can render as current. */
export interface RailState {
  items: RailItem[];
  managerActive: boolean;
}
```

- [ ] **Step 2: Update the preload test first (new shape + showManager)**

In `tests/railPreload.test.ts`, replace the "delivers state" test and add a showManager test:

```ts
  it('delivers rail state (items + managerActive) to the subscriber', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    const cb = vi.fn();
    b.onState(cb);
    const state = { items: [{ id: 'slack' }], managerActive: true };
    ipc.listeners.get('rail:state')!(null, state);
    expect(cb).toHaveBeenCalledWith(state);
  });

  it('showManager asks main to open the manager', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    b.showManager();
    expect(ipc.sent).toEqual([['rail:showManager', undefined]]);
  });
```

Run: `npx vitest run tests/railPreload.test.ts`
Expected: FAIL — `b.showManager` is not a function (and the state test may still pass against the old array shape until the preload changes).

- [ ] **Step 3: Update the rail preload**

Replace `src/preload/rail.ts` with:

```ts
import { contextBridge, ipcRenderer, type IpcRenderer } from 'electron';
import type { RailState } from '../main/railModel';

export interface RailBridge {
  /** Subscribe to rail state. Returns an unsubscribe — call it on teardown. */
  onState(cb: (state: RailState) => void): () => void;
  select(id: string): void;
  /** Ask main to pop the native per-service context menu for this item. */
  menu(id: string): void;
  /** Open the manager view (the rail's Loft "home" button). */
  showManager(): void;
}

/** Pure factory so the bridge is testable against a fake ipc (mirrors preload/hub.ts). */
export function buildRailBridge(ipc: IpcRenderer): RailBridge {
  return {
    onState(cb) {
      const h = (_e: unknown, state: RailState): void => cb(state);
      ipc.on('rail:state', h);
      return () => ipc.removeListener('rail:state', h);
    },
    select: (id) => ipc.send('rail:select', id),
    menu: (id) => ipc.send('rail:menu', id),
    showManager: () => ipc.send('rail:showManager'),
  };
}

contextBridge.exposeInMainWorld('loftRail', buildRailBridge(ipcRenderer));
```

Run: `npx vitest run tests/railPreload.test.ts`
Expected: PASS.

- [ ] **Step 4: Emit `RailState` from `loftWindow`**

In `src/main/loftWindow.ts`, change `refreshRail` (currently `const refreshRail = (): void => safeSend(rail, 'rail:state', model());`) to:

```ts
  const refreshRail = (): void =>
    safeSend(rail, 'rail:state', { items: model(), managerActive: active === undefined });
```

- [ ] **Step 5: Render the home button in `rail.ts`**

Replace `src/renderer/rail/rail.ts` with:

```ts
// See the original note below: an inline `import()` type query keeps tsc from emitting
// module boilerplate that would throw under `<script type="module">`.
type RailItem = import('../../main/railModel').RailItem;
type RailState = import('../../main/railModel').RailState;

const root = document.getElementById('rail')!;

const initials = (name: string): string =>
  name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

function serviceButton(item: RailItem): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'item';
  b.classList.toggle('active', item.active);
  b.classList.toggle('sleeping', item.sleeping);
  b.title = item.displayName;
  b.setAttribute('aria-label', item.displayName);
  if (item.active) b.setAttribute('aria-current', 'page');

  const g = document.createElement('span');
  g.className = 'glyph';
  g.textContent = initials(item.displayName);
  b.append(g);

  if (item.badge > 0) {
    const n = document.createElement('span');
    n.className = 'badge';
    n.textContent = item.badge > 99 ? '99+' : String(item.badge);
    b.append(n);
  }
  for (const [on, cls, glyph] of [[item.detached, 'detached', '⧉'], [item.dnd, 'dnd', '🌙']] as const) {
    if (!on) continue;
    const m = document.createElement('span');
    m.className = `mark ${cls}`;
    m.setAttribute('aria-hidden', 'true');
    m.textContent = glyph;
    b.append(m);
  }

  b.addEventListener('click', () => window.loftRail.select(item.id));
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); window.loftRail.menu(item.id); });
  return b;
}

function homeButton(active: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'home';
  b.classList.toggle('active', active);
  b.title = 'Loft';
  b.setAttribute('aria-label', 'Loft manager');
  if (active) b.setAttribute('aria-current', 'page');
  const img = document.createElement('img');
  img.src = 'loft://icon/loft';
  img.alt = '';
  b.append(img);
  b.addEventListener('click', () => window.loftRail.showManager());
  return b;
}

function render(state: RailState): void {
  const divider = document.createElement('div');
  divider.className = 'divider';
  divider.setAttribute('aria-hidden', 'true');
  root.replaceChildren(
    homeButton(state.managerActive),
    divider,
    ...state.items.map(serviceButton),
  );
}

window.loftRail.onState(render);
```

- [ ] **Step 6: Style the home button + divider**

In `src/renderer/rail/rail.css`, add (after the `.item` rules):

```css
.home {
  flex: none; width: 34px; height: 34px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 8px;
  background: transparent; cursor: pointer;
}
.home img { width: 26px; height: 26px; border-radius: 6px; }
.home:hover { background: #d1d1d6; }
.home.active { box-shadow: inset 3px 0 0 #0071e3; background: #d8d8dd; }
.divider { flex: none; width: 24px; height: 1px; background: #c7c7cc; margin: 1px 0; }
```

and in the `@media (prefers-color-scheme: dark)` block, add:

```css
  .home:hover { background: #4a4a4c; }
  .home.active { box-shadow: inset 3px 0 0 #0a84ff; background: #48484a; }
  .divider { background: #545456; }
```

- [ ] **Step 7: Allow the Loft icon through the rail CSP**

In `src/renderer/rail/index.html`, change the CSP meta to add `img-src loft:`:

```html
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; img-src loft:" />
```

- [ ] **Step 8: Handle `rail:showManager` in main**

In `src/main/index.ts`, next to the `rail:select`/`rail:menu` handlers (~line 518), add:

```ts
  ipcMain.on('rail:showManager', () => loft?.showManager());
```

- [ ] **Step 9: Build + full suite**

Run: `npm run build && npm test`
Expected: build succeeds; all tests pass.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(rail): Loft home button opens the manager"
```

> **Manual (Keith):** the Loft button sits at the top of the rail; clicking it shows the manager and the button highlights; selecting a service un-highlights it; the icon renders (CSP allows it).

---

### Task 4: Right-click a rail icon → "Settings…" opens that service

The second reach path: the native per-service menu's "Settings…" opens the manager *on that service*. Needs a `manager:select` push and a renderer listener.

**Files:**
- Modify: `src/preload/hub.ts`, `src/renderer/hub/lib/hub.d.ts`, `src/main/index.ts`, `src/renderer/hub/App.svelte`
- Test: `tests/hubPreload.test.ts`

**Interfaces:**
- Consumes: `LoftWindow.sendManager` (existing); `ManagerSelection` (Task 1).
- Produces: `LoftHub.onSelect(cb: (id: string) => void): () => void`; `manager:select` IPC channel.

- [ ] **Step 1: Add the failing preload test**

In `tests/hubPreload.test.ts`, add:

```ts
  it('onSelect subscribes to manager:select and returns an unsubscribe', () => {
    const ipc = mockIpc();
    const cb = vi.fn();
    const off = buildBridge(ipc as never).onSelect(cb);
    expect(ipc.on).toHaveBeenCalledWith('manager:select', expect.any(Function));
    const handler = ipc.on.mock.calls.find((c) => c[0] === 'manager:select')![1] as (e: unknown, id: string) => void;
    handler({}, 'slack');
    expect(cb).toHaveBeenCalledWith('slack');
    off();
    expect(ipc.removeListener).toHaveBeenCalledWith('manager:select', expect.any(Function));
  });
```

Run: `npx vitest run tests/hubPreload.test.ts`
Expected: FAIL — `onSelect` is not a function.

- [ ] **Step 2: Add `onSelect` to the hub preload**

In `src/preload/hub.ts`, add to the `LoftHub` interface (after `quit()`):

```ts
  /** Main asks the manager to open a specific service's settings (rail right-click → Settings…). */
  onSelect(cb: (id: string) => void): () => void;
```

and to the object returned by `buildBridge` (after `quit`):

```ts
    onSelect: (cb) => {
      const handler = (_e: unknown, id: string) => cb(id);
      ipc.on('manager:select', handler);
      return () => ipc.removeListener('manager:select', handler);
    },
```

Run: `npx vitest run tests/hubPreload.test.ts`
Expected: PASS.

- [ ] **Step 3: Mirror the type in `hub.d.ts`**

In `src/renderer/hub/lib/hub.d.ts`, add to the `loftHub` interface (after `quit(): void;`):

```ts
      onSelect(cb: (id: string) => void): () => void;
```

- [ ] **Step 4: Push `manager:select` from the "Settings…" menu item**

In `src/main/index.ts` `buildServiceMenu`, change the Settings item (~line 395) to also select the service in the manager:

```ts
    { label: 'Settings…', click: () => { loft?.showManager(); loft?.open(); loft?.sendManager('manager:select', id); } },
```

- [ ] **Step 5: Listen for `manager:select` in `App.svelte`**

In `src/renderer/hub/App.svelte`, change `onMount(initStore);` to:

```ts
  onMount(() => {
    initStore();
    // Right-click a rail icon → "Settings…" asks the manager to open that service.
    window.loftHub.onSelect((id) => { selection = { service: id }; });
  });
```

- [ ] **Step 6: Type-check, build, full suite**

Run: `npm run check && npm run build && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: rail right-click Settings opens the manager on that service"
```

> **Manual (Keith):** right-click a rail icon → "Settings…" opens the manager with that service's settings pane selected; works whether the service is loaded or sleeping.

---

### Task 5: Extract `registerHubIpc` (test seam)

Move the `hub:*` handler wiring out of `index.ts` into a testable `registerHubIpc`. Behaviour is unchanged; this restores the coverage lost when `hubWindow.ts` was deleted and shrinks `index.ts`.

**Files:**
- Create: `src/main/hubIpc.ts`
- Test: `tests/hubIpc.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `HubState`, `ServicePatch`, `GlobalPatch`, `RecoverOpts` (`src/shared/hubTypes`).
- Produces: `interface HubIpcDeps { ... }` and `function registerHubIpc(ipc: Pick<IpcMain,'handle'|'on'>, deps: HubIpcDeps): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/hubIpc.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { registerHubIpc, type HubIpcDeps } from '../src/main/hubIpc';

function fakeIpc() {
  const handlers = new Map<string, (...a: any[]) => any>();
  return {
    handlers,
    handle: (ch: string, cb: (...a: any[]) => any) => handlers.set(ch, cb),
    on: (ch: string, cb: (...a: any[]) => any) => handlers.set(ch, cb),
    fire: (ch: string, ...args: any[]) => handlers.get(ch)!({}, ...args),
  };
}

function deps(over: Partial<HubIpcDeps> = {}): HubIpcDeps {
  return {
    getState: vi.fn().mockReturnValue({ services: [], globals: { trayBackend: 'auto', autostartBlocked: false } }),
    openService: vi.fn(),
    addService: vi.fn(),
    removeService: vi.fn(),
    setServiceSetting: vi.fn(),
    setGlobal: vi.fn(),
    recoverService: vi.fn(),
    quit: vi.fn(),
    ...over,
  };
}

describe('registerHubIpc', () => {
  it('hub:getState returns deps.getState()', () => {
    const d = deps(); const ipc = fakeIpc();
    registerHubIpc(ipc as never, d);
    expect(ipc.fire('hub:getState')).toEqual({ services: [], globals: { trayBackend: 'auto', autostartBlocked: false } });
    expect(d.getState).toHaveBeenCalled();
  });

  it('routes each action channel to its dep with the unwrapped payload', () => {
    const d = deps(); const ipc = fakeIpc();
    registerHubIpc(ipc as never, d);
    ipc.fire('hub:openService', 'slack');
    ipc.fire('hub:addService', { id: 'talk', customUrl: 'x' });
    ipc.fire('hub:removeService', { id: 'slack', deleteData: true });
    ipc.fire('hub:setServiceSetting', { id: 'slack', patch: { dnd: true } });
    ipc.fire('hub:setGlobal', { trayBackend: 'sni' });
    ipc.fire('hub:recoverService', { id: 'slack', opts: { clearCaches: true } });
    ipc.fire('hub:quit');
    expect(d.openService).toHaveBeenCalledWith('slack');
    expect(d.addService).toHaveBeenCalledWith('talk', 'x');
    expect(d.removeService).toHaveBeenCalledWith('slack', true);
    expect(d.setServiceSetting).toHaveBeenCalledWith('slack', { dnd: true });
    expect(d.setGlobal).toHaveBeenCalledWith({ trayBackend: 'sni' });
    expect(d.recoverService).toHaveBeenCalledWith('slack', { clearCaches: true });
    expect(d.quit).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hubIpc.test.ts`
Expected: FAIL — cannot find module `../src/main/hubIpc`.

- [ ] **Step 3: Create `hubIpc.ts`**

Create `src/main/hubIpc.ts`:

```ts
import type { IpcMain } from 'electron';
import type { HubState, ServicePatch, GlobalPatch, RecoverOpts } from '../shared/hubTypes';

/** What the hub:* handlers need. Each value is the fully-formed operation, so this module
 *  stays a thin registrar and remains importable under vitest (index.ts is not). Channel
 *  names + payload shapes are the renderer's contract (src/preload/hub.ts) — keep in step. */
export interface HubIpcDeps {
  getState(): HubState;
  openService(id: string): void;
  addService(id: string, customUrl: string | undefined): void;
  removeService(id: string, deleteData: boolean): void;
  setServiceSetting(id: string, patch: ServicePatch): void;
  setGlobal(patch: GlobalPatch): void;
  recoverService(id: string, opts: RecoverOpts): void;
  quit(): void;
}

export function registerHubIpc(ipc: Pick<IpcMain, 'handle' | 'on'>, deps: HubIpcDeps): void {
  ipc.handle('hub:getState', () => deps.getState());
  ipc.on('hub:openService', (_e, id: string) => deps.openService(id));
  ipc.on('hub:addService', (_e, m: { id: string; customUrl?: string }) => deps.addService(m.id, m.customUrl));
  ipc.on('hub:removeService', (_e, m: { id: string; deleteData: boolean }) => deps.removeService(m.id, m.deleteData));
  ipc.on('hub:setServiceSetting', (_e, m: { id: string; patch: ServicePatch }) => deps.setServiceSetting(m.id, m.patch));
  ipc.on('hub:setGlobal', (_e, patch: GlobalPatch) => deps.setGlobal(patch));
  ipc.on('hub:recoverService', (_e, m: { id: string; opts: RecoverOpts }) => deps.recoverService(m.id, m.opts));
  ipc.on('hub:quit', () => deps.quit());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hubIpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into `index.ts`**

Add the import near the other `./` imports in `src/main/index.ts`:

```ts
import { registerHubIpc } from './hubIpc';
```

Then replace the whole `hub:*` block (the comment at ~line 521 plus every `ipcMain.handle('hub:getState'...)` / `ipcMain.on('hub:...')` handler down through `ipcMain.on('hub:quit', ...)` at ~line 584) with a single registration:

```ts
  // --- hub:* — the manager view (src/renderer/hub). Wiring lives in hubIpc.ts so it's
  // unit-testable; the deps below are index.ts's own operations, unchanged. hub:openService
  // does exactly what rail:select does (showService(getService(id))) — the old version
  // re-emitted rail:select to avoid drift; calling the same helper keeps them identical.
  registerHubIpc(ipcMain, {
    getState: hubState,
    openService: (id) => { const d = getService(id); if (d) showService(d); },
    addService: (id, customUrl) => {
      const d = getService(id); if (!d) return;
      addService(d, config, { execPath: process.execPath, iconSourceDir, customUrl });
      saveConfig(configPath(), config);
      loft?.refreshRail();
      notifyHub();
    },
    removeService: (id, deleteData) => {
      const d = getService(id); if (!d) return;
      quitService(id);
      removeService(d, config, deleteData);
      saveConfig(configPath(), config);
      reconcileAutostart();
      loft?.refreshRail();
      notifyHub();
    },
    setServiceSetting: (id, patch) => { setServiceSetting(id, patch); notifyHub(); },
    setGlobal: (patch) => {
      if (patch.trayBackend !== undefined) { config.trayBackend = patch.trayBackend; saveConfig(configPath(), config); }
      notifyHub();
    },
    recoverService: (id, opts) => {
      const host = hostOf(id);
      if (!opts.clearCaches) { host?.reload(); return; }
      if (host) { void host.clearAndReload(); return; }
      void clearServiceCaches(session.fromPartition(`persist:${id}`));
    },
    quit: () => { quitting = true; app.quit(); },
  });
```

> Inside those arrows, `addService`/`removeService`/`setServiceSetting` resolve to index.ts's imported/module functions (lexical scope) — the object's own property names are *not* in scope, so there's no self-reference. Keep the `hub:openService` comment: behaviour is identical to the old `ipcMain.emit('rail:select', …)`.

- [ ] **Step 6: Build (and prune now-unused imports)**

Run: `npm run build`
Expected: succeeds. If tsc reports `ServicePatch` / `GlobalPatch` / `RecoverOpts` as unused in `index.ts` (they were only used to type the inline handler params, which moved to `hubIpc.ts`), delete them from index.ts's import from `../shared/hubTypes` and re-run. Keep any that are still referenced elsewhere in index.ts.

- [ ] **Step 7: Full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(main): extract registerHubIpc as a test seam"
```

> **Manual (Keith):** unchanged behaviour — add/remove a service, toggle a per-service setting, Clear cache & reload, and Quit from the manager all still work.

---

## Self-Review

**Spec coverage:**
- Rail Loft "home" button + `active` when manager shown → Task 3. ✓
- Manager master–detail (nav + pane), header/back/Installed-list removed, Quit in footer → Task 2. ✓
- `Configure` list = installed services (settings-nav, not a switcher) → Tasks 1 (model) + 2 (render). ✓
- Add pane as the star; `ServiceDetail`/`GlobalSettings`/`About` as panes → Task 2. ✓
- Per-service settings reachable via `Configure` **and** right-click → "Settings…" → Tasks 2 + 4. ✓
- `manager:select` push + renderer listener → Task 4. ✓
- `rail:state` widened to `{ items, managerActive }` → Task 3. ✓
- `registerHubIpc` test seam (buildHubState already extracted/tested) → Task 5. ✓
- Removed-service edge folds to Add → Task 1 (`resolveSelection`), used in Task 2. ✓
- Theme (CSS vars / rail dark block) preserved → Tasks 2 + 3. ✓
- No `HubState` shape change → confirmed; only `manager:select` is new on the wire. ✓

**Placeholder scan:** none — every code step carries full content; no "TBD"/"add error handling"/"similar to Task N".

**Type consistency:** `ManagerSelection`/`managerNav`/`resolveSelection` (Task 1) are used verbatim in Task 2; `RailState` (Task 3 railModel) matches the preload import and the renderer's inline type query; `RailBridge.showManager`/`onState(RailState)` match the test and renderer; `LoftHub.onSelect` matches preload, `hub.d.ts`, and App; `HubIpcDeps` names match the `registerHubIpc` handlers and the index.ts wiring. `ServiceDetail` prop is `onDone` in both the component and App's call site.

## Manual Verification Checklist (Keith, after all tasks)

- Reach the manager via the rail's Loft home button; it highlights while shown, un-highlights when a service is selected.
- Right-click a rail icon → "Settings…" opens the manager on that service (loaded or sleeping).
- Add a service from the Add pane (incl. a self-hosted one via the URL modal); it appears in the rail.
- Toggle each per-service setting (Server URL, Open on startup + inline autostart warning, badge, DND); changes persist.
- Clear cache & reload; Remove a service (with/without delete-data) returns you to Add.
- Settings (tray backend) and About render; Quit Loft from the footer exits.
- Light and dark both read correctly; no duplicate "Loft" header over the manager.
