# Electron Loft — Unified view: one window, many services — Design

Status: approved (Keith, 2026-07-17). Branch: `electron-rewrite`. NOT merged to main.

Follows the tray DND label fix (HEAD `379b8bf`). This is the **first feature past v1 parity** — the thing the
rewrite was for. It is the spec deliberately deferred by decision #5 of `dev_local/electron-rewrite-decisions.md`
("Unified tabbed view and new features are explicitly OUT of scope (their own spec later)").

## 1. Why / scope

Loft has reached parity with the Rust+Chrome v1: every service works, calls work, tray/notifications/DND work.
Parity alone does not justify a rewrite. Decision #3 of the rewrite design chose `WebContentsView`-per-service
**specifically so this could exist**: "v2 unified window re-parents the SAME view objects into one window + tab
strip (additive)." This spec cashes that cheque.

**In scope:** the unified window, per-service attach/detach, the rail, the manager surface moving inside it,
sleeping services, tray/D-Bus/GNOME-helper adaptation, opt-in launchers, notification *routing*, migration.

**Out of scope, deliberately:**

- **Per-service deeplink implementation** (WhatsApp/Slack/Element/Talk sourcing an `href`). Its own spec. See §9.
- Anything not required to make the above work.

## 2. Resolved decisions (Keith, this session)

- **Not a mode — per-service window membership.** Rejected: a global unified/separate switch, a first-run
  wizard, a menu toggle. A service is *attached* (lives in the Loft window) or *detached* (its own window), and
  that is a per-service property. There is nothing to switch, so there is no wizard and no reconciliation
  problem. Detach is also the **escape hatch for the one real regression** (§4).
- **The hub *is* the unified window.** Rejected: two windows. The Loft window is both manager and container. With
  zero services attached it degrades to exactly today's hub, so the empty state needs no design and no mode.
- **`openOnStartup` decides what loads.** Rejected: load-everything-always, and lazy-on-click. The existing
  per-service flag already means "have this running at startup"; reusing it keeps **derived autostart**
  (`autostart.ts:95`, spec 08) intact. Load-everything-always would have collapsed `openOnStartup` into precisely
  the global "start at login" toggle spec 08 removed.
- **One desktop identity: `Loft` / `Loft (7)`.** Rejected: title-follows-active-tab; fake per-service alt-tab
  entries via helper pseudo-apps. Attached services lose per-app alt-tab. This is accepted, not overlooked (§4).
- **GNOME gets the rich tray menu; SNI falls back to submenus.** Rejected: mirrored layouts. Knowingly abandons
  the "panel menu mirrors the SNI menu" rule in CLAUDE.md. Cost is contained because the backends already diverge
  in mechanism — `gnomePanel.ts` pushes per-service diffs and the extension renders its own widgets, while
  `dbusMenu.ts` builds a tree. The shared `MenuModel` stays the single source of truth.
- **Layout A — full-height rail**, titlebar beside it belonging to the active service. Rejected: titlebar-on-top;
  top tab strip. The Ferdium/Slack/Discord shape; the existing titlebar view (icon + name + zoom + ✕) keeps its
  meaning and gains a rail.
- **✕ hides the window; the rail's right-click menu unloads.** Rejected: per-item ✕; ✕-unloads-service. Preserves
  "close **is** hide" (CLAUDE.md) and keeps one ✕ per window.
- **Launchers are an opt-in per-service setting, default off.** Rejected: launcher-follows-detach-state (would
  write and delete `.desktop` files on every drag, and desktop environments cache them aggressively);
  keep-for-everything; drop-entirely. Unified view ships **one** launcher — Loft. A service gets its own only if
  the user ticks the box, independent of detaching.
- **Detached state is remembered**, with a startup override worded *"Reopen detached services in their own
  windows"* (ticked by default).

### 2a. A constraint that killed Keith's first tray sketch — recorded so it is not re-derived

The original sketch had rows like `- Messenger [DND] [X]` with inline controls. **Not renderable over SNI.** The
DBusMenu spec gives label, enabled, icon, `toggle-type` (checkmark/radio), and submenus. There are no inline
buttons in a menu item. The GNOME panel menu *can* do it (the helper builds real St widgets), which is why the
resolution is divergence rather than a shared design. Do not re-propose inline controls for SNI.

## 3. The model

Four states. *Active* is not a state — it is which attached view is currently visible.

| State | Config entry | `ServiceView` | Rail | Badges + notifications |
|---|---|---|---|---|
| Not installed | no | — | absent | no |
| Installed, sleeping | yes | no | dashed icon | **no** |
| Installed, loaded, attached | yes, `detached: false` | in LoftWindow | icon | yes |
| Installed, loaded, detached | yes, `detached: true` | own window | icon + ⧉ | yes |

**The rail lists every installed service, including detached ones** (marked ⧉). Clicking a detached entry raises
its window instead of selecting a tab. The rail is the service list, not the tab strip — that is what makes it
the way *back* from a detached window, and what keeps `railOrder` meaningful across attach/detach.

"Loaded" keeps today's invariant, renamed off "window": present in the live map. Today that map is
`windows: Map<string, ServiceWindow>` (`index.ts:90`); it becomes `services: Map<string, ServiceView>` plus a
`hostOf(id)`.

Sleeping is not a new concept — it is today's tray "available" (`tray/model.ts:78-79`, *configured but not
running*). The word changes; the semantics do not.

## 4. The accepted regression: alt-tab

The GNOME helper finds windows **by title** — `title === key || title.startsWith(key + ' (')`
(`extension.js:113`), key = display name, the `' ('` form catching `WhatsApp (3)` from `serviceTitle.ts:2`.
KWin does the byte-identical thing (`kde/kwin.ts:38`). One window per service is what makes that work.

Attached services are not windows. They cannot have their own title, and — the part that matters — they cannot
have their own alt-tab entry. **The MRU ordering work in commit `4884e62` only has meaning for things the shell
sees as windows.** Under unified view, alt-tab shows `Loft`, not `WhatsApp`.

This is the one genuine functional loss, and it is why detach exists: *want WhatsApp on workspace 3, in your
alt-tab, in MRU order? Detach it.* The helper's alt-tab/overview/dash patches are **not** deleted — they keep
serving detached windows and the Loft window itself, exactly as today.

Rejected alternative — injecting one pseudo-app per attached service into `Shell.AppSystem.get_running` with
activation calling back over D-Bus to select a tab. It would preserve per-service alt-tab, but it is deep
GNOME-internals magic, GNOME-only (KDE gets nothing), and the likeliest thing to break on each shell release.

## 5. Architecture

### 5a. Split what a service *is* from what a window *is*

`serviceWindow.ts` (330 lines) currently tangles both. A service must now outlive its window, so:

- **`serviceView.ts`** — owns one service's `WebContentsView` + all its policy: session/partition, preload and
  `--loft-service=<id>`, badge state, zoom, nav + `setWindowOpenHandler`, recovery watcher. **Host-agnostic.**
- **`serviceWindow.ts`** — a *detached* host: BrowserWindow + titlebar view + one `ServiceView`. Today's file,
  minus what moved out.
- **`loftWindow.ts`** — the *unified* host: BrowserWindow + rail view + titlebar view + manager view + N
  `ServiceView`s.
- **`serviceHost.ts`** — the interface both hosts satisfy (`show`/`hide`/`focus`/`setBadge`/`navigate`/
  `setZoom`). **Tray, D-Bus and notifications talk to this and never learn where a service lives.**

Attach/detach is then one sentence: move a `ServiceView` between hosts. `contentView.removeChildView(v)` then
`otherWindow.contentView.addChildView(v)` — the `WebContents` belongs to the view, not the window, so the page
survives with scroll position and half-typed drafts.

### 5b. Layout

`computeLayout` (`layout.ts:10`) gains a rail region and is parameterised so **one function serves both hosts**
(detached passes `railWidth: 0`, yielding today's two-region result):

```ts
export const RAIL_WIDTH = 52;      // alongside the existing TITLEBAR_HEIGHT = 40

rail:     { x: 0,      y: 0,  width: RAIL_W,   height: H    }
titlebar: { x: RAIL_W, y: 0,  width: W-RAIL_W, height: 40   }
content:  { x: RAIL_W, y: 40, width: W-RAIL_W, height: H-40 }
```

The manager view and every attached service view share the `content` rect; exactly one is `setVisible(true)`.
`View.setVisible()` exists in Electron 43.1.0 and is documented as *"whether the view should be drawn"* — not a
renderer suspend. With `backgroundThrottling: false` already set (`serviceWindow.ts:88`), inactive tabs keep
scraping badges and firing notifications exactly as hidden windows do today.

### 5c. Config

```ts
interface Bounds      { x?: number; y?: number; width: number; height: number }
interface WindowState extends Bounds { zoom: number }   // per-service, unchanged

interface ServiceConfig {
  customUrl?; window?; openOnStartup?; dnd?; badgesEnabled?;  // unchanged
  detached?: boolean;   // NEW — reopen in its own window
  launcher?: boolean;   // NEW — opt-in .desktop, default false
}
interface LoftConfig {
  services; globalDnd?; trayBackend?;                          // unchanged
  configVersion?: number;     // NEW — 2; gates migration (§8)
  window?: Bounds;            // NEW — the Loft window's own bounds
  reopenDetached?: boolean;   // NEW — default true
  railOrder?: string[];       // NEW — drag-to-reorder within the rail
}
```

**Targeted fix, in scope:** `loadConfig` (`config.ts:41-59`) validates the top level but never the inner
`ServiceConfig` — a malformed `window` object passes through and becomes a `BrowserWindow`'s width and height.
This spec adds a second bounds path reading the same file, so `ServiceConfig`/`Bounds` get validated now.

## 6. Desktop integration

### 6a. Identity

Loft window title: `Loft`, or `Loft (7)` where 7 = summed unread over **attached, loaded, badges-enabled**
services. Reuses `formatWindowTitle` (`serviceTitle.ts:2`) with `Loft` as the name, so the helper's existing
matcher handles it **unchanged**. Detached windows keep display-name titles. `windowKeys()` (`index.ts:98-101`)
pushes `['Loft', ...detachedNames]` to `SetLoftWindows`.

Two different sums, deliberately: the **window title** counts attached services only, because it names *that
window's* contents — a detached Slack has its own `Slack (2)` title. The **tray icon overlay** keeps aggregating
across every loaded service, attached or not, because the one tray icon represents the whole app. Same for the
GNOME background-status line (`gnome/backgroundStatus.ts`), which is unchanged.

`focusExternal`/`hideExternal` start taking the **host's** key: `focusService('slack')` → `focusExternal('Loft')`
+ select tab when attached, `focusExternal('Slack')` when detached.

### 6b. D-Bus — no new methods, no signature changes

Only the referent of "this service" widens to "this service's host":

| Method | Attached | Detached |
|---|---|---|
| `Show()` | load if sleeping, select tab, show+focus Loft | today |
| `Hide()` | hides the **Loft window**, and with it every other attached service | today |
| `Toggle()` | Show unless already visible **and** active | today |
| `Quit()` | unload the view → sleeping | today (destroy window) |
| `GetStatus()` | `visible` = Loft visible **and** this is the active tab | today |

`Hide()` on an attached service is a documented wart: the only way to make it not-visible is to hide its host.
Better than inventing a fourth verb. `Quit()` already means exactly "unload", so the tray's per-row ✕ maps onto
an existing method for free.

**`SetDetached(b)` is deliberately omitted** (YAGNI): the rail menu drives detach over IPC, and nothing outside
the app needs it.

### 6c. Tray

`ServiceTrayState` (`tray/model.ts:5-13`) gains **one** field, `detached`, so rows render ⧉ and pick verbs. The
running/available split needs no rework (§3). `UpdateCombinedService`'s signature grows a bool.

- **GNOME (rich):** global DND · Show/Hide Loft · per-service rows (click = go to, inline DND, inline ✕ →
  `Quit()`) · Settings… · Quit Loft.
- **SNI (submenus):** same model; each service is a submenu parent with `Go to <name>` as its first child, then
  DND, then Unload.

### 6d. Notifications

Routing: resolve host → load if sleeping → select tab → show+focus → navigate. The Messenger-only branch
(`preload/notify/bridge.ts:93`) becomes a **per-service strategy table** (§9).

**The bug this feature would otherwise ship with.** `recomputeHidden` (`notifications/index.ts:75-79`) pushes
`!(focused && visible)`; the DND gate (`gate.ts:10-14`) suppresses when a service is focused **and** visible.
Both are correct today because *visible* means "its window is on screen". In the unified window, **every attached
service counts as visible whenever Loft is focused** — so every tab you are not looking at goes silent, and its
web app suppresses its own `Notification` calls too. Both rules become:

```
focused && visible && isActive       // isActive is always true for a detached service
```

This is the likeliest thing to be missed and the hardest to catch, because **it fails as absence**. It gets
table-driven tests (§10).

### 6e. Launchers

`writeServiceLauncher` gates on `launcher === true`. The startup self-heal loop (`index.ts:385-390`) gains a
matching sweep that **removes** `loft-<id>.desktop` when the flag is false, so unticking the box cleans up.

Autostart needs **no change** — still derived from `openOnStartup` (`autostart.ts:95`). That surviving intact is
the payoff from choosing `openOnStartup` as the load gate.

### 6f. CLI

`--service=X` keeps its flag, gains routing: load if sleeping → show its window or select its tab. Never-installed
X keeps today's implicit install (`index.ts:111-114`) and attaches by default.

**One deliberate behaviour change:** today `--service=X` skips the `openOnStartup` loop entirely
(`index.ts:472-473`), so launching WhatsApp from its launcher does not start Slack. Since the Loft window now
always exists, `openOnStartup` services always load regardless of `--service`. More consistent — but users who
relied on a per-service launcher starting only that service will get their whole startup set.

## 7. Interaction

**Drag.** Within the rail: reorder, persisted to `railOrder`. Out of it: past a threshold the rail sends
`rail:drag-start`; main adds a transparent overlay `WebContentsView` across the content rect to own the pointer,
and tears it down on release. **The overlay is necessary**, not defensive: the moment the pointer leaves the
rail's `RAIL_W`, events belong to WhatsApp's actual page, and that renderer will not cooperate.

**Wayland limit.** The detached window lands where GNOME puts it, not at the drop point. Electron cannot position
a window under the cursor on Wayland; Chrome does tab-drag via the `xdg_toplevel_drag` protocol, which Electron
does not expose. **The gesture carries intent, not placement.** Two reliable equivalents sit alongside it: the
rail's right-click → *Detach to own window*, and the settings checkbox.

**Re-attach needs its own affordance** — you cannot drag between OS windows either. The titlebar's service icon
becomes a menu button in **both** hosts, opening the same per-service menu. In the Loft window it is a
convenience; in a detached window it is the only door back, holding *Move into Loft window*.

**Menus** use `Menu.popup()` from main — native, no CSS menu to build.

**Renderers.** New `src/renderer/rail/`. The existing `src/renderer/hub/` becomes the manager view inside the
Loft window, restructured to General + per-service pages + the add gallery — the rail *is* the installed-services
list, so the manager no longer repeats it. Most `hub:*` channels survive; `hub:openService` becomes select-tab.
`hubWindow.ts` is **deleted**; `ShowHub()` becomes show Loft + select manager.

**Startup:** load config → migrate → create Loft window hidden → for each `openOnStartup` service create its view
and place it per `detached && reopenDetached` → show unless `--minimized`. The `reopenDetached: false` override
governs **startup only**; detaching mid-session still writes `detached: true`.

**Edge cases:**

- Detaching or unloading the *active* service selects the next attached one, or the manager if none. Detaching
  the last one leaves the Loft window showing the manager — fine, that is today's hub.
- ✕ on the Loft window hides only it. Detached windows stay; the tray still lists everything.
- **Unloading must clear `currentBadge`**, or the tray icon and `Loft (7)` keep a badge for a view that no longer
  exists.
- A notification clicked for a since-unloaded service must **queue its `href`** until the fresh view's first
  `did-finish-load`, or navigate fires into a blank page.

## 8. Migration

`configVersion: 2` gates a one-shot migration. Upgrading from unversioned:

```
launcher = existsSync(launcherPath(id))     // for every service already in config
```

Evidence from disk, not a guessed default — matching how `isAutostartEnabled()` (`autostart.ts:58`) already
judges state by reading it back rather than trusting a flag. **Nobody's launchers vanish, and nobody gets new
ones.** Without this, the new `launcher: false` default would silently delete the six `.desktop` files every
existing user has, on first run, via the self-heal sweep in §6e.

`detached` is absent → false → everything attaches. An upgrading user's first launch is the unified window with
their services in the rail.

## 9. Deeplinks — contract here, implementation elsewhere

What actually happens today (`preload/notify/bridge.ts:92-105`):

| Service | Sends `href`? | Navigates on click? |
|---|---|---|
| Messenger | yes | yes — anchor click, else full nav |
| Telegram | yes | **no** — silently dropped by a `serviceId !== 'messenger'` guard |
| WhatsApp, Slack, Element, Talk | no, hardcoded `''` | never — focus only |

So click-to-conversation only works for Messenger **today**, in the per-service-window world. Unified view does
not break it; it adds "select the right tab" on top. Two separable problems:

- **In scope — routing + the contract.** Main resolves a service to its host, selects/loads it, then calls
  `navigate(id, href)`. `navigate` becomes a per-service **strategy table** with a real interface, replacing the
  Messenger-only if-branch. Telegram gets a real strategy as proof the contract works — its `href` already
  arrives and is currently thrown away. The other four get a null strategy.
- **Its own spec — per-service `href` sourcing** for WhatsApp/Slack/Element/Talk. Not uniform work: Element has
  routable URLs (`#/room/!id`), Talk has `/call/<token>`, Slack has channel URLs, and **WhatsApp Web has no URL
  routing for chats at all** — selection is pure in-page state, needing sender-matching by DOM scrape. That is
  per-service research, not a design decision, and it must not be allowed to stall the window architecture.

## 10. Testing

**Spike first, before any implementation.** Two assumptions carry the whole design:

1. Re-parenting a live `WebContentsView` between windows preserves the page (no reload, `webContents` id and
   page state survive). If false, detach becomes "reload in a new window" and the drag gesture needs rethinking.
2. **A voice/video call works in an *attached* tab.** Calls working is Loft's entire reason to exist over
   Ferdium, and the `window.open` popup handler carries the SIGSEGV fix — `sandbox: true`,
   `contextIsolation: true`, `additionalArguments: []` on the child (`serviceWindow.ts:128-162`), because a popup
   inherits its opener's prefs and a non-sandboxed WebRTC renderer crashes on some GPU stacks. That handler moves
   to `ServiceView` and must keep working when the opener is a view **inside** the Loft window. If anything here
   breaks Loft's reason to exist, it is this — so it is verified in the spike, not at the end.

**Unit (Vitest):** `computeLayout` with a rail (and `railWidth: 0` reproducing today's result); the
attach/detach/load/unload state machine against a fake host; migration (launcher inferred from disk,
`configVersion` stamped once, idempotent); `ServiceConfig`/`Bounds` validation incl. malformed input; menu model
with detached rows; title aggregation (`Loft` / `Loft (7)`, attached-only, badges-disabled excluded);
`SetLoftWindows` keys; navigate strategy table (Telegram routes, WhatsApp no-ops); **table-driven
`focused && visible && isActive`** — non-negotiable, its failure mode is silence.

**`svelte-check`:** the rail and the restructured manager renderers.

**Manual:** drag-out on GNOME Wayland; alt-tab shows one Loft plus each detached window; a background tab's
notification actually fires; per-service DND from both tray backends; suspend/resume re-registration; Flatpak run.

## 11. Staging

This is a big spec — deliberately one spec, because a half-built unified window ships nothing, but the plan must
stage it. The natural seam is that **§5a lands first as a pure refactor with no behaviour change**: extract
`ServiceView` and `serviceHost` out of `serviceWindow.ts`, leave the per-service window as the only host, keep
every test green. That is independently verifiable and independently revertable, and it is where the spike's
findings (§10) land. Only then does `loftWindow.ts` appear behind it.

## 12. What this delivers

The first thing the rewrite buys that v1 could not do at all — Chrome-in-`--app=`-mode had no way to host six
services in one window. It arrives without a mode switch, without a wizard, and without touching derived
autostart. And it does not take per-app alt-tab away from anyone who wants it: that is what detach is for.
