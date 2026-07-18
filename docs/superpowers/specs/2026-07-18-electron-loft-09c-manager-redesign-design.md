# Electron Loft 09c-1 — Manager redesign

**Status:** design approved (2026-07-18), pending implementation plan.

The first of three 09c "polish" slices (the others: live-view detach; a small correctness grab-bag — launcher enforcement, Telegram deeplink, badge-path perf). A deferrable rich-GNOME-tray plan and a separate per-service-deeplinks spec sit outside 09c.

## Why

09b moved the manager *inside* the Loft window but loaded today's hub renderer unchanged. That renderer is a tall, narrow, phone-style page-router (`App.svelte` swaps `main`/`detail`/`settings`/`about` in one column). Dropped into the ~1048px content rect (1100px window − 52px rail) it has four concrete problems:

1. **No way to reach the manager from the rail.** The rail (`rail.ts`) lists installed services as 34px glyph buttons — click to switch, right-click for the per-service menu — but has no home/settings/add button. Once a service is selected there is no in-window path back to the manager. Today it surfaces only on cold start (nothing selected) or via tray "Settings."
2. **Two stacked "Loft" headers.** When the manager shows, the window's titlebar view says "Loft" *and* the manager's own `<header>` says "Loft" + hamburger.
3. **The manager duplicates the rail.** `ServiceList.svelte` shows an "Installed" list that is now exactly the rail's job.
4. **Sparse layout.** A narrow phone column stranded in a wide rect.

This slice redesigns the manager for its home, and folds in the `hubIpc.ts` test seam (main's side of `hub:*` lost its unit test when `hubWindow.ts` was deleted in 09b, because `index.ts` is unimportable under vitest).

## Decisions (from brainstorming)

- **Manager's role — "add + settings surface."** The rail is the single installed-service list and switcher. The manager drops its Installed list. Its jobs: **add a service** (the star), **per-service settings**, **global settings**, **about**, **quit**.
- **Layout — master–detail.** Inside the content rect: a left nav column + a right detail pane. Nav = `Add a service`, a `Configure` section listing each installed service, and a footer (`Settings`, `About`, `Quit Loft`). The detail pane renders whatever the nav has selected. The `Configure` list mirrors the rail's membership but is **not** a second switcher — it is settings-navigation (pick which service to *configure*), the way a settings app lists the things you can configure down its left edge. Selecting one shows its settings pane; it never selects the service's live tab.
- **Reach — a Loft "home" button at the top of the rail.** Pinned above the service glyphs (Discord/Slack-workspace idiom), it selects the manager. It is the rail's `active` item exactly when no service is (`active === undefined`).
- **Per-service settings also reachable by right-clicking a rail icon → "Settings…"**, which opens the manager with that service selected in Configure.
- **Chrome cleanup.** The manager's own `<header>` (title + hamburger) is removed; the window titlebar already shows "Loft" when the manager is active. The hamburger's items move into the nav: `Settings` and `About` to the footer, `Quit Loft` to the footer. The titlebar ✕ stays hide-to-tray (not quit).
- **Theme.** Follows the system theme (light/dark), unchanged from today.

## Non-goals (explicitly deferred)

- **Live-view detach** — 09c-2. Detach still unloads-and-reloads until then.
- **The opt-in launcher checkbox and its enforcement sweep** — 09c-3. The per-service detail pane leaves room for the checkbox but does not add it here.
- **Deeplinks / navigate, rich GNOME tray rows, drag-to-detach** — other slices / specs.
- **No change to `HubState` shape.** Services already carry an `installed` flag and their settings; the redesign only consumes that data differently (rail = installed, Add pane = not-installed, Configure = installed). Nothing new crosses the wire except a `manager:select` push (below).

## Components

### 1. Rail — the Loft "home" button (`src/renderer/rail/`, `src/preload/rail.ts`, `src/main`)

- `rail.ts` renders a fixed home button at the top of `#rail`, above the service list, with a divider. It carries `aria-current="page"` / an `.active` class when the pushed state says the manager is active.
- The rail model must tell the renderer whether the manager is the active selection. Options: extend the `rail:state` payload to `{ items, managerActive }`, or send a separate `rail:manager-active` boolean. **Chosen:** widen the push to an object so a single message stays the source of truth. `buildRailModel` is unchanged (it still returns items); `loftWindow`'s `refreshRail` wraps it: `{ items: model(), managerActive: active === undefined }`.
- `window.loftRail` (preload) gains `showManager()`. Clicking the home button calls it → IPC → `index.ts` → `loft.showManager()`.
- The home button is not a service: no badge, no context menu, no sleeping state.

### 2. Manager renderer — master–detail (`src/renderer/hub/`)

Replace the page-router in `App.svelte` with a master–detail shell.

- **Selection state** is one value: `'add' | { service: id } | 'settings' | 'about'`. Default on load: `'add'`.
- **Pure model, unit-tested (matches the `railModel` pattern).** Extract the nav's shape into `src/renderer/hub/managerModel.ts`: given `HubState`, return the nav structure — `{ addLabel, configure: {id, displayName}[], footer: [...] }` — and a resolver that maps a selection to which pane component renders. Keeping this pure keeps the Svelte thin and gives us a jsdom-free unit test.
- **Components:**
  - `ManagerShell.svelte` (replaces `App.svelte`'s router body): renders the left `<nav>` from the model + the right pane; owns selection state; no `<header>`, no hamburger, no Back button.
  - `AddServices.svelte`: the not-installed services as Add tiles (today's `AvailableTile` grid, promoted to a first-class pane). Empty state when everything is installed ("You've added every service Loft supports").
  - `ServiceDetail.svelte` (existing, adapted): no longer a pushed page with a Back button — it *is* the right pane. Same fields (Server URL for self-hosted; Open on startup + inline autostart warning; Show unread badge; Do Not Disturb; Troubleshooting → Clear cache & reload; Remove…). The `onBack` prop is dropped.
  - `GlobalSettings.svelte`, `About.svelte`: existing, rendered as panes.
  - **Removed:** the hamburger dropdown, the `‹ Back` button, `ServiceList.svelte`'s Installed list. `ServiceRow.svelte` becomes unused (delete). `AvailableTile.svelte` folds into `AddServices`.
- **Welcome / empty state:** when no services are installed, the Configure section is empty and `AddServices` is the natural landing — it already carries the welcome copy.

### 3. Right-click → "Settings…" wiring (`src/main`)

- `buildServiceMenu(id)` (main, native menu) gains a **"Settings…"** item. It calls `loft.showManager()` then `loft.sendManager('manager:select', id)`.
- `ManagerShell` listens for `manager:select` (exposed through the manager preload as `window.loftHub.onSelect(cb)`) and sets its selection to `{ service: id }`. Because the manager view pulls its own first state over `hub:getState`, a push that arrives before load is a no-op the renderer recovers from on its next `hub:state` — but `manager:select` is only ever sent in response to a user action on an already-open app, so the view is loaded; no cold-start race here (unlike the rail/titlebar).

### 4. `hubIpc.ts` test seam (`src/main/hubIpc.ts`, `src/main/index.ts`)

- Extract main's `hub:*` handling out of `index.ts` into `src/main/hubIpc.ts`: a `registerHubIpc(deps)` that wires the `ipcMain.handle`/`on` channels (`hub:getState`, `hub:setServiceSetting`, `hub:removeService`, `hub:recoverService`, `hub:quit`, and whatever else is there today) to injected dependencies (config, host registry, autostart, install/remove, recover).
- The **state-shaping** (`buildHubState(config, services, hosts…) → HubState`) and the **mutation** helpers become pure functions taking plain inputs, so vitest can exercise them without Electron. This restores the coverage lost with `hubWindow.ts`.
- This is a *move + seam*, not a rewrite of the handlers. Behaviour is unchanged; only the boundary moves so it's importable and testable.

## Data flow (reach paths)

```
Rail home button ──click──▶ loftRail.showManager() ──IPC──▶ index.ts ──▶ loft.showManager()  [select(undefined)]
Rail icon right-click ──▶ native menu "Settings…" ──▶ loft.showManager() + loft.sendManager('manager:select', id)
                                                                                   │
                                                        ManagerShell.onSelect(id) ─┘ ──▶ selection = {service:id}
Nav "Quit Loft" ──▶ window.loftHub.quit()  (exists)
Manager data ──▶ hub:getState / hub:state  (existing; shape unchanged)
```

## Testing

- **Vitest — `managerModel.ts`:** nav structure for zero / some installed services; selection→pane resolution; default selection is `add`; footer contents.
- **Vitest — `hubIpc.ts`:** the restored seam — `buildHubState` shape (installed flag, per-service settings, globals incl. `autostartBlocked`); `setServiceSetting` / `removeService` / `recoverService` route to the right dep with the right args; `hub:quit` triggers app quit. No Electron import required.
- **Vitest — rail state payload:** `refreshRail` emits `{ items, managerActive }` and `managerActive` is true exactly when `active === undefined`.
- **`svelte-check`:** the redesigned hub renderer type-checks (drop the removed components' imports).
- **Manual checklist:** reach the manager via the rail home button; right-click a rail icon → "Settings…" opens the correct service's detail; add a service from the Add pane; toggle each per-service setting and confirm it persists; autostart-blocked warning appears inline under Open-on-startup when applicable; Quit from the nav footer; light and dark both read correctly; the two-header duplication is gone.

## Edge cases

- **No services installed:** rail shows only the (active) home button; manager lands on `AddServices` with welcome copy; Configure is empty.
- **Right-click "Settings…" on a sleeping (not-loaded) service:** per-service settings are config, not the live view, so the detail pane opens without loading the service.
- **Selecting the manager while a service is focused:** `select(undefined)` hides all service views and shows the manager; the home button becomes active and no service is. (Existing 09b behaviour.)
- **Window OS title while the manager is active:** "Loft" / "Loft (N)" summing attached badges — unchanged from 09b.
- **`manager:select` before the manager view has loaded:** cannot happen in practice (it follows a user click on the running app), and if it ever did, the renderer's `hub:getState` pull leaves selection at the default `add` — a harmless miss, not a broken view.

## File-level impact (orientation for the plan)

- `src/renderer/hub/App.svelte` → becomes `ManagerShell.svelte` (master–detail; router + header removed).
- New `src/renderer/hub/managerModel.ts` (pure, tested) + `src/renderer/hub/components/AddServices.svelte`.
- `ServiceDetail.svelte` adapted (drop Back/onBack); `GlobalSettings.svelte`, `About.svelte` reused as panes.
- Delete `ServiceRow.svelte`; fold `AvailableTile.svelte` into `AddServices`; `ServiceList.svelte` removed.
- `src/renderer/rail/rail.ts` + `rail.css` + `src/preload/rail.ts`: home button + `showManager()`; `rail:state` payload widened.
- `src/main/loftWindow.ts`: `refreshRail` emits `{ items, managerActive }`.
- `src/main/index.ts`: `buildServiceMenu` gains "Settings…"; `hub:*` handlers move out.
- New `src/main/hubIpc.ts` (`registerHubIpc` + pure `buildHubState`/mutation helpers).
