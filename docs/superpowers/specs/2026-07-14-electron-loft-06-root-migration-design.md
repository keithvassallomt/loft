# Electron Loft — Root Migration: hoist Electron to repo root, delete old Rust Loft — Design

Status: approved (Keith, 2026-07-14). Branch: `electron-rewrite`. NOT merged to main.

Follows Stage 5 (packaging, HEAD `f394209`). This is a housekeeping/restructuring change, not a feature stage:
the Electron rewrite has replaced the Rust app, so the old Rust code is deleted and the Electron app —
currently in the `electron/` sub-folder — moves up to the repository root, with every path that assumed the
split fixed.

## 1. Why / scope

The Electron rewrite is feature-complete and packaged. The repo still carries the **old Rust Loft** at root
(`Cargo.toml`, `src/`, `tests/`, the old Chrome `extension/`, `justfile`) alongside the **Electron app** in
`electron/`. This split is now pure debt: the Rust app is dead, and the `electron/` nesting complicates every
package path (flatpak manifest, CI, scripts). This change eliminates the Rust app and hoists the Electron app
to root so the repository root *is* the app.

In scope: delete old Rust + old extension + Rust build recipes; `git mv` the Electron app to root; reconcile
the two `assets/` trees and the two `.gitignore`s; fix the three package/CI paths that reference `electron/`;
and **rewrite `CLAUDE.md` + `README.md`** from the Rust architecture to the Electron reality (Keith's call).

Out of scope: any behavior change to the app; merging `electron-rewrite` to `main`; the Stage-5 follow-ups
(EGO helper publish, live packaged-build smoke); `dev_local/` (git-ignored scratch — untouched).

## 2. Resolved decisions

- **Docs: rewrite to Electron reality now** (Keith) — `CLAUDE.md` + `README.md` rewritten as part of this change,
  not deferred.
- **`git mv` for moves** (preserves history/blame); `git rm` for deletes.
- **Staged commits** (delete → move+paths → docs) so the change is bisectable and reviewable.
- **One cohesive spec/plan** — not decomposed.

## 3. Target root layout (after)

```
package.json  package-lock.json                  (from electron/)
tsconfig.json  vite.config.ts  vitest.config.ts  svelte.config.js
electron-builder.yml                             (moves as-is — relative paths, zero edits)
chat.loft.Loft.yml                               (flatpak manifest — paths fixed, §6)
src/                                             (Electron TS: main/ preload/ renderer/ shared/)
tests/                                           (Electron Vitest suite)
build/icon.png                                   (electron-builder icon)
assets/                                          (merged: icons/*.{svg,png,symbolic} + loft.png tray base)
data/  flatpak/  gnome-shell-extension/  docs/  .github/    (unchanged)
CHANGELOG.md  LICENSE  README.md  CLAUDE.md  .gitignore  .vscode/
```

## 4. Delete — old Rust Loft + obsolete (`git rm`)

- `Cargo.toml`, `Cargo.lock`
- `src/` — the entire Rust tree (`main.rs`, `daemon/`, `manager/`, `combined_tray/`, `chrome.rs`, `config.rs`, …)
- `tests/` — the Rust integration tests (config/messaging/D-Bus)
- `extension/` — the old Chrome MV3 extension (`background.js`, `content.js`, `manifest.json`, …); the Electron
  app replaced it with sandboxed preloads
- `justfile` — Rust build recipes (`cargo build`, `cargo generate-rpm`, `cargo deb`, AppImage) superseded by
  electron-builder + `.github/workflows/release.yml`

## 5. Move + reconcile (`git mv`)

**Ordering matters:** the Rust `src/` and `tests/` must be `git rm`'d (§4) **before** the Electron `src/`/`tests/`
move in, or the names collide.

- Move every `electron/*` up one level: `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`,
  `vitest.config.ts`, `svelte.config.js`, `electron-builder.yml`, `src/`, `tests/`, `build/`.
- **Assets merge (verified byte-identical):** every `electron/assets/icons/*.png` is identical to the matching
  `assets/icons/*.png` (root already holds the svg+png+symbolic superset), and `electron/assets/loft.png` is
  identical to `assets/icons/loft.png`. So: `git mv electron/assets/loft.png assets/loft.png` (root lacked a
  top-level `assets/loft.png`, which `copy-assets` reads as the tray base), then `git rm -r` the remaining
  `electron/assets/` (pure duplicates). Result: one root `assets/` — `assets/loft.png` (tray base) +
  `assets/icons/*.{svg,png}` incl. `loft-symbolic.svg`.
- **`.gitignore` merge:** fold electron's `node_modules`, `dist`, `dist-electron` into the root `.gitignore`
  (which already carries the Stage-5 flatpak artifacts `build-dir/`, `.flatpak-repo/`, `flatpak-node/`,
  `*.flatpak`). Drop Rust-only entries (`/target`, Cargo/flatpak-builder-of-Rust artifacts) that no longer apply.
- Remove the now-empty `electron/` directory.

**No `electron-builder.yml` edits:** its paths (`dist/**`, `package.json`, `build/icon.png`,
`buildResources: build`, `directories.output: dist-electron`) are all relative to the config's own location, so
moving it to root re-roots them correctly. It moves untouched.

**No app source edits:** runtime asset resolution uses `__dirname` relative to `dist/` (e.g.
`join(__dirname,'..','assets',…)` from `dist/main`, `'..','..','assets'` from `dist/main/tray`); `dist/` moves
with the app, so these are unchanged. The tsconfig/vite/vitest/svelte configs use in-app relative paths and move
as a unit.

## 6. Path fixes (exactly three files + one comment)

- **`chat.loft.Loft.yml`** (flatpak manifest build-commands + sources skip-list):
  - `- cd electron && npm ci --offline` → `- npm ci --offline`
  - `- cd electron && node node_modules/electron/install.js` → `- node node_modules/electron/install.js`
  - `- cd electron && npm run build` → `- npm run build`
  - `- cp -r electron/dist electron/package.json electron/node_modules /app/main/` →
    `- cp -r dist package.json node_modules /app/main/`
  - `- install -Dm644 electron/build/icon.png …` → `- install -Dm644 build/icon.png …`
  - skip-list `electron/node_modules`, `electron/dist`, `electron/dist-electron` →
    `node_modules`, `dist`, `dist-electron`
  - **Leave untouched:** the `$XDG_CACHE_HOME/electron` comment and `github.com/electron/electron` /
    `@electron/*` URLs — those are the Electron *binary/npm packages*, not the `electron/` folder.
- **`.github/workflows/release.yml`:** remove `working-directory: electron` (both occurrences — the
  install/test/build step and the electron-builder step); change the three publish globs
  `electron/dist-electron/*.{deb,rpm,AppImage}` → `dist-electron/*.{deb,rpm,AppImage}`. (The flatpak-builder
  step already runs at repo root and is unaffected.)
- **`package.json` `copy-assets`:** the single `../assets/icons/loft-symbolic.svg` → `assets/icons/loft-symbolic.svg`
  (every other segment already reads `assets/…` and now resolves against the merged root `assets/`).
- **`.vscode/settings.json`:** tidy the comment that references the `electron/` tree (the `files.exclude` globs
  `**/node_modules`, `**/dist` are path-agnostic and keep working).

**Do NOT touch `flatpak/generated-sources.json`** — its `electron` mentions are npm-registry/GitHub URLs for the
Electron binary + `@electron/*` deps, not our folder; and it is machine-generated from `package-lock.json` (whose
dependency tree is unchanged by a folder move).

## 7. Docs rewrite (to Electron reality)

- **`CLAUDE.md`** — rewrite from the Rust architecture to the Electron one. Cover: single Electron app for all
  services (single-instance lock, one `chat.loft.Loft` identity, per-service `WebContentsView` in-process);
  sandboxed preloads replace the Chrome extension (service id injected; self-hosted Element/Talk "just work");
  `persist:<id>` partitions + Chrome-stable UA; hand-rolled dbus-next SNI tray + `org.freedesktop.Notifications`
  + `chat.loft.Loft` service object; GNOME Shell helper installed from EGO (`InstallRemoteExtension`, no
  bundle-deploy) + KWin scripting on KDE + Plasma/GNOME system-DND; frameless window + own titlebar view;
  packaging via electron-builder (deb/rpm/AppImage) + from-source flatpak-builder manifest (FriendlyHub); the new
  root layout; and the real dev commands (`npm run build` / `test` / `check` / `dist` / `start`, `env -u
  ELECTRON_RUN_AS_NODE`). **Preserve the still-true content:** the supported-services table and their URLs, the
  self-hosted Element/Talk specifics (badge/notification/de-chrome behavior), the user-data file layout
  (`~/.local/share/loft/`, `~/.config/loft/`), and the D-Bus interface table (still accurate). Keep the
  "always check latest versions" and debug-vs-release-build development rules (still apply to Electron/npm).
- **`README.md`** — rewrite the user-facing overview: drop "uses your real Google Chrome installation"; describe
  the self-contained Electron app with voice/video, tray, badges, notifications, close-to-tray, GNOME + KDE
  integration, and the install formats (deb/rpm/AppImage/Flatpak via FriendlyHub + Releases). Keep the supported
  apps, the problem statement (messaging apps lack good Linux desktop apps), and license/links.

Accuracy is the bar (these load into every session and currently misdirect), not exhaustiveness — describe what
the code actually does; do not invent features.

## 8. Sequencing & verification

Staged commits (bisectable):
1. **Delete** — `git rm` the §4 set. (App still builds from `electron/`; root is now Rust-free.)
2. **Move + paths** — the §5 moves + assets/gitignore merge + the §6 path fixes, in one commit (the app is
   non-building *between* the move and the path fixes, so they land together).
3. **Docs** — the §7 rewrites.

Verification after commit 2 (the load-bearing one):
- `npm ci` at repo root (clean install proves the lockfile + root layout).
- `npm run build` (tsc + esbuild preloads + vite + copy-assets) exits 0; `dist/assets/` contains `loft.png`,
  `loft-symbolic.svg`, `icons/*.png`.
- `npm test` (full Vitest suite, expect the current 161 green) and `npm run check` (svelte-check 0/0).
- `npx electron-builder --linux AppImage` produces `dist-electron/*.AppImage` (config re-roots correctly) and it
  launches without crashing (headless timeout smoke, as in Stage 5).
- `.github/workflows/release.yml` is valid YAML and its paths reference root (`dist-electron/*`, no
  `working-directory: electron`).
- **`flatpak-builder` full local build** of the fixed `chat.loft.Loft.yml` (offline, from the committed
  `generated-sources.json`) succeeds + installs + headless-smoke — this is the authoritative proof the manifest
  path edits are correct (same heavy local build approved for Stage 5's manifest).
- `git grep -n "electron/" -- ':!docs/' ':!flatpak/generated-sources.json' ':!*.md'` returns only legitimate
  Electron-binary references (the `@electron/get` cache comment, the launcher's `/app/main/node_modules/electron/
  dist/electron` path) — no stray `electron/`-folder paths.

## 9. What this delivers

The repository root becomes the Electron app: `npm` commands run at root, packaging paths are clean, the dead
Rust code is gone, and `CLAUDE.md`/`README.md` describe what actually ships. This is the natural precondition for
eventually merging `electron-rewrite` to `main` as the one true Loft.
