# Loft

Linux desktop integration layer for web apps (WhatsApp, Facebook Messenger, Slack, Telegram, Element, NextCloud Talk) that provides full functionality including voice/video calling, system tray integration, and proper desktop presence.

## Problem

Messaging apps don't provide good desktop apps on Linux. Existing workarounds:

- **Third-party Electron wrappers** (e.g. Ferdium): historically thought to lack voice/video calling because of WebRTC issues with Electron's Chromium build. Loft's own proof-of-concept disproved that for WhatsApp, Messenger, and Slack — calls, video, and screen-share all work in vanilla Electron. The actual breakage in wrappers like Ferdium was a missing `window.open` handler for call popups, not a fundamental Electron/WebRTC limitation.
- **PWAs from Chrome**: Full functionality works, but no tray icon and poor system integration.

Loft is a self-contained Electron app that gets the full functionality of a real browser tab (Electron bundles Chromium directly, no separate browser required) plus the desktop integration a bare PWA can't provide — tray icons, badge counts, native notifications, close-to-tray, and GNOME/KDE-specific window management.

## Architecture

Loft is **one Electron application** that hosts every installed service, not a manager plus a fleet of daemons:

- **Single-instance lock** (`app.requestSingleInstanceLock()`) — only one Loft process ever runs; a second launch (e.g. `loft --service slack`) is routed to the running instance via the `second-instance` event and argv, then exits.
- **One app identity**: `app.setAppUserModelId('chat.loft.Loft')`, and the app exports one D-Bus bus name (`chat.loft.Loft`, see below) instead of the old per-service bus names.
- **One main process** owns everything non-web: the service registry, window/view lifecycle, tray, notifications, D-Bus, config, autostart, and `.desktop` generation. This replaces what used to be a separate daemon per service.
- **A hub window** (Svelte 5 + Vite renderer) is the manager UI — install/remove services, per-service and global settings, live running/badge status pushed over IPC (no polling).
- **A frameless `BrowserWindow` per running service**, each with its own titlebar `WebContentsView` (icon + name + zoom controls + close-to-tray) stacked above the service's own `WebContentsView`, which renders the web app **in-process** — Electron's bundled Chromium, not an external browser. The service view is deliberately kept separate from the titlebar view (rather than merged into one window/view) so that a future unified/tabbed window can re-parent the same view objects.

- **Pinned conversations ("bubbles")** sit below the services in the rail: a round avatar with the service's icon badged bottom-right. A bubble shows an unread **dot** (never a count) top-right, gated exactly like a service's own badge — nothing while that service sleeps or has badges disabled, and DND does not suppress it. Unread state is ephemeral and never persisted; it clears when the scrape stops reporting the conversation, when it is observed open (read by definition — the signal that still works when the row has scrolled out of a virtualised list), or when the bubble is clicked. A bubble whose service is asleep is greyed with the same `opacity: .45; filter: grayscale(1)` the service icons use, because a bubble with no dot would otherwise be ambiguous between "nothing unread" and "nobody is looking". Bubbles reorder by vertical drag, among themselves only — they never detach and never enter the grid, so the gesture is its own small one rather than the service icons' machinery (which exists to resolve reorder-vs-detach-vs-grid from the release point). A press shorter than 4px is a click, since a bubble has no separate drag handle.

- **A grid view** (`src/main/gridTree.ts`, `gridLayout.ts`, `gridDrop.ts`, `src/renderer/grid/`) tiles several live services in the Loft window's content rect at once, selected from a pinned **Grid** entry at the top of the rail. The arrangement is a binary split tree persisted as `grid` in `config.json`. **This is the one place the "exactly one visible view in the content rect" invariant does not hold** — see the stacking note below, which is load-bearing rather than stylistic.
- **Multiple accounts** (`src/main/registry.ts`, `src/main/instances.ts`) — the registry lists **kinds** (`ServiceKind`, `KINDS`): the app itself (URL, badge parser, brand icon), not an account. A `config.services` entry is an **instance**, one account of a kind. Instance 1 of a kind keeps the bare kind id (`whatsapp`); later ones are `<kind>-<N>` (`whatsapp-2`). `kind`/`name`/`icon` are optional per-service config fields — absent means default (the id itself, the kind's display name, the brand icon) — so an existing `config.json` needs no migration and `configVersion` stays unchanged. The service preload argument (`--loft-service=`) carries the **kind**, never the instance id: it selects the badge parser, the Messenger/Telegram scrape-only notification rule, the Slack/Talk avatar scanners and the Messenger de-chroming — all properties of the app, not the account. Everything else (the session partition, the `loft://icon/<id>` lookup, the `.desktop` launcher, `railOrder`, the grid tree) already keyed on the instance id before multiple accounts existed, so none of that plumbing changed.

There is no separate daemon process, no launching of a real Chrome binary, and no Chrome extension / native-messaging host — sandboxed preloads take over what the extension used to do (see Components below).

> **Note:** the two bullets above about per-service `BrowserWindow`s describe the *detached* case. Since the unified-view work, services are attached to the single Loft window by default and detaching is the opt-out. Those bullets predate that change and are due a rewrite that is out of scope here.

### Components

1. **Hub window** (`src/main/hubWindow.ts`, `src/renderer/hub/` — Svelte 5 + Vite) — the manager UI, opened by `loft` with no `--service` flag (or a second launch with no service and no `--minimized`)
   - Installed services: icon, name, live running/badge status, Open button, per-service settings (gear)
   - Available services: not-yet-added services, shown as tiles to Add
   - Per-service settings: custom URL (Element/Talk), **Auto Open** (a three-way choice — Disabled / On login / On launching Loft), badges on/off, DND, remove (with an explicit "also delete login data" option)
   - Global settings: tray backend, appearance (follows the system theme), developer mode. There is deliberately no "start at login" toggle — autostart is derived from the per-service Auto Open flags (a service set to **On login**; see the File Layout note). When autostart is blocked, the warning is rendered next to that service's own Auto Open control in the per-service settings, **not** here: a warning on a page reached via a menu the user has no reason to open is the same silent failure the derived model exists to remove
   - Add/remove writes/removes that service's `.desktop` launcher and (on remove, if requested) deletes its partition data

2. **Per-service window** (`src/main/serviceWindow.ts`) — one frameless window per running service
   - Its own titlebar `WebContentsView` (`src/renderer/titlebar/`): service icon + name (+ live unread count), a drag region, zoom-out/zoom-in ("A" glyph buttons, not `+`/`-`) and a close (✕) button
   - Close (✕) hides the window to the tray — there is no separate minimize button; close *is* hide
   - Hidden windows stay alive (not destroyed) so badge scraping and notifications keep working in the background; destroyed only on remove-service or app quit

3. **Sandboxed preloads replace the Chrome extension** (`src/preload/service.ts` + `src/preload/badge/`, `src/preload/notify/`, `src/preload/dechrome.ts`)
   - Each service `WebContentsView` gets its preload with the service id injected directly as a launch argument (`--loft-service=<id>`), not derived from the page's origin — so there's no manifest, no `host_permissions`, and no generated origin-to-service override map. **Self-hosted Element and NextCloud Talk instances just work** by loading the custom URL with the same preload.
   - Badge scraping (`src/preload/badge/parsers.ts`): per-service DOM/title parsers (WhatsApp `aria-label`, Slack unread channel rows, Element `document.title` `[N]`, NextCloud Talk sums `.counter-bubble__counter`, Telegram/Messenger unread conversation counts), driven by a `MutationObserver` + polling, sent to main via `service:badge` IPC.
   - Notification interception (`src/preload/notify/`): the service view is `sandbox:true` + `contextIsolation:false`, so its (sandboxed) preload still shares the page's real main world and can `require('electron')` — it wraps `window.Notification` directly and relays to main via IPC instead of Chrome's native-messaging wire format. (`sandbox:true` is load-bearing, not incidental: a same-origin call popup opened via `window.open()` inherits the opener's renderer process, and a `sandbox:false` service view previously made that popup a non-sandboxed WebRTC renderer that crashed on some GPU stacks.) Messenger and Telegram stay DOM-scrape-only (their native notifications are suppressed, not relayed) to avoid duplicates; WhatsApp/Slack/Element/Talk go through the override path. A separate gate wraps `HTMLMediaElement.play` so the web apps' own in-page notification sounds (not just the OS notification) respect DND/focus.
   - De-chroming (`src/main/dechromeCss.ts`, injected via `webContents.insertCSS`): removes Messenger's navigation banner and Talk's app header/sidebar chrome so the content fills the window.

4. **Tray** (`src/main/tray/`) — a single combined "Loft" icon (there are no more per-service tray icons); left-click opens a menu listing every configured service (each with Show/Hide, per-service DND, Quit) plus a global DND toggle, Settings (opens the hub), and Quit. Two backends, selected by `trayBackend` in config (`auto` | `gnome-panel` | `sni`; `auto` → GNOME panel on GNOME, SNI elsewhere):
   - **SNI**: hand-rolled `StatusNotifierItem` over `dbus-next` (no native/C dependencies), with unread/DND overlay pixmaps composited at runtime and spawn-retry backoff for `org.kde.StatusNotifierWatcher` at login.
   - **GNOME panel**: a native panel button rendered by the GNOME Shell helper (below), driven by the same tray model.

5. **Notifications** (`src/main/notifications/`) — a hand-rolled `dbus-next` client for `org.freedesktop.Notifications`, kept on a persistent connection (KDE closes notifications when the sender disconnects). Avatars are resolved in the main process via each service's own partition session (`session.fetch(url)`, so **cookie**-authenticated avatars — NextCloud Talk's — work), cached on disk for about an hour. **Element is the exception and its avatars are read in the page instead**: Synapse serves authenticated media, and the access token lives in the page (Element's service worker attaches it) rather than in a cookie, so the URL its `<img>` renders returns `404 application/json` to main no matter which session fetches it. Both avatar paths handle this the same way — `bridge.ts` inlines the notification icon to a data URI, and `CapturedConversation.inlineAvatar` does the same for bubbles. Measured against a real homeserver, 2026-07-27. Clicking a notification (`ActionInvoked`) focuses the service window and navigates to the conversation.

6. **GNOME Shell helper** (`gnome-shell-extension/`, UUID `loft-shell-helper@loft.chat`) — unlike the old Rust build, Loft no longer bundles and deploys this extension itself. On GNOME, Loft checks whether the helper is installed (`org.gnome.Shell.Extensions.GetExtensionInfo`) and, if not, prompts the user and installs it **from extensions.gnome.org** via `InstallRemoteExtension` — GNOME's own dialog downloads, installs, and enables it in-process. D-Bus interface (`chat.loft.ShellHelper` at `/chat/loft/ShellHelper`): `FocusWindow`/`HideWindow` (bypasses focus-stealing prevention via `meta_window.activate()`), `SetLoftWindows` (the set of open windows to hide from alt-tab/overview/dock while minimized), and the combined-panel methods (`RegisterCombined`/`UpdateCombinedService`/`RemoveCombinedService`/`UpdateAvailableService`/`RemoveAvailableService`/`UnregisterCombined`/`UpdateGlobalDnd`). Global DND sits outside the per-service push, so it gets its own method — the helper needs it to render the switch and to grey the panel icon. The traffic is not all one way: the helper also **publishes** a read-only `SystemDnd` property (`b`, with a manual `PropertiesChanged` — `register_object` needs explicit property closures and emits nothing for you, unlike `Gio.DBusExportedObject`). It mirrors GNOME's own DND switch (`org.gnome.desktop.notifications show-banners`, negated) and is the only way Loft learns about system DND under Flatpak — see §9. The panel menu mirrors the SNI menu's layout (`src/main/tray/dbusMenu.ts`) — global DND, running service rows (Show/Hide + DND + Quit), then a launch row per *available* (configured-but-not-running) service, then Settings + Quit Loft. Running and available services are pushed on separate channels (`UpdateCombinedService` vs `UpdateAvailableService`); a launch/quit flips a service between them, and the helper keeps each service in exactly one section. A launch row calls the service's `Show()` (which opens the window). Its whole-app items call the `chat.loft.Loft` root object; its per-service items the per-service objects. Its whole-app items call the `chat.loft.Loft` root object; its per-service items the per-service objects. Because every Loft window now shares one app identity (one WM_CLASS), the helper matches windows **by title** (`caption === key || caption.startsWith(key + ' (')`, key = the service's display name) instead of by per-service WM_CLASS. The `name` argument on `RegisterCombined`/`UpdateCombinedService`/`RemoveCombinedService`/`UpdateAvailableService`/`RemoveAvailableService` is the D-Bus segment main already computed for that account, not re-derived by the helper from the display name — the segment is the stable key the helper indexes its panel rows by. Window matching, however, is still by caption (the display name), which is why display names must stay unique: two accounts sharing one would make focus/hide land on whichever window matched first. Helper JS changes still only take effect after a GNOME session restart (logout/login on Wayland) — but that's now Keith's/a contributor's concern when updating the extension, not something every end user hits on every Loft update.

7. **KWin scripting** (`src/main/kde/kwin.ts`) — the KDE analog of the GNOME helper: drives `org.kde.kwin.Scripting` to focus/hide/skip-taskbar windows, matched the same way, by window caption.

8. **Grid view** (`src/main/gridTree.ts` / `gridLayout.ts` / `gridDrop.ts` / `gutterDrag.ts`, `src/renderer/grid/`, `src/renderer/gridOverlay/`) — tiles several live services in the Loft window at once, from a pinned **Grid** entry at the top of the rail.
   - The arrangement is a **binary split tree** (`GridNode`: leaves are services, splits carry a direction and a ratio), persisted as `grid` in `config.json`. Holes and overlaps are unrepresentable: a split always has exactly two children, so removing a leaf collapses its parent into the sibling and the space is always reclaimed.
   - **Chrome sits UNDER the pages, not over them, and this is load-bearing.** One grid chrome view fills the content rect drawing per-cell header strips and gutters; each service view mounts *on top of it* in its cell's **body** rect only. Headers and gutters are therefore simply the regions no page covers. A `WebContentsView` has no click-through — a transparent view over a live page swallows every pointer event in its rect ([electron#49039](https://github.com/electron/electron/issues/49039), open; [#23863](https://github.com/electron/electron/issues/23863) open since 2020) — so any design that paints chrome over a page buys a permanent input bug. Do not "simplify" this into an overlay.
   - The one thing that must appear over a live page is the blue drop preview, drawn by a transparent overlay view (`setBackgroundColor('#00000000')` — alpha hex is `AARRGGBB`, and the string `"transparent"` is invalid and fails silently). It is created **once** at construction and toggled with `setVisible`, never per drag ([electron#47351](https://github.com/electron/electron/issues/47351): a freshly created view does not cover lower views until its page loads). It swallowing events is harmless — during a drag they are going to the rail via pointer capture.
   - **Stacking**: `addChildView` appends, and re-adding an existing child raises it to topmost — the documented reorder, since there is no raise/lower API. Index-to-depth direction is undocumented, so nothing passes an index. A service view is *not one view*: a stuck cell has a recovery overlay above its page, so restacking goes through `ServiceView.raise()` (page, then overlay) rather than re-adding the page alone, which would bury the UI that exists to rescue it.
   - Add by dragging a rail icon in (release region decides: rail = reorder, content rect with Grid selected = add/move, outside the window = detach as always), or from the titlebar's ＋. Resize by dragging gutters, move a cell by its header handle, remove with ✕ — the service keeps running and stays in the rail. `gridDropPlan` is the **single** source of the drop rule, returning both the preview rectangle and the resulting tree, so the preview cannot promise something the release will not produce.
   - **Grid and detached are mutually exclusive**, enforced inside `LoftWindow.detach`/`unload` rather than by their callers: both call `refreshAll()` mid-transition, when `isDetached(id)` is briefly false in every term, and a caller-side prune runs too late to stop the grid rebuilding a second live view of the same service.
   - Zoom acts on the **focused cell** (set by clicking a cell's page — via that view's `webContents` `focus` event — or its header), and writes to that service's existing `window.zoom`; there is no separate grid zoom.

9. **Do Not Disturb** — a notification is shown only when none of: system DND, per-service DND, or "this service is both focused and visible" apply. In the grid, *every* visible cell counts as focused-and-visible while the Loft window has focus, so all of them suppress; cell focus is a zoom target and deliberately does not enter this gate. System DND is detected live: GNOME via the `org.gnome.desktop.notifications` `show-banners` gsetting (negated) or, under Flatpak, the Shell helper's `SystemDnd`; every other desktop via the `Inhibited` property on `org.freedesktop.Notifications` (used directly, not negated).

**Backend selection** is `selectSystemDndBackend` (`src/main/notifications/systemDnd.ts`). Only GNOME is special-cased, and only because gnome-shell exposes no properties to read: unsandboxed GNOME → `gsettings`, **GNOME-under-Flatpak → the Shell helper's `SystemDnd` property**. **Everything else — KDE, XFCE, Cinnamon, sway, an unset `XDG_CURRENT_DESKTOP` — tries the `Inhibited` property on `org.freedesktop.Notifications`.** There is deliberately no "unsupported desktop" case: that name is already talk-granted (Loft sends its notifications there), so probing is free, and a server without the property answers a clean `No such property` that lands as unknown — verified against gnome-shell's own server, which reports nothing and does not throw. Any daemon implementing the inhibition extension therefore works without Loft knowing the desktop's name. Plasma is still the only server this has been *confirmed* against.

Both property-backed backends share one implementation (`propertyDeps`): read the property, follow `PropertiesChanged`, tolerate an unreadable initial read (a server may be mid-startup) but keep the change stream, and release the bus connection on `stop()` — which the older KDE-only copy never did.

> The sandbox cannot read this itself, and every route out was re-verified 2026-07-30 (xdg-desktop-portal 1.22.1 / xdg-desktop-portal-gnome 50.0, GNOME Shell 50.3): there is no dconf grant and flatpak dropped the dconf bridge; the XDG **Settings portal exposes no `org.gnome.desktop.notifications` namespace** (only `org.freedesktop.appearance` + a dozen curated `org.gnome.desktop.*` ones — which is why the live-theme feature *can* use the portal); and GNOME's notification server implements **no properties at all**, so KDE's `Inhibited` has nothing to read (`GetAll` on GNOME's `org.freedesktop.Notifications` returns `{}`). Worse, `gsettings` in the sandbox does not fail *loudly* — `org.gnome.desktop.notifications` ships in the `org.freedesktop.Platform` runtime, so the read succeeds and returns the schema default `show-banners=true`: a confident, wrong "DND is off".
>
> The helper closes it because it is an *extension running inside gnome-shell* — outside the sandbox, with plain `Gio.Settings` access — and Loft already holds `--talk-name=chat.loft.ShellHelper`, so this costs **no new sandbox permission**. Do not reintroduce `flatpak-spawn --host` or spend a `--filesystem` grant on `~/.config/dconf` for it.
>
> **Degradation:** a user who declined the extension, or whose EGO-installed helper predates it (`< 2.1`), gets `null`/unknown — the previous behaviour, never a confident "off". The user-visible harm that state causes is the in-page notification **sound** and message-tray entries; the *banner* is suppressed by GNOME Shell regardless of the sender, so it was never visible. Loft's own global/per-service DND remains the in-app substitute.

### Window Behavior

- **Close (✕)**: hides the window; the app and tray stay alive. Click its tray/hub entry to reopen.
- **Show/Hide/Focus**: on GNOME, routed through the Shell helper's `FocusWindow`/`HideWindow` (bypasses focus-stealing prevention); on KDE, through KWin scripting; on other desktops, Loft falls back to Electron's own `window.show()`/`window.hide()`.
- **Quit**: a per-service Quit (tray submenu or D-Bus `Quit()` on that service's object) destroys just that service's window. Quitting the whole app (tray "Quit Loft" or the root D-Bus `Quit()`) closes every window and exits the process.
- **Session end (logout/shutdown)**: the SIGTERM/SIGINT/SIGHUP handler calls `app.exit(0)` and **does nothing else** — no config write, no D-Bus close, no child reap. This is load-bearing, and the budget is much tighter than it looks. Chromium calls `LOG(FATAL)` (`dbus/bus.cc:1245`, "D-Bus connection was disconnected. Aborting.") the instant its D-Bus connection drops while the process is alive → SIGTRAP, coredump, and an "Electron crashed" notice at the next login. Under **Flatpak** the app's bus is `xdg-dbus-proxy`, and the proxy is a member of the app's **own systemd scope**, so `systemctl stop` SIGTERMs the proxy and the app together; the proxy has no teardown work and exits in ~20ms. Measured at a real GNOME logout (2026-07-25): scope `Stopping` at `19:34:33.174`, `FATAL` at `19:34:33.196` — a **21ms** budget. A deb/rpm build talks to `dbus-broker` directly, which stops ~940ms later (`19:34:33.859`) — so **the same code has a ~45× larger budget in dev than on the shipped Flatpak**, and any shutdown work you add will look fine locally and crash at every logout for real users. An earlier fix budgeted against `dbus-broker` and did persist-then-exit here; it never worked. Everything that needs saving must therefore be saved *while the app is alive*: all config already writes on change, and window bounds/zoom flush via `src/main/configFlush.ts` (debounced 400ms off `resize`/`move`/`hide`). See `src/main/shutdown.ts` for the full measurement.

### D-Bus Interface

Loft exports **one** D-Bus service (not one bus name per service, as in the old Rust build):

- **Bus name**: `chat.loft.Loft`
- **Root object** `/chat/loft/Loft`, interface `chat.loft.Loft`: `Quit()` (quit the whole app), `ShowHub()` (open/focus the hub window), `SetGlobalDnd(b)` (toggle global Do Not Disturb, persisted to config). These three are the whole-app actions the GNOME panel menu's footer drives.
- **Per-service objects**: `/chat/loft/<DbusSegment>`, where the segment is derived from the kind's *default* display name plus the instance number — never the account's current (renameable) display name — so it is stable across renames (`/chat/loft/WhatsApp`, `/chat/loft/WhatsApp2`, `/chat/loft/NextCloudTalk`). Each installed account exports its own object at startup (or on add) and unexports it on removal. Interface `chat.loft.Service`:

| Method                 | Signature   | Description                                          |
|------------------------|-------------|-------------------------------------------------------|
| `Show()`               | `→ ()`      | Show / focus the service window                       |
| `Hide()`               | `→ ()`      | Hide the service window                                |
| `Toggle()`             | `→ ()`      | Toggle show/hide                                       |
| `Quit()`               | `→ ()`      | Close this service's window (not the whole app)        |
| `GetStatus()`          | `→ (bub)`   | Returns `(visible: bool, badge: u32, dnd: bool)`       |
| `SetDnd(b)`            | `(b) → ()`  | Set per-service Do Not Disturb, persisted to config    |
| `SetBadgesEnabled(b)`  | `(b) → ()`  | Enable/disable badge indicator, persisted to config    |

(`SetShowTitlebar` from the old interface is gone — the titlebar is a structural part of every service window now, not an optional extra.)

### Supported Apps

| App                | URL                          |
|--------------------|------------------------------|
| WhatsApp           | https://web.whatsapp.com/    |
| Facebook Messenger | https://www.facebook.com/messages/   |
| Slack              | https://app.slack.com/client/    |
| Telegram           | https://web.telegram.org/a/      |
| Element (Matrix)   | https://app.element.io/      |
| NextCloud Talk     | self-hosted only (`customUrl`)  |

Element is self-hostable, so its per-service config supports a `customUrl` (set on the hub's per-service settings) to point at a self-hosted Element Web instance instead of `app.element.io`. Because Loft no longer ships a Chrome extension with `host_permissions` to template, this "just works" — the preload is handed the service id directly and loads whatever origin the window is pointed at, no manifest/permission scheme involved.

Element specifics: badge count is read from `document.title` (`[N]`, where N = rooms with unread notifications — matching Element's own favicon), not DOM-scraped (Element's room list uses hashed CSS-module classes and is virtualized). Notifications use the standard `Notification` API with no focus gating beyond the shared DND rule, so they flow through the same override + D-Bus notification path as Slack/WhatsApp. The one piece of Element-specific notification code is the icon: it is fetched **in the page** rather than by main, because Element's media is authenticated by a token the page holds (see Notifications above).

NextCloud Talk is **always self-hosted** — there is no central instance, so its registry entry's `url` is a placeholder and `customUrl` is effectively required (set on the hub's per-service settings). Once set, the window loads that origin directly via the same preload used for every other service.

Talk specifics: badge count is **DOM-scraped** (not title-based) — the conversation list renders an unread badge per conversation as `<div class="counter-bubble__counter">N</div>`; the badge parser sums the numbers across all `.counter-bubble__counter` elements (non-numeric/mention bubbles count as 1). Notifications flow through the shared override path like Element/Slack; avatars are resolved in the main process via that service's authenticated partition session (`session.fetch`), the same mechanism used for Element's avatars — there is no more in-page data-URL workaround, since main can now fetch with cookies directly instead of asking the (Chrome-only) extension to do it.

The Talk window is also de-chromed for an app feel (`src/main/dechromeCss.ts`, gated on `service === 'talk'`, injected via `webContents.insertCSS`): NextCloud's global `#header` is hidden and `--header-height` zeroed, and `#content`/`#content-vue` are stretched edge-to-edge (no margin, full width/height, no border-radius). Because this is a real CSS injection into the page rather than the old JS-driven titlebar-shift hack, there's no need for Talk's old `<body>`-transform workaround — the titlebar is a separate view stacked above the page, not injected into it.

## Tech Stack

- **Language**: TypeScript (entire application — main process, preloads, and renderer)
- **App runtime**: Electron 43 (bundles Chromium; no external browser dependency)
- **Hub UI**: Svelte 5 (runes) + Vite
- **D-Bus**: `dbus-next` (hand-rolled SNI tray, `org.freedesktop.Notifications` client, `chat.loft.Loft` service, GNOME Shell helper/KWin clients — no native/C dependencies)
- **Packaging**: `electron-builder` (deb/rpm/AppImage) + a hand-written `flatpak-builder` manifest (Flatpak)
- **Testing**: Vitest (+ jsdom for DOM-dependent logic), `svelte-check` for the hub renderer

## Logging

Loft currently logs to stdout/stderr via plain `console.*` calls in the main process — there is no structured log-level system or persistent log file yet. The CLI accepts `--verbose`/`-v`, but nothing currently reads that flag. When run unpackaged (`npm start`) or from a terminal-launched package, output appears in the launching terminal; packaged/autostart launches have no dedicated log file to check.

## File Layout

```
~/.config/loft/
  config.json                      # single JSON file: global settings + services map keyed by service id
                                    # (customUrl, dnd, badgesEnabled, autoOpen ('login'|'launch'; absent=disabled,
                                    #  superseding the legacy openOnStartup bool), window bounds/zoom per service;
                                    #  trayBackend, globalDnd, railOrder and grid at the top level)
                                    # `grid` is the grid view's split tree; absent or null = empty grid.
                                    # Validated recursively on load (depth-capped, ratios clamped) and
                                    # collapsed to null if malformed — a corrupt grid must cost you the
                                    # arrangement, never the ability to start Loft.

~/.config/autostart/
  chat.loft.Loft.desktop           # one login-autostart entry (launches `loft --minimized`). DERIVED, not a
                                    # setting: it exists iff some service is Auto Open = On login
                                    # (effectiveAutoOpen === 'login'). An "On launching Loft" service loads only
                                    # when the user opens Loft (the --minimized login launch skips it), so it does
                                    # NOT create this entry. Written by the XDG Background portal under Flatpak (so
                                    # the manifest needs only :ro here) and directly otherwise; read back with
                                    # existsSync in both cases.

~/.local/share/loft/
  Partitions/
    whatsapp/                      # Electron session partition (persist:whatsapp) — cookies, storage, cache
    messenger/                     # replaces the old Chrome --user-data-dir profile per service
    slack/
    telegram/
    element/
    talk/
  icons/
    whatsapp.png                   # per-INSTANCE PNGs, keyed by instance id (whatsapp.png,
    whatsapp-2.png                 # whatsapp-2.png, ...) — deployed on add and on every icon
    messenger.png                  # change, for .desktop entries / tray / notifications. A second
    ...                            # instance has no bundled fallback of its own, so this copy is
                                    # what keeps its icon from going blank.
  avatars/                         # cached notification avatar images (~1hr TTL)

~/.local/share/applications/
  loft-whatsapp.desktop            # per-service launcher (`loft --service=whatsapp`), one per installed service
  loft-messenger.desktop
  chat.loft.Loft.desktop           # the hub's own launcher, written at first run (dev/AppImage only — deb/rpm/Flatpak ship their own)

~/.local/share/gnome-shell/extensions/
  loft-shell-helper@loft.chat/     # GNOME Shell helper — installed from extensions.gnome.org, not bundled/deployed by Loft
```

Build-time icon assets (repo, not runtime): `assets/icons/variants/<kind>-<colour>.png` (e.g. `whatsapp-rose.png`) are the pastel swatches the hub's icon picker offers, regenerated from the checked-in SVGs by `npm run icons` (needs ImageMagick) — only needed when adding or changing an icon, never for an ordinary build.

## Packaging

Loft is distributed as native Linux packages: **DEB**, **RPM**, and **AppImage**, built with `electron-builder` (`electron-builder.yml`, app id `chat.loft.Loft`).

Loft is also distributed as a **Flatpak** (`chat.loft.Loft`) — both as a standalone `.flatpak` file and on [FriendlyHub](https://friendlyhub.org) — built from a hand-written from-source `flatpak-builder` manifest (`chat.loft.Loft.yml`) rather than electron-builder's own Flatpak target (which only wraps a prebuilt single-arch binary). Because Loft no longer launches an external Chrome binary — everything renders in-process inside Electron's own sandboxed views — it no longer needs `flatpak-spawn --host`/`org.freedesktop.Flatpak`, the sandbox escape that kept the old Rust build off Flathub. The manifest is Flathub-clean (tight `finish-args`, no `--filesystem=home`), so Flathub is technically viable now, but Loft isn't submitted there — distribution stays FriendlyHub + GitHub Releases, matching the rest of the project.

## Testing

- **Unit tests (Vitest)**: config load/save, service registry, badge parsers (per service), CLI arg parsing, `.desktop`/autostart file generation, D-Bus object-path naming, notification gating/avatar caching, tray menu model, GNOME helper install flow, KWin script generation, system-DND detection.
- **`svelte-check`**: type-checks the hub renderer (`src/renderer/hub/`).
- **Manual testing checklist**: calls (voice/video/screen-share) per service, badge count updates, close-to-tray, show/hide/focus on GNOME and KDE, notifications with avatars + click-to-navigate, DND (system + per-service + focus), autostart, add/remove service, Flatpak run.

Run tests with:

```sh
npm test
```

## Development Rules

- **Always check latest versions**: When adding or referencing any dependency (npm package, Electron API, extension API, etc.), look up the current version online. Do not assume version numbers from training data.

## Development

Iterate with the plain build/run commands below — they're fast. Only reach for a full packaging build (`npm run dist`, or a Flatpak build) when producing a package to distribute or verifying packaged-only behavior (e.g. AppImage/Flatpak exec-path resolution); it's much slower than a plain build and not needed for day-to-day changes.

The integrated terminal in some editors (e.g. VS Code) exports `ELECTRON_RUN_AS_NODE=1`, which makes `electron .` behave like plain Node instead of launching the app — strip it with `env -u ELECTRON_RUN_AS_NODE` when launching Electron directly.

```sh
# Build + run for local testing
npm run build
# `electron` is a devDependency, so it is only on PATH inside an npm script. From a bare
# shell use `npx electron .` (or just `npm start`, which builds and launches).
env -u ELECTRON_RUN_AS_NODE npx electron .
env -u ELECTRON_RUN_AS_NODE npx electron . --service=whatsapp
env -u ELECTRON_RUN_AS_NODE npx electron . --service=whatsapp --minimized

# Equivalent one-shot npm scripts (build + run)
npm start
npm run whatsapp   # also: messenger, slack, telegram, element, talk

# Run the working-tree build against the INSTALLED FLATPAK's profile, so a dev session
# inherits real logins instead of asking for a QR scan every time. The whole mechanism is
# XDG_CONFIG_HOME/XDG_DATA_HOME (see scripts/devProfile.mjs) — no dev branch in the app.
npm run dev                        # copy-on-write clone of the Flatpak profile (safe; can
                                   # run alongside the Flatpak). Args pass through:
npm run dev -- --service=whatsapp  #   e.g. straight into a service for a DevTools spike
npm run dev:refresh                # re-snapshot the clone (picks up new logins)
npm run dev:live                   # against the Flatpak's REAL profile — writes persist
                                   # both ways. Refuses to start while the Flatpak is
                                   # running, and backs up config.json first.

# Tests and renderer type-checking
npm test
npm run check

# Regenerate the icon variant PNGs (needs ImageMagick; only when adding/changing an icon)
npm run icons

# Packaging (heavier; only for distribution or packaged-behavior verification)
npm run dist                 # electron-builder: deb/rpm/AppImage
# The committed chat.loft.Loft.yml is what FriendlyHub gets: its app source is `type: git`
# pinned to the release tag, so it does NOT see working-tree changes. Generate the dev
# manifest (same file, working-tree source) for local builds.
npm run flatpak:dev
flatpak-builder --user --force-clean --repo=.flatpak-repo build-dir chat.loft.Loft.dev.yml
```
