# Electron Loft — Stage 4.5: KDE support + VM test delivery — Design

Status: approved (Keith, 2026-07-14). Branch: `electron-rewrite`. Code in `electron/`.

Parent spec: `docs/superpowers/specs/2026-07-09-electron-loft-v1-parity-design.md` (§13 open items #2 KDE
system-DND, and the KWin/KDE deferrals). Follows Stage 4 (hub), precedes Stage 5 (full packaging).

## 1. Why / scope

On KDE today the Electron app already works for SNI tray, notification delivery, per-service DND, and
calls. The gaps are (a) **window raise/focus + hide** (Electron's native `window.show()/focus()` doesn't
reliably grab focus under KDE's focus-stealing prevention), and (b) **system-wide DND auto-detect** (the
OS "Do Not Disturb" toggle doesn't gate Loft notifications). Stage 4.5 closes both by porting the Rust
KWin scripting path and adding a Plasma DND watcher.

Because Keith tests on a **Kubuntu VM with no dev setup**, Stage 4.5 also introduces a **minimal
packaging + CI delivery** slice so a runnable build lands on the VM with zero effort: electron-builder
produces a `.deb` + `AppImage`, and a `workflow_dispatch` GitHub Actions job publishes them to a rolling
`kde-preview` pre-release the VM downloads from. (Full packaging — rpm/Flatpak/Flathub/auto-update —
remains Stage 5.)

**Target:** Plasma **6** (Keith's VM is 6.6/6.7). The injected KWin JS also feature-detects Plasma 5 API
since it costs nothing.

Out of scope: full packaging (Stage 5); GNOME behavior changes; the unified/tabbed view (post-v1).

## 2. Resolved decisions

- **VM delivery: GitHub Actions → rolling `kde-preview` pre-release.** CI builds `.deb` + `AppImage` on a
  manual `workflow_dispatch` (fired at test-ready checkpoints, not every commit) and attaches them to a
  single reused pre-release. Keith downloads from the repo Releases page — no dev tools, no transfer.
  Repo is public (free Actions). I build once locally first to prove the electron-builder config launches.
- **KWin match key = window title (caption), not `resourceClass`.** All Loft windows share WM_CLASS
  `chat.loft.Loft` under the single Electron identity; we own titles via `formatWindowTitle`, so KWin
  matches `caption === key || caption.startsWith(key + ' (')` with `key = def.displayName` — identical
  keying to the GNOME helper.
- **System-DND deps refactor to boolean-shaped** (`current(): boolean|null` + `watch`), so GNOME (gsettings
  `show-banners`) and KDE (`Inhibited` property) both fit one seam without shoehorning D-Bus into a
  gsettings-text shape. `parseShowBanners` and its tests are preserved as a gnomeDeps-internal helper.
- **Primary artifact = `.deb`** (native to Kubuntu, menu integration, no FUSE); `AppImage` is the no-sudo
  alternative. Both emitted from one build.

## 3. KDE window focus/hide — `electron/src/main/kde/kwin.ts` (replaces the stub)

Port of `src/daemon/kwin.rs`, re-keyed to titles. Exports the existing stub's interface:

```ts
export interface KwinClient {
  focusWindow(key: string): Promise<void>;
  hideWindow(key: string): Promise<void>;
}
export function createKwinClient(): KwinClient;
```

- **Contract:** fire-and-forget, **never-throw** (mirrors `gnome/shellHelper.ts`'s `ShellHelperClient`);
  any D-Bus failure is caught + logged, never propagated (a missing/erroring KWin must not crash a window
  action). The factory itself must not throw at construction (it may open a session-bus connection).
- **Mechanism** (via `dbus-next` session bus, dest `org.kde.KWin`), exact sequence ported from `kwin.rs`:
  write the JS snippet to a temp file (`os.tmpdir()/loft-kwin-<show|hide>.js`); then
  (1) `unloadScript(plugin)` on `/Scripting` iface `org.kde.kwin.Scripting` (clear any prior; ignore
  errors); (2) `loadScript(path, plugin)` on `/Scripting` → returns an **int32 `scriptId`**;
  (3) `run()` (no args) on path **`/Scripting/Script<scriptId>`** iface **`org.kde.kwin.Script`**;
  (4) ~100 ms delay to let it execute; (5) `unloadScript(plugin)` again (ignore errors); (6) delete the
  temp file. Use distinct plugin names `loft-show` / `loft-hide`. Signatures: `loadScript` in `ss` out `i`,
  `run`/`unloadScript` as above.
- **Injected JS** (pure builder `buildKwinScript(action: 'show'|'hide', key: string): string`, unit-tested):
  ```js
  var list = (typeof workspace.windowList === 'function')
    ? workspace.windowList()      // Plasma 6
    : workspace.clientList();     // Plasma 5 fallback
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    if (w.caption === KEY || w.caption.indexOf(KEY + " (") === 0) {
      // show:
      w.skipTaskbar = false; w.minimized = false;
      if ("activeWindow" in workspace) workspace.activeWindow = w; else workspace.activeClient = w;
      // hide:
      w.skipTaskbar = true; w.minimized = true;
      break;
    }
  }
  ```
  `KEY` is the JSON-encoded title (escaped) so titles with quotes/spaces are safe. The builder emits the
  show or hide branch, not both.

## 4. KDE system-DND — `electron/src/main/notifications/systemDnd.ts`

Refactor the deps seam to booleans; add `kdeDeps`; auto-select by DE.

```ts
export interface SystemDndDeps {
  current(): boolean | null;                 // current DND state; null = unknown
  watch(onChange: (dnd: boolean) => void): { stop(): void };
}
export function watchSystemDnd(onChange: (dnd: boolean) => void, deps?: SystemDndDeps): SystemDndWatcher;
```

- `gnomeDeps()`: wraps `gsettings get/monitor org.gnome.desktop.notifications show-banners`; `current()` =
  `banners === null ? null : !banners`; `watch` maps monitor lines through `parseShowBanners` → `!banners`.
  `parseShowBanners` stays (kept + still tested).
- `kdeDeps()`: `dbus-next` — `current()` does `org.freedesktop.DBus.Properties.Get('org.freedesktop.Notifications','Inhibited')`
  on bus `org.freedesktop.Notifications`, path `/org/freedesktop/Notifications`; `watch` subscribes to
  `PropertiesChanged` on that path and emits the new `Inhibited` boolean (DND is `Inhibited` **directly** —
  no negation, unlike GNOME). Confirmed interface (Plasma 5.16+): Arch Wiki + KDE Plasma/Notifications.
- **Selection:** `defaultSystemDndDeps(env) = isKde(env) ? kdeDeps() : isGnome(env) ? gnomeDeps() : noopDeps()`
  (noop `current()→null`, `watch→{stop(){}}`; other DEs keep today's "no system-DND autodetect" behavior).
- `watchSystemDnd` collapses to: seed `dnd = deps.current() ?? false`; on `watch` change, if it differs,
  update + `onChange`. (Per-service DND + focus-gate unchanged.)

## 5. Wire-in — `electron/src/main/index.ts` (+ `trayBackend.ts`)

- Add `isKde(env)` next to `isGnome` (in `trayBackend.ts`): true when `XDG_CURRENT_DESKTOP` contains `KDE`
  (case-insensitive, colon-split).
- At the KDE seam (the marker comment added in Stage 4.5 stub commit): when `!gnome && isKde()`, build
  `const kwin = createKwinClient()` in a try/catch (never crash startup).
- Introduce `focusExternal(key)` / `hideExternal(key)` that dispatch to whichever window manager is active
  — GNOME `helper?.focusWindow/hideWindow` xor KDE `kwin?.focusWindow/hideWindow` (no-op on other DEs) —
  and replace the current inline `helper?.focusWindow(...)` / `helper?.hideWindow(...)` call sites
  (`openService`, `toggleService`, `loftDeps.hide`) with these. Fire in parallel with the native
  `show()/hide()`, never awaited.
- system-DND: no index.ts change — `watchSystemDnd` selects `kdeDeps`/`gnomeDeps` by env internally.

## 6. Minimal packaging — electron-builder

- Add `electron-builder` (devDep) + config (in `package.json` `build` or `electron-builder.yml`):
  `appId: chat.loft.Loft`, `productName: Loft`, `linux: { target: ['deb','AppImage'], category: 'Network',
  icon: assets/loft.png }`, `files` = `dist/**` + prod `node_modules` (only `dbus-next`; `svelte` is a
  devDep and its compiled output already lives in `dist/renderer/hub`). `main` is already
  `dist/main/index.js`.
- New script: `"dist": "npm run build && electron-builder --linux deb AppImage"`.
- **No native modules** (`dbus-next` is pure JS) → no `node-gyp`/rebuild step.
- **Local verification (me, before CI):** `npm run dist` produces `dist-electron/*.deb` + `*.AppImage`; the
  AppImage **launches on this (Fedora, non-KDE) box and the hub opens** — proving the packaging config,
  independent of KDE behavior. Icon: if `assets/loft.png` is < 512×512, electron-builder may warn/scale;
  accept the warning or supply a 512² `build/icon.png` (decide at implementation, don't block).

## 7. CI delivery — `.github/workflows/kde-preview.yml`

- Trigger: `workflow_dispatch` (manual — I fire it via `gh workflow run kde-preview.yml` at checkpoints).
- Runner `ubuntu-latest`; steps: checkout → `actions/setup-node@v4` (Node 22) → `working-directory: electron`
  `npm ci` → `npm run dist` → publish `electron/dist-electron/*.deb` + `*.AppImage` as assets on a rolling
  pre-release **tag `kde-preview`** (create if absent, else replace assets; `prerelease: true`). Use
  `softprops/action-gh-release@v2` (or `gh release create/upload --clobber`).
- Keith: repo → Releases → `kde-preview` → download the newest `.deb` (install via Discover/`dpkg -i`) or
  `.AppImage` (`chmod +x`, run). Building on `ubuntu-latest` keeps glibc compatible with Kubuntu.
- `GITHUB_TOKEN` (default, `contents: write` permission) authorizes the release upload.

## 8. Testing

- **Unit (Vitest, runs locally + in CI's `npm ci` env):**
  - `isKde(env)` truth table (KDE present/absent, mixed `XDG_CURRENT_DESKTOP`).
  - `buildKwinScript('show'|'hide', key)` — asserts the caption-prefix match, the correct property
    assignments per action, the Plasma-6/5 feature-detection, and safe key escaping (a title with a quote).
  - `kdeDeps` mapping: `Inhibited=true → dnd=true`, `false → false` (via an injected fake D-Bus surface);
    `gnomeDeps` still maps `show-banners` → `!banners` (existing `parseShowBanners` tests stay green);
    `noopDeps` → `current()===null`.
  - `watchSystemDnd` emits `onChange` only on a real transition.
- **Manual matrix (Keith, Kubuntu Plasma 6 VM, from the `kde-preview` build):** install `.deb`; SNI tray
  appears with badge; hub Open/Show/Hide **focuses/raises the right service window** (KWin), incl. from
  hidden; per-service + tray DND; notifications with avatars + click-to-navigate; **toggle Plasma system
  DND → Loft suppresses notifications**, untoggle → they resume; a voice/video call; add/remove/gear from
  the hub; second-launch behavior.

## 9. What this unblocks

KDE reaches parity with GNOME on window management + DND. The electron-builder config + CI preview are the
foundation Stage 5 extends (rpm, Flatpak, Flathub, signing/auto-update). After Keith's KDE sign-off →
Stage 5.
