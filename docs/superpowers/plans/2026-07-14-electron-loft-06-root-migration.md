# Root Migration Implementation Plan — hoist Electron to root, delete old Rust Loft

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the dead Rust Loft and move the Electron app from `electron/` to the repository root, fixing every package/CI path and rewriting `CLAUDE.md`/`README.md` to the Electron reality — with no change to app behavior.

**Architecture:** Three staged, bisectable commits: (1) `git rm` the Rust app + old Chrome extension + Rust build recipes; (2) `git mv` `electron/*` up to root, merge the two `assets/` trees + two `.gitignore`s, fix the three `electron/`-path references, reinstall + full-build verify; (3) rewrite the two docs. Runtime asset resolution and `electron-builder.yml` use paths relative to their own location, so the app source and builder config move untouched.

**Tech Stack:** git, npm, electron-builder 26, flatpak-builder, Vitest, svelte-check.

## Global Constraints

- Branch `electron-rewrite`; **NOT merged to main**. All commits land here.
- **No app behavior change** — this is a move/delete/path/docs change only. No edits to `src/**` TypeScript logic, no dependency changes.
- **`git mv` for moves** (preserve history), **`git rm` for deletes**.
- App identity stays `chat.loft.Loft`; version stays `1.0.0`.
- The Electron app is verified by build + suite, not new unit tests: `npm run build`, `npm test` (expect **161** passing), `npm run check` (svelte-check **0 errors/0 warnings**) must pass at the new root.
- The flatpak manifest is `chat.loft.Loft.yml` at repo root; its offline build uses the committed `flatpak/generated-sources.json` (do **not** regenerate or edit that file).
- Do **not** touch `flatpak/generated-sources.json` or `dev_local/` (git-ignored scratch).

---

## File Structure (after migration)

- **Deleted:** `Cargo.toml`, `Cargo.lock`, `src/` (Rust), `tests/` (Rust), `extension/`, `justfile`
- **Moved `electron/*` → root:** `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `svelte.config.js`, `electron-builder.yml`, `src/` (Electron TS), `tests/` (Vitest), `build/icon.png`
- **Merged:** `assets/` (root superset + `assets/loft.png` from electron), `.gitignore`
- **Edited for paths:** `chat.loft.Loft.yml`, `.github/workflows/release.yml`, `package.json` (`copy-assets`), `.vscode/settings.json` (comment)
- **Rewritten:** `CLAUDE.md`, `README.md`
- **Unchanged:** `data/`, `flatpak/`, `gnome-shell-extension/`, `docs/`, `CHANGELOG.md`, `LICENSE`

---

## Task 1: Delete the old Rust Loft + old Chrome extension + Rust build recipes

Removes dead code. The Electron app is untouched (still in `electron/`), so it must still build afterward — that is the task's verification.

**Files:**
- Delete: `Cargo.toml`, `Cargo.lock`, `src/`, `tests/`, `extension/`, `justfile`

- [ ] **Step 1: Confirm what's being deleted is the Rust app, not the Electron app**

Run (repo root):
```bash
head -3 Cargo.toml; ls src/ | head; ls tests/ | head; ls extension/
```
Expected: `Cargo.toml` is a Rust manifest; `src/` shows `main.rs`/`daemon`/`manager`/`combined_tray` (Rust); `tests/` shows Rust `.rs` tests; `extension/` shows `manifest.json`/`background.js`/`content.js` (old Chrome MV3). The Electron app lives separately in `electron/` — none of these paths overlap it.

- [ ] **Step 2: Delete the Rust app, old extension, and Rust recipes**

Run:
```bash
git rm -q Cargo.toml Cargo.lock justfile
git rm -qr src tests extension
```

- [ ] **Step 3: Verify the deletes are clean and the Electron app is untouched**

Run:
```bash
git status --short | grep -E '^D ' | wc -l          # count of deletions staged
ls electron/src >/dev/null && echo "electron/ intact"
test ! -e Cargo.toml && test ! -e src && test ! -e extension && test ! -e justfile && echo "ROOT RUST GONE"
```
Expected: deletions staged; `electron/ intact`; `ROOT RUST GONE`.

- [ ] **Step 4: Prove the Electron app still builds + tests (only dead code was removed)**

Run:
```bash
cd electron && npm run build && npm test && npm run check
```
Expected: build exits 0; **161** tests pass; svelte-check **0 errors, 0 warnings**. (Deleting the Rust tree cannot affect the Electron build — this confirms it.)

- [ ] **Step 5: Commit**

```bash
cd /home/keith/LocalCode/keithvassallomt/loft
git commit -q -m "chore: delete old Rust Loft, Chrome extension, and cargo build recipes

The Electron rewrite has fully replaced the Rust app. Remove Cargo.toml/lock,
the Rust src/ + tests/, the old Chrome MV3 extension/ (replaced by sandboxed
preloads), and the justfile (cargo/generate-rpm/cargo-deb recipes, superseded by
electron-builder + release.yml). The Electron app in electron/ is untouched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Move the Electron app to root, merge assets + gitignore, fix paths

The load-bearing change. After Task 1 the root `src/`/`tests/` names are free. Move every tracked `electron/*` up, merge the duplicate assets and the two `.gitignore`s, fix the three `electron/`-path references, reinstall at root, and verify the full build + packaging. Move and path-fixes commit **together** — the app is non-building in between.

**Files:**
- Move: `electron/{package.json,package-lock.json,tsconfig.json,vite.config.ts,vitest.config.ts,svelte.config.js,electron-builder.yml}` → repo root
- Move: `electron/src` → `src`, `electron/tests` → `tests`, `electron/build` → `build`, `electron/assets/loft.png` → `assets/loft.png`
- Delete: `electron/assets/icons` (byte-identical dupes of `assets/icons`), `electron/.gitignore`, the leftover `electron/` dir
- Modify: `.gitignore`, `package.json` (`copy-assets`), `chat.loft.Loft.yml`, `.github/workflows/release.yml`, `.vscode/settings.json`

- [ ] **Step 1: Move the tracked Electron files up to root**

Run (repo root):
```bash
git mv electron/package.json electron/package-lock.json electron/tsconfig.json \
       electron/vite.config.ts electron/vitest.config.ts electron/svelte.config.js \
       electron/electron-builder.yml .
git mv electron/src src
git mv electron/tests tests
git mv electron/build build
```

- [ ] **Step 2: Merge assets — keep the root superset, take the tray-base `loft.png`, drop dupes**

The service icons in `electron/assets/icons/` are byte-identical to `assets/icons/`; only the top-level tray base `electron/assets/loft.png` (which `copy-assets` reads as `assets/loft.png`) is missing at root.
```bash
git mv electron/assets/loft.png assets/loft.png
git rm -qr electron/assets/icons
```

- [ ] **Step 3: Drop electron's `.gitignore` and remove the leftover `electron/` dir**

`electron/` still physically holds git-ignored `node_modules/`, `dist/`, `dist-electron/` (not moved by `git mv`). We reinstall fresh at root, so nuke the whole leftover dir.
```bash
git rm -q electron/.gitignore
rm -rf electron
test ! -e electron && echo "electron/ removed"
```
Expected: `electron/ removed`.

- [ ] **Step 4: Merge the root `.gitignore`** (drop Rust-only entries, fold in Node/Electron output)

Replace the entire contents of `.gitignore` with:
```gitignore
/dev
/dev_local

# Node / Electron build output
node_modules/
dist/
dist-electron/
*.log

# Flatpak build artifacts (flatpak-builder cache + bundle)
/.flatpak-builder/
/build-dir/
/.flatpak-repo/
/flatpak-node/
*.flatpak
```
(Removed the Rust-era `/target`, `/flatpak-build/`, `/flatpak-repo/`, `/cargo-sources.json`; kept `/.flatpak-builder/` — the generic flatpak-builder cache used by the Electron build too.)

- [ ] **Step 5: Fix `package.json` `copy-assets` — the one `../` reference**

In `package.json`, the `copy-assets` script's last segment reads `../assets/icons/loft-symbolic.svg` (a reach into the parent when the app lived in `electron/`). Change it to `assets/icons/loft-symbolic.svg`. The full corrected `copy-assets` value:
```
"copy-assets": "mkdir -p dist/renderer/titlebar dist/assets/icons && cp src/renderer/titlebar/index.html src/renderer/titlebar/titlebar.css dist/renderer/titlebar/ && cp assets/loft.png dist/assets/ && cp assets/icons/*.png dist/assets/icons/ && cp assets/icons/loft-symbolic.svg dist/assets/loft-symbolic.svg",
```

- [ ] **Step 6: Fix the flatpak manifest `chat.loft.Loft.yml`** (drop `cd electron` + `electron/` prefixes)

Apply exactly these replacements in `chat.loft.Loft.yml`:
- `- cd electron && npm ci --offline` → `- npm ci --offline`
- `- cd electron && node node_modules/electron/install.js` → `- node node_modules/electron/install.js`
- `- cd electron && npm run build` → `- npm run build`
- `- cp -r electron/dist electron/package.json electron/node_modules /app/main/` → `- cp -r dist package.json node_modules /app/main/`
- `- install -Dm644 electron/build/icon.png /app/share/icons/hicolor/512x512/apps/chat.loft.Loft.png` → `- install -Dm644 build/icon.png /app/share/icons/hicolor/512x512/apps/chat.loft.Loft.png`
- in the `dir` source's skip list: `electron/node_modules` → `node_modules`, `electron/dist` → `dist`, `electron/dist-electron` → `dist-electron`

Do **not** change the `$XDG_CACHE_HOME/electron` comment or any `github.com/electron/electron` reference — those are the Electron binary cache, not the folder.

- [ ] **Step 7: Fix `.github/workflows/release.yml`** (remove `working-directory: electron`, re-root artifact globs)

- Remove both `working-directory: electron` lines (the "Install, test, build (electron)" step and the electron-builder "Package deb/rpm/AppImage" step) so those steps run at repo root.
- Change the three publish globs:
  - `electron/dist-electron/*.deb` → `dist-electron/*.deb`
  - `electron/dist-electron/*.rpm` → `dist-electron/*.rpm`
  - `electron/dist-electron/*.AppImage` → `dist-electron/*.AppImage`

(The `Build Flatpak bundle` step already runs at repo root against `chat.loft.Loft.yml` and needs no change.)

- [ ] **Step 8: Tidy the `.vscode/settings.json` comment**

The `files.exclude` globs (`**/node_modules`, `**/dist`) are path-agnostic and keep working. Update only the explanatory comment that references the old `electron/` tree so it no longer names a path that doesn't exist (e.g. change a mention of "electron/ and dev_local/electron_test/" to "the build output (node_modules/, dist/) and dev_local/"). No functional keys change.

- [ ] **Step 9: Reinstall at root and run the full build + suite**

Run (repo root):
```bash
npm ci
npm run build
npm test
npm run check
```
Expected: `npm ci` installs into a root `node_modules/`; `npm run build` exits 0; **161** tests pass; svelte-check **0 errors/0 warnings**. Then confirm assets landed:
```bash
ls dist/assets dist/assets/icons | grep -E 'loft.png|loft-symbolic.svg|whatsapp.png' && echo ASSETS_OK
```
Expected: `ASSETS_OK` (build's `copy-assets` resolved the merged root `assets/`).

- [ ] **Step 10: Smoke the AppImage package (config re-roots correctly)**

Run:
```bash
npx electron-builder --linux AppImage
ls dist-electron/*.AppImage && echo APPIMAGE_OK
```
Then a headless non-crash smoke (no display in this env):
```bash
timeout 12 env -u ELECTRON_RUN_AS_NODE ./dist-electron/*.AppImage --no-sandbox >/tmp/loft-root-smoke.log 2>&1; echo "exit=$?"
```
Expected: `APPIMAGE_OK`; `exit=124` (timeout kill = stayed up). An early non-zero exit with a stack trace = investigate. (If the AppImage build hits an environmental wall — FUSE/sandbox/display — that's acceptable per Stage 5 precedent: the config validity is proven by electron-builder parsing + packing; note it and continue. A config/schema error is NOT acceptable.)

- [ ] **Step 11: Full local flatpak-builder build — authoritative proof of the manifest path edits**

The manifest paths changed (Step 6), so build it offline from the committed sources (heavy, ~15–20 min; same procedure verified in Stage 5). The flatpak runtimes/base-app (`org.freedesktop.Platform//24.08`, `Sdk//24.08`, `org.electronjs.Electron2.BaseApp//24.08`, `Sdk.Extension.node22//24.08`) are already installed from Stage 5.
```bash
flatpak-builder --user --force-clean --repo=.flatpak-repo build-dir chat.loft.Loft.yml
flatpak build-bundle .flatpak-repo Loft-root-check.flatpak chat.loft.Loft && echo FLATPAK_OK
```
Expected: builds offline (npm ci + install.js + npm run build all run at `/run/build/loft/` root, no `cd electron`), installs, `FLATPAK_OK`. Optional non-crash check: `timeout 12 flatpak run chat.loft.Loft --no-sandbox; echo exit=$?` → `exit=124`. Remove the throwaway bundle: `rm -f Loft-root-check.flatpak`.
- If, after genuine effort, the flatpak build hits an environmental wall unrelated to the path edits, report **DONE_WITH_CONCERNS** with the exact error — the AppImage build + Step 12 grep still prove the move, and CI (`release.yml`) is the backstop. But the path edits themselves must be correct by inspection.

- [ ] **Step 12: Verify no stray `electron/`-folder references remain, and YAML is valid**

Run:
```bash
git grep -nI "electron/" -- ':!docs/' ':!flatpak/generated-sources.json' ':!*.md' || echo NONE
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo YAML_OK
```
Expected: the only `electron/` hits are legitimate Electron-*binary* references — `flatpak/loft-launcher.sh`'s `/app/main/node_modules/electron/dist/electron` and any `$XDG_CACHE_HOME/electron` comment in `chat.loft.Loft.yml` — and **no** `electron/`-folder paths (no `cd electron`, `electron/dist`, `electron/src`, `working-directory: electron`). `YAML_OK` prints.

- [ ] **Step 13: Commit the move + path fixes together**

```bash
git add -A
git commit -q -m "refactor: hoist the Electron app from electron/ to the repository root

Move package.json/configs/src/tests/build/assets up one level, merge the two
assets/ trees (root already held the icon superset; take loft.png tray base) and
the two .gitignores, and remove the now-empty electron/. Fix the three paths that
assumed the split: the flatpak manifest build-commands + skip-list, the CI
working-directory + artifact globs, and copy-assets' ../ reach. electron-builder.yml
and app source use location-relative paths and move untouched; no behavior change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Rewrite `CLAUDE.md` + `README.md` to the Electron reality

Both docs describe the dead Rust architecture (daemon, ksni, real-Chrome launch, native messaging). Rewrite them to describe what actually ships. Accuracy is the bar — describe what the code does; do not invent features.

**Files:**
- Rewrite: `CLAUDE.md`, `README.md`

**Source facts to draw on:** the design spec `docs/superpowers/specs/2026-07-14-electron-loft-06-root-migration-design.md` §7, the parent rewrite spec `docs/superpowers/specs/2026-07-09-electron-loft-v1-parity-design.md`, and the project memory `~/.claude/projects/-home-keith-LocalCode-keithvassallomt-loft/memory/project_electron_rewrite_design.md` (the authoritative record of the Electron architecture + gotchas).

- [ ] **Step 1: Read the current docs and the source facts**

Read `CLAUDE.md` and `README.md` (to know what to preserve), plus spec §7 and the rewrite memory file above. Identify the still-true content to keep verbatim (see Step 2/3).

- [ ] **Step 2: Rewrite `CLAUDE.md`**

Replace the Rust architecture with the Electron one. **Structure to write** (adapt headings as needed):
- **Overview / Problem** — keep the problem statement (messaging apps lack good Linux desktop apps; Electron wrappers historically lacked WebRTC/codecs — the POC disproved that for our set). State Loft is now a self-contained Electron app.
- **Architecture** — ONE Electron app for all services (single-instance lock; one `chat.loft.Loft` app identity; a hub/manager window + per-service `WebContentsView` rendered **in-process**, re-parentable for a future unified view). No separate daemon, no real-Chrome launch, no native-messaging host.
- **Components** — (1) hub window (Svelte 5 + Vite renderer) for install/settings/autostart; (2) per-service frameless window + own titlebar view (close ✕ = hide-to-tray, A-glyph zoom); (3) **sandboxed preloads replace the Chrome extension** — service id injected directly, badge/notification/de-chrome logic per service, self-hosted Element/Talk "just work" (no manifest/host_permissions); (4) tray: hand-rolled dbus-next SNI (single Loft icon, left-click menu) or GNOME-panel via the shell helper; (5) notifications: hand-rolled dbus-next `org.freedesktop.Notifications` proxy with avatars via per-partition `session.fetch`; (6) GNOME Shell helper installed **from EGO** (`InstallRemoteExtension`, no bundle-deploy) for focus/hide + alt-tab/overview hiding; (7) KWin scripting on KDE for focus/hide; (8) system-DND (GNOME `show-banners` negated / KDE `Inhibited` direct) OR per-service DND OR focus-gate.
- **Preserve (still accurate):** the **Supported Apps** table + URLs; the self-hosted **Element** and **NextCloud Talk** specifics (badge source, notification/avatar handling, de-chrome); the **D-Bus interface** table (`chat.loft.Service` methods — still exported); the user-data **File Layout** (`~/.local/share/loft/`, `~/.config/loft/`, `Partitions/<id>` for sessions — note it's Electron partitions now, not Chrome `--user-data-dir`); the **Logging** section; the **Development Rules** ("always check latest versions") and the debug-vs-release note (recast for `npm`/electron-builder — release/packaging builds are heavy, iterate with `npm run build`).
- **Replace:** Chrome Launch Details, Chrome Detection, Native Messaging Protocol wire-format-as-transport (the preload now talks IPC, not native messaging) — describe the IPC/preload bridge instead. Tech Stack → TypeScript/Electron 43, Svelte 5, dbus-next, electron-builder, Vitest (not Rust/libadwaita/ksni/zbus). Packaging → deb/rpm/AppImage via electron-builder + from-source flatpak-builder manifest (FriendlyHub); **the repo root is the app** (new layout). Development commands → `npm run build` / `test` / `check` / `dist` / `start` (with `env -u ELECTRON_RUN_AS_NODE`), `--service=<id>`.

- [ ] **Step 3: Rewrite `README.md`**

User-facing overview to match:
- **Problem/Features** — self-contained Electron app; full voice/video calling, system tray, badge counts, desktop notifications, close-to-tray, native GNOME + KDE integration. **Drop** "uses your real Google Chrome installation."
- **Supported Services** — keep the table (WhatsApp, Messenger, Slack, Telegram, Element, NextCloud Talk + URLs / self-hosted notes).
- **Requirements** — a Linux desktop (GNOME or KDE Plasma); Google Chrome is **no longer required**.
- **Installation** — Flatpak (FriendlyHub + standalone `.flatpak`), rpm/deb/AppImage from GitHub Releases. Update the **Building from source** section to the new root layout + npm (`npm ci && npm run build && npm start`; package with `npm run dist` / the flatpak manifest) — remove the cargo/just instructions. Update **Cutting a release** to the tag → `release.yml` flow.
- **Usage** — `loft` opens the hub; `loft --service <id>` opens a service; `--minimized`. **How It Works** — brief, matching CLAUDE.md's architecture. Keep **License**/links.

- [ ] **Step 4: Verify no stale Rust/Chrome-mechanism claims remain**

Run (repo root):
```bash
grep -niE "cargo|libadwaita|\bksni\b|zbus|native messaging|--user-data-dir|real (google )?chrome|daemon|rust" CLAUDE.md README.md || echo "CLEAN"
```
Expected: no hits that describe Loft's *mechanism* as Rust/daemon/real-Chrome/native-messaging. (A deliberate historical mention — e.g. "unlike the earlier Rust version" — is fine; judge in context. `Partitions` replacing Chrome `--user-data-dir` may mention Chrome as the *old* approach; that's acceptable.) Also sanity-read both files once for accuracy.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -q -m "docs: rewrite CLAUDE.md + README.md for the Electron architecture

Replace the Rust daemon / ksni / real-Chrome / native-messaging descriptions with
the self-contained Electron app: in-process WebContentsView per service, sandboxed
preloads (no Chrome extension), dbus-next SNI tray + notifications, EGO-installed
GNOME helper + KWin on KDE, electron-builder + flatpak packaging, and the new
repo-root layout. Preserve the still-accurate service tables, D-Bus interface, and
user-data file layout.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §4 delete Rust/extension/justfile → **Task 1**. ✓
- §5 move electron→root + assets merge + gitignore merge + remove electron/ → **Task 2 Steps 1–4**. ✓
- §6 three path fixes (manifest, release.yml, copy-assets) + .vscode comment → **Task 2 Steps 5–8**. ✓
- §7 docs rewrite (CLAUDE.md + README.md, preserve-list) → **Task 3**. ✓
- §8 sequencing (3 staged commits; move+paths together) + verification (npm ci/build/test/check, AppImage smoke, release.yml YAML, flatpak build, stray-`electron/` grep) → **Task 1 Step 4–5, Task 2 Steps 9–13**. ✓

**Placeholder scan:** No TBD/TODO. The docs task (Task 3) gives a section-by-section outline + explicit preserve/replace lists + a stale-term grep gate rather than inlining full final prose — appropriate for a rewrite whose deliverable *is* the prose; the source facts are named (spec §7, memory file). Not a placeholder.

**Consistency:** Task 1 frees the `src/`/`tests/` names that Task 2 Step 1 moves into (ordering explicit). Task 2 keeps `electron-builder.yml` unedited (relative paths) as the spec states; the copy-assets/manifest/release.yml edits use the exact strings verified against the current files. The `.gitignore` merge keeps `/.flatpak-builder/` (generic) and the Stage-5 Electron flatpak artifacts, drops Rust-only entries. Verification commands match the Global Constraints (161 tests, 0/0 check).
