# Electron Loft — Stage 3a: Tray (SNI) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A single "Loft" system-tray icon (StatusNotifierItem, hand-rolled over `dbus-next`) that shows a red-dot overlay when any service has unread messages, and whose menu lists every service (with an unread indicator + a Do-Not-Disturb toggle) plus Show/Hide, Settings, and Quit — wiring the Stage-2 badge counts to the icon and the menu actions back to the Stage-1 windows.

**Architecture:** A `TrayModel` in main holds per-service `{displayName, badge, dnd, visible}`. On any change it (a) recomputes the icon pixmap (base Loft icon + red-dot/DND overlay) and pushes it to the SNI object, and (b) rebuilds the `com.canonical.dbusmenu` layout. The SNI object implements `org.kde.StatusNotifierItem`, registers with `org.kde.StatusNotifierWatcher` (with the ksni-proven `[0,2,4,8,16]s` backoff + `NameOwnerChanged` re-register), and routes `Activate`/menu events into main callbacks (show/focus a service window, toggle DND, show hub, quit). Ports the icon/overlay + menu logic from `src/combined_tray/tray.rs`.

**Tech Stack:** Electron 43, TypeScript 5.9 (CommonJS), Vitest 4.1, `dbus-next` (new runtime dep), `nativeImage` for pixmap compositing. Ports from `src/combined_tray/tray.rs` + the SNI/dbusmenu specs.

**Scope note:** Stage 3a of the Stage 3 decomposition (see the branch's earlier plans + spec §8). **IN:** SNI tray, badge overlay, services menu, wiring to Stage-2 badges + Stage-1 windows, DND *state* (persisted + reflected; actual notification gating is 3b). **OUT (later sub-stages):** notifications (3b), the GNOME-native panel backend + `tray_backend` switching + GNOME Shell helper + KWin + `chat.loft.Loft` D-Bus (3c). On GNOME this SNI icon relies on an AppIndicator extension being present (Keith has one); the extension-free GNOME panel path is 3c.

## Global Constraints

- All paths relative to `electron/`; run `npm`/`git` from there. Branch: `electron-rewrite`.
- Electron `^43.1.0`; TS `~5.9` (CommonJS, ES2022); Vitest `^4.1`; `dbus-next` `^0.10` (verify latest at install).
- **Single combined "Loft" icon only** (per spec §8) — no per-service icons.
- Icon id `chat.loft.Loft`; SNI category `Communications`; SNI `Status` `Active`.
- Left-click = open the menu (SNI `Activate` is a no-op; hosts open the menu — matches `tray.rs`).
- Icon = base Loft symbolic icon + a **red-dot** overlay when total unread > 0; a **grey-dash** overlay when DND is on for any/all (match `tray.rs` `generate_red_dot_overlay` / `generate_dnd_dash_overlay`).
- StatusNotifierWatcher registration retries on the schedule **`[0, 2, 4, 8, 16]`** seconds (login race), and re-registers when `org.kde.StatusNotifierWatcher` reappears on `NameOwnerChanged`.
- DND is **per-service**, persisted to config (`ServiceConfig.dnd`), reflected in the menu. (Gating notifications on it is Stage 3b.)

---

## File Structure

- `src/main/tray/watcher.ts` — **pure** backoff schedule + a `connectSni()` that waits for `StatusNotifierWatcher` and registers, monitoring `NameOwnerChanged`.
- `src/main/tray/sniItem.ts` — the `org.kde.StatusNotifierItem` D-Bus object (properties/methods/signals) over `dbus-next`.
- `src/main/tray/dbusMenu.ts` — the `com.canonical.dbusmenu` object built from a `MenuModel`.
- `src/main/tray/icon.ts` — base-icon load + overlay compositing → ARGB32 pixmap (port of `tray.rs` overlays via `nativeImage`).
- `src/main/tray/model.ts` — `TrayModel`: per-service state, change → menu model + icon; exposes update methods + action callbacks.
- `src/main/tray/index.ts` — `startTray(deps)` wiring: build model, connect SNI, register menu, hook callbacks.
- Modify: `src/main/index.ts` — start the tray; route `service:badge` → `tray.setBadge(id, n)`; menu callbacks → `openService`/hide/quit; add a `dnd` field to per-service config.
- Modify: `src/main/config.ts` — add `dnd?: boolean` to `ServiceConfig`.
- Assets: `assets/loft-symbolic.png` (+ red-dot/dash generated at runtime like `tray.rs`, or shipped).
- Tests: `tests/trayWatcher.test.ts` (backoff), `tests/trayMenuModel.test.ts` (menu model from state), `tests/trayIcon.test.ts` (overlay-selection logic).

---

## Task 1: `dbus-next` + StatusNotifierWatcher connection with backoff

**Files:** Create `src/main/tray/watcher.ts`, `tests/trayWatcher.test.ts`; add `dbus-next` dep.

**Interfaces produced:**
- `const WATCHER_BACKOFF_SECONDS: readonly number[]` = `[0, 2, 4, 8, 16]`.
- `function nextBackoff(attempt: number): number` — clamps to the last entry.
- `async function connectSni(opts): Promise<SniHandle>` — connects to the session bus, exports the given SNI + dbusmenu objects on a unique bus name (`org.kde.StatusNotifierItem-<pid>-1`), waits for `org.kde.StatusNotifierWatcher`, calls `RegisterStatusNotifierItem`, and subscribes to `NameOwnerChanged` to re-register when the watcher reappears. (This task delivers the backoff helpers + connection skeleton; the SNI/menu objects it exports come from Tasks 2–3.)

- [ ] **Step 1: Install dbus-next** — `npm install dbus-next@^0.10` (verify latest first). Expected: installs.
- [ ] **Step 2: Write the failing test** — `tests/trayWatcher.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { WATCHER_BACKOFF_SECONDS, nextBackoff } from '../src/main/tray/watcher';
describe('watcher backoff', () => {
  it('follows the ksni-proven schedule then holds at the max', () => {
    expect(WATCHER_BACKOFF_SECONDS).toEqual([0, 2, 4, 8, 16]);
    expect([0,1,2,3,4,5].map(nextBackoff)).toEqual([0, 2, 4, 8, 16, 16]);
  });
});
```
- [ ] **Step 3: Run → fail.** `npx vitest run tests/trayWatcher.test.ts` → cannot find module.
- [ ] **Step 4: Implement** the backoff exports (pure) + the `connectSni` skeleton. Backoff:
```ts
export const WATCHER_BACKOFF_SECONDS = [0, 2, 4, 8, 16] as const;
export function nextBackoff(attempt: number): number {
  return WATCHER_BACKOFF_SECONDS[Math.min(attempt, WATCHER_BACKOFF_SECONDS.length - 1)];
}
```
For `connectSni`: use `dbus-next`'s `sessionBus()`; export the SNI + menu objects (passed in) at `/StatusNotifierItem` and `/MenuBar`; request a unique name; call `org.kde.StatusNotifierWatcher.RegisterStatusNotifierItem(busName)`; on failure schedule a retry via `setTimeout(nextBackoff(attempt))`; subscribe to `org.freedesktop.DBus.NameOwnerChanged` filtered to `org.kde.StatusNotifierWatcher` and re-register on reappear. Reference: `dbus-next` README (interface export, `bus.getProxyObject`, signal subscription) and the SNI spec. Keep all `dbus-next` types behind this module.
- [ ] **Step 5: Run → pass.** Full suite too (`npm test`).
- [ ] **Step 6: Commit** — `feat(tray): dbus-next SNI watcher connection + backoff`.

---

## Task 2: `org.kde.StatusNotifierItem` object

**Files:** Create `src/main/tray/sniItem.ts`.

**Interfaces produced:**
- `class SniItem` exporting the `org.kde.StatusNotifierItem` interface via `dbus-next` with:
  - **Properties:** `Category='Communications'`, `Id='chat.loft.Loft'`, `Title='Loft'`, `Status='Active'`, `IconName` (fallback), `IconPixmap` (ARGB32 `a(iiay)`), `ToolTip`, `ItemIsMenu=true`, `Menu` (object path `/MenuBar`).
  - **Methods:** `Activate(x,y)` → `onActivate()` callback (no-op default; hosts open the menu), `SecondaryActivate`, `ContextMenu`, `Scroll` (stubs).
  - **Signals:** `NewIcon`, `NewStatus`, `NewToolTip`, `NewTitle`.
  - `setIconPixmap(pixmap)` / `setToolTip(text)` methods that update the property and emit the matching signal.

Follow the `org.kde.StatusNotifierItem` spec exactly for signatures. No unit test (D-Bus object); verified live in Task 6. Reference `tray.rs` for property values (`category`/`id`/`title`).

- [ ] **Step 1: Implement** `sniItem.ts` per the interface above. `IconPixmap` signature is `a(iiay)` — array of `(width, height, ARGB32-bytes)`.
- [ ] **Step 2: Build** — `npm run build` compiles.
- [ ] **Step 3: Commit** — `feat(tray): StatusNotifierItem D-Bus object`.

---

## Task 3: Icon + overlay compositing (badge / DND)

**Files:** Create `src/main/tray/icon.ts`, `tests/trayIcon.test.ts`. Add `assets/loft-symbolic.png` (ship the base icon).

**Interfaces produced:**
- `type OverlayKind = 'none' | 'unread' | 'dnd'`.
- `function overlayFor(totalUnread: number, anyDnd: boolean): OverlayKind` — **pure**: `dnd` if `anyDnd`, else `unread` if `totalUnread>0`, else `none`. (DND takes visual precedence — match `tray.rs`.)
- `function compositeTrayIcon(kind: OverlayKind): { width: number; height: number; argb: Buffer }` — loads the base PNG via `nativeImage`, composites the red-dot (unread) or grey-dash (dnd) overlay bottom-right, returns ARGB32 for `IconPixmap`. Ports `generate_red_dot_overlay` / `generate_dnd_dash_overlay` / `composite_overlay` from `tray.rs` (read it for the exact dot size/colour `#e01b24` and dash geometry).

- [ ] **Step 1: Write the failing test** — `tests/trayIcon.test.ts` (only the pure selector; compositing is verified live):
```ts
import { describe, it, expect } from 'vitest';
import { overlayFor } from '../src/main/tray/icon';
describe('overlayFor', () => {
  it('shows DND dash over everything, else unread dot, else none', () => {
    expect(overlayFor(5, true)).toBe('dnd');
    expect(overlayFor(0, true)).toBe('dnd');
    expect(overlayFor(3, false)).toBe('unread');
    expect(overlayFor(0, false)).toBe('none');
  });
});
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `overlayFor` (pure) + `compositeTrayIcon` (nativeImage: `nativeImage.createFromPath`, draw overlay, `toBitmap()` gives BGRA — convert to ARGB32 for SNI). Colours/geometry from `tray.rs`.
- [ ] **Step 4: Run → pass** (`overlayFor` tests; full suite).
- [ ] **Step 5: Commit** — `feat(tray): Loft icon + unread/DND overlay compositing`.

---

## Task 4: `com.canonical.dbusmenu` object

**Files:** Create `src/main/tray/dbusMenu.ts`.

**Interfaces produced:**
- `interface MenuModel { services: Array<{ id: string; label: string; unread: boolean; dnd: boolean; visible: boolean }>; }`
- `class DbusMenu` exporting `com.canonical.dbusmenu` built from a `MenuModel`:
  - Root → `Show/Hide Loft` (hub), a separator, one submenu per service `label` with a bullet/check when `unread`, containing a `Do Not Disturb` checkmark item (checked = `dnd`) and a `Show/Hide` item, then a separator, `Settings…`, `Quit`.
  - Implements `GetLayout`, `GetGroupProperties`, `AboutToShow`, and `Event(id, "clicked", …)` → dispatches to an injected `onEvent(actionId)` callback. Emits `LayoutUpdated` when the model changes (`setModel(model)`).
  - Action ids are stable strings: `hub`, `quit`, `settings`, `svc:<id>:toggle`, `svc:<id>:dnd`.

The menu *layout construction* from a `MenuModel` is the testable seam (Task 5 covers the model; here the dbusmenu wire format follows the spec). Reference the dbusmenu spec (`GetLayout` returns `(ui(a{sv}av))`). No unit test for the wire format; verified live.

- [ ] **Step 1: Implement** `dbusMenu.ts`.
- [ ] **Step 2: Build.**
- [ ] **Step 3: Commit** — `feat(tray): com.canonical.dbusmenu object`.

---

## Task 5: `TrayModel` (state → menu model + icon) + menu-model test

**Files:** Create `src/main/tray/model.ts`, `tests/trayMenuModel.test.ts`.

**Interfaces produced:**
- `interface ServiceTrayState { id: string; displayName: string; badge: number; dnd: boolean; visible: boolean; }`
- `class TrayModel` with `setBadge(id,n)`, `setDnd(id,b)`, `setVisible(id,b)`, `addService(state)`, and pure getters `menuModel(): MenuModel` and `iconOverlay(): OverlayKind` (uses `overlayFor(totalUnread, anyDnd)`), plus an `onChange` callback fired after any mutation.

- [ ] **Step 1: Write the failing test** — `tests/trayMenuModel.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { TrayModel } from '../src/main/tray/model';
describe('TrayModel', () => {
  it('derives the menu model and icon overlay from service state', () => {
    const m = new TrayModel();
    m.addService({ id: 'whatsapp', displayName: 'WhatsApp', badge: 0, dnd: false, visible: true });
    m.addService({ id: 'slack', displayName: 'Slack', badge: 2, dnd: false, visible: false });
    expect(m.iconOverlay()).toBe('unread');
    const mm = m.menuModel();
    expect(mm.services.map((s) => [s.id, s.unread])).toEqual([['whatsapp', false], ['slack', true]]);
    m.setDnd('slack', true);
    expect(m.iconOverlay()).toBe('dnd');
    expect(mm.services.find((s) => s.id === 'slack')); // re-fetch: mm is a snapshot
    expect(m.menuModel().services.find((s) => s.id === 'slack')!.dnd).toBe(true);
  });
});
```
- [ ] **Step 2: Run → fail. Step 3: Implement** `TrayModel`. **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(tray): TrayModel deriving menu + icon from service state`.

---

## Task 6: wire the tray into main + verify live

**Files:** Create `src/main/tray/index.ts`; modify `src/main/index.ts`, `src/main/config.ts`.

**Interfaces produced:**
- `async function startTray(deps: { services: ServiceDef[]; onShowService(id): void; onToggleDnd(id, b): void; onShowHub(): void; onQuit(): void; }): Promise<Tray>` where `Tray` exposes `setBadge(id, n)`, `setVisible(id, b)`, `setDnd(id, b)`.
- `ServiceConfig` gains `dnd?: boolean`.

- [ ] **Step 1: Add `dnd?: boolean` to `ServiceConfig`** in `config.ts`.
- [ ] **Step 2: Implement `startTray`** — builds a `TrayModel` seeded from the registry + saved `dnd`; constructs `SniItem` + `DbusMenu` + `compositeTrayIcon`; `connectSni`; on `TrayModel.onChange` push new pixmap (`sni.setIconPixmap(compositeTrayIcon(model.iconOverlay()))`) + `dbusMenu.setModel(model.menuModel())`; wire `dbusMenu.onEvent` → the `deps` callbacks (`hub`→onShowHub, `quit`→onQuit, `svc:<id>:toggle`→onShowService/hide by current visible, `svc:<id>:dnd`→onToggleDnd).
- [ ] **Step 3: Wire in `index.ts`** (inside the single-instance owner block): `const tray = await startTray({ services: listServices(), onShowService: (id)=>openService(getService(id)!, false), onToggleDnd: (id,b)=>{ setServiceDnd(id,b); tray.setDnd(id,b); }, onShowHub: ()=>{/* Stage 4 hub; for now focus any window */}, onQuit: ()=>{ quitting=true; app.quit(); } });` Route `service:badge` also to `tray.setBadge(sw.def.id, payload.count)`; on window show/hide call `tray.setVisible(id, …)`. Persist DND to config (`config.services[id].dnd`).
- [ ] **Step 4: Build + full test suite** — `npm run build && npm test`. Expected: compiles; all tests pass.
- [ ] **Step 5: Manual verification** (KDE, or GNOME with an AppIndicator extension):
  - `cd electron && npm run whatsapp` (or `npm start`). A **Loft tray icon** appears.
  - With an unread chat, the icon shows the **red dot**; clears when read.
  - **Left-click** opens the menu: services listed (unread ones marked), each with **Do Not Disturb** + **Show/Hide**; plus **Settings…** and **Quit**.
  - Clicking a service **shows/focuses** its window; **Quit** exits the app; toggling **DND** persists (re-launch shows it checked).
- [ ] **Step 6: Commit** — `feat(tray): wire SNI tray to badges, windows, and DND`.

---

## Self-Review (plan author)

**Spec coverage (3a scope):** single SNI Loft icon ✓; badge/DND overlay ✓ (Task 3); services menu with per-service DND + show/hide + settings + quit ✓ (Tasks 4/5); StatusNotifierWatcher registration + `[0,2,4,8,16]s` backoff + re-register ✓ (Task 1); wired to Stage-2 badges + Stage-1 windows + persisted DND ✓ (Task 6). Deferred (documented): GNOME-native panel backend, `tray_backend` switch, GNOME Shell helper, KWin, `chat.loft.Loft` D-Bus → 3c; notification gating on DND → 3b.

**Placeholders:** the D-Bus protocol objects (SNI, dbusmenu) are specified by interface/property/method/signal + spec reference rather than full wire-format code — a deliberate granularity for a protocol port (the `org.kde.StatusNotifierItem` and `com.canonical.dbusmenu` specs + `tray.rs` are the authoritative sources; reproducing the boilerplate verbatim in the plan adds no value). The pure/testable seams (backoff, overlay selection, menu model) have full code + tests.

**Type consistency:** `MenuModel`, `OverlayKind`, `ServiceTrayState`, `TrayModel`, `SniItem`, `DbusMenu`, `startTray` deps, `ServiceConfig.dnd` are defined once and consumed consistently. `service:badge` → `tray.setBadge` matches Stage 2.

**Known follow-ups:** 3b gates notifications on the `dnd` state this stage persists; 3c adds the GNOME-native panel backend (so the SNI AppIndicator-extension dependency on GNOME goes away) + moves menu window-actions onto the focus-stealing-bypass path.
