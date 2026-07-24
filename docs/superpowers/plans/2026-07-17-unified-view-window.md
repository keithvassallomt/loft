# Unified View — The Loft Window (09b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Loft window that is both the manager and a container: a full-height rail of services down the left, the active service filling the rest. The first plan in this feature with a user-visible result.

**Architecture:** Spec `docs/superpowers/specs/2026-07-17-electron-loft-09-unified-view-design.md`. Plan 09a split `ServiceView` (host-agnostic, mountable into any window) out of `serviceWindow.ts` and defined `ServiceHost` (the where-agnostic contract). This plan adds the **second implementer**: `loftWindow.ts` hosts N `ServiceView`s and satisfies `ServiceHost` per attached service, so tray/D-Bus/notifications keep working unchanged. Detached services keep their own `serviceWindow` — chosen per service by config, not a global mode.

**Tech Stack:** TypeScript, Electron 43.1.0, Svelte 5 (runes) + Vite, Vitest, `dbus-next`.

## Global Constraints

- **Branch:** `electron-rewrite`. Do NOT merge to `main`.
- **Baseline:** HEAD `de8ef21`, 277 tests passing, `tsc` clean, `svelte-check` clean. **No existing test may be deleted or weakened.**
- **Calls working is why this app exists.** The `window.open` handler in `serviceView.ts` is load-bearing: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `additionalArguments: []` on the child. A popup inherits its opener's prefs and a non-sandboxed WebRTC renderer SIGSEGVs (exit 139) on some GPU stacks. **Do not touch it.** It must keep working when the opener is a view inside the Loft window.
- The service view keeps `sandbox: true` + `contextIsolation: false`.
- `TITLEBAR_HEIGHT = 40`, `RAIL_WIDTH = 52`, zoom 0.3–3.0 in 0.1 steps.
- **`ServiceHost` must stay window-free** — no BrowserWindow, titlebar, bounds, or `persist()`. This plan makes the Loft window the second implementer, which is what finally enforces it.
- Domain is `chat.loft` (never `com.loft`).
- **Always check latest versions online** before adding or referencing any dependency (CLAUDE.md). This plan adds **no** new dependencies.
- `ELECTRON_RUN_AS_NODE=1` is exported by VS Code's terminal and makes `electron .` behave like plain Node. Always `env -u ELECTRON_RUN_AS_NODE`. Electron is **not on PATH** — use `./node_modules/.bin/electron`.
- Iterate with `npm run build`; never `npm run dist`. Tests: `npm test`. Renderer types: `npm run check`.
- Test files live in `tests/<name>.test.ts` and import from `../src/main/...`.
- **Never touch `~/.config/loft/` or `~/.local/share/applications/`.** Keith's real config lives in the Flatpak sandbox (`~/.var/app/chat.loft.Loft/config/loft/config.json`) — leave that alone too.
- Commit after every task. Conventional-commit prefixes, matching the log.

## Deliberately NOT in this plan (→ 09c)

- **Drag a rail icon out to detach.** Needs a transparent overlay view to own the gesture (once the pointer leaves the rail's 52px it is over a third-party page), and Wayland won't honour the drop position. Detach in 09b is the settings checkbox + `detached` in config — which is the whole escape hatch for the alt-tab regression, just without the gesture.
- **The rich GNOME tray rows** (spec §6c). The tray keeps today's submenu shape here, fed correctly. The extension is GJS and needs a session restart to test.
- **Launcher enforcement.** `launcher` is recorded (09a) but the self-heal loop at `index.ts` still writes one per configured service. 09c adds the gate + sweep.
- **The navigate strategy table** (spec §9). Replacing the `serviceId !== 'messenger'` guard in `src/preload/notify/bridge.ts` with a per-service table, and unblocking Telegram's already-arriving `href`, is independent of the window — 09c. What 09b *does* owe §9 is the **routing**: a notification click must resolve the host, load a sleeping service, select its tab, and then call `navigate`. That is Task 7 Step 5.
- **Re-attach from a detached window's titlebar menu** (spec §7). In 09b the rail lists detached services (spec §3), so the rail's *Open in its own window* checkbox is already a complete round trip. The titlebar-icon menu matters once drag exists.

## File Structure

| File | Responsibility |
|---|---|
| `src/main/serviceHost.ts` *(modify)* | Gains `def` + `isVisible()`. Still window-free. |
| `src/main/railModel.ts` *(new)* | **Pure.** Config + live state → the rail's ordered items. No Electron. |
| `src/main/loftWindow.ts` *(new)* | The unified host: window + rail view + titlebar view + manager view + N `ServiceView`s. Satisfies `ServiceHost` per attached service. |
| `src/preload/rail.ts` *(new)* | `contextBridge` for the rail renderer. Mirrors `preload/titlebar.ts`. |
| `src/renderer/rail/` *(new)* | Svelte rail: icons, badges, sleeping/detached marks, context menu trigger. |
| `src/main/index.ts` *(modify)* | `windows` map → host registry; startup placement; CLI/D-Bus/tray/title routing. |
| `src/main/hubWindow.ts` *(delete)* | The hub becomes a view inside `loftWindow`. |
| `src/main/notifications/gate.ts` *(modify)* | `focused && visible && isActive`. |

---

### Task 1: `ServiceHost` gains `def` and `isVisible()`

Spec §5a. 09a's final review flagged this as the **must-do-before-the-second-implementer** item: `windows.get(id)?.window.isVisible()` returns `false` (it does not throw) for a service that has no `ServiceWindow`. Once a service can live in the rail, every one of those sites silently reports an open service as hidden — greying it out in the tray and hub while it is visibly on screen. Fixing it *after* adding the rail means hunting a silent bug; fixing it now is mechanical.

**Files:**
- Modify: `src/main/serviceHost.ts`
- Modify: `src/main/serviceWindow.ts` (implement the two new members)
- Modify: `src/main/index.ts` (route the `.window.isVisible()` and `.def` sites through `hostOf`)
- Test: none new — `tsc` is the gate, as in 09a's Task 8. `ServiceWindow` must keep satisfying `ServiceHost`.

**Interfaces:**
- Consumes: `ServiceHost`, `hostOf(id): ServiceHost | undefined`, `ServiceWindow` (all from 09a).
- Produces: `ServiceHost.def: ServiceDef` (readonly) and `ServiceHost.isVisible(): boolean`. Tasks 5–8 depend on both.

- [ ] **Step 1: Add the two members to the interface**

In `src/main/serviceHost.ts`, add to the top of the interface body (before `show()`), and add the `ServiceDef` import:

```ts
import type { ServiceDef } from './registry';
```

```ts
  /** Which service this host is showing. A rail entry has an id and a display name
   *  just as a window does — this is not window-shaped. */
  readonly def: ServiceDef;
  /** Is this service actually on screen? For a shared host that means the window is
   *  shown AND this service is the selected tab — an unselected tab is not visible.
   *  Callers must never reach for `.window.isVisible()`: that returns false (it does
   *  not throw) for a service with no window of its own, silently reporting an open
   *  service as hidden. */
  isVisible(): boolean;
```

- [ ] **Step 2: Implement them on `ServiceWindow`**

`ServiceWindow` already carries `def`, so `extends ServiceHost` satisfies it for free. Add `isVisible` to the `api` object literal in `src/main/serviceWindow.ts`, next to `show`/`hide`:

```ts
    isVisible: () => window.isVisible(),
```

- [ ] **Step 3: Route index.ts's sites through `hostOf`**

In `src/main/index.ts`, replace each of these. Match on code text, not line numbers.

```ts
  tray?.setVisible(def.id, sw.window.isVisible());
  notifications?.setVisible(def.id, sw.window.isVisible());
```
→
```ts
  tray?.setVisible(def.id, sw.isVisible());
  notifications?.setVisible(def.id, sw.isVisible());
```

```ts
  if (sw && sw.window.isVisible()) { sw.hide(); hideExternal(sw.def.displayName); return; }
```
→
```ts
  if (sw && sw.isVisible()) { sw.hide(); hideExternal(sw.def.displayName); return; }
```

```ts
          visible: windows.get(d.id)?.window.isVisible() ?? false,
```
→
```ts
          visible: hostOf(d.id)?.isVisible() ?? false,
```

```ts
        tray.setVisible(id, sw.window.isVisible());
```
→
```ts
        tray.setVisible(id, sw.isVisible());
```

```ts
        notifications.setVisible(id, sw.window.isVisible());
```
→
```ts
        notifications.setVisible(id, sw.isVisible());
```

```ts
        visible: (id) => windows.get(id)?.window.isVisible() ?? false,
```
→
```ts
        visible: (id) => hostOf(id)?.isVisible() ?? false,
```

And in the D-Bus `hide` and `getStatus` handlers, replace `sw.window.isVisible()` with `sw.isVisible()`, and change their `const sw = windows.get(id)` to `const sw = hostOf(id)` — with `def` on `ServiceHost` they no longer need the window.

- [ ] **Step 4: Verify no `.window.isVisible()` survives**

Run: `grep -n "window.isVisible()" src/main/index.ts`
Expected: **no output.** Every visibility question now goes through `ServiceHost`.

Then run: `grep -n "windows.get(\|windows.has(" src/main/index.ts`
Expected: only `hostOf`'s own definition, `openService`'s create path, `toggleService`, and `quitService` (which need `windows.delete` / `.window.destroy()` / `.persist()`). If any other site remains, it is window-free and should have moved — report it.

- [ ] **Step 5: Run tests and build**

Run: `npm test && npm run build`
Expected: 277 tests PASS; `tsc` no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/serviceHost.ts src/main/serviceWindow.ts src/main/index.ts
git commit -m "refactor: add def + isVisible() to ServiceHost

Both are the rail's business as much as a window's, and .window.isVisible()
returns FALSE rather than throwing for a service with no window — so once a
service can live in the rail, every one of those sites would silently report
an open service as hidden. Mechanical to fix now; a silent bug hunt later."
```

---

### Task 2: The notification gate learns `isActive`

Spec §6d — the bug this feature would otherwise ship with, and the one whose failure mode is **silence**. Today `visible` means "its window is on screen", which is why `focused && visible` is correct. In the Loft window, *every* attached service is "visible" whenever Loft is focused — so every tab you are not looking at would go quiet, and its web app would suppress its own `Notification` calls too.

**Files:**
- Modify: `src/main/notifications/gate.ts`
- Modify: `src/main/notifications/index.ts`
- Test: `tests/notificationGate.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `NotifyDecisionInput` gains `active: boolean`; `NotificationGate.setActive(id: string, v: boolean): void`; `Notifications.setActive(id: string, v: boolean): void`. Task 6 calls `setActive` when the rail selection changes; Task 7 wires it for detached windows (always `true`).

- [ ] **Step 1: Write the failing test**

Add to `tests/notificationGate.test.ts`, inside the existing `describe` for `shouldNotify`:

```ts
  it('notifies an inactive tab even when its window is focused and visible', () => {
    // The Loft window hosts several services; only one is the selected tab. The
    // others are focused+visible by the window's reckoning but are NOT on screen,
    // so they must still notify. Getting this wrong makes every background tab
    // silent — a failure you notice as an absence, weeks later.
    expect(shouldNotify({
      systemDnd: false, globalDnd: false, serviceDnd: false,
      focused: true, visible: true, active: false,
    })).toBe(true);
  });

  it('suppresses only the service the user is actually looking at', () => {
    expect(shouldNotify({
      systemDnd: false, globalDnd: false, serviceDnd: false,
      focused: true, visible: true, active: true,
    })).toBe(false);
  });

  it('still notifies an active service whose window is hidden or unfocused', () => {
    expect(shouldNotify({
      systemDnd: false, globalDnd: false, serviceDnd: false,
      focused: false, visible: true, active: true,
    })).toBe(true);
    expect(shouldNotify({
      systemDnd: false, globalDnd: false, serviceDnd: false,
      focused: true, visible: false, active: true,
    })).toBe(true);
  });

  it('lets any DND flag beat focus regardless of active', () => {
    for (const flag of ['systemDnd', 'globalDnd', 'serviceDnd'] as const) {
      expect(shouldNotify({
        systemDnd: false, globalDnd: false, serviceDnd: false,
        focused: false, visible: false, active: false,
        [flag]: true,
      })).toBe(false);
    }
  });
```

And add a case for the gate class:

```ts
describe('NotificationGate.setActive', () => {
  it('defaults active to true so a lone window behaves exactly as before', () => {
    // A detached service is always "active" — there is no other tab to be behind.
    // The default must therefore be true, or every detached window would keep
    // notifying while the user reads it.
    const g = new NotificationGate();
    g.setFocused('slack', true);
    g.setVisible('slack', true);
    expect(g.shouldNotify('slack')).toBe(false);
  });

  it('an inactive tab notifies even when focused and visible', () => {
    const g = new NotificationGate();
    g.setFocused('slack', true);
    g.setVisible('slack', true);
    g.setActive('slack', false);
    expect(g.shouldNotify('slack')).toBe(true);
    g.setActive('slack', true);
    expect(g.shouldNotify('slack')).toBe(false);
  });
});
```

Ensure the file imports `NotificationGate` alongside `shouldNotify`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/notificationGate.test.ts`
Expected: FAIL — `active` is not a property of `NotifyDecisionInput`, and `g.setActive is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/main/notifications/gate.ts`:

```ts
export interface NotifyDecisionInput {
  systemDnd: boolean;
  globalDnd: boolean;
  serviceDnd: boolean;
  focused: boolean;
  visible: boolean;
  /** Is this the service the user is actually looking at? Always true for a service
   *  with its own window; for a shared host, true only for the selected tab. */
  active: boolean;
}

/**
 * Show a notification only when no DND flag is set and the user is not already
 * looking at this service.
 *
 * "Looking at it" needs all three: the window focused, the window visible, AND this
 * service being the active tab. Before the Loft window, active was implicitly always
 * true (one service per window) and focused+visible was the whole test. In a shared
 * host every attached service is focused+visible at once, so without `active` every
 * background tab goes silent.
 */
export function shouldNotify(i: NotifyDecisionInput): boolean {
  if (i.systemDnd || i.globalDnd || i.serviceDnd) return false;
  if (i.focused && i.visible && i.active) return false;
  return true;
}
```

In the `NotificationGate` class, add the map and setter next to `visible`:

```ts
  private active = new Map<string, boolean>();
```

```ts
  setActive(id: string, v: boolean): void { this.active.set(id, v); }
```

and in `shouldNotify(id)`:

```ts
      active: this.active.get(id) ?? true,
```

**`?? true` is deliberate** — a detached service has no tab to be behind and must default to active, or its window would keep notifying while the user reads it.

- [ ] **Step 4: Expose it on `Notifications`**

In `src/main/notifications/index.ts`, add to the `Notifications` interface next to `setVisible`:

```ts
  /** For a shared host: is this the selected tab? Detached services are always active. */
  setActive(id: string, v: boolean): void;
```

and to the returned object, next to `setVisible`:

```ts
    setActive(id, v) {
      knownIds.add(id);
      gate.setActive(id, v);
      recomputeHidden(id);
    },
```

Then teach `recomputeHidden` about it. It currently reads:

```ts
  const recomputeHidden = (id: string): void => {
    const isFocused = focused.get(id) ?? false;
    const isVisible = visible.get(id) ?? false;
    deps.pushHidden(id, !(isFocused && isVisible));
  };
```

Replace with:

```ts
  const recomputeHidden = (id: string): void => {
    const isFocused = focused.get(id) ?? false;
    const isVisible = visible.get(id) ?? false;
    const isActive = active.get(id) ?? true; // detached services have no tab to be behind
    // Deliberately not `!visible`: an unfocused-but-visible service is told it's hidden
    // so web apps that gate new Notification() on document.hidden still fire. An
    // unselected tab is hidden for the same reason.
    deps.pushHidden(id, !(isFocused && isVisible && isActive));
  };
```

and add the backing map next to `focused`/`visible`:

```ts
  const active = new Map<string, boolean>();
```

- [ ] **Step 5: Run tests and build**

Run: `npm test && npm run build`
Expected: all PASS (277 + the new cases); `tsc` no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/notifications/gate.ts src/main/notifications/index.ts tests/notificationGate.test.ts
git commit -m "feat(notifications): gate on active tab, not just focus+visible

Spec 09 §6d. 'visible' means the window is on screen, which was the whole
test when a window held one service. The Loft window holds several, so every
attached service is focused+visible at once — without this, every tab you're
not looking at goes silent, and its web app suppresses its own Notification
calls too. Fails as an absence, which is why it gets table-driven tests.

active defaults to TRUE: a detached service has no tab to be behind."
```

---

### Task 3: Spike — `ServiceView.mount`/`unmount` round-trip

09a's spike proved **raw** `removeChildView`/`addChildView` survives. It did **not** exercise `ServiceView`'s own `mount()`/`unmount()`, which have zero callers and zero tests — 09a's final review called this out explicitly. They also carry logic the raw calls don't: re-adding a live recovery overlay, and re-applying `rect`. Task 6 is the first caller. Prove the wrapper before building on it.

**Not TDD** — a throwaway probe. Deliverable is evidence.

**Files:**
- Create: `dev_local/spike_mount/main.js` (`dev_local/` is gitignored — the spec entry is the durable record)
- Modify: `docs/superpowers/specs/2026-07-17-electron-loft-09-unified-view-design.md` (append to §10a)

**Interfaces:**
- Consumes: `createServiceView(def, cfg)` from 09a.
- Produces: a go/no-go. No code any later task imports.

- [ ] **Step 1: Write the spike**

`dev_local/spike_mount/main.js` — note it requires the **built** output, so `npm run build` must run first:

```js
// Spike for plan 09b Task 3. Throwaway. 09a's spike proved raw removeChildView/
// addChildView survives; this proves ServiceView's OWN mount()/unmount() do, since
// they have never executed and Task 6 is their first caller.
//
// Requires the Chrome UA + media permission, or WhatsApp serves "works with Chrome
// 100+" and the probe fails for reasons unrelated to the question — 09a's spike v1
// died exactly that way. createServiceView does that itself via configureSession.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const dist = path.join(__dirname, '..', '..', 'dist', 'main');
const { createServiceView } = require(path.join(dist, 'serviceView.js'));
const { getService } = require(path.join(dist, 'registry.js'));

const SIZE = { width: 1100, height: 800 };
const RECT = { x: 0, y: 0, ...SIZE };
const HOTKEY = 'CommandOrControl+Alt+M'; // NOT Ctrl+Alt+R — GNOME owns that (screen recording)

app.whenReady().then(async () => {
  const a = new BrowserWindow({ ...SIZE, title: 'Spike A' });
  const b = new BrowserWindow({ ...SIZE, title: 'Spike B', show: false });

  const cfg = { services: { whatsapp: {} } };
  const sv = createServiceView(getService('whatsapp'), cfg);

  sv.view.webContents.on('did-start-loading', () => console.log('[spike] did-start-loading'));

  // mount() must happen in the same synchronous tick as createServiceView — see the
  // doc comment on createServiceView.
  sv.mount(a, RECT);
  const idBefore = sv.view.webContents.id;
  console.log('[spike] id in A:', idBefore);
  console.log(`[spike] Log in, open a chat, scroll, type a draft. Then press ${HOTKEY}.`);

  const { globalShortcut } = require('electron');
  let done = false;
  const move = async () => {
    if (done) return;
    done = true;
    await sv.view.webContents.executeJavaScript('window.__spike = "before"');

    console.log('[spike] unmount from A, mount into B ...');
    sv.unmount();
    sv.mount(b, RECT);
    b.show();
    b.focus();

    let marker;
    try { marker = await sv.view.webContents.executeJavaScript('window.__spike'); }
    catch (e) { marker = `<threw: ${e.message}>`; }
    console.log('[spike] ---------------- RESULT ----------------');
    console.log('[spike] id same?          ', idBefore === sv.view.webContents.id);
    console.log('[spike] __spike survived? ', marker === 'before', `(${marker})`);
    console.log('[spike] url:              ', sv.view.webContents.getURL());
    console.log('[spike] ----------------------------------------');
    console.log('[spike] NOW: place a voice call, then a video call, from window B.');
    console.log('[spike] THEN: press the hotkey region again? No — quit and report.');
  };
  if (!globalShortcut.register(HOTKEY, move)) {
    console.error(`[spike] Could not register ${HOTKEY}; falling back to a 90s timer.`);
    setTimeout(move, 90_000);
  }
  app.on('will-quit', () => globalShortcut.unregisterAll());
});
```

- [ ] **Step 2: Run it**

Run: `npm run build && env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron dev_local/spike_mount`

Log into WhatsApp in window A, open a chat, scroll, type an unsent draft, then press **Ctrl+Alt+M**.

Expected:

```
[spike] id same?           true
[spike] __spike survived?  true (before)
```

with **no** `did-start-loading` after the `unmount from A` line, and window B showing the same chat, scroll position and draft.

- [ ] **Step 3: Place a call**

From window B (post-move), place a **voice call** and a **video call**. Both must connect; no exit code 139.

- [ ] **Step 4: Record in the spec**

Append to §10a of the spec, filling in what you saw:

```markdown
### 10b. ServiceView.mount/unmount spike (09b Task 3, <date>)

- **`ServiceView.mount()`/`unmount()` round-trip preserves the page:** <yes/no>. id <same/changed>;
  `window.__spike` <survived/lost>; no `did-start-loading` after the move: <true/false>; chat, scroll
  and draft <survived/lost>.
- **Call after a wrapper round-trip:** voice <works/fails>, video <works/fails>. Exit 139: <not seen/seen>.
- **Verdict:** <GO / NO-GO — details>.
```

**If either probe fails, STOP and report.** Task 6 mounts `ServiceView`s for real; if the wrapper loses the page, the rail's tab-switching model needs redesigning first.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-17-electron-loft-09-unified-view-design.md
git commit -m "docs(spec): record the ServiceView mount/unmount spike

09a's spike proved raw removeChildView/addChildView; this proves our own
wrapper, whose first caller is 09b's loftWindow. dev_local/ is gitignored,
so this entry is the only lasting record."
```

---

### Task 4: `railModel.ts` — the rail's contents, as a pure function

The rail's ordering and per-item state are decidable without Electron, so they get real tests. Everything Electron-shaped stays in Task 6.

**Files:**
- Create: `src/main/railModel.ts`
- Test: `tests/railModel.test.ts`

**Interfaces:**
- Consumes: `LoftConfig`, `ServiceConfig` (`src/main/config.ts`); `ServiceDef` (`src/main/registry.ts`).
- Produces:
  - `RailItem { id: string; displayName: string; badge: number; dnd: boolean; sleeping: boolean; detached: boolean; active: boolean }`
  - `RailModelInput { services: ServiceDef[]; config: LoftConfig; loaded(id): boolean; detached(id): boolean; badge(id): number; activeId: string | undefined }`
  - `buildRailModel(i: RailModelInput): RailItem[]`
  - `nextActiveId(items: RailItem[], closingId: string): string | undefined`
  Tasks 5 and 6 both import these.

- [ ] **Step 1: Write the failing test**

Create `tests/railModel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRailModel, nextActiveId, type RailModelInput } from '../src/main/railModel';
import type { ServiceDef } from '../src/main/registry';

const def = (id: string, displayName: string): ServiceDef =>
  ({ id, displayName, url: `https://${id}.test/`, selfHosted: false, origins: [] });

const SERVICES = [def('whatsapp', 'WhatsApp'), def('slack', 'Slack'), def('element', 'Element')];

function input(over: Partial<RailModelInput> = {}): RailModelInput {
  return {
    services: SERVICES,
    config: { services: { whatsapp: {}, slack: {} } },
    loaded: () => true,
    detached: () => false,
    badge: () => 0,
    activeId: undefined,
    ...over,
  };
}

describe('buildRailModel', () => {
  it('lists only installed services — the rail is not the registry', () => {
    expect(buildRailModel(input()).map((i) => i.id)).toEqual(['whatsapp', 'slack']);
  });

  it('honours railOrder, and sorts unlisted ids after it in registry order', () => {
    const items = buildRailModel(input({
      config: { services: { whatsapp: {}, slack: {}, element: {} }, railOrder: ['slack'] },
    }));
    expect(items.map((i) => i.id)).toEqual(['slack', 'whatsapp', 'element']);
  });

  it('ignores railOrder entries for services that are not installed', () => {
    const items = buildRailModel(input({
      config: { services: { whatsapp: {} }, railOrder: ['slack', 'whatsapp'] },
    }));
    expect(items.map((i) => i.id)).toEqual(['whatsapp']);
  });

  it('marks an unloaded service sleeping and gives it no badge', () => {
    const items = buildRailModel(input({ loaded: (id) => id !== 'slack', badge: () => 7 }));
    const slack = items.find((i) => i.id === 'slack')!;
    expect(slack.sleeping).toBe(true);
    // A sleeping service has no view, so it cannot have scraped a count. Showing a
    // stale one would claim unread messages nothing is watching for.
    expect(slack.badge).toBe(0);
  });

  it('zeroes the badge when the service disables badges, without claiming it is sleeping', () => {
    const items = buildRailModel(input({
      config: { services: { whatsapp: { badgesEnabled: false } } },
      badge: () => 5,
    }));
    expect(items[0].badge).toBe(0);
    expect(items[0].sleeping).toBe(false);
  });

  it('treats a missing badgesEnabled as enabled', () => {
    expect(buildRailModel(input({ badge: () => 3 }))[0].badge).toBe(3);
  });

  it('reports dnd and detached per service', () => {
    const items = buildRailModel(input({
      config: { services: { whatsapp: { dnd: true }, slack: {} } },
      detached: (id) => id === 'slack',
    }));
    expect(items.find((i) => i.id === 'whatsapp')!.dnd).toBe(true);
    expect(items.find((i) => i.id === 'slack')!.detached).toBe(true);
  });

  it('marks exactly one item active, and none when activeId is unknown', () => {
    expect(buildRailModel(input({ activeId: 'slack' })).filter((i) => i.active).map((i) => i.id))
      .toEqual(['slack']);
    expect(buildRailModel(input({ activeId: 'nope' })).some((i) => i.active)).toBe(false);
    expect(buildRailModel(input({ activeId: undefined })).some((i) => i.active)).toBe(false);
  });

  it('never marks a detached service active — it is not a tab in this window', () => {
    const items = buildRailModel(input({ detached: (id) => id === 'slack', activeId: 'slack' }));
    expect(items.some((i) => i.active)).toBe(false);
  });
});

describe('nextActiveId', () => {
  const items = (ids: string[], detached: string[] = []) =>
    ids.map((id) => ({
      id, displayName: id, badge: 0, dnd: false, sleeping: false,
      detached: detached.includes(id), active: false,
    }));

  it('picks the next attached service after the one closing', () => {
    expect(nextActiveId(items(['a', 'b', 'c']), 'b')).toBe('c');
  });

  it('wraps backwards when the last one closes', () => {
    expect(nextActiveId(items(['a', 'b', 'c']), 'c')).toBe('b');
  });

  it('skips detached services — they are not selectable tabs', () => {
    expect(nextActiveId(items(['a', 'b', 'c'], ['c']), 'b')).toBe('a');
  });

  it('returns undefined when nothing attached is left, so the manager shows', () => {
    expect(nextActiveId(items(['a']), 'a')).toBeUndefined();
    expect(nextActiveId(items(['a', 'b'], ['b']), 'a')).toBeUndefined();
  });

  it('returns undefined for an id that is not in the rail', () => {
    expect(nextActiveId(items(['a', 'b']), 'zz')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/railModel.test.ts`
Expected: FAIL — `Cannot find module '../src/main/railModel'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/railModel.ts`:

```ts
import type { LoftConfig } from './config';
import type { ServiceDef } from './registry';

/** One entry in the Loft window's service rail. */
export interface RailItem {
  id: string;
  displayName: string;
  /** Already gated: 0 when sleeping or when the service disables badges. */
  badge: number;
  dnd: boolean;
  /** Installed but not loaded — no view, no badges, no notifications until clicked. */
  sleeping: boolean;
  /** Lives in its own window; clicking raises that window rather than selecting a tab. */
  detached: boolean;
  /** The selected tab. At most one, and never a detached service. */
  active: boolean;
}

export interface RailModelInput {
  /** The registry, in its canonical order — the tiebreak for anything railOrder omits. */
  services: ServiceDef[];
  config: LoftConfig;
  loaded(id: string): boolean;
  detached(id: string): boolean;
  badge(id: string): number;
  activeId: string | undefined;
}

/**
 * The rail lists every INSTALLED service — including detached ones (spec 09 §3). It is
 * the service list, not the tab strip: that is what makes it the way back from a
 * detached window, and what keeps railOrder meaningful across attach/detach.
 */
export function buildRailModel(i: RailModelInput): RailItem[] {
  const installed = i.services.filter((d) => i.config.services[d.id] !== undefined);
  const order = i.config.railOrder ?? [];
  const rank = (id: string): number => {
    const at = order.indexOf(id);
    return at === -1 ? order.length + installed.findIndex((d) => d.id === id) : at;
  };

  return [...installed]
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((d) => {
      const cfg = i.config.services[d.id] ?? {};
      const sleeping = !i.loaded(d.id);
      const detached = i.detached(d.id);
      // badgesEnabled is absent-means-true. A sleeping service has no view and so
      // cannot have a count; showing a stale one would claim unread messages that
      // nothing is watching for.
      const badgesOn = cfg.badgesEnabled !== false;
      return {
        id: d.id,
        displayName: d.displayName,
        badge: sleeping || !badgesOn ? 0 : i.badge(d.id),
        dnd: cfg.dnd === true,
        sleeping,
        detached,
        active: !detached && i.activeId === d.id,
      };
    });
}

/**
 * Which service the Loft window should select when `closingId` stops being a tab
 * (unloaded, detached, or removed). Next one along, else the previous; undefined when
 * nothing attached remains — the caller then shows the manager, which is the correct
 * empty state rather than a special case.
 */
export function nextActiveId(items: RailItem[], closingId: string): string | undefined {
  const attached = items.filter((it) => !it.detached);
  const at = attached.findIndex((it) => it.id === closingId);
  if (at === -1) return undefined;
  const rest = attached.filter((it) => it.id !== closingId);
  if (rest.length === 0) return undefined;
  return (rest[at] ?? rest[at - 1] ?? rest[rest.length - 1]).id;
}
```

- [ ] **Step 4: Run tests and build**

Run: `npm test && npm run build`
Expected: all PASS; `tsc` no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/railModel.ts tests/railModel.test.ts
git commit -m "feat(rail): pure model for the Loft window's service rail

Ordering, sleeping/detached marks and badge gating are decidable without
Electron, so they get real tests here rather than hiding in the window.

The rail lists every INSTALLED service, detached ones included — it's the
service list, not the tab strip, which is what makes it the way back from a
detached window."
```

---

### Task 5: Rail preload + renderer

Mirrors the existing titlebar pair (`src/preload/titlebar.ts` + `src/renderer/titlebar/`). Read both before starting. **Do not reach for Svelte** — see Step 4 for why.

**Files:**
- Create: `src/preload/rail.ts`
- Create: `src/renderer/rail/index.html`, `rail.ts`, `rail.css`, `window.d.ts`
- Modify: `package.json` (`bundle-rail-preload` + `copy-assets`)
- **Not** `vite.config.ts` — the rail is plain TS, so Vite never sees it.
- Test: `tests/railPreload.test.ts` (mirror `tests/hubPreload.test.ts` — a pure bridge factory, mock-tested)

**Interfaces:**
- Consumes: `RailItem` (Task 4).
- Produces: `window.loftRail` = `{ onState(cb: (items: RailItem[]) => void): () => void; select(id: string): void; menu(id: string): void }`. Task 6 sends `rail:state` and handles `rail:select` / `rail:menu`.

- [ ] **Step 1: Write the failing preload test**

Create `tests/railPreload.test.ts`, modelled on `tests/hubPreload.test.ts` (read it first and match its fake-ipc style):

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildRailBridge } from '../src/preload/rail';

function fakeIpc() {
  const sent: Array<[string, unknown]> = [];
  const listeners = new Map<string, (e: unknown, ...a: unknown[]) => void>();
  return {
    sent,
    listeners,
    send: (ch: string, payload: unknown) => { sent.push([ch, payload]); },
    on(ch: string, cb: (e: unknown, ...a: unknown[]) => void) { listeners.set(ch, cb); },
    removeListener(ch: string) { listeners.delete(ch); },
  };
}

describe('rail bridge', () => {
  it('sends select and menu on the expected channels', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    b.select('slack');
    b.menu('whatsapp');
    expect(ipc.sent).toEqual([['rail:select', 'slack'], ['rail:menu', 'whatsapp']]);
  });

  it('delivers state to the subscriber', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    const cb = vi.fn();
    b.onState(cb);
    ipc.listeners.get('rail:state')!(null, [{ id: 'slack' }]);
    expect(cb).toHaveBeenCalledWith([{ id: 'slack' }]);
  });

  it('unsubscribes so a re-render cannot stack duplicate listeners', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    const off = b.onState(vi.fn());
    off();
    expect(ipc.listeners.has('rail:state')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/railPreload.test.ts`
Expected: FAIL — `Cannot find module '../src/preload/rail'`.

- [ ] **Step 3: Write the preload**

Create `src/preload/rail.ts`:

```ts
import { contextBridge, ipcRenderer, type IpcRenderer } from 'electron';
import type { RailItem } from '../main/railModel';

export interface RailBridge {
  /** Subscribe to rail state. Returns an unsubscribe — call it on teardown. */
  onState(cb: (items: RailItem[]) => void): () => void;
  select(id: string): void;
  /** Ask main to pop the native per-service context menu for this item. */
  menu(id: string): void;
}

/** Pure factory so the bridge is testable against a fake ipc (mirrors preload/hub.ts). */
export function buildRailBridge(ipc: IpcRenderer): RailBridge {
  return {
    onState(cb) {
      const h = (_e: unknown, items: RailItem[]): void => cb(items);
      ipc.on('rail:state', h);
      return () => ipc.removeListener('rail:state', h);
    },
    select: (id) => ipc.send('rail:select', id),
    menu: (id) => ipc.send('rail:menu', id),
  };
}

contextBridge.exposeInMainWorld('loftRail', buildRailBridge(ipcRenderer));
```

- [ ] **Step 4: Write the renderer — plain TS, NOT Svelte**

This repo has two renderer patterns. The hub is Svelte built by Vite (`vite.config.ts` has `root: src/renderer/hub` and a **single** input). The titlebar and recovery views are plain TS + CSS: compiled by `tsc` with the rest of `src/`, with their `index.html`/`.css` copied by the `copy-assets` script.

**The rail follows the titlebar**, deliberately. It is a list of icons; making it Svelte would force `vite.config.ts` into a multi-root build for no benefit, and the titlebar pattern already does exactly this job.

`src/renderer/rail/window.d.ts`:

```ts
import type { RailBridge } from '../../preload/rail';
declare global {
  interface Window { loftRail: RailBridge }
}
export {};
```

`src/renderer/rail/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'" />
    <link rel="stylesheet" href="rail.css" />
  </head>
  <body>
    <nav id="rail" aria-label="Services"></nav>
    <script type="module" src="rail.js"></script>
  </body>
</html>
```

`src/renderer/rail/rail.ts`:

```ts
import type { RailItem } from '../../main/railModel';

const root = document.getElementById('rail')!;

const initials = (name: string): string =>
  name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

function render(items: RailItem[]): void {
  root.replaceChildren(
    ...items.map((item) => {
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
    }),
  );
}

window.loftRail.onState(render);
```

`src/renderer/rail/rail.css` — the rail is exactly `RAIL_WIDTH` (52px) and must **not** be a drag region, or clicks never reach the buttons:

```css
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; overflow: hidden; font-family: system-ui, sans-serif; }

#rail {
  width: 52px; height: 100vh;
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 7px 0;
  background: #e5e5e7; border-right: 1px solid #d1d1d6;
  overflow-y: auto; scrollbar-width: none;
}
#rail::-webkit-scrollbar { display: none; }

.item {
  position: relative; flex: none;
  width: 34px; height: 34px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid #d1d1d6; border-radius: 8px;
  background: #fff; color: #86868b;
  font: 700 10px/1 system-ui, sans-serif;
  cursor: pointer; padding: 0;
}
.item:hover { border-color: #86868b; }
.item.active { border-color: #0071e3; color: #0071e3; box-shadow: inset 3px 0 0 #0071e3; }
.item.sleeping { opacity: .4; border-style: dashed; }

.badge {
  position: absolute; top: -4px; right: -4px;
  background: #ff3b30; color: #fff;
  border-radius: 8px; padding: 0 3px;
  font: 700 8px/1.5 system-ui, sans-serif;
}
.mark { position: absolute; bottom: -2px; right: -2px; font-size: 8px; }

@media (prefers-color-scheme: dark) {
  #rail { background: #3d3d3f; border-right-color: #424245; }
  .item { background: #2d2d2f; border-color: #424245; }
  .item.active { border-color: #0a84ff; color: #0a84ff; box-shadow: inset 3px 0 0 #0a84ff; }
}
```

- [ ] **Step 5: Wire the build**

Two edits to `package.json`, both mirroring what already exists — invent nothing.

The rail preload is `contextIsolation: true` like the hub's, so it gets its own esbuild line. Add the script:

```json
    "bundle-rail-preload": "esbuild src/preload/rail.ts --bundle --platform=node --format=cjs --external:electron --outfile=dist/preload/rail.js",
```

and add `&& npm run bundle-rail-preload` to `build`, after `bundle-hub-preload`.

`rail.ts` is compiled by `tsc` with the rest of `src/`, so only its static assets need copying. In `copy-assets`, add `dist/renderer/rail` to the `mkdir -p` list and add:

```
cp src/renderer/rail/index.html src/renderer/rail/rail.css dist/renderer/rail/
```

alongside the titlebar's copy — matching how `src/renderer/titlebar/` is handled.

- [ ] **Step 6: Run tests, build, type-check**

Run: `npm test && npm run build && npm run check`
Expected: all PASS; `tsc` no errors; `svelte-check` 0 errors.

Then confirm the assets actually landed:
Run: `ls dist/preload/rail.js dist/renderer/rail/index.html`
Expected: both exist. If not, the build wiring in Step 5 is wrong — fix it before committing; a missing renderer file only fails at runtime.

- [ ] **Step 7: Commit**

```bash
git add src/preload/rail.ts src/renderer/rail tests/railPreload.test.ts package.json
git commit -m "feat(rail): preload bridge + rail renderer

A pure buildRailBridge factory (mock-tested) plus a contextIsolation:true
preload, mirroring the hub's. The rail is its own WebContentsView, so it
can't share the titlebar's.

Plain TS, following the titlebar/recovery pattern rather than the hub's —
Svelte would force vite.config.ts into a multi-root build to render a list
of icons."
```

---

### Task 6: `loftWindow.ts` — the unified host

The core. One window: rail view (full height, left), titlebar view (top of the remaining area, belonging to the **active service**), manager view + N `ServiceView`s sharing the content rect with exactly one visible.

**Files:**
- Create: `src/main/loftWindow.ts`
- Test: none new — Electron-bound, like `serviceWindow.ts`. `railModel` (Task 4) holds the testable logic; the smoke test in Task 8 is the gate.

**Interfaces:**
- Consumes: `computeLayout(w, h, { railWidth })` + `RAIL_WIDTH` + `Rect` (09a); `createServiceView` / `ServiceView` (09a); `ServiceHost` + `def` + `isVisible()` (Task 1); `buildRailModel` / `nextActiveId` / `RailItem` (Task 4); `formatWindowTitle` (`src/main/serviceTitle.ts`).
- Produces:
  ```ts
  export interface LoftWindow {
    window: BrowserWindow;
    open(): void;                         // show + focus
    hide(): void;
    attach(def: ServiceDef): ServiceHost; // create+mount a view; does NOT select it
    /** Unmount and hand the still-live view back for re-mounting elsewhere.
     *  ORDERING CONTRACT: call this BEFORE writing `detached: true` to config. It picks
     *  the next tab by locating `id` in the attached list, so a config flag flipped first
     *  makes it show the manager instead of the next service. */
    detach(id: string): ServiceView | undefined;
    unload(id: string): void;             // destroy the view; drop to sleeping
    select(id: string | undefined): void; // undefined = show the manager
    activeId(): string | undefined;
    hostOf(id: string): ServiceHost | undefined;
    has(id: string): boolean;
    ids(): string[];
    setBadge(id: string, count: number): void;
    refreshRail(): void;
    showManager(): void;
    popServiceMenu(id: string): void;
    ownsWebContents(id: number): boolean;
    persist(): void;
    destroy(): void;
  }
  export const LOFT_WINDOW_KEY = 'Loft';
  export function createLoftWindow(deps: LoftWindowDeps): LoftWindow
  ```
  Task 7 consumes all of it; Task 8 uses `showManager`.

- [ ] **Step 1: Write `loftWindow.ts`**

Create `src/main/loftWindow.ts`:

```ts
import { BrowserWindow, WebContentsView, Menu } from 'electron';
import { join } from 'node:path';
import type { ServiceDef } from './registry';
import type { LoftConfig } from './config';
import { computeLayout, RAIL_WIDTH, type Rect } from './layout';
import { formatWindowTitle } from './serviceTitle';
import { createServiceView, type ServiceView } from './serviceView';
import type { ServiceHost } from './serviceHost';
import { buildRailModel, nextActiveId, type RailItem } from './railModel';

/** The window's own display name — the key the GNOME helper and KWin match on. */
export const LOFT_WINDOW_KEY = 'Loft';

export interface LoftWindowDeps {
  cfg: LoftConfig;
  services: ServiceDef[];
  /** Never true unless the app is really quitting — close-to-tray depends on it. */
  onQuit(): boolean;
  /** Live unread for a service, ungated (the rail model applies badgesEnabled itself). */
  badge(id: string): number;
  /** Is this service detached? Detached services appear in the rail but aren't tabs. */
  detached(id: string): boolean;
  /** Rail right-click → the per-service menu. Main owns it so it's native. */
  buildServiceMenu(id: string): Electron.MenuItemConstructorOptions[];
  /** Selection changed (or the manager took over, id undefined). */
  onActiveChanged(id: string | undefined): void;
  railPreload: string;
  railHtml: string;
  titlebarPreload: string;
  titlebarHtml: string;
  managerPreload: string;
  managerHtml: string;
  iconPath: string;
}

function safeSend(view: WebContentsView, channel: string, ...args: unknown[]): void {
  const wc = view.webContents;
  if (wc.isDestroyed()) return;
  try { wc.send(channel, ...args); } catch { /* render frame disposed transiently */ }
}

export function createLoftWindow(deps: LoftWindowDeps): LoftWindow {
  const saved = deps.cfg.window;

  const window = new BrowserWindow({
    width: saved?.width ?? 1100,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    frame: false,
    show: false,
    title: LOFT_WINDOW_KEY,
    icon: deps.iconPath,
  });

  const views = new Map<string, ServiceView>();
  let active: string | undefined;

  // --- chrome views -----------------------------------------------------------
  const rail = new WebContentsView({
    webPreferences: { preload: deps.railPreload, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  void rail.webContents.loadFile(deps.railHtml);

  const titlebar = new WebContentsView({ webPreferences: { preload: deps.titlebarPreload } });
  void titlebar.webContents.loadFile(deps.titlebarHtml);

  const manager = new WebContentsView({
    webPreferences: { preload: deps.managerPreload, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  void manager.webContents.loadFile(deps.managerHtml);

  // Insertion order is z-order. Rail and titlebar never overlap the content rect, so
  // only manager-vs-service matters, and setVisible arbitrates that.
  window.contentView.addChildView(rail);
  window.contentView.addChildView(titlebar);
  window.contentView.addChildView(manager);

  const rects = (): { rail: Rect; titlebar: Rect; content: Rect } => {
    const [w, h] = window.getContentSize();
    return computeLayout(w, h, { railWidth: RAIL_WIDTH });
  };

  const relayout = (): void => {
    const r = rects();
    rail.setBounds(r.rail);
    titlebar.setBounds(r.titlebar);
    manager.setBounds(r.content);
    for (const sv of views.values()) sv.setRect(r.content);
  };
  relayout();
  window.on('resize', relayout);

  // --- rail + titlebar state --------------------------------------------------
  const model = (): RailItem[] => buildRailModel({
    services: deps.services,
    config: deps.cfg,
    loaded: (id) => views.has(id),
    detached: deps.detached,
    badge: deps.badge,
    activeId: active,
  });

  const refreshRail = (): void => safeSend(rail, 'rail:state', model());

  const refreshTitlebar = (): void => {
    if (!active) { safeSend(titlebar, 'titlebar:set-service', 'Loft'); return; }
    const sv = views.get(active);
    if (!sv) return;
    const count = deps.cfg.services[active]?.badgesEnabled === false ? 0 : deps.badge(active);
    safeSend(titlebar, 'titlebar:set-service', formatWindowTitle(sv.def.displayName, count));
  };

  /**
   * The window's OS title (spec 09 §6a): "Loft", or "Loft (7)" summing unread across
   * ATTACHED, loaded, badges-enabled services. Attached-only on purpose — it names this
   * window's contents, and a detached Slack has its own "Slack (2)". The tray icon still
   * aggregates everything, so the two can legitimately disagree.
   */
  const refreshWindowTitle = (): void => {
    let total = 0;
    for (const id of views.keys()) {
      if (deps.detached(id)) continue;
      if (deps.cfg.services[id]?.badgesEnabled === false) continue;
      total += deps.badge(id);
    }
    window.setTitle(formatWindowTitle(LOFT_WINDOW_KEY, total));
  };

  const refreshAll = (): void => { refreshRail(); refreshTitlebar(); refreshWindowTitle(); };

  // --- selection --------------------------------------------------------------
  const select = (id: string | undefined): void => {
    // A detached service isn't a tab here; the caller raises its window instead.
    if (id !== undefined && (!views.has(id) || deps.detached(id))) return;
    active = id;
    const r = rects().content;
    manager.setVisible(id === undefined);
    for (const [vid, sv] of views) {
      const on = vid === id;
      sv.setVisible(on);
      if (on) sv.setRect(r);
    }
    refreshAll();
    deps.onActiveChanged(id);
  };

  const showManager = (): void => select(undefined);

  // --- lifecycle --------------------------------------------------------------
  window.on('close', (e) => {
    if (!deps.onQuit()) { e.preventDefault(); window.hide(); }
  });

  const persist = (): void => {
    const [w, h] = window.getSize();
    const [x, y] = window.getPosition();
    deps.cfg.window = { x, y, width: w, height: h };
    // Per-service zoom belongs to the service, not this window — an attached service
    // keeps its own factor across attach/detach.
    for (const [id, sv] of views) {
      const prev = deps.cfg.services[id];
      if (prev) deps.cfg.services[id] = { ...prev, window: { ...(prev.window ?? { width: 1100, height: 800 }), zoom: sv.getZoom() } };
    }
  };
  window.on('resize', persist);
  window.on('move', persist);
  window.on('hide', persist);

  window.on('closed', () => { for (const sv of views.values()) sv.dispose(); });

  // --- rail IPC is registered by index.ts (it owns ipcMain) --------------------

  const hostFor = (id: string): ServiceHost | undefined => {
    const sv = views.get(id);
    if (!sv) return undefined;
    return {
      def: sv.def,
      show: () => { select(id); api.open(); },
      // Spec §6b: the only way to make an attached service not-visible is to hide its
      // host — and that hides every other attached service too. Documented wart.
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
  };

  const api: LoftWindow = {
    window,
    open: () => { window.show(); window.focus(); },
    hide: () => window.hide(),

    attach: (def) => {
      const existing = views.get(def.id);
      if (existing) return hostFor(def.id)!;
      const sv = createServiceView(def, deps.cfg);
      // mount() must be in the same synchronous tick as createServiceView — see its
      // doc comment: the initial load is already away and arms the stuck watcher,
      // whose showRecovery early-returns while unmounted.
      sv.mount(window, rects().content);
      sv.setVisible(false); // select() decides what's on screen
      views.set(def.id, sv);
      refreshAll();
      return hostFor(def.id)!;
    },

    detach: (id) => {
      const sv = views.get(id);
      if (!sv) return undefined;
      // Snapshot the successor BEFORE the transition. nextActiveId locates `id` in the
      // ATTACHED list to pick its neighbour, so it must still be both loaded and
      // not-yet-detached: call it after views.delete (or after deps.detached(id) flips)
      // and it finds nothing, returns undefined, and we show the manager instead of the
      // next service. Hence also the ordering contract on this method — see the doc on
      // LoftWindow.detach: the caller must not write `detached: true` to config first.
      const next = active === id ? nextActiveId(model(), id) : undefined;
      sv.unmount();
      views.delete(id);
      if (active === id) select(next);
      refreshAll();
      return sv; // still live — the caller re-mounts it into its own window
    },

    unload: (id) => {
      const sv = views.get(id);
      if (!sv) return;
      // Same rule: compute the successor while `id` is still in the attached list.
      const next = active === id ? nextActiveId(model(), id) : undefined;
      sv.unmount();
      sv.dispose();
      if (!sv.view.webContents.isDestroyed()) sv.view.webContents.close();
      views.delete(id);
      if (active === id) select(next);
      refreshAll();
    },

    select,
    activeId: () => active,
    hostOf: hostFor,
    has: (id) => views.has(id),
    ids: () => [...views.keys()],

    setBadge: (id, _count) => {
      // The count itself lives in index.ts's currentBadge (deps.badge reads it), so
      // there is nothing to store here — just re-render everything that shows it.
      if (!views.has(id)) return;
      refreshAll();
    },

    refreshRail: refreshAll,
    showManager,

    /** Native per-service context menu (rail right-click). Main owns it so it renders
     *  as a real menu rather than CSS, and so the actions are the same ones the tray
     *  drives. */
    popServiceMenu: (id) => {
      Menu.buildFromTemplate(deps.buildServiceMenu(id)).popup({ window });
    },

    /** The rail/titlebar/manager views belong to the WINDOW, not to any one service —
     *  no ServiceHost owns them, so index.ts must ask the window before falling back
     *  to a per-service lookup when routing titlebar IPC. */
    ownsWebContents: (wcId) =>
      rail.webContents.id === wcId ||
      titlebar.webContents.id === wcId ||
      manager.webContents.id === wcId ||
      [...views.values()].some((sv) => sv.ownsWebContents(wcId)),
    persist,
    destroy: () => window.destroy(),
  };

  showManager(); // a fresh window with nothing selected shows the manager
  return api;
}
```

`popServiceMenu(id: string): void` goes **in the `LoftWindow` interface** alongside everything else — declare it there, not by assigning to `api` after construction (that neither type-checks nor reads as part of the contract).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `tsc` no errors. Nothing constructs `LoftWindow` yet — Task 7 does.

- [ ] **Step 3: Commit**

```bash
git add src/main/loftWindow.ts
git commit -m "feat(loft-window): the unified host

Second implementer of ServiceHost, which is what finally enforces that the
interface stayed window-free. Rail + titlebar + manager + N ServiceViews;
exactly one of manager/service is setVisible(true) at a time.

hide() on an attached service hides the whole window (spec §6b) — the
documented wart: a shared host has no other way to make one service
not-visible."
```

---

### Task 7: Wire it up in `index.ts`

Replaces the `windows` map with a host registry spanning both window kinds, places services at startup per `detached`, and routes CLI/D-Bus/tray/notifications through it.

**Files:**
- Modify: `src/main/index.ts`
- Test: none new — the testable parts are `railModel` (Task 4) and the gate (Task 2). Task 8's smoke test is the gate.

**Interfaces:**
- Consumes: everything from Tasks 1, 2, 4, 6.
- Produces: `hostOf(id)` now resolves across both kinds; `allHosts(): ServiceHost[]`.

- [ ] **Step 1: Registry + placement**

Keep `windows: Map<string, ServiceWindow>` for **detached** services only, and add the Loft window beside it. Rewrite `hostOf` and add `allHosts`:

```ts
let loft: LoftWindow | undefined;

/** Where a service currently lives, across BOTH host kinds. This is the seam: when a
 *  service moves between the rail and its own window, only this function knows. */
const hostOf = (id: string): ServiceHost | undefined => windows.get(id) ?? loft?.hostOf(id);

/** Every loaded service, wherever it lives. hostOf is per-id and cannot answer this;
 *  the sweeps (SetLoftWindows, background status, persistAll) need it. */
const allHosts = (): ServiceHost[] => [
  ...windows.values(),
  ...(loft?.ids().map((id) => loft!.hostOf(id)!) ?? []),
];
```

Then replace the four sweep sites that iterate `windows.values()`:

- `windowKeys()` — the set of Loft-owned **windows** for `SetLoftWindows`. It is NOT `allHosts` (attached services are not windows):
  ```ts
  function windowKeys(): string[] {
    const keys = [...windows.values()].map((sw) => sw.def.displayName);
    if (loft) keys.push(LOFT_WINDOW_KEY);
    return keys;
  }
  ```
- `findBySenderId` — must also consult the Loft window:
  ```ts
  function findBySenderId(senderId: number): ServiceHost | undefined {
    for (const sw of windows.values()) if (sw.ownsWebContents(senderId)) return sw;
    const id = loft?.ids().find((i) => loft!.hostOf(i)!.ownsWebContents(senderId));
    return id ? loft!.hostOf(id) : undefined;
  }
  ```
  Its callers use `sw.def.id` and `ServiceHost` members only — `def` is on `ServiceHost` as of Task 1, so this compiles. **The titlebar/recovery views of the Loft window are not owned by any ServiceHost** — handle `titlebar:*` for the Loft window via `loft.ownsWebContents(senderId)` before falling through to `findBySenderId`, and route zoom/close to the *active* service.
- the `bgStatus` `collect` — `allHosts().map((h) => ({ displayName: h.def.displayName, badge: ... }))`.
- `persistAll` — `for (const sw of windows.values()) sw.persist(); loft?.persist();`

- [ ] **Step 2: Startup placement**

Create the Loft window before the CLI branch, and place each `openOnStartup` service by its `detached` flag (spec §7). `reopenDetached` is 09c's setting; read it now via `reopenDetachedEnabled(config)` so the behaviour is right from the start:

```ts
    loft = createLoftWindow({ /* deps — see loftWindow.ts */ });

    const placeService = (d: ServiceDef, minimized: boolean): ServiceHost => {
      const wantsOwnWindow = config.services[d.id]?.detached === true && reopenDetachedEnabled(config);
      if (wantsOwnWindow) return openService(d, minimized);   // existing per-service window path
      return loft!.attach(d);
    };
```

`openService` keeps its create-or-reuse shape but must consult `hostOf` first (09a already routed its reuse check through `hostOf`, which now spans both kinds — so a service already in the rail will be *shown* rather than duplicated into a second window).

- [ ] **Step 3: Rail IPC**

`ipcMain` lives in `index.ts`. Register once, next to the other handlers:

```ts
    ipcMain.on('rail:select', (_e, id: string) => {
      const d = getService(id);
      if (!d) return;
      // Sleeping → load it. Detached → raise its own window. Otherwise select the tab.
      if (!hostOf(id)) { openServiceById(id); return; }
      if (config.services[id]?.detached === true) { hostOf(id)!.show(); return; }
      loft?.select(id);
      loft?.open();
    });
    ipcMain.on('rail:menu', (_e, id: string) => loft?.popServiceMenu(id));
```

and build the menu template (spec §7 — every per-service action lives here):

```ts
    const buildServiceMenu = (id: string): Electron.MenuItemConstructorOptions[] => {
      const d = getService(id);
      const cfg = config.services[id] ?? {};
      const loaded = hostOf(id) !== undefined;
      return [
        { label: `Go to ${d?.displayName ?? id}`, click: () => ipcMain.emit('rail:select', null, id) },
        { type: 'separator' },
        { label: 'Do Not Disturb', type: 'checkbox', checked: cfg.dnd === true,
          click: (mi) => setServiceDnd(id, mi.checked) },
        { label: 'Show badge', type: 'checkbox', checked: cfg.badgesEnabled !== false,
          click: (mi) => hub.setServiceSetting(id, { badgesEnabled: mi.checked }) },
        { type: 'separator' },
        { label: 'Open in its own window', type: 'checkbox', checked: cfg.detached === true,
          click: (mi) => setDetached(id, mi.checked) },
        { label: 'Unload', enabled: loaded, click: () => quitService(id) },
        { type: 'separator' },
        { label: 'Settings…', click: () => { loft?.showManager(); loft?.open(); } },
      ];
    };
```

`setDetached(id, v)` moves the live view and writes `config.services[id].detached = v`, **in that order** — `loft.detach(id)` picks the next tab by locating `id` in the attached list, so flipping the config flag first makes it show the manager instead of the next service (see the ordering contract on `LoftWindow.detach`):

```ts
    const setDetached = (id: string, v: boolean): void => {
      const d = getService(id);
      if (!d) return;
      // Move the view FIRST, while config still says what it said — see LoftWindow.detach.
      if (v) loft?.detach(id);            // hands back the live ServiceView
      config.services[id] = { ...config.services[id], detached: v };
      saveConfig(configPath(), config);
      // then re-place it in its new home
      ...
    };
```

**If re-mounting the live view into the other host proves troublesome, unload-and-reload is an acceptable fallback for 09b** — the service reloads rather than keeping its scroll and drafts. Say so in the report; the gesture-driven version is 09c's problem, and Task 3's spike is what tells you whether the live move is viable at all.

- [ ] **Step 4: `setActive` wiring**

`loftWindow`'s `onActiveChanged` must reach the gate (Task 2). For attached services, exactly one is active:

```ts
      onActiveChanged: (activeId) => {
        for (const id of loft?.ids() ?? []) notifications?.setActive(id, id === activeId);
        for (const id of windows.keys()) notifications?.setActive(id, true); // own window ⇒ always active
      },
```

Also push `setActive(id, true)` for every detached service when it is created, and bind the Loft window's `focus`/`blur`/`show`/`hide` to `notifications.setFocused`/`setVisible` **for every attached id** — the window's focus is shared by all of them.

- [ ] **Step 5: CLI + notification-click routing**

Spec §6f and §6d. **Both currently create a per-service window unconditionally**, which is wrong the moment a service can live in the rail — a notification click on an attached Slack would spawn a *second*, detached Slack window.

`focusService` (the notification-click path) currently reads:

```ts
      focusService: (id) => { const d = getService(id); if (d) openService(d, false); },
```

It must go through the placement rule instead, so a sleeping service loads where it belongs and an attached one is selected rather than duplicated:

```ts
      focusService: (id) => {
        const d = getService(id);
        if (!d) return;
        const host = hostOf(id) ?? placeService(d, false);  // loads it if sleeping
        host.show();  // rail ⇒ select + raise Loft; own window ⇒ raise that window
      },
```

The CLI branch has the same shape. `--service=X` becomes "go to X", not "open a window for X":

```ts
    if (def) {
      const host = hostOf(def.id) ?? placeService(def, args.minimized);
      if (!args.minimized) host.show();
    } else {
      for (const id of Object.keys(config.services)) {
        if (config.services[id]?.openOnStartup) { const d = getService(id); if (d) placeService(d, true); }
      }
      if (!args.minimized) { loft!.showManager(); loft!.open(); }
    }
```

**One deliberate behaviour change, already recorded in spec §6f:** the `openOnStartup` loop now runs on *every* launch path. Today `--service=X` skips it entirely, so launching WhatsApp from its launcher starts only WhatsApp. The Loft window exists regardless now, so its startup set loads regardless. Users relying on the old behaviour will notice.

Route `second-instance` (`index.ts:218`) through the same two branches — a second launch must never create a duplicate window either.

- [ ] **Step 6: Build + full suite**

Run: `npm test && npm run build`
Expected: 280+ PASS; `tsc` no errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: host services in the Loft window

hostOf() now spans both host kinds and is the only thing that knows where a
service lives; allHosts() serves the sweeps hostOf can't (it's per-id).
windowKeys() stays window-scoped on purpose — attached services aren't
windows, so SetLoftWindows gets ['Loft', ...detached]."
```

---

### Task 8: The hub moves inside; delete `hubWindow.ts`

Spec §2: the hub **is** the unified window — which is what makes "zero attached services" degrade to exactly today's hub, so there is no empty state and no mode. This task moves the window; the manager's own redesign is 09c.

**Files:**
- Modify: `src/main/index.ts` (own the `hub:*` IPC; `ShowHub()` → show Loft + select manager; drop `createHub`)
- Delete: `src/main/hubWindow.ts`
- Delete/port: `tests/hubWindow.test.ts`
- **Unchanged:** `src/renderer/hub/**` — see Step 4.
- Test: existing `tests/hubState.test.ts`, `tests/hubPreload.test.ts`, `tests/serviceRow.test.ts` must stay green

**Interfaces:**
- Consumes: `LoftWindow.showManager()` (Task 6).
- Produces: nothing new. `hub:*` IPC channels keep their names and payloads.

- [ ] **Step 1: Move the IPC registration**

`hubWindow.ts` owns both the window *and* the `hub:*` IPC. Only the window goes. Move the `ipcMain.handle('hub:getState')` + the seven `ipcMain.on('hub:*')` registrations into `index.ts` verbatim (they already call `deps.*` functions that live there), and replace `notifyChanged()` with a send to the Loft window's manager view.

`hub:openService` becomes select-the-tab rather than open-a-window:

```ts
    ipcMain.on('hub:openService', (_e, id: string) => { ipcMain.emit('rail:select', null, id); });
```

- [ ] **Step 2: Delete the window**

```bash
git rm src/main/hubWindow.ts tests/hubWindow.test.ts
```

`tests/hubWindow.test.ts` tests a file that no longer exists — deleting it is correct, not a weakening. **If it contains assertions about IPC wiring that still apply, port them** to a new `tests/hubIpc.test.ts` rather than dropping them. Read it before deleting and say in your report which of its cases you kept, moved, or dropped, and why.

- [ ] **Step 3: Route `ShowHub()`**

In the D-Bus deps: `ShowHub: () => { loft?.showManager(); loft?.open(); }`. Same for the tray's `Settings…`.

- [ ] **Step 4: Do NOT restructure the manager UI**

The manager view loads the **existing** hub renderer unchanged — same `dist/renderer/hub/index.html`, same `dist/preload/hub.js`, same Svelte app, same `hub:*` channels. It simply renders inside the Loft window's content rect instead of its own 520×700 window.

**Resist restructuring it here.** Spec §7 does say the rail makes the manager's installed-services list redundant, collapsing it to add-a-service plus settings — but that is a *design* change to a working Svelte app, and this task is already the one deleting a window and moving eight IPC registrations. Landing both at once means a failure could be either. **The restructure is 09c.**

Consequence to expect and accept: at ~1048×760 the hub was laid out for 520px, so it will look wide and sparse, and it lists services the rail also shows. That is ugly, not broken, and it is the correct trade for keeping this task revertible.

Do **not** touch `App.svelte`, `ServiceList`, `ServiceRow`, `AvailableTile`, `GlobalSettings`, or `ServiceDetail`. `tests/serviceRow.test.ts` and `tests/hubState.test.ts` must stay green untouched.

- [ ] **Step 5: Tests, build, type-check**

Run: `npm test && npm run build && npm run check`
Expected: all PASS; `tsc` no errors; `svelte-check` 0 errors.

- [ ] **Step 6: SMOKE TEST — this is the real gate**

No test file imports `loftWindow`, `serviceWindow` or `serviceView`, so a green suite proves nothing about this plan's core. **Do not skip.** Ask Keith to run it — it needs real accounts and real calls:

```sh
npm run build && env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .
```

1. The Loft window opens showing the manager, with a rail of installed services.
2. Clicking a rail item selects that service; it fills the content area.
3. A sleeping (dashed) item loads on click.
4. The rail badge and the OS window title (`Loft (N)`) both update on a new message.
5. Titlebar zoom acts on the **active** service; `Ctrl+R` reloads it and the zoom survives.
6. **A background tab still raises a desktop notification** (this is Task 2's whole point — send yourself a message in a service you are *not* looking at, with Loft focused).
7. Right-click a rail item → menu; toggle DND; Unload drops it to dashed.
8. ✕ hides the whole window to tray; the tray entry brings it back.
9. Tick *Open in its own window* → the service gets its own window; untick → back in the rail.
10. **A voice call and a video call in an attached tab.** If anything in this plan breaks Loft's reason to exist, it is this.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(hub): the manager moves into the Loft window

Spec 09 §2: the hub IS the unified window — with nothing attached it degrades
to exactly today's hub, so there is no empty state and no mode. The rail is
now the installed-services list, so the manager collapses to add-a-service
plus settings. hubWindow.ts is gone; ShowHub() selects the manager view."
```

---

## What 09b delivers

The first thing anyone can see: one window, a rail, services as tabs, the manager inside it. Detach exists as a checkbox (the alt-tab escape hatch); the drag gesture, the rich GNOME tray, and launcher enforcement are 09c.
