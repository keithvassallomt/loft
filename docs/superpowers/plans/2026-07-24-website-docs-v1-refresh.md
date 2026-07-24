# Website & Docs Refresh for Loft 1.0.0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the `loft.chat` marketing site and `docs.loft.chat` VitePress docs into line with Loft 1.0.0 (the Electron rewrite), and replace every screenshot with a captioned placeholder plus a shot-list.

**Architecture:** All edits land in the **`loft.chat`** repo (`/home/keith/LocalCode/keithvassallomt/loft.chat`). Two sites share one repo: the React/Vite marketing site at the root (`src/`) and a VitePress docs site under `docs/`. Corrections are driven by the **canonical fact inventory** in the spec — `docs/superpowers/specs/2026-07-24-website-docs-v1-refresh-design.md` in the **`loft`** app repo — referenced below as "fact N". Every content task ends by grepping the file for retired terms (must be zero) and building the affected site.

**Tech Stack:** React 19 + Vite 8 (marketing site), VitePress 2.0-alpha (docs), TypeScript, ImageMagick 7 (`magick`) for placeholders. Node scripts: `npm run build`, `npm run lint`, `npm run docs:build` (all run from the `loft.chat` repo root).

## Global Constraints

Copy these **exact values** verbatim wherever a page states them. Every task's requirements implicitly include this section. Source: spec fact inventory (facts 1–18), verified against the `loft` app repo.

- **Runtime:** self-contained **Electron 43**, bundles Chromium, **no external Google Chrome**. Voice/video/screen-share work in-process. (fact 1)
- **Components:** one Electron **main process** (TypeScript); a **Svelte 5 (runes) + Vite hub** as the manager UI; **sandboxed preloads** replace the old Chrome extension; D-Bus is hand-rolled **`dbus-next`**. No Rust, zbus, ksni, libadwaita, Manifest V3, or native messaging. (fact 2)
- **Config file:** `~/.config/loft/config.json` (JSON, **not** TOML). Global keys: `services`, `globalDnd`, `trayBackend`, `debug`, `configVersion`, `window`, `reopenDetached`, `railOrder`, `grid`. Per-service keys (inside `services[<id>]`): `kind`, `name`, `icon`, `customUrl`, `window`, `autoOpen` (`'login'|'launch'`; absent = disabled), `dnd`, `badgesEnabled`, `detached`, `launcher`. **No** `chrome_path`, `combine_tray_icons`, `skip_extension_prompt`, `show_titlebar`, `start_hidden`, `autostart`. Appearance follows the system theme (no persisted theme key). Developer mode is the `debug` key. (facts 6, 9)
- **D-Bus:** one bus name **`chat.loft.Loft`**. Root object `/chat/loft/Loft`, iface `chat.loft.Loft`: `Quit()`, `ShowHub()`, `SetGlobalDnd(b)`. Per-service objects `/chat/loft/<DbusSegment>` (segment = kind's **default** display name + instance number, stable across renames: `WhatsApp`, `WhatsApp2`, `NextCloudTalk`), iface `chat.loft.Service`: `Show()`, `Hide()`, `Toggle()`, `Quit()`, `GetStatus() → (bub)`, `SetDnd(b)`, `SetBadgesEnabled(b)`. **No `SetShowTitlebar`.** (fact 10)
- **Tray:** one combined **"Loft"** icon, no per-service icons, no individual mode. Backends via `trayBackend`: `auto` (GNOME→panel, else SNI) / `gnome-panel` / `sni`. (fact 8)
- **Autostart:** one derived entry `~/.config/autostart/chat.loft.Loft.desktop` (launches `loft --minimized`), exists **iff** some service is Auto Open = On login. (fact 11)
- **Data paths:** session partitions `~/.local/share/loft/Partitions/<id>/`; per-instance icons `~/.local/share/loft/icons/<id>.png`; avatar cache `~/.local/share/loft/avatars/`. **No** `profiles/`, `extension/`, or `logs/` directories. (facts 12, 17)
- **GNOME helper:** installed **from extensions.gnome.org on request**, UUID **`loft-shell-helper@loft.chat`**, matches windows **by title**. Not bundled. (fact 14)
- **Flatpak:** no `flatpak-spawn`/sandbox escape; Flathub-clean manifest; distributed on **FriendlyHub + GitHub Releases by choice**. (fact 15)
- **Logging:** stdout/stderr via `console.*`; **no persistent log files**; `-v`/`--verbose` accepted but unused. (fact 17)
- **CLI:** `loft` (→ hub), `loft --service=<id>` or `loft --service <id>`, `--minimized`, `-v`/`--verbose`. Single-instance lock for the **whole app**. (facts 9, 18)
- **Supported services (unchanged in 1.0.0):** WhatsApp `https://web.whatsapp.com/`, Facebook Messenger `https://www.facebook.com/messages/`, Slack `https://app.slack.com/client/`, Telegram `https://web.telegram.org/a/`, Element `https://app.element.io/`, NextCloud Talk (self-hosted, `customUrl`).
- **Retired-term denylist** (must not appear as a *current* fact anywhere; historical mentions clearly framed as "old"/"previously" are the only exception): `Google Chrome`, `chrome_path`, `combine_tray_icons`, `skip_extension_prompt`, `config.toml`, `.toml`, `Rust`, `zbus`, `ksni`, `libadwaita`, `native messaging`, `Manifest`, `flatpak-spawn`, `SetShowTitlebar`, `show_titlebar`, `Start Hidden`, `start_hidden`, `profiles/`, `@chat.loft`, `individual tray`, `combined mode`.

---

## Task order & why

Ordered so every commit leaves both sites building. Screenshots and the three new pages come first (they add files nothing else breaks); the sidebar is rewired only once its new targets exist; `chrome.md` and the retired PNGs are deleted **last**, after every inbound reference is gone (verified by grep), so no build ever has a dead link or the sites keep valid image refs throughout.

---

### Task 1: Screenshot placeholders, generator script, and SHOTLIST

**Files:**
- Create: `loft.chat/scripts/gen-placeholder-screenshots.sh`
- Create: `loft.chat/SHOTLIST.md`
- Create (11 files × 2 dirs): `loft.chat/public/screenshots/<name>` and `loft.chat/docs/public/screenshots/<name>` for each new-set name below (overwrites the existing `service_settings.png` and `video_call.png`; the 7 other retired PNGs are left in place and removed in Task 18).

**New-set names, dimensions, captions** (used by the script):

| name | WxH | caption line 2 |
|---|---|---|
| `hub_light.png` | 1400x1000 | Hub (light): installed + available services, status |
| `hub_dark.png` | 1400x1000 | Hub (dark): installed + available services, status |
| `unified_window.png` | 1600x1000 | Loft window: rail + a service full-size with titlebar |
| `grid.png` | 1600x1000 | Grid view: WhatsApp + Slack + Telegram tiled |
| `multiple_accounts.png` | 1200x900 | Rail with two accounts of one service / Add another gallery |
| `service_settings.png` | 900x1100 | Per-service settings incl. Auto Open three-way |
| `developer_mode.png` | 1200x900 | Shift+right-click Chromium menu over a service |
| `tray_menu.png` | 900x800 | Combined 'Loft' panel menu on GNOME |
| `tray_menu_kde.png` | 900x800 | Combined 'Loft' tray menu on KDE |
| `notification.png` | 900x600 | Desktop notification with sender avatar |
| `video_call.png` | 1600x900 | Voice/video call in progress inside Loft |

**Interfaces:**
- Produces: the 11 image paths in both `public/screenshots/` and `docs/public/screenshots/` that Tasks 2–5, 6, 7, 16 reference by name.

- [ ] **Step 1: Write the generator script**

Create `loft.chat/scripts/gen-placeholder-screenshots.sh` (the `magick` invocation is verified working on ImageMagick 7.1.2 with Liberation Sans):

```bash
#!/usr/bin/env bash
# Regenerate captioned placeholder screenshots for both the marketing site and the docs.
# Real captures replace these at the same paths later (see SHOTLIST.md). Needs ImageMagick 7 (`magick`).
set -euo pipefail
cd "$(dirname "$0")/.."
DIRS=(public/screenshots docs/public/screenshots)

# name|WxH|caption
SHOTS=(
  "hub_light.png|1400x1000|Hub (light): installed + available services, status"
  "hub_dark.png|1400x1000|Hub (dark): installed + available services, status"
  "unified_window.png|1600x1000|Loft window: rail + a service full-size with titlebar"
  "grid.png|1600x1000|Grid view: WhatsApp + Slack + Telegram tiled"
  "multiple_accounts.png|1200x900|Rail with two accounts of one service / Add another gallery"
  "service_settings.png|900x1100|Per-service settings incl. Auto Open three-way"
  "developer_mode.png|1200x900|Shift+right-click Chromium menu over a service"
  "tray_menu.png|900x800|Combined 'Loft' panel menu on GNOME"
  "tray_menu_kde.png|900x800|Combined 'Loft' tray menu on KDE"
  "notification.png|900x600|Desktop notification with sender avatar"
  "video_call.png|1600x900|Voice/video call in progress inside Loft"
)

for d in "${DIRS[@]}"; do
  mkdir -p "$d"
  for shot in "${SHOTS[@]}"; do
    IFS='|' read -r name size caption <<< "$shot"
    w="${size%x*}"; h="${size#*x}"
    magick -size "${size}" canvas:"#2b2f36" \
      -fill "#8b929e" -stroke "#8b929e" -strokewidth 3 \
      -draw "roundrectangle 20,20 $((w-20)),$((h-20)) 24,24" \
      -stroke none -fill "#c9cdd6" -font "Liberation-Sans" -pointsize 46 \
      -gravity north -annotate +0+90 "PLACEHOLDER" \
      -fill "#5a6270" -pointsize 28 -gravity center \
      -annotate +0+0 "${name} — ${size}\n${caption}" \
      "$d/$name"
  done
done
echo "Generated ${#SHOTS[@]} placeholders in each of: ${DIRS[*]}"
```

- [ ] **Step 2: Run the script**

Run: `chmod +x loft.chat/scripts/gen-placeholder-screenshots.sh && loft.chat/scripts/gen-placeholder-screenshots.sh`
Expected: "Generated 11 placeholders in each of: public/screenshots docs/public/screenshots"

- [ ] **Step 3: Verify every placeholder exists at the right size**

Run (from `loft.chat`):
```bash
for d in public/screenshots docs/public/screenshots; do
  for n in hub_light hub_dark unified_window grid multiple_accounts service_settings developer_mode tray_menu tray_menu_kde notification video_call; do
    magick identify -format "%f %wx%h\n" "$d/$n.png" || echo "MISSING $d/$n.png"
  done
done
```
Expected: 22 lines, no "MISSING".

- [ ] **Step 4: Write `SHOTLIST.md`**

Create `loft.chat/SHOTLIST.md`: a title, a short intro ("Placeholders live at each path below; replace with real captures at the same filenames and rerun nothing — the sites pick them up directly. Each capture goes in **both** directories."), a note that the two dirs are intentionally duplicated (not deduped) and every capture must be copied to both, and a table with columns: **File**, **Both paths**, **Size**, **Capture**, **Referenced by**. One row per new-set name using the caption text above as "Capture", and "Referenced by" naming the pages/components from Tasks 3–7, 16 (e.g. `unified_window.png` → what-is-loft.md, unified-view-grid.md, data.ts carousel).

- [ ] **Step 5: Verify the docs still build with the new images present**

Run (from `loft.chat`): `npm run docs:build`
Expected: build succeeds (old images still referenced by not-yet-rewritten pages, new images added — no dead links).

- [ ] **Step 6: Commit**

```bash
cd loft.chat
git add scripts/gen-placeholder-screenshots.sh SHOTLIST.md public/screenshots docs/public/screenshots
git commit -m "assets: captioned placeholder screenshots + SHOTLIST for 1.0.0 reshoot"
```

---

### Task 2: New docs feature pages

Create the three net-new pages. They are **not yet linked** from the sidebar (Task 3 does that) — orphan pages build fine. Each may link only to pages that already exist (`services.md`, `dbus.md`, etc.). Apply Global Constraints.

**Files:**
- Create: `loft.chat/docs/guide/unified-view-grid.md`
- Create: `loft.chat/docs/guide/multiple-accounts.md`
- Create: `loft.chat/docs/guide/developer-mode.md`

**Interfaces:**
- Produces: `/guide/unified-view-grid`, `/guide/multiple-accounts`, `/guide/developer-mode` — sidebar targets Task 3 wires in.

- [ ] **Step 1: Write `unified-view-grid.md`** (facts 3, 4, 13; spec "new" rows)

Sections and required assertions:
- **Unified view** — one Loft window with a left **rail** of service icons; click an icon to switch that service full-size; each service has its own **structural titlebar** (name + live unread count + zoom out/in "A" buttons + close ✕). **Drag rail icons to reorder.** Close (✕) hides to tray; the service keeps running.
- **Detaching** — "Open in its own window" (`detached`) is opt-in and remembered; grid and detached are mutually exclusive.
- **Live move** — moving a service between the shared window, its own window, and the grid keeps its page **live**: scroll position, half-typed drafts, and ongoing calls (incl. video/screen-share) survive.
- **Grid** — a pinned **Grid** entry at the top of the rail tiles several live services at once. Add by dragging a rail icon into the grid or via the titlebar **＋**; drop against a cell edge to pick the half. Drag gutters to resize; drag a cell by its header handle to move; remove with ✕ (service keeps running, stays in the rail). Arrangement is remembered across restarts. Zoom acts on the focused cell.
- Embed `![Unified window](/screenshots/unified_window.png)` and `![Grid view](/screenshots/grid.png)`.

- [ ] **Step 2: Write `multiple-accounts.md`** (fact 5)

Required assertions: Loft holds more than one account of the same service (two WhatsApps, two Talk servers), each with its own login, badges, notifications. The registry lists **kinds** (the app: URL, badge parser, brand icon); a config entry is an **instance** (one account). Instance 1 keeps the bare kind id (`whatsapp`); later ones are `<kind>-<N>` (`whatsapp-2`). Add from the **Add another** gallery in the hub. Each account gets its own **name** and **icon** (brand icon / pastel colour variant / custom image file) shown in the rail, tray, and titlebar. The D-Bus object segment is derived from the kind's **default** name + instance number, so it's stable across renames (link to `/guide/dbus`). Embed `![Multiple accounts](/screenshots/multiple_accounts.png)`.

- [ ] **Step 3: Write `developer-mode.md`** (fact 6)

Required assertions: a **Settings** toggle (the `debug` config key), off by default. When on, **Shift+right-click** inside a service opens the Chromium developer menu (Inspect Element, DevTools, Reload, back/forward); a plain right-click still uses the web app's own menu. Purpose: troubleshooting a service's web page. Embed `![Developer menu](/screenshots/developer_mode.png)`.

- [ ] **Step 4: Verify build + no retired terms**

Run (from `loft.chat`):
```bash
npm run docs:build
grep -nEi 'google chrome|config\.toml|\bzbus\b|\bksni\b|native messaging|SetShowTitlebar|flatpak-spawn|@chat\.loft' docs/guide/unified-view-grid.md docs/guide/multiple-accounts.md docs/guide/developer-mode.md
```
Expected: build succeeds; grep prints nothing.

- [ ] **Step 5: Commit**

```bash
cd loft.chat
git add docs/guide/unified-view-grid.md docs/guide/multiple-accounts.md docs/guide/developer-mode.md
git commit -m "docs: add unified-view/grid, multiple-accounts, developer-mode pages"
```

---

### Task 3: Docs sidebar IA + home cards

**Files:**
- Modify: `loft.chat/docs/.vitepress/config.ts` (sidebar + nav)
- Modify: `loft.chat/docs/index.md` (hero feature cards)

**Interfaces:**
- Consumes: the three pages from Task 2.

- [ ] **Step 1: Rewrite the sidebar in `config.ts`**

Replace the `sidebar` array with these four groups (drop the `chrome` link; the `chrome.md` file itself stays until Task 18):
- **Introduction**: What is Loft? (`/guide/what-is-loft`) · Getting Started (`/guide/getting-started`)
- **Features**: Unified View & Grid (`/guide/unified-view-grid`) · Multiple Accounts (`/guide/multiple-accounts`) · Supported Services (`/guide/services`) · Tray Icon (`/guide/tray-icons`) · Notifications & Badges (`/guide/notifications`) · Window Behaviour (`/guide/window-behaviour`) · Desktop Environment Integration (`/guide/desktop-environments`)
- **Configuration**: Global Settings (`/guide/global-config`) · Per-Service Settings (`/guide/service-config`) · Auto Open & Autostart (`/guide/autostart`)
- **Advanced**: D-Bus Interface (`/guide/dbus`) · Flatpak (`/guide/flatpak`) · Developer Mode (`/guide/developer-mode`) · Troubleshooting (`/guide/troubleshooting`)

Leave `nav`, `socialLinks`, `search`, `logo` unchanged. Update `footer.copyright` year range if it reads `2025-present` — leave as-is otherwise.

- [ ] **Step 2: Fix the home feature cards in `index.md`** (facts 1, 8; spec `index.md` row)

- "Voice & Video Calling" details → drop "real Google Chrome"; say calls, video, and screen-share work in-process on Electron's bundled Chromium, no external browser.
- "System Tray Integration" details → one combined **Loft** tray icon with badge counts, per-service Do Not Disturb, and show/hide; drop "each service gets its own".
- Keep "Desktop Notifications" as-is.
- Replace the "GNOME & KDE Support" card with **Unified View & Grid**: every service in one window with a switchable rail, or tile several at once in the grid — drafts and calls survive the move. (Reuse a suitable inline SVG icon, e.g. a layout-grid glyph.)
- Tagline unchanged.

- [ ] **Step 3: Verify build + link integrity**

Run (from `loft.chat`): `npm run docs:build`
Expected: build succeeds; sidebar shows the four new groups; no dead links (every sidebar target exists; `chrome.md` still present so any lingering inbound link stays valid).

- [ ] **Step 4: Commit**

```bash
cd loft.chat
git add docs/.vitepress/config.ts docs/index.md
git commit -m "docs: regroup sidebar for 1.0.0 IA; fix home feature cards"
```

---

### Task 4: Rewrite `what-is-loft.md`

**Files:**
- Modify: `loft.chat/docs/guide/what-is-loft.md`

- [ ] **Step 1: Rewrite the page** (facts 1, 2, 3, 8, 16)

- Intro: Loft gives you proper desktop apps for the six services with voice/video calling, a combined tray icon, badge counts, and desktop notifications — as a **self-contained Electron app** (bundles Chromium, no external browser).
- **The Problem**: keep the two bullets but correct them — third-party Electron wrappers were *thought* to lack calls, but the real breakage was a **missing `window.open` handler** for call popups, not an Electron/WebRTC limitation (fact 16); PWAs from Chrome work but have no tray icon and poor integration.
- **How Loft solves this**: self-contained Electron with bundled Chromium (full WebRTC/codec support in-process); a unified window with a service rail (+ grid, + multiple accounts); sandboxed preloads for badges/notifications; combined tray; desktop notifications with avatars and click-to-navigate; close-to-tray; deep GNOME/KDE integration.
- **Architecture**: replace the old `manager + per-service daemon` list and the `loft --service → Chrome + extension` code block. New description: **one** Electron application — a main process owns the service registry, window/view lifecycle, tray, notifications, D-Bus, config and autostart; a Svelte hub is the manager UI; each running service is a `WebContentsView` (its own titlebar view stacked above it) inside the single Loft window. Replace the ASCII block with one reflecting: `loft` → hub; `loft --service=whatsapp` → routed into the single app instance → renders WhatsApp in-process in a session partition. No extension, no native messaging, no external Chrome.
- Replace the `video_call.png` image reference caption if needed (path unchanged); update the two manager images from `main_light.png`/`main_dark.png` → `hub_light.png`/`hub_dark.png`.
- **Packaging**: keep RPM/DEB/AppImage/Flatpak-on-FriendlyHub.

- [ ] **Step 2: Verify** — Run (from `loft.chat`):
```bash
npm run docs:build
grep -nEi 'google chrome|per-service daemon|--load-extension|native messaging|user-data-dir|profiles/|libadwaita' docs/guide/what-is-loft.md
grep -n 'main_light\|main_dark\|whatsapp_light' docs/guide/what-is-loft.md
```
Expected: build succeeds; both greps print nothing.

- [ ] **Step 3: Commit** — `cd loft.chat && git add docs/guide/what-is-loft.md && git commit -m "docs: rewrite what-is-loft for the Electron architecture"`

---

### Task 5: Rewrite `getting-started.md`

**Files:**
- Modify: `loft.chat/docs/guide/getting-started.md`

- [ ] **Step 1: Rewrite** (facts 1, 7, 9, 18; Global Constraints CLI)

- **Delete the "Prerequisites / Google Chrome" section entirely.** No Chrome prompt.
- **Installation**: keep the Flatpak/RPM/DEB/AppImage blocks and the FriendlyHub badge (`/screenshots/friendlyhub-badge-*.svg` — leave those refs).
- **Installing a service**: launch `loft` → the hub → Add a service from the gallery (no extension/native-messaging setup, no `.desktop`-and-native-messaging sentence). Update image `main_light.png` → `hub_light.png`.
- **Launching**: switching to a service in the unified window; `loft --service whatsapp` opens/focuses it in the single app instance. Update `whatsapp_light.png` → `unified_window.png`.
- **Service settings**: replace the old bullet list with: custom URL (Element/Talk), **Auto Open** (Disabled / On login / On launching Loft), Show Badges, Do Not Disturb, Remove (with "also delete login data"). Remove "Start at Login", "Start Hidden", "Show Loft Titlebar". Update `service_settings.png` caption.
- **Command-Line Options** block → exactly: `loft` (hub); `loft --service <name>` (whatsapp, messenger, slack, telegram, element, talk); `loft --service <name> --minimized`; `loft -v` / `--verbose`.

- [ ] **Step 2: Verify** — Run (from `loft.chat`):
```bash
npm run docs:build
grep -nEi 'google chrome|start hidden|show loft titlebar|start at login|native messaging|main_light|whatsapp_light' docs/guide/getting-started.md
```
Expected: build succeeds; grep prints nothing.

- [ ] **Step 3: Commit** — `cd loft.chat && git add docs/guide/getting-started.md && git commit -m "docs: rewrite getting-started (no Chrome, Auto Open, unified window)"`

---

### Task 6: Rewrite `services.md`

**Files:**
- Modify: `loft.chat/docs/guide/services.md`

- [ ] **Step 1: Rewrite** (facts 2, 5, 12; Supported services list)

- Intro: each service runs in its own Electron **session partition** (not a Chrome profile), rendered in-process; no per-service daemon. Add a short **Multiple accounts** note (kinds vs instances) linking `/guide/multiple-accounts`.
- Per-service subsections — correct the "Notifications" mechanism to sandboxed preloads (not Chrome extension). Keep the URL/calling/badge facts, updating specifics: WhatsApp badge from `aria-label`/title; Messenger **DOM-scrape-only** (native suppressed to avoid duplicates) + nav-banner de-chrome; Slack unread rows + avatar scan; Telegram **scrape-only**; Element badge from `document.title` `[N]`; NextCloud Talk badge = sum of `.counter-bubble__counter`, notifications via the override path, avatars fetched in **main** via the authenticated partition session, plus header/sidebar de-chrome. Fix the Messenger URL to `https://www.facebook.com/messages/` and Talk's row to "self-hosted (`customUrl`)".
- "Adding a Service": from the hub; self-hosted Element/Talk via `customUrl`.

- [ ] **Step 2: Verify** — Run (from `loft.chat`):
```bash
npm run docs:build
grep -nEi 'chrome profile|chrome native|daemon instance|inlined? in-page|native messaging' docs/guide/services.md
```
Expected: build succeeds; grep prints nothing.

- [ ] **Step 3: Commit** — `cd loft.chat && git add docs/guide/services.md && git commit -m "docs: rewrite services (partitions, preloads, per-service specifics)"`

---

### Task 7: Rewrite `tray-icons.md`

**Files:**
- Modify: `loft.chat/docs/guide/tray-icons.md`

- [ ] **Step 1: Rewrite** (fact 8)

- **Remove the "Individual Mode" section and every "individual" reference.** There is one combined **Loft** icon, always.
- Left-click opens a menu that mirrors the SNI/panel layout: a **global DND** toggle, one row per configured service (Show/Hide + per-service DND + Quit), then **Settings** (opens the hub) and **Quit Loft**. Badge/DND state shown via overlay.
- **Backends** section: `trayBackend` = `auto` (GNOME→`gnome-panel`, else `sni`) / `gnome-panel` (native panel button via the Shell helper) / `sni` (hand-rolled `dbus-next` StatusNotifierItem, unread/DND overlay pixmaps composited at runtime). Link `/guide/global-config`.
- Update images `gnome_unified.png` → `tray_menu.png`, `kde_unified.png` → `tray_menu_kde.png`; remove `gnome_individual.png` / `kde_individual.png` references. Drop the `combine_tray_icons` mention.

- [ ] **Step 2: Verify** — Run (from `loft.chat`):
```bash
npm run docs:build
grep -nEi 'individual|combine_tray_icons|gnome_individual|kde_individual|gnome_unified|kde_unified' docs/guide/tray-icons.md
```
Expected: build succeeds; grep prints nothing.

- [ ] **Step 3: Commit** — `cd loft.chat && git add docs/guide/tray-icons.md && git commit -m "docs: rewrite tray-icons (single combined icon, no individual mode)"`

---

### Task 8: Rewrite `notifications.md`

**Files:**
- Modify: `loft.chat/docs/guide/notifications.md`

- [ ] **Step 1: Rewrite** (facts 9, 10; DND semantics)

- Desktop notifications via `org.freedesktop.Notifications` over a **persistent `dbus-next` connection** (KDE closes notifications when the sender disconnects). Avatars resolved in the **main process** via each service's partition `session.fetch` (so authenticated Element/Talk avatars work), cached ~1hr at `~/.local/share/loft/avatars/`. Click focuses the window and navigates to the conversation.
- **Badge counts**: shown in the service titlebar's unread count and on the tray/panel icon (not "tray icon title"). Per-service `SetBadgesEnabled` toggle.
- **Do Not Disturb**: shown only when **none** of {system DND, per-service DND, "this service is both focused and visible"} apply. In the grid, every visible cell counts as focused-and-visible while the Loft window has focus. System DND detected live (GNOME `show-banners` gsetting negated; KDE `Inhibited` property). Global DND mutes everything.
- Update the `gdbus` example to the single bus name + per-service object path (see Global Constraints D-Bus), e.g. `--dest chat.loft.Loft --object-path /chat/loft/WhatsApp --method chat.loft.Service.SetBadgesEnabled false`.
- Remove the `do_not_disturb = true` TOML snippet; DND is set via the tray, the hub, or D-Bus `SetDnd(true)`.

- [ ] **Step 2: Verify** — Run (from `loft.chat`):
```bash
npm run docs:build
grep -nEi 'chat\.loft\.WhatsApp |\.toml|tray icon title|data URI' docs/guide/notifications.md
```
Expected: build succeeds; grep prints nothing (the D-Bus dest is now `chat.loft.Loft`).

- [ ] **Step 3: Commit** — `cd loft.chat && git add docs/guide/notifications.md && git commit -m "docs: rewrite notifications (dbus-next, main-side avatars, DND gate)"`

---

### Task 9: Rewrite `window-behaviour.md`

**Files:**
- Modify: `loft.chat/docs/guide/window-behaviour.md`

- [ ] **Step 1: Rewrite** (facts 3, 13, 18)

- **Closing**: Close (✕) on the titlebar **hides to tray**; the window stays alive so badges/notifications keep working; no Chrome "leave this page?" warning; there is no separate minimize. Quit (tray submenu / D-Bus `Quit()`) fully closes.
- **Titlebar**: a **structural** view on every service window (icon + name + live unread + zoom-out/zoom-in "A" buttons + ✕). No hover-to-reveal, no toggle.
- **Show/Hide/Focus**: GNOME → Shell helper `FocusWindow`/`HideWindow`; KDE → KWin scripting; other desktops → Electron `window.show()`/`hide()`. Hidden windows removed from alt-tab/overview/dock on GNOME.
- **Rail & moving**: switch services via the rail; detach opt-in; moving between shared window / own window / grid keeps the page live.
- **Persistence**: window bounds + per-service zoom (0.3×–3.0×) saved and restored.
- **Single instance**: replace the per-service singleton section — the lock is for the **whole app**; a second launch (`loft --service slack`) routes its argv to the running instance and exits.
- Remove `SetShowTitlebar`.

- [ ] **Step 2: Verify** — Run (from `loft.chat`):
```bash
npm run docs:build
grep -nEi 'SetShowTitlebar|hover near the top|leave this page|chromeless chrome|per service.*singleton|daemon instance' docs/guide/window-behaviour.md
```
Expected: build succeeds; grep prints nothing.

- [ ] **Step 3: Commit** — `cd loft.chat && git add docs/guide/window-behaviour.md && git commit -m "docs: rewrite window-behaviour (structural titlebar, close-to-tray, app singleton)"`

---

### Task 10: Rewrite `desktop-environments.md`

**Files:**
- Modify: `loft.chat/docs/guide/desktop-environments.md`

- [ ] **Step 1: Rewrite** (fact 14)

- **GNOME**: the Shell helper is installed **from extensions.gnome.org on request** (Loft checks via `GetExtensionInfo`, prompts, and installs via `InstallRemoteExtension`), **not bundled**. UUID **`loft-shell-helper@loft.chat`**. It provides window focus/hide (bypassing focus-stealing prevention via `meta_window.activate()`), alt-tab/overview/dock filtering for hidden windows, and the native combined panel menu. Because every Loft window shares one WM_CLASS, the helper matches windows **by title**. Keep the Wayland "changes need a session restart" note but frame it as a contributor/update concern.
- **KDE**: KWin scripting over D-Bus (`org.kde.kwin.Scripting`) matched by caption + SNI tray. Unchanged conceptually.
- **Other desktops**: window management via Electron `window.show()`/`hide()` (not `chrome.windows.update()`); SNI tray.

- [ ] **Step 2: Verify** — Run (from `loft.chat`):
```bash
npm run docs:build
grep -nEi '@chat\.loft|installs a companion|bundled|chrome\.windows\.update|installed automatically' docs/guide/desktop-environments.md
```
Expected: build succeeds; grep prints nothing.

- [ ] **Step 3: Commit** — `cd loft.chat && git add docs/guide/desktop-environments.md && git commit -m "docs: rewrite desktop-environments (helper from EGO, @loft.chat, match-by-title)"`

---

### Task 11: Rewrite `global-config.md` + `service-config.md`

**Files:**
- Modify: `loft.chat/docs/guide/global-config.md`
- Modify: `loft.chat/docs/guide/service-config.md`

- [ ] **Step 1: Rewrite `global-config.md`** (fact 9)

Config lives at `~/.config/loft/config.json` (single JSON file). Document only the real global keys: `trayBackend` (`auto`/`gnome-panel`/`sni`), `globalDnd`, `debug` (developer mode), `reopenDetached`, `railOrder`, `grid`, `window`, `configVersion`. Note appearance follows the system theme (no key). **Remove** `chrome_path`, `combine_tray_icons`, `skip_extension_prompt` and all TOML. Give one JSON example.

- [ ] **Step 2: Rewrite `service-config.md`** (facts 7, 9, 10)

Per-service settings live inside `config.json` under `services.<id>`. Document keys: `kind`, `name`, `icon`, `customUrl`, `autoOpen` (`'login'|'launch'`; absent = disabled), `dnd`, `badgesEnabled`, `detached`, `launcher`, `window`. Explain **Auto Open** three-way. **Remove** `show_titlebar`, `start_hidden`, `autostart` (bool). Runtime-change example → per-service D-Bus object path (`--dest chat.loft.Loft --object-path /chat/loft/Slack --method chat.loft.Service.SetDnd true`); drop the `SetShowTitlebar` example. Give one JSON example.

- [ ] **Step 3: Verify** — Run (from `loft.chat`):
```bash
npm run docs:build
grep -nEi '\.toml|chrome_path|combine_tray_icons|skip_extension_prompt|show_titlebar|start_hidden|SetShowTitlebar|autostart =' docs/guide/global-config.md docs/guide/service-config.md
```
Expected: build succeeds; grep prints nothing.

- [ ] **Step 4: Commit** — `cd loft.chat && git add docs/guide/global-config.md docs/guide/service-config.md && git commit -m "docs: rewrite config pages for config.json schema"`

---

### Task 12: Rewrite `autostart.md`

**Files:**
- Modify: `loft.chat/docs/guide/autostart.md`

- [ ] **Step 1: Rewrite** (facts 7, 11)

Autostart is **derived**, not a per-service setting: a single `~/.config/autostart/chat.loft.Loft.desktop` (launches `loft --minimized`) exists **iff** some service has Auto Open = **On login** (`effectiveAutoOpen === 'login'`). An **On launching Loft** service loads only when you open Loft (the `--minimized` login launch skips it) and does **not** create the entry. Written via the XDG Background portal under Flatpak, directly otherwise. Remove per-service autostart `.desktop` files and "Start Hidden". Cross-link `/guide/service-config` for the Auto Open control.

- [ ] **Step 2: Verify** — Run (from `loft.chat`):
```bash
npm run docs:build
grep -nEi 'loft-whatsapp\.desktop|start hidden|autostart = true|per-service.*autostart' docs/guide/autostart.md
```
Expected: build succeeds; grep prints nothing.

- [ ] **Step 3: Commit** — `cd loft.chat && git add docs/guide/autostart.md && git commit -m "docs: rewrite autostart (single derived entry from Auto Open)"`

---

### Task 13: Rewrite `dbus.md`

**Files:**
- Modify: `loft.chat/docs/guide/dbus.md`

- [ ] **Step 1: Rewrite** (fact 10; Global Constraints D-Bus)

- One bus name **`chat.loft.Loft`**. Document the **root object** `/chat/loft/Loft` (iface `chat.loft.Loft`): `Quit()`, `ShowHub()`, `SetGlobalDnd(b)`.
- **Per-service objects** `/chat/loft/<DbusSegment>` (iface `chat.loft.Service`): `Show`, `Hide`, `Toggle`, `Quit`, `GetStatus → (bub)`, `SetDnd(b)`, `SetBadgesEnabled(b)`. Note the segment is the kind's **default** name + instance number (stable across renames).
- Replace the bus-name/object-path table with a **segment** table: WhatsApp→`/chat/loft/WhatsApp`, a second WhatsApp→`/chat/loft/WhatsApp2`, Messenger→`/chat/loft/Messenger`, Slack, Telegram, Element, NextCloud Talk→`/chat/loft/NextCloudTalk`.
- Rewrite **every** `gdbus` example to `--dest chat.loft.Loft --object-path /chat/loft/<Segment> --method chat.loft.Service.<M>`. Remove `SetShowTitlebar`. Fix the scripting/waybar loops to iterate object paths under the one dest.

- [ ] **Step 2: Verify** — Run (from `loft.chat`):
```bash
npm run docs:build
grep -nE 'dest chat\.loft\.(WhatsApp|Messenger|Slack|Telegram|Element|NextCloudTalk)|SetShowTitlebar' docs/guide/dbus.md
```
Expected: build succeeds; grep prints nothing (all `--dest` values are `chat.loft.Loft`).

- [ ] **Step 3: Commit** — `cd loft.chat && git add docs/guide/dbus.md && git commit -m "docs: rewrite dbus (single bus name, root + per-service objects)"`

---

### Task 14: Rewrite `flatpak.md`

**Files:**
- Modify: `loft.chat/docs/guide/flatpak.md`

- [ ] **Step 1: Rewrite** (facts 12, 15, 17)

- **Remove** the "How It Works / flatpak-spawn --host / org.freedesktop.Flatpak" and "Chrome with Flatpak" sections. Loft renders everything in-process; no sandbox escape.
- New framing: the manifest is **Flathub-clean** (tight `finish-args`), but Loft is distributed on **FriendlyHub + GitHub Releases by choice**, not because Flathub is blocked. Keep the install command.
- **File Locations** table: `~/.config/loft/` (config.json), `~/.local/share/loft/Partitions/`, `~/.local/share/loft/avatars/`, `~/.local/share/loft/icons/`; GNOME helper from extensions.gnome.org (`~/.local/share/gnome-shell/extensions/loft-shell-helper@loft.chat/`). **Remove** `profiles/`, `extension/`, and `logs/` rows. Note autostart is written by the XDG Background portal under Flatpak.

- [ ] **Step 2: Verify** — Run (from `loft.chat`):
```bash
npm run docs:build
grep -nEi 'flatpak-spawn|org\.freedesktop\.Flatpak|proprietary codecs|profiles/|/extension/|logs/|@chat\.loft' docs/guide/flatpak.md
```
Expected: build succeeds; grep prints nothing.

- [ ] **Step 3: Commit** — `cd loft.chat && git add docs/guide/flatpak.md && git commit -m "docs: rewrite flatpak (no sandbox escape, Flathub-clean, FriendlyHub by choice)"`

---

### Task 15: Rewrite `troubleshooting.md`

**Files:**
- Modify: `loft.chat/docs/guide/troubleshooting.md`

- [ ] **Step 1: Rewrite** (facts 1, 14, 17, 18)

- **Log Files**: replace the per-daemon log table with the truth — Loft logs to **stdout/stderr** via `console.*`; there is **no persistent log file yet**; run `loft` from a terminal (or `npm start` unpackaged) to see output; `-v`/`--verbose` is accepted but currently unused.
- **Remove** "Chrome Not Found" and the per-service "Service Won't Start (Singleton)" sections; the singleton is whole-app now.
- **No Tray Icon**: combined icon only; GNOME needs the Shell helper (or SNI with AppIndicator if `trayBackend = "sni"`); SNI watcher backoff at login.
- **Window Won't Focus (GNOME)**: check the helper is enabled — `gnome-extensions list | grep loft`, `gnome-extensions enable loft-shell-helper@loft.chat`; Wayland may need a session restart.
- **Video/Voice**: drop "use real Chrome / Chrome version"; check mic/camera permissions in the OS.
- **File Locations Reference** table: `config.json`, `Partitions/<id>/`, `~/.local/share/loft/icons/`, `~/.local/share/loft/avatars/`, helper `@loft.chat`, `.desktop` launchers, the single `chat.loft.Loft.desktop` autostart entry. **Remove** `config.toml`, `services/<name>.toml`, `profiles/`, `extension/`, `logs/`.
- **Resetting a service**: quit it, then delete its `~/.local/share/loft/Partitions/<id>/`.

- [ ] **Step 2: Verify** — Run (from `loft.chat`):
```bash
npm run docs:build
grep -nEi 'google chrome|chrome version|\.toml|profiles/|/extension/|/logs/|native-messaging|@chat\.loft|singleton' docs/guide/troubleshooting.md
```
Expected: build succeeds; grep prints nothing.

- [ ] **Step 3: Commit** — `cd loft.chat && git add docs/guide/troubleshooting.md && git commit -m "docs: rewrite troubleshooting (stdout logs, no Chrome, app singleton)"`

---

### Task 16: Rewrite marketing site `src/data.ts`

**Files:**
- Modify: `loft.chat/src/data.ts`

- [ ] **Step 1: Rewrite the conversation** (facts 1, 2, 5, 8; spec A1)

- `intro-bot.footer`: replace the "real Google Chrome … Rust-based system daemon" sentence with the self-contained-Electron framing (bundles Chromium, no separate browser; native desktop integration — tray, badges, notifications, close-to-tray).
- `intro-bot-2.carousel`: rewrite entries to the new screenshots — `hub_light.png`+`hub_dark.png` (dark via `darkSrc`), `unified_window.png`, `grid.png`, `multiple_accounts.png`, `service_settings.png`, `video_call.png`, `tray_menu.png`, `tray_menu_kde.png` — with accurate captions. Remove `main_light`/`main_dark`/`whatsapp_light`/`gnome_individual`/`kde_individual`/`gnome_unified`/`kde_unified` entries.
- `features-bot.content`: rewrite bullets to unified view + rail, grid, multiple accounts, combined tray with badges, notifications with avatars, per-service DND, Auto Open modes, developer mode, in-process voice/video/screen-share, isolated per-service **sessions**. Fix "it's own" → "its own".
- `download-bot.content`: delete the "you just need Google Chrome installed" note; keep the formats.
- `privacy-bot.content`: replace "Rust daemon and Chrome extension … native messaging" with: GPL-3.0-or-later, no tracking, handled locally by the app, isolated per-service sessions.

- [ ] **Step 2: Verify** — Run (from `loft.chat`):
```bash
npm run build && npm run lint
grep -nEi 'google chrome|rust|native messaging|main_light|whatsapp_light|gnome_individual|kde_individual' src/data.ts
```
Expected: build + lint succeed; grep prints nothing.

- [ ] **Step 3: Commit** — `cd loft.chat && git add src/data.ts && git commit -m "site: rewrite conversation content + carousel for 1.0.0"`

---

### Task 17: Rewrite marketing site `src/components/ChatArea.tsx`

**Files:**
- Modify: `loft.chat/src/components/ChatArea.tsx`

- [ ] **Step 1: Rewrite the bot data** (facts 2, 5, 8, 14, 15; spec A2)

Rewrite each `botReplies` entry accurately (keep the tone): architecture → Electron 43 + bundled Chromium + sandboxed preloads + `dbus-next`; source → TypeScript + Svelte 5/Vite hub + `dbus-next` (drop Rust/libadwaita/Manifest V3); services → six services, session partitions, multiple accounts; dnd/notifications → preloads wrap `Notification` + scrape badges, combined tray with global + per-service DND; gnome → helper from extensions.gnome.org (`@loft.chat`); kde → KWin scripting + SNI; distro/flatpak → Flathub-clean, FriendlyHub by choice (no `flatpak-spawn`); zoom/titlebar/close → structural titlebar, zoom 0.3×–3.0×, close = hide-to-tray. Update `slashCommands` + `predefinedPills` to match; add `/grid` and `/accounts` commands (and at least one matching pill). Keep the component's logic/JSX unchanged — only the data arrays and reply strings.

- [ ] **Step 2: Verify** — Run (from `loft.chat`):
```bash
npm run build && npm run lint
grep -nEi 'zbus|ksni|libadwaita|manifest v3|native messaging|flatpak-spawn|real google chrome|--user-data-dir' src/components/ChatArea.tsx
```
Expected: build + lint succeed; grep prints nothing.

- [ ] **Step 3: Commit** — `cd loft.chat && git add src/components/ChatArea.tsx && git commit -m "site: rewrite keyword bot replies for the Electron architecture"`

---

### Task 18: Final cleanup, fact audit, and full builds

**Files:**
- Delete: `loft.chat/docs/guide/chrome.md`
- Delete (both dirs): `main_light.png`, `main_dark.png`, `whatsapp_light.png`, `gnome_individual.png`, `gnome_unified.png`, `kde_individual.png`, `kde_unified.png`

- [ ] **Step 1: Confirm no inbound links to `chrome.md`, then delete it**

Run (from `loft.chat`):
```bash
grep -rn 'guide/chrome' docs/ ; echo "exit:$?"
```
Expected: no matches (grep exits non-zero). Then:
```bash
git rm docs/guide/chrome.md
```

- [ ] **Step 2: Confirm no references to the retired PNGs, then delete them**

Run (from `loft.chat`):
```bash
grep -rn 'main_light\|main_dark\|whatsapp_light\|gnome_individual\|gnome_unified\|kde_individual\|kde_unified' src/ docs/ ; echo "exit:$?"
```
Expected: no matches. Then:
```bash
for d in public/screenshots docs/public/screenshots; do
  git rm "$d"/{main_light,main_dark,whatsapp_light,gnome_individual,gnome_unified,kde_individual,kde_unified}.png
done
```

- [ ] **Step 3: Repo-wide fact audit**

Run (from `loft.chat`):
```bash
grep -rnEi 'google chrome|chrome_path|combine_tray_icons|skip_extension_prompt|config\.toml|\bzbus\b|\bksni\b|libadwaita|native messaging|manifest v3|flatpak-spawn|SetShowTitlebar|show_titlebar|start_hidden|@chat\.loft|--user-data-dir|profiles/' src/ docs/guide docs/index.md docs/.vitepress
```
Expected: no matches. (Any hit is a leftover to fix before committing.)

- [ ] **Step 4: Both sites build clean**

Run (from `loft.chat`):
```bash
npm run build && npm run lint && npm run docs:build
```
Expected: all three succeed; no dead links; no broken image references.

- [ ] **Step 5: Every referenced screenshot resolves**

Run (from `loft.chat`):
```bash
for ref in $(grep -rhoE '/screenshots/[a-z0-9_]+\.(png|svg)' src docs/guide docs/index.md | sort -u); do
  f="public${ref}"; df="docs/public${ref}"
  [ -f "$f" ] || echo "MISSING site $f"
  [ -f "$df" ] || echo "MISSING docs $df"
done
```
Expected: no "MISSING" lines.

- [ ] **Step 6: Commit**

```bash
cd loft.chat
git add -A
git commit -m "docs: delete chrome.md and retired screenshots; final 1.0.0 fact audit"
```

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- Deliverable A (site): A1 `data.ts` → Task 16; A2 `ChatArea.tsx` → Task 17; A3 `index.md` cards → Task 3.
- Deliverable B (docs): sidebar/IA → Task 3; per-page table → Tasks 4–15 (`what-is-loft`, `getting-started`, `services`, `tray-icons`, `notifications`, `window-behaviour`, `desktop-environments`, `global-config`+`service-config`, `autostart`, `dbus`, `flatpak`, `troubleshooting`); three new pages → Task 2; `chrome.md` delete → Task 18.
- Deliverable C (screenshots): placeholders + generator + SHOTLIST → Task 1; retired-image deletion → Task 18.
- Testing (builds, lint, fact-audit grep, image-resolution check) → per-task verifies + Task 18.

**Placeholder scan** — no "TBD"/"implement later"; every task carries exact key names, D-Bus signatures, filenames, and runnable commands. Prose-heavy tasks give concrete section outlines + the exact values to state (the correct altitude for a documentation rewrite; the verbatim final prose is the executor's output, gated by the retired-term greps).

**Type/name consistency** — one bus name `chat.loft.Loft` and object path form `/chat/loft/<Segment>` used identically in Tasks 8, 11, 13; `config.json` key sets identical in the Global Constraints and Tasks 11/12; screenshot filenames defined in Task 1 match every reference in Tasks 2–7 and 16 and the Task 18 resolution check; developer mode is `debug` throughout.

**Ordering** — new files (images, new pages) land before the sidebar references them; `chrome.md` and retired PNGs are deleted only after Task 18 greps prove no inbound references, so every intermediate commit builds.
