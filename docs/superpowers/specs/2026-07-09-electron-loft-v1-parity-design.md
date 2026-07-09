# Electron Loft — v1 (Parity) Architecture Design

**Date:** 2026-07-09
**Status:** Design approved (all sections); ready for implementation planning.
**Supersedes:** the Chrome-based architecture in `CLAUDE.md` (that remains the reference for *current* behavior until v1 lands).
**Working notes:** `dev_local/electron-rewrite-decisions.md`. **Mockups:** `dev_local/electron_mockups/`.

---

## 1. Why

The Electron POC (`dev_local/electron_test/`, results in `dev_local/project-electron.md` Part 3)
proved that voice, video, and screen-share all work in vanilla Electron for **Messenger,
WhatsApp, and Slack** — including Messenger's incoming-accept path, the exact case that was
broken in Ferdium for two years. Root cause of that breakage was a missing `window.open`
handler, not Meta gating. **Chrome is therefore no longer required**, and every Chrome-imposed
workaround in today's Loft becomes self-inflicted.

This rewrite moves Loft onto Electron to shed those workarounds and unlock a Flathub-acceptable
Flatpak, while **reproducing today's functionality exactly** (parity). The unified tabbed view
and other new features are explicitly deferred to a later spec.

## 2. Goals / Non-goals

**Goals (v1):**
- Full functional parity with today's Loft on an Electron runtime, in TypeScript.
- All six services: WhatsApp, Messenger, Slack, Telegram, Element (incl. self-hosted),
  NextCloud Talk (self-hosted).
- Per-service windows, tray, badges, notifications (with avatars + click-to-navigate), DND,
  close-to-tray, GNOME/KDE integration — all preserved.
- Delete the Chrome-era complexity that Electron makes unnecessary.
- Native RPM/DEB/AppImage/Flatpak via `electron-builder`; pursue Flathub.

**Non-goals (this spec):**
- **Unified/tabbed single-window view** — deferred to its own spec (architecture here is built
  to make it *additive*, not a rewrite).
- Any new end-user features beyond parity.
- Migrating existing logins (see §3, clean re-login).

## 3. Cross-cutting decisions (locked)

| # | Decision |
|---|----------|
| Runtime | **Full TypeScript/Node.** No Rust. The GNOME Shell helper (GJS) and KWin scripts (JS) port as-is; the D-Bus service, notifications, tray, config, autostart, and `.desktop` writers are reimplemented in TS. Chrome detection is deleted. |
| Process model | **One Electron app** hosts all services. `app.requestSingleInstanceLock()` replaces the D-Bus singleton; a second launch fires `second-instance` and routes by argv. Replaces daemon-per-service + combined-tray process. |
| View model | **`WebContentsView` per service**, re-parentable. v1 = one lightweight `BrowserWindow` per active service; v2 unified window re-parents the same view objects. |
| Isolation | `session.fromPartition('persist:<id>')` per service; Chrome-stable UA + POC permission/display-media/window-open handlers per session. |
| Migration | **Clean re-login.** No cookie/session migration (Chromium cookie encryption is keyring/app-identity bound and fragile). Old Chrome profiles left untouched. |
| Spec scope | **One v1-parity spec** (this doc). Implementation plan stages the build. |

## 4. System architecture & process model

- **Singleton:** `requestSingleInstanceLock()`; `second-instance(argv)` opens/focuses the
  requested service. No per-service D-Bus liveness.
- **Main process** owns everything non-web: service registry, window/view lifecycle, tray,
  notifications, D-Bus, config, autostart. (The equivalent of today's daemon, once, for all.)
- **Renderers:** the **hub window** (app home UI) and **one `WebContentsView` per service**
  (remote URL + per-service preload).
- **Service registry:** data-driven port of `src/service.rs` — `id`, `displayName`, `url`,
  optional `customUrl` (Element/Talk), derived origin(s), preload set. Same six services.
- **IPC:** one typed `contextBridge` channel (badge counts, notification payloads, open-url,
  focus events). **Replaces both** the CDP extension-loading pipe *and* the native-messaging
  Unix-socket relay.

**Deleted here:** CDP fd 3/4 pipe + `Extensions.loadUnpacked`; native-messaging host + socket
relay; `chrome_desktop_id`/WM_CLASS scheme; broken-`.desktop` overwrite hack; all of `chrome.rs`.

## 5. Window & view management

- **Titlebar (see `01-service-window-chrome.png`):** frameless `BrowserWindow` (`frame:false`)
  + our own titlebar rendered as a separate `WebContentsView` strip pinned to the top; the
  service view fills below. Left = service icon + name; drag region; right = `[zoom-out,
  zoom-in, ✕]`. **✕ hides to tray** — there is no separate minimize button; close *is* hide.
  Because the titlebar is our own view *above* the page (not injected into it), the injected
  hover-titlebar and the Messenger/Talk de-chrome-for-layout CSS are eliminated.
- **Zoom buttons are "A" glyphs with arrows** (large-A/small-A, word-processor style) — **not**
  `+`/`−`, to avoid confusion with GTK themes whose min/max controls read as `+`/`−`.
- **Composition:** main lays out titlebar view + service view on resize (`WebContentsView` has
  no auto-layout).
- **Close-to-tray:** `win.on('close', e => { if(!quitting){ e.preventDefault(); win.hide() } })`.
  Deletes today's `beforeunload` "leave page" hack.
- **Focus/show/hide:** GNOME Shell helper (`FocusWindow`) + KWin scripting, targeting a
  service's window **by our own window title** (we own titles now) instead of
  `chrome_desktop_id`/WM_CLASS.
- **Persistence:** per-service window bounds + zoom in config; service views use
  `webPreferences.backgroundThrottling:false` so hidden views keep scraping badges/notifications.
- **Lifecycle:** hide ≠ destroy (views stay alive in the background for badges/notifications);
  start-minimized = create with `show:false`; destroy only on remove-service or quit.

### 5.1 GNOME Shell helper — preserved in full (do NOT trash)
The helper (`gnome-shell-extension/`, already GJS) is ported with its current behavior intact:
- Overview hiding (`Workspace._isOverviewWindow`).
- Overview dock/dash hiding (`Shell.AppSystem.get_running`) + `app-state-changed` rebuild.
- Alt-tab exclusion of hidden windows (`AppSwitcherPopup.prototype._init`).
- **Alt-tab MRU ordering** (commit `4884e62`): per-service app injection into `get_running`,
  per-service recency from `get_user_time()`, and the `_initialSelection` rewrite. **Still
  required** because our single grouped Loft app identity (§8) means one shared MRU timestamp — the
  exact situation Chrome's `com.google.Chrome` collapse created. Adapt keying from per-PWA
  WM_CLASS → our window titles. **Requirement: per-service alt-tab entries in correct MRU order.**
- Focus-stealing bypass (`meta_window.activate()` inside the compositor).
- Startup/resume resilience: re-register on `NameOwnerChanged` for `chat.loft.ShellHelper`
  (suspend/lock fires `disable()`/`enable()`, destroying panel icons) + SNI spawn backoff
  `[0,2,4,8,16]s` at login. Independent of window hiding — carries over 100%.
- `skip_taskbar` stays **prototype-patched** (read-only GObject prop, unsettable from JS).
- Helper JS changes still require a **logout/login on Wayland**.

> The idea that `hide()` (full unmap) might let some of the overview/alt-tab patches go is a
> **deferred, per-patch experiment** — default is KEEP EVERYTHING; drop a patch only if
> implementation testing proves it redundant.

KWin scripting (KDE) is ported equivalently for focus/hide/skip-taskbar.

## 6. Web integration (preload) — replaces the Chrome extension

- **Model:** one preload per service `WebContentsView`, handed its **service id + config
  directly** (`webPreferences.additionalArguments`/IPC handshake), not derived from origin. One
  typed `contextBridge` channel to main.
- **Deletes:** `loft-overrides.js` (origin→service map), `manifest.json` + `host_permissions`,
  `deploy_extension()` templating, the granted-origin scheme. **Self-hosted Element/Talk "just
  work"** — load the custom URL with the preload; no origin declaration, no runtime prompt.
- **Badge extraction:** port per-service `content.js` scrapers into the preload — Messenger /
  Slack / Telegram / WhatsApp DOM+title; Element title-based (`Element [N]`); Talk sums
  `.counter-bubble__counter`. `MutationObserver` + title observer → `badge_update` → main.
- **Notification interception:** the preload injects a **main-world `<script>` at document-start**
  wrapping `window.Notification` (port of `notification-override.js`, zero `chrome.*` APIs);
  relays via `postMessage` → preload → IPC → main. Messenger stays DOM-scrape
  (`notifiedConversations` `Map<href,fingerprint>`, 15s startup grace, DND-silent-add). Slack
  invariants preserved: `SilentNotification.prototype === OrigNotification.prototype`, the
  "New message from {Name}" title regex, and the `-24`→`-128` avatar upscale.
- **De-chroming** (decoupled from the titlebar now): Messenger banner removal + `--header-height:0`
  (restore `56px` on `[role="dialog"]`); Talk hide `#header`, stretch `#content`/`#content-vue`.
  Talk's `<body>`-transform hack is gone. Static CSS via `webContents.insertCSS`; dynamic/React
  bits stay observer-driven.
- **Deletes:** `offscreen.html`, `background.js` service worker (→ main), Slack
  `*.slack-edge.com` host_permissions, `content.js` titlebar injection, `chrome.storage.local`.

## 7. Notifications & DND

- **Delivery:** reimplement `notifications.rs` in TS via **`dbus-next` → `org.freedesktop.Notifications`
  directly** (not Electron's built-in `Notification`). Persistent connection (KDE closes
  notifications when the sender disconnects), `ActionInvoked` handling, avatar control.
- **Avatars — consolidated in main via `net.fetch(url,{session:partitionSession})`** (carries the
  service's cookies): public (Slack `-128`, Messenger, WhatsApp) *and* authenticated (Element,
  Talk) fetched in main — replaces today's in-page `resolveIcon`/data-URL dance. Only in-page
  bit: Talk's display-name→avatar-URL DOM lookup (preload supplies URL, main fetches). ~1hr cache.
- **Click-to-navigate:** notification click (`ActionInvoked`) → main focuses the window
  (helper/KWin) + IPC navigate-to-conversation to the view.
- **DND:** show a notification only when **none** of these apply —
  `show = !systemDND && !serviceDND[svc] && !(focused && visible)`:
  - **System DND (new):** OS DND suppresses all services. GNOME via
    `org.gnome.desktop.notifications` `show-banners` gsettings; KDE via Plasma notification
    inhibition (exact interface to confirm at implementation). Watched live.
  - **Per-service DND (parity):** persisted per service, toggled from the icon menu; pushed to
    views (needed for Messenger DND-silent-add); main also gates delivery.
  - **Focus gate:** the focused + visible service is suppressed.
- **Background status:** port `background_status.rs` (commit `9b29a9f`) — notify when a service
  is open but not focused.

## 8. Tray & system integration

- **One Loft icon.** `tray_backend` config preserved: `auto | gnome-panel | sni` (`auto` →
  GNOME-panel on GNOME, SNI elsewhere; a GNOME user can force `sni`). Both backends kept.
  Combined-only ⇒ **deletes** per-service tray icons, `combine_tray_icons`, and the separate
  combined-tray process (`loft --tray`, `src/combined_tray/`, `chat.loft.Tray`).
- **Single-icon interaction:** **left-click → menu** (services each with a notification dot ·
  DND · Quit · open Hub/Settings); selecting a service focuses/opens it. **Right-click does
  nothing** — GNOME panel icons are effectively left-click-only. The SNI/KDE backend surfaces
  the same menu for consistency.
- **SNI backend in TS:** hand-rolled `StatusNotifierItem` over `dbus-next` (port of `tray.rs`/
  `ksni`; no native C deps; supports the left-click menu, a dynamic badge pixmap, the login
  backoff, and `StatusNotifierWatcher` monitor/re-register). *Not* Electron's built-in `Tray`
  (its left-click behavior is unreliable across DEs and conflicts with left-click-menu).
- **GNOME-panel backend:** shell helper kept — `RegisterCombined` / `UpdateCombinedService` /
  `RemoveCombinedService` / `UnregisterCombined`; `gnome_shell.rs` client → TS.
- **Icon rendering:** SNI composes icon + total-badge pixmap (`nativeImage`/offscreen canvas);
  the GNOME panel helper renders dots/badge from counts sent by main.
- **`chat.loft` D-Bus interface:** one bus name `chat.loft.Loft`, per-service object paths
  `/chat/loft/<Service>` (`Show/Hide/Toggle/Quit/GetStatus/SetDnd/SetBadgesEnabled`) + a root
  app object. Kept for scripting/parity. **`SetShowTitlebar` dropped** (titlebar is structural).
- **Autostart & `.desktop`:** one Loft login autostart entry (port `autostart.rs`); per-service
  granularity → per-service **"open on startup"** flags in config. `.desktop`: one main
  `chat.loft.Loft.desktop` + per-service launchers (`loft --service <id>`, routed via the
  single-instance lock) — the per-service files are also what the GNOME helper's alt-tab/dock
  injection looks up (`lookup_app('<id>.desktop')`).

## 9. App/UX shell — the hub window (parity-only)

See `02-hub-window.png`. The hub is today's redesigned manager, carried into the Electron app:
- **Installed** boxed list: per service — icon + name, live Running/Not-running status, unread
  badge, an **Open** button, and a **gear** for per-service settings.
- **Available** tile grid: not-yet-added services → **Add**.
- **Welcome** empty-state; header menu → settings · about · quit.
- **Live status via push IPC** — main knows each view's state and pushes it; **delete
  `query_statuses` cross-daemon polling** and its flicker workarounds.
- **Per-service settings (gear):** custom URL (Element/Talk), open-on-startup, start-minimized,
  badges on/off, DND default, notifications on/off, remove service.
- **Global settings:** `tray_backend`, start at login, appearance (follow system), default zoom.
  No Chrome-path override.
- **First-run:** delete the "Chrome Not Found" `StatusPage`; keep the GNOME Shell helper
  install/logout prompt; show the welcome empty-state.
- **"Add"** = enable in config + generate the per-service `.desktop` + create the partition on
  first open (no NM host, no CDP, no Chrome profile wrangling).
- **No unified/tabbed mode** — deferred; groundwork is the re-parentable `WebContentsView` (§4)
  and the hub-as-home surface.

## 10. Config, data layout & packaging

- **Config:** single `~/.config/loft/config.json` (global + `services` map keyed by id);
  consolidates `config.toml` + `services/*.toml`.
- **Data:** `~/.local/share/loft/Partitions/<service>/` (Electron partitions, via
  `app.setPath('userData', …)`); one `~/.local/share/loft/logs/loft.log` (`electron-log`);
  `~/.local/share/loft/icons/` deployed for `.desktop`/SNI/notifications; GNOME helper dir
  unchanged.
- **Packaging:** `electron-builder` → AppImage/deb/rpm/Flatpak; app id `chat.loft.Loft`. Helper
  + `.desktop` + icons deployed at runtime, not by the packager.
- **Flathub:** now viable (the `flatpak-spawn --host` Chrome escape is gone). Remaining review
  items: D-Bus talk-names for notifications/tray/KWin, and deploying the GNOME helper into
  `~/.local/share/gnome-shell/extensions` — *not* a sandbox escape. FriendlyHub + standalone
  `.flatpak` remain as fallbacks.
- **CLI:** `loft` (hub), `loft --service <id>` (single-instance routed), `--verbose`,
  `--minimized`. Drop `--tray` and the NM-relay mode.

## 11. Simplification ledger (deleted vs today)

CDP extension loader; native-messaging host + socket relay; `chrome_desktop_id`/WM_CLASS scheme;
broken-`.desktop` overwrite hack; `chrome.rs` detection; the Chrome extension packaging
(`manifest.json`, `loft-overrides.js`, `host_permissions`, `deploy_extension()` templating,
`offscreen.html`, `background.js` service worker); the combined-tray process (`loft --tray`,
`src/combined_tray/`, `chat.loft.Tray`, `combine_tray_icons`); per-service tray icons; the
injected hover-titlebar + `beforeunload` hack + Talk `<body>`-transform; per-daemon status
polling; the `ksni` crate and the Rust toolchain.

## 12. Carried over (runtime-agnostic, preserved)

GNOME Shell helper (§5.1, incl. alt-tab MRU); KWin scripting; the notification semantics
(avatars, click-to-navigate, persistent D-Bus connection); per-service badge scraper logic;
`notification-override.js` and Slack/Messenger specifics; the service registry; DND semantics
(now plus system-DND); autostart concept; the hub (manager redesign).

## 13. Open items to confirm (during spec review / early implementation)

1. **Hub/titlebar renderer UI tech** — plain TS + Web Components/Lit vs a light framework
   (Svelte). Recommendation: keep it minimal but pick something the eventual unified view can
   reuse (leaning Svelte or Lit). *Not yet decided — confirm.*
2. **KDE system-DND interface** — exact D-Bus/Plasma signal for "OS DND on" (GNOME path is
   known: `show-banners`). Confirm at implementation.
3. **`hide()` vs the GNOME overview/alt-tab patches** — the per-patch redundancy experiment
   (§5.1); default keep.
4. **Per-service window identification by title** — validate the GNOME helper + KWin can reliably
   target/inject per-service windows keyed on titles under one app identity on Wayland.

## 14. Testing strategy

- **Unit (TS):** service registry, config load/save, badge parsers (per service), native
  message/IPC payload shapes, notification gating logic (`show = …`).
- **Integration:** D-Bus service interface (call methods, assert responses); notification
  round-trip; single-instance routing.
- **Manual matrix (per service):** calls (voice/video/screen-share — already POC-proven),
  badge updates, close-to-tray, show/hide/focus on GNOME + KDE, alt-tab MRU ordering,
  notifications with avatars + click-to-navigate, DND (system + per-service + focus), autostart,
  add/remove service, Flatpak run.

## 15. Suggested implementation staging (detailed in the plan)

1. **Walking skeleton:** Electron app, single-instance, service registry, `WebContentsView`
   per service in per-service frameless windows, partitions, UA + POC handlers, close-to-tray,
   the titlebar view. (Proves the architecture end-to-end.)
2. **Web integration:** preloads — badge scraping, notification interception, de-chroming.
3. **System integration:** SNI + GNOME-panel tray, D-Bus notifications (avatars, click-nav),
   DND (system + per-service + focus), GNOME helper + KWin port, D-Bus service interface.
4. **App/UX:** hub window, per-service + global settings, autostart, `.desktop` generation.
5. **Packaging:** `electron-builder` (AppImage/deb/rpm/Flatpak); Flathub work.
