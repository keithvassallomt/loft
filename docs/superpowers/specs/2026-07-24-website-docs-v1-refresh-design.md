# Website & Docs Refresh for Loft 1.0.0 — Design

**Date:** 2026-07-24
**Status:** Approved (design), pending spec review
**Repos touched:** `loft.chat` (marketing site + VitePress docs). Spec + ledger live in the `loft` app repo alongside the other 1.0.0 specs.

## Goal

Bring the `loft.chat` marketing site and the `docs.loft.chat` documentation into line with Loft 1.0.0 — the ground-up Electron rewrite described in `CHANGELOG.md` (1.0.0) and `CLAUDE.md`. Today both sites describe **pre-rewrite Loft**: a Rust daemon driving a real Google Chrome via a Manifest-V3 extension and native messaging, one window and one tray icon per service, per-service TOML config, and per-service D-Bus bus names. None of that is true anymore. This is a **fact-level rewrite of essentially every page**, plus a full screenshot replacement (all current shots show UI that no longer exists) and coverage of the four headline 1.0.0 features (unified view, grid, multiple accounts, developer mode).

## Non-goals

- No redesign of either site's visual style or structure. The marketing site keeps its chat-simulation format; the docs keep the default VitePress theme.
- No new marketing copy beyond what accuracy requires.
- **Not** deduplicating the two identical screenshot directories (`public/screenshots/` and `docs/public/screenshots/`). They stay separate; the shot-list documents that each capture is placed in both. Deduping is a separate concern.
- No changes to the Loft app itself. This is documentation only. Where a fact is uncertain, the app code (`loft` repo) and `CLAUDE.md` are the source of truth — implementers verify against them, they do not invent.
- The `RightPanel.tsx` download links are already dynamic (GitHub releases API) and need no content change.

---

## Canonical fact inventory (old → new)

This table is the **single source of truth** every page and every content file is corrected against. Implementers do not re-derive these; they apply them. All are drawn from `CLAUDE.md` and verified against the `loft` app repo.

| # | Old (currently on the sites) | New (1.0.0 reality) |
|---|---|---|
| 1 | "Uses **real Google Chrome**"; requires Chrome ≥137; a whole `chrome.md` detection page; Chrome install prompt | **Self-contained Electron app** (Electron 43) that bundles Chromium. No external browser. Voice/video/screen-share all work in-process. No Chrome prerequisite, no detection, no `chrome_path`. |
| 2 | "Rust daemon (`zbus`, `ksni`)", "libadwaita Manager GUI", "Chrome extension (Manifest V3)", "native messaging" | One **Electron main process** (TypeScript) owns everything non-web; a **Svelte 5 + Vite hub** is the manager UI; **sandboxed preloads** replace the extension (badge scraping, notification interception, de-chroming); D-Bus is hand-rolled `dbus-next`. |
| 3 | One window per service | **Unified window** with a sidebar **rail** of service icons; click to switch a service full-size; each has its own titlebar (name + unread count + zoom + close). Detaching to its own window is opt-in (`detached`). |
| 4 | — (did not exist) | **Grid view**: a pinned **Grid** rail entry tiles several live services at once (binary split tree, persisted). Add by dragging a rail icon in or via the titlebar ＋; resize gutters; move by header handle; remove with ✕. Calls survive tiling/resize/move. |
| 5 | — (did not exist) | **Multiple accounts**: more than one account of the same service (two WhatsApps, two Talk servers). Registry lists **kinds**; a config entry is an **instance**. Instance 1 keeps the bare id (`whatsapp`), later ones are `<kind>-<N>`. Each account has its own name, icon (brand / pastel variant / custom file), login, badges, notifications. Added from the **Add another** gallery. |
| 6 | — (did not exist) | **Developer mode**: a **Settings** toggle (`debug` in config). On → **Shift+right-click** in a service opens the Chromium menu (Inspect Element, DevTools, Reload, back/forward); plain right-click still uses the web app's menu. Off by default. |
| 7 | "Start at Login" + "Start Hidden" checkboxes | **Auto Open** three-way per-service choice: **Disabled** / **On login** (background from login; creates the autostart entry) / **On launching Loft** (loads only when you open Loft; does not autostart). Legacy "start on startup" services map to **On login**. |
| 8 | Each service gets its **own tray icon**; "individual" is the default, "combined" optional | **One combined "Loft" tray icon**, no per-service icons and no individual mode. Left-click → a menu listing every configured service (Show/Hide, per-service DND, Quit) + a global DND toggle + Settings + Quit. Two backends via `trayBackend`: `auto` (GNOME→panel, else SNI) / `gnome-panel` / `sni`. |
| 9 | Config is TOML: `~/.config/loft/config.toml` + per-service `~/.config/loft/services/<name>.toml` | One JSON file: `~/.config/loft/config.json`. Global keys: `services` (map keyed by instance id), `globalDnd`, `trayBackend`, `debug`, `configVersion`, `window`, `reopenDetached`, `railOrder`, `grid`. Per-service keys: `kind`, `name`, `icon`, `customUrl`, `window`, `autoOpen`, `dnd`, `badgesEnabled`, `detached`, `launcher`. **No** `chrome_path`, `combine_tray_icons`, `skip_extension_prompt`, `show_titlebar`, `start_hidden`, `autostart`. |
| 10 | Per-service bus names `chat.loft.WhatsApp`; method `SetShowTitlebar` | **One bus name `chat.loft.Loft`**. Root object `/chat/loft/Loft` (iface `chat.loft.Loft`): `Quit()`, `ShowHub()`, `SetGlobalDnd(b)`. Per-service objects `/chat/loft/<DbusSegment>` (segment from the kind's **default** display name + instance number, stable across renames — `/chat/loft/WhatsApp`, `/chat/loft/WhatsApp2`, `/chat/loft/NextCloudTalk`), iface `chat.loft.Service`: `Show/Hide/Toggle/Quit/GetStatus (→ bub)/SetDnd(b)/SetBadgesEnabled(b)`. **`SetShowTitlebar` removed.** |
| 11 | Per-service autostart `.desktop` files in `~/.config/autostart/` | One **derived** entry `~/.config/autostart/chat.loft.Loft.desktop` (launches `loft --minimized`). Exists **iff** some service is Auto Open = On login. Written via the XDG Background portal under Flatpak, directly otherwise. |
| 12 | Per-service Chrome profiles `~/.local/share/loft/profiles/<service>/` | Electron **session partitions** `~/.local/share/loft/Partitions/<id>/` (persist:<id>). Per-**instance** icons `~/.local/share/loft/icons/<id>.png`. No extension dir. |
| 13 | Titlebar is an optional injected in-page toolbar; hover the top edge to reveal; "avoid clicking X (Chrome leave-page warning)" | Titlebar is a **structural** `WebContentsView` per service window (always present). **Close (✕) = hide-to-tray**; the window stays alive so badges/notifications keep working. No hover-reveal, no Chrome warning, no titlebar toggle. |
| 14 | GNOME helper is **bundled** and auto-installed to `loft-shell-helper@chat.loft`; changes need logout | Helper installed **from extensions.gnome.org on request** (Loft asks first, GNOME's own dialog installs/enables), UUID **`loft-shell-helper@loft.chat`**. Not bundled/deployed by Loft. Because every window shares one WM_CLASS, the helper matches windows **by title**. |
| 15 | Flatpak needs `flatpak-spawn --host` / `org.freedesktop.Flatpak` (a sandbox escape); "that's why not on Flathub" | No `flatpak-spawn`, no sandbox escape — everything renders in-process. Manifest is **Flathub-clean** (tight `finish-args`). Loft stays on **FriendlyHub + GitHub Releases by choice**, not because Flathub is blocked. |
| 16 | Wrappers like Ferdium "can't do calls — Electron WebRTC is broken" | The real breakage was a **missing `window.open` handler** for call popups, not an Electron/WebRTC limitation. Loft's vanilla-Electron views do calls, video, and screen-share. (Use this corrected framing in `what-is-loft.md`; don't overstate — keep it factual.) |
| 17 | Per-daemon log files under `~/.local/share/loft/logs/` (one per service + tray + native-messaging) | **No persistent log files yet.** Loft logs to stdout/stderr via `console.*`. `--verbose`/`-v` is accepted but nothing reads it yet. Packaged/autostart launches have no dedicated log file. Troubleshooting must reflect this rather than inventing log paths. |
| 18 | Singleton is **per service** | **Single-instance lock for the whole app** (`app.requestSingleInstanceLock()`). A second launch (e.g. `loft --service slack`) routes its argv to the running instance and exits. |

CLI, verified: `loft` (no flag) → hub; `loft --service=<id>` or `--service <id>`; `--minimized`; `-v`/`--verbose`. Supported services and URLs are unchanged from the current `services.md` list (WhatsApp, Messenger, Slack, Telegram, Element, NextCloud Talk) — 1.0.0 added none.

---

## Deliverable A — Marketing site (`loft.chat`, React/Vite)

Structure and styling unchanged; correct the content. Three files:

### A1. `src/data.ts` — the scripted conversation
- **intro-bot `footer`**: remove the "real Google Chrome … Rust-based system daemon" sentence. Replace with the self-contained-Electron framing (fact 1, 2): bundles Chromium, no separate browser, native desktop integration (tray, badges, notifications, close-to-tray).
- **intro-bot `serviceIcons`**: already lists all six services — keep.
- **carousel**: rewrite captions and point `src`/`darkSrc` at the new screenshot filenames (see Deliverable C). Add unified-window (hero), grid, and multiple-accounts entries; drop the individual-tray captions (no individual mode).
- **features-bot `content`**: rewrite the bullet list to the 1.0.0 feature set — unified view + rail, grid, multiple accounts, combined tray with badges, desktop notifications with avatars, per-service DND, Auto Open modes, developer mode, voice/video/screen-share in-process, per-service isolated **sessions** (not Chrome profiles). Fix the existing typos ("it's own").
- **download-bot `content`**: delete the "you just need Google Chrome installed" note (fact 1). Formats list (RPM/DEB/AppImage/Flatpak via FriendlyHub) stays.
- **privacy-bot `content`**: remove "handled locally by the Rust daemon and Chrome extension, communicating solely via native messaging" (fact 2). Replace with: 100% open-source (GPL-3.0-or-later), no tracking, everything handled locally by the app, per-service isolated sessions.

### A2. `src/components/ChatArea.tsx` — the keyword bot
Rewrite each `botReplies` entry to be accurate; keep the playful tone and the technical flavour, just make the internals correct:
- **architecture / how it works**: Electron 43 (bundled Chromium) + sandboxed preloads + hand-rolled `dbus-next`. Not Chrome / zbus / ksni / extension / native messaging.
- **source / open-source**: TypeScript throughout (main + preloads + renderer), Svelte 5 (runes) + Vite hub, `dbus-next`. Not Rust / libadwaita / Manifest V3.
- **services**: all six, each in its own Electron session partition; multiple accounts of one service supported.
- **dnd / notifications / badge**: sandboxed preloads wrap `window.Notification` and scrape badges; combined tray with global + per-service DND. Not extension / native messaging.
- **gnome**: helper from extensions.gnome.org (UUID `@loft.chat`), `meta_window.activate()`, hides minimized windows from alt-tab/overview/dock, combined panel menu.
- **kde**: KWin scripting over D-Bus, SNI tray.
- **distro / flatpak**: RPM/DEB/AppImage + Flatpak; Flathub-clean manifest, distributed on FriendlyHub by choice (no `flatpak-spawn`).
- **zoom / titlebar / close**: structural titlebar with zoom (0.3×–3.0×), per service; close = hide-to-tray.
- **`slashCommands` / `predefinedPills`**: refresh to match; add `/grid` and `/accounts` (and matching pill(s)) to surface the headline features; drop anything now inaccurate.

> **Note:** `docs/index.md` (the VitePress home hero + feature cards) is a docs file and is owned by **Deliverable B** (the `index.md` row) — a single task, not a separate marketing one. It is called out here only because its feature cards are the most marketing-facing surface in the docs.

---

## Deliverable B — Docs (`docs/`, VitePress)

### B1. Sidebar / IA (`docs/.vitepress/config.ts`)
Retire `chrome.md`; regroup:

- **Introduction**: What is Loft? · Getting Started
- **Features**: Unified View & Grid *(new)* · Multiple Accounts *(new)* · Supported Services · Tray Icon · Notifications & Badges · Window Behaviour · Desktop Environment Integration
- **Configuration**: Global Settings · Per-Service Settings · Auto Open & Autostart
- **Advanced**: D-Bus Interface · Flatpak · Developer Mode *(new, short)* · Troubleshooting

Footer copyright year and nav are otherwise fine.

### B2. Page work
All rewrites apply the fact inventory. "Major" = the page's core premise is wrong and most prose is replaced.

| Page | Scope | Key changes |
|---|---|---|
| `index.md` | Cards | Fix "Voice & Video Calling" (fact 1: drop "real Google Chrome" → "bundled Chromium, no external browser") and "System Tray Integration" (fact 8: one combined "Loft" icon, drop "each service gets its own"). Keep "Desktop Notifications". Replace the "GNOME & KDE Support" card with **Unified View & Grid** — GNOME/KDE integration has its own docs page, and the marquee 1.0.0 capability deserves a card. Tagline needs no change. |
| `what-is-loft.md` | **Major** | Rewrite problem framing (fact 16: wrappers *can* call; the bug was `window.open`). "How Loft solves this" = self-contained Electron, bundled Chromium, sandboxed preloads, unified window + rail, grid, multiple accounts, combined tray, notifications, close-to-tray, GNOME/KDE. **New architecture block**: one app (main process + hub + per-service views), not manager + per-service daemons. Replace the old `loft --service … → Chrome + extension` diagram. |
| `getting-started.md` | **Major** | Drop Chrome prerequisite. Install (unchanged package steps). "Installing a service" = Add from the hub (no extension/native-messaging setup). Launching = the unified window. Replace Start-at-Login/Start-Hidden with **Auto Open** modes. CLI options block (facts: `--service`, `--minimized`, `-v`). Uninstall = remove with optional "also delete login data". |
| `services.md` | Rewrite intro + tables | Session partitions, no per-service daemon. Notifications via preloads; Messenger/Telegram **scrape-only** (native suppressed to avoid dupes); WhatsApp/Slack/Element/Talk via override path. Talk = DOM-scraped `.counter-bubble__counter` sum + de-chrome; Element = `document.title` `[N]`. Avatars fetched in **main** via each partition session. Add a short **multiple accounts** note (kinds vs instances) linking the new page. |
| `tray-icons.md` | **Major** | Remove individual mode entirely. One combined "Loft" icon; menu layout (global DND · per-service Show/Hide + DND + Quit · Settings · Quit Loft). Backends: `auto`/`gnome-panel`/`sni`. SNI = hand-rolled `dbus-next` StatusNotifierItem; GNOME = native panel button via the Shell helper. |
| `notifications.md` | Update | `org.freedesktop.Notifications` via persistent `dbus-next` connection; avatars resolved in main via partition `session.fetch`, cached ~1hr. Badge shown in titlebar unread count + tray/panel (not "tray icon title"). DND gate = none of {system DND, per-service DND, focused-and-visible}; grid counts every visible cell as focused-and-visible. System DND detection (GNOME `show-banners`, KDE `Inhibited`). D-Bus example → single bus name + per-service object path. |
| `window-behaviour.md` | **Major** | Structural titlebar (no hover-reveal). Close (✕) = hide-to-tray, window stays alive (badges/notifications keep working); Quit fully closes. Rail switching; detach opt-in; **moving between shared window / own window / grid keeps the page live** (scroll, drafts, calls survive). Show/Hide/Focus routing (GNOME helper / KWin / Electron fallback). Single-instance = whole app (fact 18). Zoom persisted per service. |
| `desktop-environments.md` | Update | GNOME helper from EGO on request, UUID `@loft.chat`, match-by-title (one WM_CLASS), combined panel menu mirrors the SNI menu, helper changes need a session restart (contributor concern, not per-update). KDE = KWin scripting + SNI. Other desktops = Electron `show()`/`hide()` fallback (not `chrome.windows.update`). |
| `global-config.md` | **Major** | `config.json` (not TOML). Document the exact global keys (fact 9): `trayBackend`, `globalDnd`, `debug` (developer mode), `reopenDetached`, `railOrder`, `grid`, `window`, `configVersion`. Appearance **follows the system theme** (no persisted theme key). Remove `chrome_path`, `combine_tray_icons`, `skip_extension_prompt`. |
| `service-config.md` | **Major** | Per-service keys in the `config.json` `services` map (fact 9): `kind`, `name`, `icon`, `customUrl`, `autoOpen`, `dnd`, `badgesEnabled`, `detached`, `launcher`, `window`. Auto Open three-way. Remove `show_titlebar`, `start_hidden`, `autostart`. Runtime-change example → per-service D-Bus object path. |
| `autostart.md` | **Major**, merge under "Auto Open & Autostart" | Single derived `chat.loft.Loft.desktop` (exists iff any service = On login; launches `loft --minimized`). "On launching Loft" does **not** autostart. XDG Background portal under Flatpak. Remove per-service autostart files. |
| `chrome.md` | **Delete** | Remove file + sidebar entry. |
| `dbus.md` | **Major** | One bus name `chat.loft.Loft`. Root object + methods (`Quit`/`ShowHub`/`SetGlobalDnd`). Per-service objects at stable `/chat/loft/<DbusSegment>`; segment table (`WhatsApp`, `WhatsApp2`, `NextCloudTalk`, …). Interface methods incl. `GetStatus (→ bub)`; **remove `SetShowTitlebar`**. Rewrite every `gdbus` example to `--dest chat.loft.Loft` + the object path. Fix the waybar/polybar loop. |
| `flatpak.md` | **Major** | No `flatpak-spawn`/Chrome. Flathub-clean manifest; on FriendlyHub by choice (fact 15). File locations: `Partitions/` not `profiles/`, no extension dir, helper from EGO, no `logs/`. |
| `troubleshooting.md` | **Major** | **No log files** (fact 17) — replace the log-files table with "logs go to stdout/stderr; run from a terminal to see them; no persistent file yet". Drop Chrome-not-found and per-service singleton. No-tray-icon (combined only). Window focus fix (helper UUID `@loft.chat`). File-locations reference → `config.json`, `Partitions/`, no `extension/`/`logs/`. Reset a service = quit + delete its `Partitions/<id>/`. |
| **new** `unified-view-grid.md` | New | The rail (switch, reorder by drag, detach opt-in), the unified window titlebar, and grid (add via drag or ＋, resize gutters, move by header, remove ✕, persisted arrangement, calls survive). Live-move guarantee. |
| **new** `multiple-accounts.md` | New | Kinds vs instances; `<kind>-<N>` ids; Add another gallery; per-account name/icon (brand / pastel variant / custom file); independent login/badges/notifications; where the name/icon show (rail, tray, titlebar); stable D-Bus segment across renames. |
| **new** `developer-mode.md` | New, short | The Settings toggle (`debug`); Shift+right-click Chromium menu vs plain right-click; off by default; intended for troubleshooting a service's web page. |

---

## Deliverable C — Screenshots & placeholders

### C1. Capture set
Retire all nine current images. New set (each captured **once**, copied into **both** `public/screenshots/` and `docs/public/screenshots/`):

| Filename | Aspect / size | What to capture |
|---|---|---|
| `hub_light.png` / `hub_dark.png` | ~ manager window | The 1.0.0 hub: installed services (icon, name, running/badge status, Open, gear) + Available/Add another; light and dark. Replaces `main_light`/`main_dark`. |
| `unified_window.png` | 16:10 wide | **Hero.** Loft window: rail of service icons on the left + one service full-size with its titlebar (name + unread + zoom + ✕). |
| `grid.png` | 16:10 wide | Grid view: WhatsApp + Slack + Telegram tiled, gutters visible. |
| `multiple_accounts.png` | ~4:3 | Rail showing two accounts of one service with distinct icons/names, and/or the **Add another** gallery. |
| `service_settings.png` | ~3:4 tall | Per-service settings incl. the **Auto Open** three-way and badges/DND/remove. Replaces the old `service_settings`. |
| `developer_mode.png` | ~4:3 | Shift+right-click Chromium menu (Inspect Element / DevTools) over a service. |
| `tray_menu.png` | ~4:3 | Combined "Loft" panel/tray menu on GNOME (global DND, per-service rows, Settings, Quit). Replaces `gnome_unified`. |
| `tray_menu_kde.png` | ~4:3 | The combined menu on KDE. Replaces `kde_unified`. |
| `notification.png` | ~4:3 | A desktop notification with sender avatar. |
| `video_call.png` | 16:9 | A voice/video call in progress inside Loft (now with the titlebar/rail visible). |

Retired with no replacement: `gnome_individual.png`, `kde_individual.png` (no individual mode). `whatsapp_light.png` is superseded by `unified_window.png`.

### C2. Placeholders
A small script (ImageMagick — already a project tool via `npm run icons`) generates a **distinct captioned grey PNG** at each path above: correct aspect ratio, a "PLACEHOLDER" label, and the intended caption text baked in, so both sites render cleanly and each slot is visually identifiable during review. Real captures drop in later at the same paths — no code change needed to swap them.

### C3. `SHOTLIST.md`
At the `loft.chat` repo root. A table: filename → both destination paths → aspect ratio → what to capture → which site/docs pages reference it. Notes the duplicate-directory smell and that each capture must be copied to both dirs. This is the artifact Keith works from when reshooting.

---

## Testing / verification

- **Docs build**: `npm run docs:build` (or the project's VitePress build script) succeeds; no dead internal links after deleting `chrome.md` and adding the three new pages; sidebar renders the new IA.
- **Site build**: `npm run build` (Vite) succeeds; `npm run lint` (eslint) clean; no broken image refs (every `src`/`darkSrc` resolves to a placeholder or real file).
- **Fact audit**: grep both trees for the retired terms — `Google Chrome`, `chrome_path`, `Rust`, `zbus`, `ksni`, `native messaging`, `Manifest`, `libadwaita`, `flatpak-spawn`, `SetShowTitlebar`, `combine_tray_icons`, `config.toml`, `profiles/`, `@chat.loft`, `individual` (tray), `Start Hidden` — expect zero hits except where deliberately describing history.
- **Screenshots**: every referenced path exists (placeholder or real); no reference to a retired filename remains.

## Execution notes

- One spec, executed as per-page / per-file subagent tasks across the three deliverables (writing-plans will sequence them). Docs pages are largely independent and parallelize well; the fact inventory keeps them consistent.
- **Ledger**: `.superpowers/sdd/progress.md` in the `loft` app repo — which task shipped which commits, plus any Minor deferred to the final whole-feature review.
- **Final whole-feature review** after all tasks, even if each task passed its own review (cross-page drift on shared facts is exactly what a per-page review misses).
- All file edits land in the **`loft.chat`** repo; this spec and the ledger live in the **`loft`** app repo.
