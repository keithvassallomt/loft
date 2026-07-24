# Electron Loft — Stage 4: Hub Window & App/UX Shell — Design

Status: approved (Keith, 2026-07-13). Branch: `electron-rewrite`. Code lives in `electron/`.

Parent spec: `docs/superpowers/specs/2026-07-09-electron-loft-v1-parity-design.md` (§9 hub, §8
autostart/`.desktop`, §13 open item #1). This document resolves that open item and details the
stage.

## 1. Why / scope

Stage 4 is the **App/UX shell**: the hub window (today's redesigned Rust manager, carried into
Electron), per-service + global settings, autostart, and `.desktop` generation. It is the last
functional stage before KDE (4.5) and packaging (5).

The Electron architecture is already **one process, many windows, single-instance** (see
`electron/src/main/index.ts`). That collapses most of the Rust manager's complexity: the hub is
just another window in the same process, "Open" is an in-process call, and live status is pushed
over IPC instead of polled cross-daemon over D-Bus.

Out of scope: the unified/tabbed view (post-v1); KDE window focus/hide (Stage 4.5); packaging
(Stage 5).

## 2. Resolved decisions

- **Hub renderer UI tech (parent spec open item #1): Svelte 5 (runes) + TypeScript, built with
  Vite.** Chosen over React+Vite: Svelte compiles to a tiny no-virtual-DOM runtime (keeps a
  full-Chromium renderer light — on-brand for the rewrite), and its reactivity ($state/$derived +
  stores) is a 1:1 fit for the spec-mandated *live status via push IPC*. Vite is the de-facto
  modern Electron renderer bundler (HMR in dev; correct static/`file://` asset handling in prod).
  React's ecosystem/hiring edge is irrelevant for a solo GPL project.
- **Visual skin: clean custom, system-aware.** A simple neutral theme of our own that follows
  `prefers-color-scheme` and reads well on both GNOME and KDE. Not an Adwaita re-creation
  (a CSS maintenance trap that never looks quite right and is foreign on KDE).
- **Hub window is normally OS-decorated** (resizable, native close), unlike the frameless service
  windows. It's a utility window; native decorations avoid re-implementing min/max/close. The
  clean skin is just its content.
- **Autostart model: one login entry + per-service `openOnStartup` flags** (parent spec §8), not
  the Rust per-service-entry model. Services flagged open-on-startup are opened **minimized to the
  tray** at login.
- **Build integration:** add a `vite build` step for the renderer only; main + preload keep their
  existing esbuild/tsc steps (Vite adds nothing for node-side code). Not migrating to
  `electron-vite` (would touch the working Stage 1–3 build).

## 3. Architecture & window model

- **CLI:** `loft` (no `--service`) opens the **hub window**. This replaces the Stage-1 fallback
  that opened WhatsApp. `loft --service <id>` unchanged; second-instance routing unchanged.
- **Hub window lifecycle:** a `BrowserWindow` with normal decorations, created on demand
  (`loft` with no service, or tray → "Show Hub"). Create-or-focus: one hub window at a time.
  Closing it closes only the hub; the app stays alive via the tray (existing
  `window-all-closed` no-op + `before-quit`). If no services are running the app becomes
  tray-only; the tray reopens the hub.
- **"Open" is in-process:** the hub's Open button calls the existing `openService(def, false)`.
  No process launch, no singleton routing.
- **"Installed" = has a config entry (created by Add).** A service moves from the Available grid to
  the Installed list once it's been Added. **Add is idempotent and is invoked implicitly the first
  time a service is launched** via `loft --service <id>` (or the tray) — so a directly-launched
  service appears as Installed with a launcher/icon, and there's one coherent definition of
  "installed" rather than the config-vs-`.desktop` split the Rust version had.
- **Live status via push IPC:** main is the single source of truth (it already tracks `windows`
  = running, window visibility via the tray `show`/`hide` hooks, `currentBadge`, and config
  dnd/badges). Main builds a **state snapshot** and emits `hub:state-changed` on any relevant
  change (window open/close/show/hide, badge update, DND toggle, add/remove). The hub subscribes
  and re-renders reactively. There is no polling and no flicker-avoidance machinery to port.

## 4. Hub UI

Three surfaces, same layout as the Rust manager (`src/manager/window.rs`):

- **Main page:** *Installed* boxed list — per service: icon · display name · live
  Running/Not-running · unread badge · **Open** button · **gear** button. *Available* tile grid —
  not-yet-added services → **Add**. *Welcome* empty-state shown when nothing is installed. Header
  `≡` overflow → Settings · About · Quit.
- **Per-service page (gear):**
  - Custom Server URL — **Element/Talk only** (`service.selfHosted`). Talk normalizes a bare host
    into the `/apps/spreed/` URL (port `normalize_talk_url`); Element normalizes a bare host to
    `https://`. Takes effect next time the service starts (reload of an open window is a nice-to-have).
  - Open on startup (per-service flag).
  - Show badges (per-service; `GetStatus()` still reports the true count when off — existing
    behavior).
  - Do Not Disturb (per-service default; same value the tray toggles).
  - **Remove** — confirm dialog with an "also delete login data" checkbox.
- **Global settings page:** Tray backend (Auto / GNOME Panel / SNI); Start Loft at login. No
  Chrome-path override, no combine-icons toggle (both deleted in the Electron model).
- **About:** app name, version, GPL-3.0, project/issue links.
- **First-run:** no "Chrome Not Found" page (deleted); the GNOME Shell helper install/logout
  prompt already fires at startup (`deployGnomeExtension` in `index.ts`), independent of the hub;
  the hub simply shows the welcome empty-state.

### IPC surface

The hub renderer is **not** a service view, so it gets a proper locked-down preload
(`contextIsolation: true`, `sandbox: true`, no node integration), exposing a typed `loftHub` API:

- `getState(): Promise<HubState>` — snapshot of every service
  `{ id, displayName, selfHosted, installed, running, visible, badge, dnd, badgesEnabled,
  openOnStartup, customUrl }` plus globals `{ trayBackend, startAtLogin }`.
- `onStateChanged(cb): () => void` — push subscription (returns an unsubscribe).
- Actions (all fire-and-forget or Promise<void>): `openService(id)` · `addService(id, customUrl?)`
  · `removeService(id, deleteData)` · `setServiceSetting(id, patch)` (patch =
  `{ openOnStartup?, badgesEnabled?, dnd?, customUrl? }`) · `setGlobal(patch)` (patch =
  `{ trayBackend?, startAtLogin? }`) · `quitApp()`.

Main maps these onto existing functions where possible (`openService`, `setServiceDnd`, the
`SetBadgesEnabled` config write) and the new backend modules for the rest.

### Build

- `deps`: `svelte`. `devDeps`: `vite`, `@sveltejs/vite-plugin-svelte`, and (optional, for
  component tests) `@testing-library/svelte`.
- `package.json`: add `bundle-hub` = `vite build` (config emits to `dist/renderer/hub/`), and fold
  it into `build` after `bundle-preload`. `copy-assets` no longer needs to copy hub HTML (Vite
  emits it).
- The existing hand-rolled titlebar renderer is left as-is; migrating it to the same Vite pipeline
  is possible later but out of scope.

## 5. New backend modules (ported from Rust)

Small, mostly-pure TS modules the `electron/` tree lacks today. Ports of `src/desktop.rs` and
`src/autostart.rs`.

- **`main/desktop.ts`:**
  - `desktopExec()` — `flatpak run chat.loft.Loft` under Flatpak, else the current binary path
    (port of `desktop_exec`).
  - Per-service launcher: `~/.local/share/applications/loft-<id>.desktop` with
    `Exec=<exec> --service=<id>`, `Categories=Network;InstantMessaging;`, service icon. Written on
    **Add**, removed on **Remove**. (Port of `create_desktop_entry` minus the Chrome
    `StartupWMClass`/notification-alias cruft.)
  - Hub entry: `chat.loft.Loft.desktop` for dev/AppImage; **skipped** when packaged or under
    Flatpak (Stage 5/electron-builder owns the canonical one). Port of
    `ensure_manager_desktop_entry` (incl. the dev-build skip).
  - Icon deploy to `~/.local/share/loft/icons/` from bundled assets (already present as PNGs under
    `dist/assets/icons/`).
  - **Note:** all service windows share WM_CLASS `chat.loft.Loft`, so these per-service `.desktop`
    files are **launcher-grid shortcuts**, not window-association (window targeting is title-keyed
    via the GNOME helper, already implemented in Stage 3c). No per-service dock icons — expected,
    not a bug.
- **`main/autostart.ts`:**
  - One login entry `~/.config/autostart/chat.loft.Loft.desktop` with `Exec=<exec> --minimized`
    and `X-GNOME-Autostart-enabled=true`. Toggled by global "Start at login".
  - `startAtLogin` state is derived from the file's presence (and persisted for the UI).
  - At app startup (in `index.ts`), after the tray/notifications are up, open each service whose
    config has `openOnStartup: true`, minimized. `openOnStartup` is already a field in
    `ServiceConfig` — currently unused; Stage 4 wires it.
- **Config additions (`main/config.ts`):**
  - Wire the existing `ServiceConfig.openOnStartup`.
  - Add global `startAtLogin?: boolean` (mirror of the autostart file; UI convenience).
  - Partition deletion helper: remove `~/.local/share/loft/Partitions/<id>/` on
    Remove-with-delete-data.

## 6. Settings scope — explicit in / deferred

**In Stage 4** (backend support exists or is added here): Open-on-startup · Show badges · DND
default · Custom URL (Element/Talk) · Remove + delete-data · Tray backend · Start-at-login · About.

**Deferred, with reason:**
- *Notifications on/off* — redundant with per-service DND (DND already mutes). Not adding a second
  switch.
- *Start-minimized (per service)* — folded into open-on-startup (opens to tray); no separate
  visible/hidden toggle.
- *Default zoom* — zoom is already per-window persisted; a global seed is cheap post-v1 polish.
- *Explicit light/dark override* — the skin follows `prefers-color-scheme` automatically; an
  override toggle (via `nativeTheme`) is post-v1.
- *Tray-backend live switch* — persist + "applies on restart"; live re-init of the tray backend is
  fiddly and low value.

## 7. Testing

- **Unit (Vitest):**
  - `.desktop`/autostart **content** writers — assert exact emitted file text for a service
    launcher, the hub entry, and the autostart entry (enabled/disabled, Flatpak vs native exec).
  - Config load/save round-trips with the new fields (`openOnStartup`, `startAtLogin`).
  - The **state-snapshot builder** — a pure function over (`windows`, `config`, `currentBadge`);
    assert running/visible/badge/dnd derivation, including a badges-disabled service reporting the
    true count but a suppressed indicator.
  - IPC patch shapes (`setServiceSetting`/`setGlobal` validation).
- **Component (optional, highest-value one or two):** Installed row renders badge + running state;
  gear form emits the correct `setServiceSetting` patch. `@testing-library/svelte` + jsdom.
- **Manual matrix (Keith):** Add/Remove a service (incl. delete-data wiping the partition); gear
  settings persist and reflect in a running window; Open focuses the right window; live
  badge/running updates while the hub is open; Start-at-login file round-trip; Talk/Element custom
  URL takes effect.

## 8. What this unblocks

Stage 4.5 (KDE window focus/hide + Plasma system-DND) then Stage 5 (electron-builder packaging).
Packaging then owns the canonical `chat.loft.Loft.desktop` and icon install that Stage 4 writes at
runtime for dev/AppImage.
