# Stage 5 — Full Packaging & Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Loft-Electron as deb, rpm, AppImage, and Flatpak, publishable to FriendlyHub + GitHub Releases, installable as an in-place replacement for the Rust production Loft.

**Architecture:** electron-builder produces deb/rpm/AppImage from the prebuilt app. The Flatpak is a separate hand-written `flatpak-builder` manifest built from source (Node offline sources, dual-arch) for FriendlyHub, with CI also emitting a standalone `.flatpak`. The GNOME Shell helper is no longer bundled — every build installs it from extensions.gnome.org (EGO) via `org.gnome.Shell.Extensions.InstallRemoteExtension`, so it updates independently of the app. The `-next` transition naming is reverted to canonical `loft`/`chat.loft.ShellHelper` first.

**Tech Stack:** Electron 43 + TypeScript, electron-builder 26, flatpak-builder + `org.electronjs.Electron2.BaseApp` + flatpak-node-generator, dbus-next 0.10.2, Vitest, GitHub Actions.

## Global Constraints

Every task's requirements implicitly include these (verbatim from the spec):

- **Version:** the first Electron release is **1.0.0** (`package.json` `version`, metainfo `<release>`, CHANGELOG). Rust was 0.2.0.
- **Canonical naming only — no `-next`:** extension UUID `loft-shell-helper@loft.chat`; D-Bus name/iface `chat.loft.ShellHelper`; D-Bus path `/chat/loft/ShellHelper`.
- **App identity:** `chat.loft.Loft` (appId, bus own-name, desktop-id, StartupWMClass).
- **Flatpak sandbox stays clean:** no `--talk-name=org.freedesktop.Flatpak` (no `flatpak-spawn` escape), no `--filesystem=home`.
- **No new native dependencies:** `dbus-next` is pure-JS; the app must never require node-gyp/native rebuild.
- **`chat.loft.ShellHelper` D-Bus interface is a stability contract.** Its methods — `SetLoftWindows(as)`, `FocusWindow(s)`, `HideWindow(s)`, `RegisterCombined(s)`, `UnregisterCombined()`, `UpdateCombinedService(ssbubs)`, `RemoveCombinedService(s)` — must not change signature in this stage (app and extension now version independently via EGO).
- **DE seams never throw:** any missing/erroring GNOME Shell, KWin, or D-Bus surface must be caught and logged, never propagated (must not crash or hang startup or a window action).
- **Gates stay green:** `npm test` (Vitest) and `npm run check` (svelte-check) must pass after every task. All npm commands run in the `electron/` working directory unless noted.
- **Build local = debug.** Only build release/packages when producing distributables (heavy; OOM risk). Packaging is validated on CI (ubuntu-latest); local packaging is best-effort (Fedora hits the vendored-fpm libcrypt.so.1 issue for deb/rpm; AppImage builds locally).

---

## File Structure

**Task 1 — revert `-next` (survivors only):**
- Modify: `gnome-shell-extension/metadata.json` (uuid, name)
- Modify: `gnome-shell-extension/extension.js:18-19` (`DBUS_NAME`, `DBUS_PATH`), `:477,554,657,703` (panel role strings)
- Modify: `electron/src/main/gnome/shellHelper.ts:6-8` (`NAME`, `PATH`, `IFACE`)

**Task 2 — EGO install module:**
- Create: `electron/src/main/gnome/helperInstall.ts` (`ensureGnomeHelper`, `HELPER_UUID`, `defaultHelperInstallDeps`)
- Create: `electron/tests/helperInstall.test.ts`

**Task 3 — wire EGO in, remove bundle-deploy:**
- Modify: `electron/src/main/index.ts:14` (drop import), `:241-266` (swap deploy block)
- Delete: `electron/src/main/gnome/deploy.ts`, `electron/tests/gnomeDeploy.test.ts`
- Modify: `electron/package.json` (`copy-assets` script — drop the gnome-shell-extension staging)

**Task 4 — electron-builder deb/rpm/AppImage + version:**
- Modify: `electron/electron-builder.yml` (add `rpm`, `desktop.entry`)
- Modify: `electron/package.json` (`version` → `1.0.0`)

**Task 5 — AppStream + desktop + CHANGELOG:**
- Modify: `data/chat.loft.Loft.metainfo.xml` (description, `<release>`), `data/chat.loft.Loft.desktop` (StartupWMClass)
- Modify: `CHANGELOG.md` (1.0.0 entry)

**Task 6 — Flatpak manifest:**
- Modify: `chat.loft.Loft.yml` (repo root — replace Rust manifest with Electron one)
- Create: `flatpak/generated-sources.json` (Node offline sources)
- Create: `flatpak/loft-launcher.sh` (zypak launcher), `flatpak/README.md` (FriendlyHub upload notes)

**Task 7 — CI release workflow:**
- Modify/rename: `.github/workflows/kde-preview.yml` → `.github/workflows/release.yml`

---

## Task 1: Revert `-next` → canonical naming (surviving files)

This is a mechanical rename, verified by grep + the existing suite. It touches **only the files that survive Stage 5** — the extension source (which becomes the EGO listing) and the daemon-side client. `gnome/deploy.ts` and the `index.ts` deploy block still contain `-next` strings after this task; they are **deleted** in Task 3, so leaving them avoids editing doomed code and keeps `gnomeDeploy.test.ts` green until then.

**Files:**
- Modify: `gnome-shell-extension/metadata.json`
- Modify: `gnome-shell-extension/extension.js`
- Modify: `electron/src/main/gnome/shellHelper.ts`

**Interfaces:**
- Produces: the extension exports D-Bus name/path/iface `chat.loft.ShellHelper` / `/chat/loft/ShellHelper` (interface XML derives its name from `DBUS_NAME`); the daemon client in `shellHelper.ts` targets the same. They must stay byte-identical to each other.

- [ ] **Step 1: Confirm the current `-next` strings are present (the "before" state)**

Run (from repo root):
```bash
grep -nE "ShellHelperNext|loft-shell-helper-next|loft-next-|Loft Shell Helper \(Next\)" \
  gnome-shell-extension/metadata.json gnome-shell-extension/extension.js electron/src/main/gnome/shellHelper.ts
```
Expected: matches in all three files (metadata uuid+name; extension.js lines 18,19,477,554,657,703; shellHelper.ts lines 6,7,8).

- [ ] **Step 2: Revert `gnome-shell-extension/metadata.json`**

Set exactly:
```json
  "uuid": "loft-shell-helper@loft.chat",
  "name": "Loft Shell Helper",
```
(Leave `version-name`, `shell-version`, `url`, `donations` unchanged.)

- [ ] **Step 3: Revert `gnome-shell-extension/extension.js`**

Line 18-19:
```js
const DBUS_NAME = 'chat.loft.ShellHelper';
const DBUS_PATH = '/chat/loft/ShellHelper';
```
Line 477: `const indicator = new PanelMenu.Button(0.0, `loft-${name}`, false);`
Line 554: `Main.panel.addToStatusArea(`loft-${name}`, indicator);`
Line 657: `const indicator = new PanelMenu.Button(0.0, 'loft-combined', false);`
Line 703: `Main.panel.addToStatusArea('loft-combined', indicator);`

- [ ] **Step 4: Revert `electron/src/main/gnome/shellHelper.ts` lines 6-8**

```ts
const NAME = 'chat.loft.ShellHelper';
const PATH = '/chat/loft/ShellHelper';
const IFACE = 'chat.loft.ShellHelper';
```

- [ ] **Step 5: Verify no `-next` remains in the survivors, and both sides match**

Run (from repo root):
```bash
grep -rnE "ShellHelperNext|loft-shell-helper-next|loft-next-|Helper \(Next\)" \
  gnome-shell-extension/ electron/src/main/gnome/shellHelper.ts || echo "CLEAN"
grep -nE "chat.loft.ShellHelper'|/chat/loft/ShellHelper'" \
  gnome-shell-extension/extension.js electron/src/main/gnome/shellHelper.ts
```
Expected: first prints `CLEAN`; second shows `chat.loft.ShellHelper` / `/chat/loft/ShellHelper` in both files.

- [ ] **Step 6: Run the gates**

Run (in `electron/`): `npm test && npm run check`
Expected: PASS (this rename touches no test; `gnomeDeploy.test.ts` still targets the `-next` deploy path in `deploy.ts`, which is untouched here).

- [ ] **Step 7: Commit**

```bash
git add gnome-shell-extension/metadata.json gnome-shell-extension/extension.js electron/src/main/gnome/shellHelper.ts
git commit -m "refactor(electron): revert GNOME helper -next scaffolding to canonical loft naming

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: EGO install module (`gnome/helperInstall.ts`)

Pure, testable logic behind a deps seam (matching the `systemDnd`/`kwin` pattern): decide whether to prompt + install the helper from EGO, never throwing. Real D-Bus/dialog/fs wiring lives in `defaultHelperInstallDeps`.

**Files:**
- Create: `electron/src/main/gnome/helperInstall.ts`
- Test: `electron/tests/helperInstall.test.ts`

**Interfaces:**
- Produces:
  - `HELPER_UUID = 'loft-shell-helper@loft.chat'`
  - `interface HelperInstallDeps { getExtensionInfo(uuid: string): Promise<Record<string, unknown>>; installRemoteExtension(uuid: string): Promise<string>; prompt(): Promise<boolean>; installSymbolicIcon(): void; }`
  - `ensureGnomeHelper(deps: HelperInstallDeps): Promise<void>`
  - `defaultHelperInstallDeps(opts: { dataHome: string; resourcesDir: string }): HelperInstallDeps`
- Consumes (real deps): GNOME Shell D-Bus `org.gnome.Shell` / `/org/gnome/Shell` / `org.gnome.Shell.Extensions` — `GetExtensionInfo(s)→a{sv}` (empty dict if not installed) and `InstallRemoteExtension(s)→s`.

- [ ] **Step 1: Write the failing test**

Create `electron/tests/helperInstall.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { ensureGnomeHelper, HELPER_UUID, type HelperInstallDeps } from '../src/main/gnome/helperInstall';

function makeDeps(over: Partial<HelperInstallDeps> = {}): HelperInstallDeps & {
  installed: string[]; iconCalls: number;
} {
  const installed: string[] = [];
  const base = {
    installed,
    iconCalls: 0,
    getExtensionInfo: vi.fn(async () => ({}) as Record<string, unknown>),
    installRemoteExtension: vi.fn(async (uuid: string) => { installed.push(uuid); return 'successful'; }),
    prompt: vi.fn(async () => true),
    installSymbolicIcon: vi.fn(() => { base.iconCalls++; }),
  };
  return Object.assign(base, over);
}

describe('ensureGnomeHelper', () => {
  it('installs from EGO when absent and the user accepts', async () => {
    const deps = makeDeps();
    await ensureGnomeHelper(deps);
    expect(deps.installRemoteExtension).toHaveBeenCalledWith(HELPER_UUID);
    expect(deps.iconCalls).toBe(1);
  });

  it('does not install when the user declines', async () => {
    const deps = makeDeps({ prompt: vi.fn(async () => false) });
    await ensureGnomeHelper(deps);
    expect(deps.installRemoteExtension).not.toHaveBeenCalled();
  });

  it('does nothing (no prompt) when already installed', async () => {
    const deps = makeDeps({ getExtensionInfo: vi.fn(async () => ({ uuid: HELPER_UUID, state: 1 })) });
    await ensureGnomeHelper(deps);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.installRemoteExtension).not.toHaveBeenCalled();
  });

  it('falls back silently (no prompt/install) when GNOME Shell is unavailable', async () => {
    const deps = makeDeps({ getExtensionInfo: vi.fn(async () => { throw new Error('no shell'); }) });
    await ensureGnomeHelper(deps);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.installRemoteExtension).not.toHaveBeenCalled();
  });

  it('never throws even if installRemoteExtension rejects', async () => {
    const deps = makeDeps({ installRemoteExtension: vi.fn(async () => { throw new Error('cancelled'); }) });
    await expect(ensureGnomeHelper(deps)).resolves.toBeUndefined();
  });

  it('always installs the symbolic icon', async () => {
    const deps = makeDeps({ getExtensionInfo: vi.fn(async () => ({ state: 1 })) });
    await ensureGnomeHelper(deps);
    expect(deps.iconCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/helperInstall.test.ts`
Expected: FAIL — cannot resolve `../src/main/gnome/helperInstall`.

- [ ] **Step 3: Write `electron/src/main/gnome/helperInstall.ts`**

```ts
import * as dbus from 'dbus-next';
import { dialog } from 'electron';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const HELPER_UUID = 'loft-shell-helper@loft.chat';

const SHELL_NAME = 'org.gnome.Shell';
const SHELL_PATH = '/org/gnome/Shell';
const SHELL_IFACE = 'org.gnome.Shell.Extensions';

export interface HelperInstallDeps {
  /** GNOME Shell's ExtensionInfo dict for uuid; empty object if not installed. Rejects if GNOME Shell is unavailable. */
  getExtensionInfo(uuid: string): Promise<Record<string, unknown>>;
  /** Trigger GNOME's native install dialog for a uuid from extensions.gnome.org. */
  installRemoteExtension(uuid: string): Promise<string>;
  /** Ask the user whether to install the helper. Resolves true if they accept. */
  prompt(): Promise<boolean>;
  /** Install the `loft-symbolic` icon into the user icon theme (needed by the combined panel button). Idempotent. */
  installSymbolicIcon(): void;
}

/**
 * Ensure the GNOME Shell helper is available, installing it from EGO on request.
 * Never throws: a missing/erroring GNOME Shell just leaves Loft on the SNI fallback.
 */
export async function ensureGnomeHelper(deps: HelperInstallDeps): Promise<void> {
  try { deps.installSymbolicIcon(); } catch (e) { console.debug('installSymbolicIcon failed:', e); }

  let info: Record<string, unknown>;
  try {
    info = await deps.getExtensionInfo(HELPER_UUID);
  } catch {
    return; // GNOME Shell not answering → SNI fallback, no prompt
  }
  if (info && Object.keys(info).length > 0) return; // already installed (any state)

  let accepted = false;
  try { accepted = await deps.prompt(); } catch { return; }
  if (!accepted) return;

  try { await deps.installRemoteExtension(HELPER_UUID); }
  catch (e) { console.debug('InstallRemoteExtension failed:', e); }
}

export function defaultHelperInstallDeps(opts: { dataHome: string; resourcesDir: string }): HelperInstallDeps {
  const bus = dbus.sessionBus();
  const iface = async () => {
    const obj = await bus.getProxyObject(SHELL_NAME, SHELL_PATH);
    return obj.getInterface(SHELL_IFACE) as unknown as {
      GetExtensionInfo(uuid: string): Promise<Record<string, dbus.Variant>>;
      InstallRemoteExtension(uuid: string): Promise<string>;
    };
  };
  return {
    getExtensionInfo: async (uuid) => (await iface()).GetExtensionInfo(uuid),
    installRemoteExtension: async (uuid) => (await iface()).InstallRemoteExtension(uuid),
    prompt: async () => {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Install', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        title: 'Enable Loft’s GNOME integration',
        message: 'Install Loft’s GNOME integration?',
        detail:
          'For window management (show/hide, panel icons, badges) on GNOME, Loft uses a small ' +
          'GNOME Shell extension from extensions.gnome.org. Install it now? GNOME will ask you to confirm.',
      });
      return response === 0;
    },
    installSymbolicIcon: () => {
      const dir = join(opts.dataHome, 'icons', 'hicolor', 'scalable', 'apps');
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(opts.resourcesDir, 'loft-symbolic.svg'), join(dir, 'loft-symbolic.svg'));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/helperInstall.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the gates**

Run: `npm test && npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/gnome/helperInstall.ts electron/tests/helperInstall.test.ts
git commit -m "feat(electron): EGO install-prompt module for the GNOME Shell helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Wire EGO install into `index.ts`, remove bundle-deploy

Replace the bundle-and-deploy block with the EGO install-prompt, and delete the old deploy path entirely. This removes the last `-next` references (they lived only in `deploy.ts` and the deleted `index.ts` block).

**Files:**
- Modify: `electron/src/main/index.ts`
- Delete: `electron/src/main/gnome/deploy.ts`, `electron/tests/gnomeDeploy.test.ts`
- Modify: `electron/package.json` (`copy-assets`)

**Interfaces:**
- Consumes: `ensureGnomeHelper`, `defaultHelperInstallDeps` (Task 2); `gnome`, `dataHome`, `join` already in scope in `index.ts`.

- [ ] **Step 1: Delete the bundle-deploy module and its test**

```bash
git rm electron/src/main/gnome/deploy.ts electron/tests/gnomeDeploy.test.ts
```

- [ ] **Step 2: Swap the import in `electron/src/main/index.ts`**

Replace line 14:
```ts
import { deployGnomeExtension } from './gnome/deploy';
```
with:
```ts
import { ensureGnomeHelper, defaultHelperInstallDeps } from './gnome/helperInstall';
```

- [ ] **Step 3: Replace the deploy block in `index.ts` (the `if (gnome) { … deployGnomeExtension … dialog … }` block, ~lines 241-266)**

Replace the entire block — from the `// GNOME Shell only loads new extension JS…` comment through the closing of the `try/catch` that logs `'GNOME helper deploy failed:'` — with:
```ts
    // On GNOME, ensure the Shell helper is present. It's no longer bundled: we
    // install it from extensions.gnome.org on the user's OK (GNOME's own dialog
    // does the download+install+enable, loading it in-process — no relogin). If
    // declined or GNOME Shell is unavailable, Loft falls back to the SNI tray.
    if (gnome) {
      await ensureGnomeHelper(defaultHelperInstallDeps({
        dataHome,
        resourcesDir: join(__dirname, '..', 'assets'),
      }));
    }
```

- [ ] **Step 4: Update `copy-assets` in `electron/package.json` — stop staging the extension, keep `loft-symbolic.svg`**

Replace the `copy-assets` script value with (single line; the only change is removing the `gnome-shell-extension` staging segment — the `loft-symbolic.svg` copy at the end stays because `installSymbolicIcon` reads it):
```
"copy-assets": "mkdir -p dist/renderer/titlebar dist/assets/icons && cp src/renderer/titlebar/index.html src/renderer/titlebar/titlebar.css dist/renderer/titlebar/ && cp assets/loft.png dist/assets/ && cp assets/icons/*.png dist/assets/icons/ && cp ../assets/icons/loft-symbolic.svg dist/assets/loft-symbolic.svg",
```

- [ ] **Step 5: Verify no `-next` remains anywhere and the deploy symbol is gone**

Run (from repo root):
```bash
grep -rnE "ShellHelperNext|loft-shell-helper-next|deployGnomeExtension|Log out to finish" \
  electron/src electron/tests electron/package.json gnome-shell-extension/ || echo "CLEAN"
```
Expected: `CLEAN`.

- [ ] **Step 6: Build and run the gates**

Run: `npm run build && npm test && npm run check`
Expected: PASS — `npm run build` succeeds (no dangling import of `./gnome/deploy`), the removed `gnomeDeploy.test.ts` no longer runs, and `helperInstall.test.ts` passes.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(electron): install GNOME helper from EGO, remove bundled deploy path

Drops deploy.ts + its asset staging and the log-out dialog. On GNOME, prompt the
user and install loft-shell-helper@loft.chat via InstallRemoteExtension; SNI
fallback otherwise.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: electron-builder deb/rpm/AppImage + version 1.0.0

Add the rpm target and desktop metadata; bump the version. (Flatpak is NOT an electron-builder target here — Task 6 owns it.)

**Files:**
- Modify: `electron/electron-builder.yml`
- Modify: `electron/package.json`

- [ ] **Step 1: Bump the version**

In `electron/package.json`, set:
```json
  "version": "1.0.0",
```

- [ ] **Step 2: Add `rpm` + `desktop.entry` to `electron/electron-builder.yml`**

Set the `linux:` block to:
```yaml
linux:
  target:
    - deb
    - rpm
    - AppImage
  category: Network
  icon: build/icon.png
  maintainer: Keith Vassallo <keith@icemalta.com>
  synopsis: Desktop integration for messaging web apps on Linux
  description: >-
    Loft gives WhatsApp, Facebook Messenger, Slack, Telegram, Element, and
    NextCloud Talk a dedicated place on your Linux desktop — voice and video
    calling, tray icons, unread badges, notifications, and close-to-tray, with
    native GNOME and KDE Plasma integration.
  desktop:
    entry:
      StartupWMClass: chat.loft.Loft
      Categories: Network;InstantMessaging;Chat;
      Keywords: WhatsApp;Messenger;Slack;Telegram;Element;Chat;
```
(`desktop` is electron-builder 26's `LinuxDesktopFile` — a nested `entry` map, verified against `linuxOptions.ts`. `rpm` is a valid `target`.)

- [ ] **Step 3: Verify the config parses and the AppImage builds locally (the one format that builds on Fedora)**

Run: `npm run build && npx electron-builder --linux AppImage`
Expected: `dist-electron/Loft-1.0.0.AppImage` (or similar) is produced; no schema errors about `desktop`/`rpm`. (Do NOT attempt deb/rpm locally on Fedora — the vendored fpm needs libcrypt.so.1; those build on CI in Task 7.)

- [ ] **Step 4: Smoke-launch the AppImage**

Run: `./dist-electron/Loft-1.0.0.AppImage &` then confirm the hub window opens; then quit it.
Expected: hub opens (proves the packaged app runs). Note: `desktopExec()` returns `$APPIMAGE` inside an AppImage run — this is the exec path validated in Task 5's exec-path test.

- [ ] **Step 5: Commit**

```bash
git add electron/electron-builder.yml electron/package.json
git commit -m "build(electron): add rpm target + desktop metadata, bump to 1.0.0

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: AppStream metainfo + desktop file + CHANGELOG (+ exec-path test)

Rewrite the now-false metainfo description, add the 1.0.0 release with the migration note, add StartupWMClass to the desktop file, update CHANGELOG, and lock the `desktopExec` branches with a test.

**Files:**
- Modify: `data/chat.loft.Loft.metainfo.xml`
- Modify: `data/chat.loft.Loft.desktop`
- Modify: `CHANGELOG.md`
- Test: `electron/tests/desktopExec.test.ts`

- [ ] **Step 1: Write the failing exec-path test**

Create `electron/tests/desktopExec.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { desktopExec } from '../src/main/desktop';

describe('desktopExec', () => {
  it('uses the AppImage path when $APPIMAGE is set', () => {
    expect(desktopExec({ env: { APPIMAGE: '/home/u/Loft.AppImage' } as NodeJS.ProcessEnv }))
      .toBe('/home/u/Loft.AppImage');
  });

  it('uses `flatpak run chat.loft.Loft` under Flatpak', () => {
    expect(desktopExec({ env: { FLATPAK_ID: 'chat.loft.Loft' } as NodeJS.ProcessEnv }))
      .toBe('flatpak run chat.loft.Loft');
  });

  it('uses the given execPath for a packaged/native run', () => {
    expect(desktopExec({ env: {} as NodeJS.ProcessEnv, execPath: '/opt/Loft/loft' }))
      .toBe('/opt/Loft/loft');
  });
});
```

- [ ] **Step 2: Run it to verify it passes (regression lock, not new code)**

Run: `npx vitest run tests/desktopExec.test.ts`
Expected: PASS — `desktopExec` already implements these branches (`desktop.ts`). This test pins the exec-path contract that the packages depend on. (If any assertion fails, the packaging exec paths are wrong — stop and reconcile before shipping.)

- [ ] **Step 3: Rewrite the `<description>` in `data/chat.loft.Loft.metainfo.xml`**

Replace the entire `<description>…</description>` block with:
```xml
  <description>
    <p>
      Loft gives your favourite messaging web apps a proper place on your Linux
      desktop. WhatsApp, Facebook Messenger, Slack, Telegram, Element (Matrix),
      and NextCloud Talk each run in their own dedicated window — with full voice
      and video calling, system tray icons, unread badge counts, desktop
      notifications, and close-to-tray behaviour.
    </p>
    <p>
      Loft integrates natively with both GNOME and KDE Plasma: window show/hide
      and focus, panel or tray icons with per-service Do Not Disturb, and
      notifications that take you straight to the conversation.
    </p>
  </description>
```

- [ ] **Step 4: Add the 1.0.0 `<release>` entry (top of `<releases>`, before 0.2.0)**

```xml
    <release version="1.0.0" date="YYYY-MM-DD">
      <description>
        <p>
          A ground-up rewrite. Loft is now a single self-contained application —
          it no longer needs a separate Google Chrome installation — with the same
          full voice and video calling, and improved GNOME and KDE Plasma integration.
        </p>
        <p>
          One-time change: you'll need to sign in to each service again after
          upgrading, as logins are no longer shared with Chrome.
        </p>
      </description>
    </release>
```
(Leave the `date` as `YYYY-MM-DD`; it is stamped at release. The `Date.now()`/`new Date()` restriction is a workflow-runtime concern, not a file-content one — a human/release step fills the real date.)

- [ ] **Step 5: Add `StartupWMClass` to `data/chat.loft.Loft.desktop`**

Add this line (e.g. after `Icon=chat.loft.Loft`):
```
StartupWMClass=chat.loft.Loft
```

- [ ] **Step 6: Add the 1.0.0 entry to `CHANGELOG.md` (above `## [0.2.0]`)**

```markdown
## [1.0.0] - YYYY-MM-DD

### Changed

- Loft is now a single self-contained application and no longer launches or depends on a separate Google Chrome installation. Voice and video calling, tray icons, badges, notifications, and close-to-tray all work as before, with improved GNOME and KDE Plasma integration.
- The GNOME Shell helper is now installed from extensions.gnome.org on request (Loft asks first) instead of being bundled, so it updates independently of the app and no longer requires logging out to finish an update.

### Note

- **You'll need to sign in to each service again after upgrading.** Logins were previously stored in Chrome's profile; Loft now keeps its own per-service sessions.
```

- [ ] **Step 7: Validate the metainfo (best-effort — CI enforces it in Task 7)**

Run: `appstreamcli validate data/chat.loft.Loft.metainfo.xml || echo "appstreamcli not installed — CI validates"`
Expected: `Validation was successful` OR the fallback note. If validation reports real errors (not just the missing-`date` info), fix them.

- [ ] **Step 8: Commit**

```bash
git add data/chat.loft.Loft.metainfo.xml data/chat.loft.Loft.desktop CHANGELOG.md electron/tests/desktopExec.test.ts
git commit -m "docs(electron): 1.0.0 AppStream/desktop/CHANGELOG + exec-path test

Rewrite the now-false Chrome-based description, add the 1.0.0 release with the
re-login migration note, add StartupWMClass, and pin desktopExec branches.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Flatpak manifest built from source (FriendlyHub + standalone bundle)

Replace the Rust-era root manifest with an Electron one that builds from source using Node offline sources, on the Electron base app with zypak. **This is an integration task with a build-and-verify loop** — the exact `flatpak-node-generator` invocation and Electron base-app/runtime versions are version-sensitive and must be verified live (spec §6). Iterate `flatpak-builder` until it builds and the hub launches.

**Files:**
- Modify: `chat.loft.Loft.yml` (repo root)
- Create: `flatpak/generated-sources.json`, `flatpak/loft-launcher.sh`, `flatpak/README.md`

**Prerequisites (local, Fedora has flatpak):**
```bash
flatpak install -y flathub org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08 \
  org.electronjs.Electron2.BaseApp//24.08 org.freedesktop.Sdk.Extension.node22//24.08
```
Verify these exact branches exist (`flatpak remote-ls flathub | grep -E "Electron2.BaseApp|Sdk.Extension.node"`); if `24.08` is not the current pairing, use the current freedesktop runtime version consistently across runtime/sdk/base-app/node-extension and record it in `flatpak/README.md`.

- [ ] **Step 1: Verify the toolchain and Electron/runtime versions (write findings into `flatpak/README.md`)**

Run and record actual values:
```bash
flatpak-node-generator --version   # from flatpak-builder-tools; pipx install flatpak-node-generator if absent
flatpak remote-ls flathub | grep -E "org.electronjs.Electron2.BaseApp|Sdk.Extension.node2" | sort -u
node -e "console.log(require('./electron/node_modules/electron/package.json').version)"  # Electron major → confirms zypak/base-app compat
```
Create `flatpak/README.md` documenting: the chosen runtime version, base-app branch, node SDK extension, and the FriendlyHub upload steps (upload `chat.loft.Loft.yml` + `flatpak/generated-sources.json`; FriendlyHub builds x86_64 + aarch64).

- [ ] **Step 2: Generate the Node offline sources for both arches**

Run (from `electron/`):
```bash
flatpak-node-generator npm package-lock.json -o ../flatpak/generated-sources.json --electron-node-headers
```
If Electron binary zips are missing for aarch64 (the common failure), add them explicitly per the flatpak-builder-tools electron guidance (pin the Electron version and add its `electron-v<ver>-linux-{x64,arm64}.zip` as extra `file` sources with sha256). Record the exact final command in `flatpak/README.md`.
Expected: `flatpak/generated-sources.json` exists and contains npm tarball + Electron binary sources.

- [ ] **Step 3: Write the zypak launcher `flatpak/loft-launcher.sh`**

```sh
#!/bin/sh
# Launch the packaged Electron app under zypak (sandboxed Chromium needs it).
exec zypak-wrapper /app/main/node_modules/electron/dist/electron /app/main "$@"
```
(Adjust the electron binary path if Step 5's install layout differs; verify in Step 6.)

- [ ] **Step 4: Write the manifest `chat.loft.Loft.yml` (repo root)**

```yaml
app-id: chat.loft.Loft
runtime: org.freedesktop.Platform
runtime-version: '24.08'
sdk: org.freedesktop.Sdk
base: org.electronjs.Electron2.BaseApp
base-version: '24.08'
sdk-extensions:
  - org.freedesktop.Sdk.Extension.node22
command: loft

finish-args:
  - --share=ipc
  - --socket=fallback-x11
  - --socket=wayland
  - --share=network
  - --device=dri
  - --talk-name=org.kde.StatusNotifierWatcher
  - --talk-name=org.kde.KWin
  - --talk-name=org.freedesktop.Notifications
  - --talk-name=org.gnome.Shell.Extensions
  - --talk-name=org.freedesktop.portal.Desktop
  - --own-name=chat.loft.*
  - --filesystem=xdg-config/autostart:create
  - --filesystem=xdg-data/applications:create

build-options:
  append-path: /usr/lib/sdk/node22/bin
  env:
    npm_config_nodedir: /usr/lib/sdk/node22

modules:
  - name: loft
    buildsystem: simple
    build-options:
      env:
        XDG_CACHE_HOME: /run/build/loft/flatpak-node/cache
        npm_config_offline: 'true'
    build-commands:
      - cd electron && npm ci --offline
      - cd electron && npm run build
      - mkdir -p /app/main
      - cp -r electron/dist electron/package.json electron/node_modules /app/main/
      - install -Dm755 flatpak/loft-launcher.sh /app/bin/loft
      - install -Dm644 data/chat.loft.Loft.desktop /app/share/applications/chat.loft.Loft.desktop
      - install -Dm644 data/chat.loft.Loft.metainfo.xml /app/share/metainfo/chat.loft.Loft.metainfo.xml
      - install -Dm644 electron/build/icon.png /app/share/icons/hicolor/512x512/apps/chat.loft.Loft.png
    sources:
      - type: dir
        path: .
      - generated-sources.json
```
Note: `generated-sources.json` in `sources` resolves relative to the manifest dir — if you keep it under `flatpak/`, reference `flatpak/generated-sources.json` or move the manifest into `flatpak/`. Decide layout at implementation and keep `data/` paths consistent; record it in `flatpak/README.md`.

- [ ] **Step 5: Build the Flatpak locally and iterate until it succeeds**

Run (from repo root):
```bash
flatpak-builder --force-clean --user --install --repo=.flatpak-repo build-dir chat.loft.Loft.yml
```
Expected: builds without network (offline npm), installs `chat.loft.Loft`. Common iterations: fix the electron binary path in the launcher (Step 3); add missing node sources (Step 2); adjust `append-path`/`npm_config_nodedir` for the node extension. **Do not proceed until it builds.**

- [ ] **Step 6: Launch it and confirm the hub opens**

Run: `flatpak run chat.loft.Loft`
Expected: the hub window opens. (Full DE integration is validated by Keith later; here we only prove the sandboxed app runs and the manifest is correct.) If it fails to launch, the launcher/zypak path is wrong — fix Step 3 and rebuild.

- [ ] **Step 7: Produce the standalone `.flatpak` bundle**

Run (from repo root):
```bash
flatpak build-bundle .flatpak-repo Loft-1.0.0.flatpak chat.loft.Loft
```
Expected: `Loft-1.0.0.flatpak` produced (this is the GitHub Releases artifact; CI reproduces it in Task 7).

- [ ] **Step 8: Add build artifacts to `.gitignore` and commit the manifest**

Ensure `build-dir/`, `.flatpak-repo/`, `*.flatpak` are gitignored (repo root `.gitignore`).
```bash
git add chat.loft.Loft.yml flatpak/ .gitignore
git commit -m "build(flatpak): from-source Electron manifest + node offline sources

flatpak-builder manifest on org.electronjs.Electron2.BaseApp + zypak, built from
source with flatpak-node-generator sources (dual-arch for FriendlyHub). Tight
finish-args: no flatpak-spawn escape, no --filesystem=home.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: CI release workflow

Generalise the Stage 4.5 preview workflow into a release workflow: build all four formats on a tag (or manual dispatch) and publish to the tag's GitHub Release; validate the metainfo.

**Files:**
- Rename/replace: `.github/workflows/kde-preview.yml` → `.github/workflows/release.yml`

- [ ] **Step 1: Write `.github/workflows/release.yml`**

```yaml
name: release
on:
  push:
    tags: ['v*']
  workflow_dispatch:
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '22'

      - name: Install packaging tooling
        run: |
          sudo apt-get update
          sudo apt-get install -y rpm appstream flatpak flatpak-builder
          pipx install flatpak-node-generator || pip install --user flatpak-node-generator

      - name: Validate AppStream metainfo
        run: appstreamcli validate --no-net data/chat.loft.Loft.metainfo.xml

      - name: Install, test, build (electron)
        working-directory: electron
        run: |
          npm ci
          npm test
          npm run check
          npm run build

      - name: Package deb/rpm/AppImage
        working-directory: electron
        run: npx electron-builder --linux deb rpm AppImage

      - name: Set up Flatpak runtimes
        run: |
          flatpak remote-add --if-not-exists --user flathub https://flathub.org/repo/flathub.flatpakrepo
          flatpak install -y --user flathub org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08 \
            org.electronjs.Electron2.BaseApp//24.08 org.freedesktop.Sdk.Extension.node22//24.08

      - name: Build Flatpak bundle
        run: |
          flatpak-builder --user --force-clean --repo=.flatpak-repo build-dir chat.loft.Loft.yml
          flatpak build-bundle .flatpak-repo Loft.flatpak chat.loft.Loft

      - name: Publish release
        uses: softprops/action-gh-release@v3
        with:
          tag_name: ${{ github.ref_type == 'tag' && github.ref_name || 'preview' }}
          name: ${{ github.ref_type == 'tag' && github.ref_name || 'Preview build' }}
          prerelease: ${{ github.ref_type != 'tag' }}
          files: |
            electron/dist-electron/*.deb
            electron/dist-electron/*.rpm
            electron/dist-electron/*.AppImage
            Loft.flatpak
```
(Pin the Flatpak runtime versions to whatever Task 6 recorded in `flatpak/README.md`. If `flatpak-node-generator` must run in CI to regenerate sources, add that step before the Flatpak build; otherwise the committed `flatpak/generated-sources.json` is used.)

- [ ] **Step 2: Remove the old preview workflow**

```bash
git rm .github/workflows/kde-preview.yml
```

- [ ] **Step 3: Validate the workflow YAML locally**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))" && echo OK`
Expected: `OK` (well-formed YAML).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(electron): release workflow — build deb/rpm/AppImage/Flatpak on tag

Replaces the kde-preview workflow. Validates metainfo, runs the gates, builds all
four formats (electron-builder + flatpak-builder bundle), publishes to the tag's
GitHub Release (or a rolling 'preview' pre-release on manual dispatch).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Trigger a dispatch run and confirm artifacts (needs push + Actions)**

After the branch is pushed, run: `gh workflow run release.yml --ref electron-rewrite`
Then watch: `gh run watch $(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')`
Expected: the run succeeds and the `preview` pre-release has `.deb`, `.rpm`, `.AppImage`, `.flatpak` assets. Iterate on any CI-only failures (rpm tooling, flatpak runtime versions, node-sources) until green. This is the real integration proof for Tasks 4 & 6.

---

## Self-Review

**Spec coverage:**
- §3 Task 0 revert → **Task 1** (survivors) + **Task 3** (removes the doomed `-next` refs with `deploy.ts`/`index.ts` block). ✓
- §4 electron-builder deb/rpm/AppImage + version → **Task 4**. ✓
- §5 EGO-install-prompt, remove bundle-deploy, symbolic-icon fallback (option a), D-Bus stability contract → **Task 2 + Task 3** (module, wire-in, deletions; `installSymbolicIcon` = option a). ✓ EGO-publish dependency is Keith-external (documented in `flatpak/README.md`/handoff, not a code task).
- §6 Flatpak from-source manifest + node sources + tight finish-args + install metainfo/desktop/icon → **Task 6**. ✓
- §7 autostart/`.desktop` exec-path per format → **Task 5** exec-path test (the branches already exist in `desktop.ts`; the packages consume them). ✓
- §8 metainfo rewrite + 1.0.0 + migration note + `appstreamcli validate` → **Task 5** + CI validate in **Task 7**. ✓
- §9 CI release workflow → **Task 7**. ✓
- §10 testing (unit + manual matrix) → unit in Tasks 2/5; manual matrix is Keith's post-build validation (documented in the spec/handoff). ✓

**Placeholder scan:** The only literal `YYYY-MM-DD` placeholders (metainfo `<release>` date, CHANGELOG date) are release-time stamps by design, explicitly noted as such — not plan gaps. Task 6's "verify and record actual values" steps are genuine integration verification (version-sensitive tooling per spec §6), each with a concrete command and a fallback, not vague hand-waving.

**Type consistency:** `HelperInstallDeps` (Task 2) — `getExtensionInfo`/`installRemoteExtension`/`prompt`/`installSymbolicIcon` — is consumed identically by the test (Task 2) and `defaultHelperInstallDeps` (Task 2), and `ensureGnomeHelper`/`defaultHelperInstallDeps` are imported with matching names in `index.ts` (Task 3). `HELPER_UUID` is the canonical `loft-shell-helper@loft.chat` matching Task 1's reverted metadata. The `chat.loft.ShellHelper` name/path in `shellHelper.ts` (Task 1) matches `extension.js` `DBUS_NAME`/`DBUS_PATH` (Task 1). `desktopExec` signature in the Task 5 test matches `desktop.ts`. ✓
