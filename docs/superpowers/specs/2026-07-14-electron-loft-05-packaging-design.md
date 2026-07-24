# Electron Loft — Stage 5: Full packaging & distribution — Design

Status: approved (Keith, 2026-07-14). Branch: `electron-rewrite`. Code in `electron/`.

Parent spec: `docs/superpowers/specs/2026-07-09-electron-loft-v1-parity-design.md`. Follows Stage 4.5
(KDE + VM preview delivery), which stood up the first electron-builder config + a `workflow_dispatch`
CI preview. Stage 5 is the final roadmap item: turn the working app into real, installable packages in
every format and get it onto its distribution channels.

## 1. Why / scope

Loft-Electron is feature-complete and Keith-verified on GNOME and KDE. What remains is distribution:
produce **deb, rpm, AppImage, and Flatpak**, publish them, and make every install path correct
(autostart/`.desktop` exec paths, GNOME integration, sandbox permissions). The end state is that Keith
can install the Stage 5 build to **replace his running production (Rust) Loft in place**.

A pivotal architectural change unlocks this stage: **the Electron rewrite no longer spawns Chrome.** It
renders every service in-process via its own `BrowserWindow`; the only external process spawns left are
`gsettings` and `gnome-extensions` (GNOME niceties, not core function). The Rust version needed
`flatpak-spawn --host` to launch host Chrome — a sandbox escape that kept it off Flathub and forced a
broad `--filesystem=home`. That escape is **gone**, so the Flatpak can be sandbox-clean.

**Out of scope (deferred):** auto-update (no electron-updater/signing — Flatpak updates via FriendlyHub,
native via re-download), Flathub submission (kept *possible* via clean permissions, not pursued),
aarch64 native packages (Flatpak is dual-arch via FriendlyHub; native stays x86_64 for now), the
unified/tabbed view (post-v1).

## 2. Resolved decisions (from brainstorming)

- **Channels:** **FriendlyHub** (Flatpak) + **GitHub Releases** (deb/rpm/AppImage + a standalone
  `.flatpak`). Flathub is newly viable but not pursued now; we keep the manifest's permissions
  Flathub-clean so it stays a low-effort future option.
- **Auto-update:** deferred. Matches Rust v1.
- **Formats:** deb, rpm, AppImage, Flatpak — all four.
- **Flatpak build method:** a **hand-written `flatpak-builder` manifest built from source**, *not*
  electron-builder's prebuilt-wrap flatpak target. FriendlyHub builds from a manifest + sources file on
  its own infra for **x86_64 and aarch64**; a single-arch prebuilt wrap cannot satisfy that. electron-builder
  therefore produces **deb/rpm/AppImage only**.
- **GNOME Shell helper:** every build (native **and** Flatpak) uses the **EGO** copy of the extension via
  `InstallRemoteExtension`, so it updates independently of the app. The old bundle-and-deploy path is
  **removed** entirely.
- **Naming:** revert the `-next` transition scaffolding to canonical `loft`/`chat.loft.ShellHelper` before
  building anything, so the distributables install as a clean in-place replacement and align with the EGO
  listing `loft-shell-helper@loft.chat`.

## 3. Task 0 — Revert `-next` → canonical `loft` (prerequisite, its own commit)

The `-next` UUID/namespace let Electron-Loft's helper coexist with Keith's running Rust production helper
during development. Shipping requires reverting to the canonical names. Exact, complete set (verified by
grep, excluding false positives like `dbus-next`, `nextId`, `nextNode`, `nextBackoff`, `NextCloud`):

| File | Current | → Canonical |
|---|---|---|
| `gnome-shell-extension/metadata.json` | `"uuid": "loft-shell-helper-next@loft.chat"` | `"loft-shell-helper@loft.chat"` |
| `gnome-shell-extension/metadata.json` | `"name": "Loft Shell Helper (Next)"` | `"Loft Shell Helper"` |
| `gnome-shell-extension/extension.js` (18–19) | `DBUS_NAME/DBUS_PATH = chat.loft.ShellHelperNext` / `/chat/loft/ShellHelperNext` | `chat.loft.ShellHelper` / `/chat/loft/ShellHelper` |
| `gnome-shell-extension/extension.js` (477, 554) | `` `loft-next-${name}` `` | `` `loft-${name}` `` |
| `gnome-shell-extension/extension.js` (657, 703) | `'loft-next-combined'` | `'loft-combined'` |
| `electron/src/main/gnome/shellHelper.ts` (6–8) | `NAME/PATH/IFACE = chat.loft.ShellHelperNext` / `/chat/loft/ShellHelperNext` | `chat.loft.ShellHelper` / `/chat/loft/ShellHelper` |
| `electron/src/main/gnome/deploy.ts` (6) | `UUID = 'loft-shell-helper-next@loft.chat'` | (module removed in §5, but revert first for a clean diff) |
| `electron/src/main/index.ts` (247) | `gnome-extensions enable loft-shell-helper-next@loft.chat` | (removed in §5) |

- The D-Bus name/path/iface revert on **both** sides together (extension exports, daemon calls) — both
  are in the list, so they stay matched. The `chat.loft.ShellHelper` interface name and bus name become
  canonical again.
- Update any test that asserts the `-next` D-Bus name (e.g. shell-helper wiring tests) to the reverted name.
- This is a self-contained commit landed before the packaging work, so the distributables carry canonical
  names from the first build.

## 4. electron-builder — deb / rpm / AppImage (`electron/electron-builder.yml`)

- Targets: **remove `flatpak`** (§6 owns it); keep `deb`, `AppImage`; **add `rpm`**.
- Metadata already present: `appId`, `productName`, `maintainer`, `synopsis`, `category: Network`,
  `icon: build/icon.png`. Add: a fuller `description`, `desktop` entry keys — `StartupWMClass=chat.loft.Loft`
  (so the launched window maps to the launcher icon) and `Keywords`/`Categories`
  (`Network;InstantMessaging;`).
- **rpm on CI:** electron-builder's rpm target uses `fpm`, which needs `rpm`/`rpmbuild` tooling present.
  CI installs it (`apt-get install -y rpm`). (Local rpm/deb builds on Fedora hit the vendored-fpm
  libcrypt.so.1 issue seen in Stage 4.5 — CI on ubuntu-latest is the build path; local is best-effort.)
- Installed layout (electron-builder default): app under `/opt/Loft/`, `loft` binary + a `/usr/bin/loft`
  wrapper. `process.execPath` inside a packaged run is `/opt/Loft/loft` (stable) — see §7.
- `package.json` `version`: **0.3.0-dev → 1.0.0** (the first Electron release; graduates out of 0.x — the
  rewrite reaching parity + KDE + real distribution is the 1.0 milestone). Rust was 0.2.0.

## 5. GNOME helper via EGO everywhere — remove bundle-deploy

Replace the bundle-and-deploy path with an install-from-EGO prompt, for **all** build types.

**Remove:**
- `electron/src/main/gnome/deploy.ts` (`deployGnomeExtension`, `helperVersion`, `compareVersions`, the
  version-compare/redeploy logic) and its tests.
- The `copy-assets` npm-script segment that stages `gnome-shell-extension/` (metadata.json, extension.js,
  icons) into `dist/assets` — the app no longer ships the extension.
- The `index.ts` deploy block: the `deployGnomeExtension(...)` call, the `gnome-extensions enable` CLI
  `execFileSync`, and the **"Log out to finish updating Loft"** dialog (no longer needed — EGO-installed
  extensions load in-process without a relogin).

**Add** (`electron/src/main/gnome/helperInstall.ts`, new; wired in `index.ts` where the deploy block was):
- On GNOME, query the helper's presence via `org.gnome.Shell.Extensions` (e.g. `GetExtensionInfo(uuid)` /
  `ListExtensions`). If already installed+enabled → nothing to do (sync state as today).
- If absent → the hub shows a gentle, dismissible prompt ("Install Loft's GNOME integration from
  extensions.gnome.org?"). On accept → `InstallRemoteExtension('loft-shell-helper@loft.chat')`; GNOME's
  own dialog downloads, installs, **enables, and loads it in-process (no relogin)**. On decline / unsupported
  shell version → SNI fallback (unchanged degradation).
- **Never-throw / best-effort**, like the other DE seams; a missing or refusing GNOME Shell must not crash
  startup.
- The suspend/resume re-register monitor (watch `chat.loft.ShellHelper` NameOwnerChanged, re-`RegisterService`
  + resync badge/visible/DND) **stays** — it now talks to whatever EGO-installed helper owns the name.

**Two implications (state in spec, resolve/verify at implementation):**
1. **Hard EGO dependency.** The reverted **hybrid** helper (matches windows by both WM_CLASS *and* title,
   confirmed in `extension.js`) must be **published to EGO** under `loft-shell-helper@loft.chat` as a new
   version *before release*. It is safe for existing Rust users (hybrid matching). This is Keith's external
   step; the in-app mechanism ships regardless and simply installs whatever EGO serves.
2. **D-Bus interface is now a stability contract.** App and extension version independently via EGO, so the
   `chat.loft.ShellHelper` interface (methods `FocusWindow`, `HideWindow`, `RegisterService`,
   `UnregisterService`, `UpdateBadge`, `UpdateDnd`, `UpdateVisible`, `RegisterCombined`, …) must stay
   backward-compatible. No signature changes in Stage 5.
3. **Combined panel icon (`loft-symbolic`).** The combined GNOME panel button uses
   `St.Icon({icon_name:'loft-symbolic'})`, which `deploy.ts` currently satisfies by copying
   `loft-symbolic.svg` into `~/.local/share/icons/hicolor/scalable/apps/`. With bundle-deploy gone, decide
   at implementation: either (a) the app still installs that one symbolic SVG into the user icon theme
   (cheap, no extension dependency), or (b) the EGO helper prepends its own dir to the icon search path and
   ships the icon. Default to (a) to avoid a silent broken icon.

## 6. Flatpak — hand-written `flatpak-builder` manifest, built from source

Adapt the existing Rust-era `chat.loft.Loft.yml` at repo root into an Electron manifest.

- **Runtime/SDK:** `org.freedesktop.Platform` / `org.freedesktop.Sdk` (version pinned to what the Electron
  base app targets) + base app **`org.electronjs.Electron2.BaseApp`** (provides Electron + **zypak** for
  sandboxed Chromium). The Node SDK extension (`org.freedesktop.Sdk.Extension.node*`) supplies `npm` at
  build time.
- **Node offline sources — the Node analog of the Rust `cargo-sources.json`:** a `generated-sources.json`
  produced by **`flatpak-node-generator`** (from `flatpak-builder-tools`) off `package-lock.json`. It must
  include the **Electron prebuilt binary zips for x86_64 and aarch64** (FriendlyHub builds both). Electron's
  npm postinstall downloads a platform binary; flatpak-node-generator has electron handling, but the exact
  invocation + per-arch electron sourcing is finicky and version-sensitive — **verify against current
  `flatpak-builder-tools` docs at implementation** (per the project's verify-online rule); pinning Electron
  and adding its per-arch zips explicitly is an acceptable fallback.
- **Build-commands:** `npm ci --offline` → `npm run build` (tsc + esbuild + vite + svelte all run offline;
  `dbus-next` is pure-JS → no node-gyp/native rebuild) → install `dist/` + prod `node_modules` (`dbus-next`)
  into `/app`, plus a **zypak launcher** at `/app/bin/loft` and the desktop/metainfo/icons. `--minimized`
  and `--service=<id>` args pass through the launcher.
- **`finish-args` (tight; no escape, no broad home):**
  ```
  --share=ipc
  --socket=fallback-x11
  --socket=wayland
  --socket=pulseaudio                               # audio out + mic: calls, notification sounds
  --share=network
  --device=all                                      # GPU (/dev/dri) + camera (/dev/video*) for video calls
  --talk-name=org.kde.StatusNotifierWatcher        # SNI tray
  --talk-name=org.kde.KWin                          # KDE focus/hide
  --talk-name=org.freedesktop.Notifications         # notifications
  --talk-name=org.gnome.Shell.Extensions            # EGO install-prompt + enable/monitor
  --talk-name=org.freedesktop.portal.Desktop        # portals (file chooser for downloads, etc.)
  --own-name=chat.loft.*
  --filesystem=xdg-config/autostart:create          # autostart .desktop (§7)
  --filesystem=xdg-data/applications:create         # per-service launchers (§7)
  ```
  Dropped vs the Rust manifest: `--talk-name=org.freedesktop.Flatpak` and `--filesystem=home` — the two
  Flathub-hostile grants. No `~/.local/share/gnome-shell/extensions` grant is needed (EGO installs the
  helper; the app never writes it).
  **`--socket=pulseaudio` + `--device=all` are NOT optional, and were missed in the first cut of this
  spec** (found only by Keith's live Flatpak smoke, 2026-07-15): the Rust build's finish-args — which this
  list was derived from — needed neither, because it ran Chrome on the HOST via `flatpak-spawn --host`, so
  audio and the camera came from *outside* the sandbox. Removing that escape moved Chromium's rendering and
  audio process INSIDE the sandbox, so those permissions must now be requested explicitly. Without the
  audio socket, ALSA's pulse plugin fails to reach the sound server and libpulse's error path `close()`s
  FDs Chromium owns → the audio process aborts with *"Crashing due to FD ownership violation"*, and call
  audio / mic / notification sounds are silently dead. Without `--device=all` there is no `/dev/video*`, so
  video calls have no camera. Reference: `com.github.IsmaelMartinez.teams_for_linux` (Electron + calls) and
  `com.google.Chrome` both ship `pulseaudio` + `devices=all`.
- **Install into the Flatpak:** the reworked `data/chat.loft.Loft.desktop` (launches the hub) and
  `data/chat.loft.Loft.metainfo.xml` (§8) into `/app/share/applications` + `/app/share/metainfo`, and the
  app icon into `/app/share/icons/hicolor/.../apps/chat.loft.Loft.png`. The desktop-id
  (`chat.loft.Loft.desktop`) matches the metainfo `<launchable>` and the appId.
- **Two outputs from one manifest:** (a) manifest + `generated-sources.json` **uploaded to FriendlyHub**
  (Keith's manual step; FriendlyHub builds both arches), and (b) CI runs the same manifest through
  `flatpak-builder` + `flatpak build-bundle` to emit the standalone `.flatpak` for GitHub Releases — which
  doubles as **manifest CI** (proves it builds before Keith uploads).

## 7. Autostart & `.desktop` exec-path correctness across formats

`desktop.ts::desktopExec()` already branches: `$APPIMAGE` → the AppImage path; `isFlatpak()` →
`flatpak run chat.loft.Loft`; else `execPath ?? process.execPath`. Stage 5 validates each branch end-to-end:

- **deb/rpm:** `process.execPath` = `/opt/Loft/loft` (stable across the install) — autostart + per-service
  launchers `Exec=/opt/Loft/loft [--service=<id>|--minimized]`. Confirm the `/usr/bin/loft` wrapper is an
  acceptable alternative and pick one deliberately.
- **AppImage:** `Exec=<AppImage path> …` — note the path moves if the user relocates the AppImage; document
  as a known AppImage limitation (matches every AppImage).
- **Flatpak:** `Exec=flatpak run chat.loft.Loft …`. Per-service launchers (`writeServiceLauncher` →
  `~/.local/share/applications/loft-<id>.desktop`) and the autostart entry
  (`~/.config/autostart/chat.loft.Loft.desktop`) land on the **real host dirs** via the two `--filesystem`
  grants, so the host desktop DB shows them and they launch via `flatpak run`. Service-icon absolute paths
  (`~/.var/app/chat.loft.Loft/data/loft/icons/<id>.png`) are host-readable, so `Icon=` resolves.
- `ensureHubDesktopEntry()` already no-ops under Flatpak (the manifest ships the hub `.desktop`). Keep.
- Add a unit test matrix over `desktopExec` for the AppImage / Flatpak / packaged-binary branches.

## 8. AppStream metainfo + desktop file (`data/`)

- **Rewrite the now-false description** in `chat.loft.Loft.metainfo.xml`: the current text
  ("Unlike Electron wrappers, Loft uses your real Google Chrome installation …") is both wrong and ironic
  now. Replace with a generic, accurate description: Loft runs each messaging web app (WhatsApp, Messenger,
  Slack, Telegram, Element, NextCloud Talk) in its own integrated window with voice/video calling, tray
  icons, badge counts, notifications, and close-to-tray, integrated with GNOME and KDE. No mention of
  Chrome/Electron internals.
- Add a `<release version="1.0.0" date="YYYY-MM-DD">` entry (date stamped at release) summarising the
  rewrite in user-facing terms. **Include the one-time migration note**: sessions don't carry over from
  0.2.x — the Rust version stored logins in Chrome `--user-data-dir` profiles, the Electron version uses
  its own `Partitions/`, so users **re-login to each service once** after upgrading. Mirror this in
  `CHANGELOG.md`.
- **Screenshots** currently point at `data/screenshots/*.png` (Rust-UI). Refresh to the new Svelte hub —
  Keith supplies updated PNGs, or we reuse the existing ones as placeholders (the manager still shows a
  service list). Flag, don't block.
- Keep license/`content_rating`/`supports`/`requires`/`branding`. Validate with **`appstreamcli validate`**
  in CI.
- `data/chat.loft.Loft.desktop`: update `Exec=` to launch the hub appropriately (Flatpak install path);
  keep `StartupWMClass=chat.loft.Loft`.

## 9. CI — release workflow

Extend the Stage 4.5 `kde-preview.yml` into a proper release path (`.github/workflows/release.yml`, or
generalise the existing file):

- **Triggers:** a `v*` tag push (real versioned release) **and** `workflow_dispatch` (preview/manual).
- **Runner:** `ubuntu-latest`. Steps: checkout → `setup-node@v4` (Node 22) → in `electron/`: `npm ci` →
  `npm test` + `npm run check` (gates) → `npm run build` → **electron-builder** `deb rpm AppImage` (after
  `apt-get install -y rpm`) → **Flatpak**: install `flatpak`/`flatpak-builder` + add flathub remote +
  install the pinned runtime/SDK/base-app, run the §6 manifest through `flatpak-builder` and
  `flatpak build-bundle` to produce `chat.loft.Loft.flatpak`.
- **Publish:** attach `*.deb`, `*.rpm`, `*.AppImage`, `*.flatpak` to the tag's GitHub Release
  (`softprops/action-gh-release@v2`); `prerelease` for dispatch/preview, full release for a `v*` tag.
  `GITHUB_TOKEN` (`contents: write`) authorises the upload.
- FriendlyHub upload (manifest + `generated-sources.json`) remains **Keith's manual step** — CI produces
  and validates the manifest artifacts but does not push to FriendlyHub.

## 10. Testing

- **Unit (Vitest, local + CI):**
  - `desktopExec` branches (AppImage / Flatpak / packaged-binary) → correct `Exec=` prefix.
  - Reverted D-Bus name wiring (`chat.loft.ShellHelper`) — the shell-helper client targets the canonical
    name/path/iface.
  - `helperInstall` logic: absent → prompt+install path invoked; present → no-op; never-throws on a missing
    GNOME Shell (injected fake D-Bus surface).
  - AppStream: `appstreamcli validate` passes on the rewritten metainfo (CI step).
- **Manual matrix (Keith):**
  - **Fedora GNOME (native rpm), replacing production:** install the rpm over the running Rust Loft; hub
    opens; EGO install-prompt appears if the canonical helper isn't the active one; window show/hide/focus,
    panel icons, badges, DND, notifications, a voice/video call, autostart toggle, per-service launchers all
    work — and it is an in-place replacement (no duplicate app/extension). Confirm the one-time
    **re-login** per service (fresh `Partitions/`) works cleanly and sessions persist thereafter.
  - **Kubuntu KDE (deb + standalone .flatpak):** SNI tray + badge; KWin focus/hide; DND (per-service +
    Plasma system); notifications with avatars + click-to-navigate; a call; add/remove/gear from the hub;
    second-launch behaviour; autostart. Flatpak: same, plus confirming the tight sandbox works and
    downloads land via the portal.
  - **Clean GNOME (any, Flatpak):** EGO install-prompt → accept → helper installs+enables **without a
    relogin** → full integration; decline → SNI fallback.

## 11. What this unblocks

Stage 5 is the last roadmap item. On completion Loft-Electron ships in all four formats, is installable
from FriendlyHub + GitHub Releases, replaces the Rust production install in place, and keeps a clean path
to Flathub if ever wanted. The GNOME extension decouples from the app's release cadence (self-updates via
EGO). v1 is done.
