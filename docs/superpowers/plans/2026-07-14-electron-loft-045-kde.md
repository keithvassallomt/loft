# Electron Loft — Stage 4.5: KDE support + VM test delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Electron Loft app KDE window focus/hide (KWin scripting, title-keyed) + Plasma system-DND detection, and a minimal `.deb`/AppImage packaging + a manually-triggered GitHub Actions job that publishes builds to a rolling `kde-preview` pre-release the Kubuntu VM downloads from.

**Architecture:** KWin focus/hide ports the Rust `kwin.rs` D-Bus dance to `dbus-next`, matching windows by title (all windows share one WM_CLASS). Plasma DND watches the `Inhibited` property on `org.freedesktop.Notifications`. The system-DND deps seam is refactored to booleans so GNOME and KDE both fit. electron-builder produces the artifacts; a `workflow_dispatch` CI job builds on an Ubuntu runner and attaches them to a reused pre-release.

**Tech Stack:** Electron 43, TypeScript (main via `tsc`, preloads via esbuild, hub via Vite), `dbus-next@0.10.2`, Vitest 4, electron-builder 26, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-14-electron-loft-045-kde-design.md`.

## Global Constraints

- **All code under `electron/`** (except `.github/workflows/`). Branch `electron-rewrite`. Run npm commands from `electron/`.
- **Target Plasma 6** (Keith's VM is 6.6/6.7): KWin JS uses `workspace.windowList()` / `workspace.activeWindow` and **feature-detects Plasma 5** (`clientList()` / `activeClient`).
- **Versions (verified 2026-07-14):** `electron-builder@^26.15.3`. CI actions: `actions/checkout@v7`, `actions/setup-node@v7` (Node 22), `softprops/action-gh-release@v3`.
- **KWin D-Bus** (dest `org.kde.KWin`): `/Scripting` iface `org.kde.kwin.Scripting` — `unloadScript(s)`, `loadScript(ss)→i (int32 scriptId)`; then `run()` (no args) on path `/Scripting/Script<scriptId>` iface `org.kde.kwin.Script`; ~120 ms delay; `unloadScript(s)` again. Plugin names `loft-show` / `loft-hide`. Temp script file in `os.tmpdir()`. **Never-throw**, fire-and-forget (mirrors `gnome/shellHelper.ts`).
- **KWin match key = window title:** `caption === key || caption.startsWith(key + ' (')`, key = `def.displayName` (same keying as the GNOME helper).
- **KDE DND** (bus `org.freedesktop.Notifications`, path `/org/freedesktop/Notifications`): boolean property **`Inhibited`** — DND is `Inhibited` **directly** (no negation). Watch via `org.freedesktop.DBus.Properties` `PropertiesChanged`.
- **`dbus-next@0.10.2` API** (verified in code): `dbus.sessionBus()`; low-level `bus.call(new dbus.Message({destination,path,interface,member,signature?,body?})): Promise<Message>` with reply args in `reply.body`; `bus.getProxyObject(name,path)` → `obj.getInterface(iface)` whose methods return values and whose signals re-emit via `.on(signal, cb)`.
- **electron-builder:** appId `chat.loft.Loft`, linux targets `deb` + `AppImage`, icon `build/icon.png` (≥256²), output `dist-electron/`. `dbus-next` is pure JS (no native rebuild). `svelte`/`vite`/`electron` are devDeps (not shipped).
- **CI:** `workflow_dispatch` only; publishes to a rolling pre-release **tag `kde-preview`**.
- **Test runner:** `npx vitest run tests/<file>.test.ts` (one file); `npm test` (all). Build: `npm run build`. Package: `npm run dist`.

---

## File structure

**New:**
- `electron/electron-builder.yml` — packaging config.
- `electron/build/icon.png` — 512² app icon (committed; CI needs it).
- `.github/workflows/kde-preview.yml` — CI build → `kde-preview` pre-release.
- `electron/src/main/kde/kwin.ts` — **replaces the stub**: `buildKwinScript` (pure) + real `createKwinClient`.
- `electron/tests/kde.test.ts` — `isKde` + `buildKwinScript`.
- `electron/tests/kwinClient.test.ts` — `createKwinClient` (mocked `dbus-next`).

**Modified:**
- `electron/package.json` — `electron-builder` devDep, `dist` script, `author`/`description`.
- `electron/.gitignore` — ignore `dist-electron/`.
- `electron/src/main/trayBackend.ts` — add `isKde(env)`.
- `electron/src/main/notifications/systemDnd.ts` — boolean deps seam + `kdeDeps` + `defaultSystemDndDeps`.
- `electron/tests/systemDnd.test.ts` — updated for the new deps shape.
- `electron/src/main/index.ts` — build KWin client, `focusExternal`/`hideExternal`, replace 4 call sites.

---

### Task 1: electron-builder packaging — prove the build pipeline

De-risks the whole VM approach first: get `npm run dist` producing a `.deb` + AppImage on the current code, before layering KDE.

**Files:**
- Create: `electron/electron-builder.yml`, `electron/build/icon.png`
- Modify: `electron/package.json`, `electron/.gitignore`

**Interfaces:**
- Produces: `npm run dist` → `electron/dist-electron/*.deb` + `electron/dist-electron/*.AppImage`.

- [ ] **Step 1: Install electron-builder**

Run (from `electron/`):
```bash
npm install --save-dev electron-builder@^26.15.3
```

- [ ] **Step 2: Generate the 512² icon**

electron-builder requires a Linux icon ≥256². The bundled `assets/loft.png` is 128². Upscale it (reliable; no SVG delegate needed):
```bash
mkdir -p build
magick assets/loft.png -resize 512x512 build/icon.png
```
Verify: `file build/icon.png` reports `512 x 512`. (A crisper icon from `../assets/icons/loft.svg` is a Stage-5 nicety; the upscale is fine for a test build.)

- [ ] **Step 3: Create `electron/electron-builder.yml`**

```yaml
appId: chat.loft.Loft
productName: Loft
copyright: Copyright © 2026 Keith Vassallo
directories:
  output: dist-electron
  buildResources: build
files:
  - dist/**
  - package.json
linux:
  target:
    - deb
    - AppImage
  category: Network
  icon: build/icon.png
  maintainer: Keith Vassallo <keith@icemalta.com>
  synopsis: Desktop integration for messaging web apps on Linux
```

- [ ] **Step 4: Add `author`/`description` + the `dist` script to `package.json`**

electron-builder's `deb` maintainer derivation and metadata need `author` + `description`. Add these top-level keys (if absent):
```json
  "description": "Desktop integration for messaging web apps on Linux",
  "author": "Keith Vassallo <keith@icemalta.com>",
```
And add to `scripts`:
```json
    "dist": "npm run build && electron-builder --linux",
```

- [ ] **Step 5: Ignore the build output**

Append to `electron/.gitignore` (create the file if it doesn't exist):
```
dist-electron/
```

- [ ] **Step 6: Build the artifacts**

Run:
```bash
npm run dist
```
Expected: electron-builder downloads Electron on first run, then writes `dist-electron/Loft-0.3.0-dev.AppImage` (or similar) and `dist-electron/loft_0.3.0-dev_amd64.deb`. Confirm:
```bash
ls -1 dist-electron/*.AppImage dist-electron/*.deb
```
Both must exist and `npm run dist` must exit 0. (If the environment blocks Electron/appimagetool downloads, report it as a concern — CI in Task 2 is the authoritative build — but do not fake success.)

- [ ] **Step 7: Commit**

```bash
git add electron/package.json electron/package-lock.json electron/electron-builder.yml electron/build/icon.png electron/.gitignore
git commit -m "build(electron): electron-builder config (.deb + AppImage) + npm run dist"
```

---

### Task 2: CI workflow — build on demand, publish to `kde-preview`

**Files:**
- Create: `.github/workflows/kde-preview.yml`

**Interfaces:**
- Consumes: the `dist` script (Task 1).
- Produces: a `workflow_dispatch` job attaching `.deb` + `.AppImage` to the rolling `kde-preview` pre-release.

- [ ] **Step 1: Create `.github/workflows/kde-preview.yml`**

```yaml
name: kde-preview
on:
  workflow_dispatch:
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: electron
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '22'
      - name: Install dependencies
        run: npm ci
      - name: Build .deb + AppImage
        run: npm run dist
      - name: Publish to the kde-preview pre-release
        uses: softprops/action-gh-release@v3
        with:
          tag_name: kde-preview
          name: KDE preview build
          body: >-
            Rolling pre-release for KDE testing (Stage 4.5). Latest build of the
            electron-rewrite branch. Not a real release.
          prerelease: true
          files: |
            electron/dist-electron/*.deb
            electron/dist-electron/*.AppImage
```
Notes: `action-gh-release` reuses the `kde-preview` tag and replaces its assets each run. `files` paths are repo-root-relative (not affected by `defaults.run.working-directory`). `GITHUB_TOKEN` with `contents: write` authorizes the upload automatically.

- [ ] **Step 2: Validate the YAML**

Run (from repo root):
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/kde-preview.yml')); print('valid yaml')"
```
Expected: `valid yaml`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/kde-preview.yml
git commit -m "ci: kde-preview workflow — build .deb + AppImage, publish to a rolling pre-release"
```

(The first real run is triggered by the controller with `gh workflow run kde-preview.yml --ref electron-rewrite` after the branch has the file — that is the authoritative verification.)

---

### Task 3: `isKde()` + `buildKwinScript()` — pure helpers

**Files:**
- Modify: `electron/src/main/trayBackend.ts` (add `isKde`)
- Modify: `electron/src/main/kde/kwin.ts` (add `buildKwinScript`; leave the stub `createKwinClient` for Task 4)
- Test: `electron/tests/kde.test.ts`

**Interfaces:**
- Produces:
  - `isKde(env: NodeJS.ProcessEnv): boolean` — true when `XDG_CURRENT_DESKTOP` has a colon-token equal (case-insensitive) to `KDE`.
  - `buildKwinScript(action: 'show' | 'hide', key: string): string` — the KWin JS that finds the window whose caption matches `key` (prefix rule) and applies the show/hide property changes; Plasma 6 with a Plasma 5 fallback; `key` safely embedded via `JSON.stringify`.

- [ ] **Step 1: Write the failing test — `electron/tests/kde.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { isKde } from '../src/main/trayBackend';
import { buildKwinScript } from '../src/main/kde/kwin';

describe('isKde', () => {
  it('detects KDE tokens case-insensitively', () => {
    expect(isKde({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe(true);
    expect(isKde({ XDG_CURRENT_DESKTOP: 'plasma:KDE' })).toBe(true);
    expect(isKde({ XDG_CURRENT_DESKTOP: 'kde' })).toBe(true);
  });
  it('is false for GNOME / empty', () => {
    expect(isKde({ XDG_CURRENT_DESKTOP: 'GNOME' })).toBe(false);
    expect(isKde({})).toBe(false);
  });
});

describe('buildKwinScript', () => {
  it('matches by caption prefix and feature-detects Plasma 6/5', () => {
    const js = buildKwinScript('show', 'Messenger');
    expect(js).toContain('workspace.windowList');   // Plasma 6
    expect(js).toContain('workspace.clientList');    // Plasma 5 fallback
    expect(js).toContain('"activeWindow" in workspace');
    expect(js).toContain('w.caption === "Messenger"');
    // the builder emits the key literal concatenated with " (" — not a pre-joined literal
    expect(js).toContain('w.caption.indexOf("Messenger" + " (") === 0');
  });
  it('show restores + activates; hide minimizes + skips taskbar', () => {
    const show = buildKwinScript('show', 'A');
    expect(show).toContain('w.skipTaskbar = false');
    expect(show).toContain('w.minimized = false');
    expect(show).toContain('workspace.activeWindow = w');
    const hide = buildKwinScript('hide', 'A');
    expect(hide).toContain('w.skipTaskbar = true');
    expect(hide).toContain('w.minimized = true');
    expect(hide).not.toContain('activeWindow = w');
  });
  it('escapes keys with quotes safely', () => {
    const js = buildKwinScript('show', 'We"ird');
    expect(js).toContain('w.caption === "We\\"ird"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/kde.test.ts`
Expected: FAIL — `isKde` not exported / `buildKwinScript` not exported.

- [ ] **Step 3: Add `isKde` to `electron/src/main/trayBackend.ts`**

Add after `isGnome`:
```ts
/** True when XDG_CURRENT_DESKTOP contains a colon-separated token equal (case-insensitive) to KDE. */
export function isKde(env: NodeJS.ProcessEnv): boolean {
  const desktop = env.XDG_CURRENT_DESKTOP ?? '';
  return desktop.split(':').some((d) => d.toLowerCase() === 'kde');
}
```

- [ ] **Step 4: Add `buildKwinScript` to `electron/src/main/kde/kwin.ts`**

At the top of the file (keep the existing `KwinClient` interface + stub `createKwinClient` for now), add:
```ts
/**
 * KWin scripting JS that finds the Loft window whose caption matches `key`
 * (exact, or "<key> (N)") and shows or hides it. Plasma 6 primary
 * (workspace.windowList / activeWindow); Plasma 5 fallback (clientList /
 * activeClient). `key` is JSON-escaped so titles with quotes/spaces are safe.
 */
export function buildKwinScript(action: 'show' | 'hide', key: string): string {
  const k = JSON.stringify(key); // yields a safely-quoted JS string literal
  const body =
    action === 'show'
      ? `w.skipTaskbar = false; w.minimized = false;
      if ("activeWindow" in workspace) workspace.activeWindow = w; else workspace.activeClient = w;`
      : `w.skipTaskbar = true; w.minimized = true;`;
  return `var list = (typeof workspace.windowList === 'function')
  ? workspace.windowList()
  : workspace.clientList();
for (var i = 0; i < list.length; i++) {
  var w = list[i];
  if (w.caption === ${k} || w.caption.indexOf(${k} + " (") === 0) {
    ${body}
    break;
  }
}
`;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/kde.test.ts`
Expected: PASS. Then `npm test` to confirm the suite is still green.

- [ ] **Step 6: Commit**

```bash
git add src/main/trayBackend.ts src/main/kde/kwin.ts tests/kde.test.ts
git commit -m "feat(electron): isKde() + buildKwinScript() (pure KDE helpers)"
```

---

### Task 4: `createKwinClient()` — the KWin D-Bus dance

**Files:**
- Modify: `electron/src/main/kde/kwin.ts` (replace the stub `createKwinClient`)
- Test: `electron/tests/kwinClient.test.ts`

**Interfaces:**
- Consumes: `buildKwinScript` (Task 3), `dbus-next`.
- Produces: `createKwinClient(): KwinClient` where `KwinClient` is the existing `{ focusWindow(key): Promise<void>; hideWindow(key): Promise<void> }`. Never-throws; the factory never touches the bus (lazy), so it can't throw at construction.

- [ ] **Step 1: Write the failing test — `electron/tests/kwinClient.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: Array<{ member: string; path: string; interface: string; body?: unknown[] }> = [];
let failCall = false;

vi.mock('dbus-next', () => {
  class Message {
    member!: string; path!: string; interface!: string; body?: unknown[];
    constructor(o: Record<string, unknown>) { Object.assign(this, o); }
  }
  const bus = {
    call: vi.fn((msg: Message) => {
      sent.push({ member: msg.member, path: msg.path, interface: msg.interface, body: msg.body });
      if (failCall) return Promise.reject(new Error('no kwin'));
      if (msg.member === 'loadScript') return Promise.resolve({ body: [7] });
      return Promise.resolve({ body: [] });
    }),
  };
  return { sessionBus: () => bus, Message };
});

import { createKwinClient } from '../src/main/kde/kwin';

beforeEach(() => { sent.length = 0; failCall = false; });

describe('createKwinClient', () => {
  it('runs unloadScript → loadScript → run(/Scripting/Script<id>) → unloadScript', async () => {
    await createKwinClient().focusWindow('Messenger');
    const members = sent.map((m) => m.member);
    expect(members).toEqual(['unloadScript', 'loadScript', 'run', 'unloadScript']);
    const run = sent.find((m) => m.member === 'run')!;
    expect(run.path).toBe('/Scripting/Script7');
    expect(run.interface).toBe('org.kde.kwin.Script');
    const load = sent.find((m) => m.member === 'loadScript')!;
    expect(load.body?.[1]).toBe('loft-show'); // plugin name for focus
  });

  it('hideWindow uses the loft-hide plugin', async () => {
    await createKwinClient().hideWindow('Messenger');
    const load = sent.find((m) => m.member === 'loadScript')!;
    expect(load.body?.[1]).toBe('loft-hide');
  });

  it('never throws when the bus call fails', async () => {
    failCall = true;
    await expect(createKwinClient().focusWindow('X')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/kwinClient.test.ts`
Expected: FAIL — the stub `createKwinClient` returns no-op methods that don't call the bus, so the sequence assertions fail.

- [ ] **Step 3: Replace the stub in `electron/src/main/kde/kwin.ts`**

Replace the file's stub `createKwinClient` (keep the doc-comment header, the `KwinClient` interface, and `buildKwinScript`) with:
```ts
import * as dbus from 'dbus-next';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const KWIN = 'org.kde.KWin';

/** Real KWin client: focus/hide the Loft window whose caption matches `key`. Never throws. */
export function createKwinClient(): KwinClient {
  let bus: ReturnType<typeof dbus.sessionBus> | null = null;
  const getBus = () => (bus ??= dbus.sessionBus());

  const call = (path: string, iface: string, member: string, signature: string | undefined, body: unknown[]) =>
    getBus().call(new dbus.Message({
      destination: KWIN, path, interface: iface, member,
      ...(signature ? { signature } : {}),
      ...(body.length ? { body } : {}),
    }));

  const runScript = async (action: 'show' | 'hide', key: string): Promise<void> => {
    const plugin = action === 'show' ? 'loft-show' : 'loft-hide';
    const path = join(tmpdir(), `${plugin}.js`);
    try {
      writeFileSync(path, buildKwinScript(action, key), 'utf8');
      // Clear any stale instance first (ignore errors).
      await call('/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', [plugin]).catch(() => {});
      const reply = await call('/Scripting', 'org.kde.kwin.Scripting', 'loadScript', 'ss', [path, plugin]);
      const id = (reply.body?.[0] as number) ?? 0;
      await call(`/Scripting/Script${id}`, 'org.kde.kwin.Script', 'run', undefined, []);
      await new Promise((r) => setTimeout(r, 120)); // let the script execute before unload
      await call('/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', [plugin]).catch(() => {});
    } catch (e) {
      console.debug(`KWin ${action} failed:`, (e as Error)?.message ?? e);
    }
  };

  return {
    focusWindow: (key) => runScript('show', key),
    hideWindow: (key) => runScript('hide', key),
  };
}
```
Add the `import * as dbus ...` etc. at the top of the file (with a one-line note like the shellHelper's: the `dbus-next@0.10.2` `Message`/`bus.call` API is verified in `gnome/shellHelper.ts`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/kwinClient.test.ts`
Expected: PASS (3 tests). Then `npm test` (full suite green) and `npm run build` (tsc clean).

- [ ] **Step 5: Commit**

```bash
git add src/main/kde/kwin.ts tests/kwinClient.test.ts
git commit -m "feat(electron): KWin scripting focus/hide client (title-keyed, never-throw)"
```

---

### Task 5: system-DND — boolean deps seam + `kdeDeps` + auto-select

**Files:**
- Modify: `electron/src/main/notifications/systemDnd.ts` (refactor)
- Modify: `electron/tests/systemDnd.test.ts` (update to the new deps shape)

**Interfaces:**
- Consumes: `isKde`/`isGnome` (`../trayBackend`), `dbus-next`.
- Produces:
  - `SystemDndDeps { current(): boolean | null; watch(onChange: (dnd: boolean) => void): { stop(): void } }` — `current()` is a best-effort sync snapshot (null if unknown for async backends); `watch` fires `onChange` on the initial value (possibly async) **and** every change.
  - `defaultSystemDndDeps(env): SystemDndDeps` — `kdeDeps()` on KDE, `gnomeDeps()` on GNOME, else a no-op.
  - `watchSystemDnd(onChange, deps?)` unchanged signature; default deps now `defaultSystemDndDeps(process.env)`.
  - `parseShowBanners` retained (gnomeDeps-internal + still tested).

- [ ] **Step 1: Rewrite the test — `electron/tests/systemDnd.test.ts`**

Replace the file with (keeps `parseShowBanners` coverage, drives `watchSystemDnd` via a fake deps, and checks selection):
```ts
import { describe, it, expect, vi } from 'vitest';
import { parseShowBanners, watchSystemDnd, defaultSystemDndDeps, type SystemDndDeps } from '../src/main/notifications/systemDnd';

describe('parseShowBanners', () => {
  it('parses gsettings get + monitor lines', () => {
    expect(parseShowBanners('true')).toBe(true);
    expect(parseShowBanners('false')).toBe(false);
    expect(parseShowBanners("  org.gnome.desktop.notifications show-banners: false")).toBe(false);
    expect(parseShowBanners('nonsense')).toBe(null);
  });
});

describe('watchSystemDnd', () => {
  function fakeDeps(initial: boolean | null): { deps: SystemDndDeps; emit: (v: boolean) => void; stopped: () => boolean } {
    let cb: (dnd: boolean) => void = () => {};
    let stopped = false;
    return {
      deps: { current: () => initial, watch: (onChange) => { cb = onChange; return { stop: () => { stopped = true; } }; } },
      emit: (v) => cb(v),
      stopped: () => stopped,
    };
  }
  it('seeds from current() and reports only real transitions', () => {
    const onChange = vi.fn();
    const f = fakeDeps(false);
    const w = watchSystemDnd(onChange, f.deps);
    expect(w.current()).toBe(false);
    f.emit(false);            // no transition
    expect(onChange).not.toHaveBeenCalled();
    f.emit(true);             // transition → dnd on
    expect(onChange).toHaveBeenCalledWith(true);
    expect(w.current()).toBe(true);
    w.stop();
    expect(f.stopped()).toBe(true);
  });
  it('treats unknown initial as not-DND and applies the first async value', () => {
    const onChange = vi.fn();
    const f = fakeDeps(null);
    const w = watchSystemDnd(onChange, f.deps);
    expect(w.current()).toBe(false);
    f.emit(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('defaultSystemDndDeps', () => {
  it('selects by desktop environment without throwing', () => {
    // We only assert it returns a usable deps object per env; the live gsettings/
    // D-Bus backends are exercised manually. current() must be callable + not throw.
    for (const env of [{ XDG_CURRENT_DESKTOP: 'KDE' }, { XDG_CURRENT_DESKTOP: 'GNOME' }, {}]) {
      const d = defaultSystemDndDeps(env);
      expect(typeof d.current).toBe('function');
      expect(typeof d.watch).toBe('function');
      expect(() => d.current()).not.toThrow();
    }
  });
});
```
Note: `defaultSystemDndDeps({XDG_CURRENT_DESKTOP:'GNOME'}).current()` calls `gsettings` via `execFileSync` — if gsettings is absent it returns null (caught), so the test is safe on any machine.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/systemDnd.test.ts`
Expected: FAIL — `defaultSystemDndDeps` not exported; `SystemDndDeps` shape changed.

- [ ] **Step 3: Rewrite `electron/src/main/notifications/systemDnd.ts`**

```ts
import { spawn, execFileSync } from 'node:child_process';
import * as dbus from 'dbus-next';
import { isGnome, isKde } from '../trayBackend';

const SCHEMA = 'org.gnome.desktop.notifications';
const KEY = 'show-banners';

/** Extract the show-banners boolean from `gsettings get`/`monitor` output; null if unparseable. */
export function parseShowBanners(text: string): boolean | null {
  const t = text.trim();
  if (/(^|:\s*)true$/.test(t) || t === 'true') return true;
  if (/(^|:\s*)false$/.test(t) || t === 'false') return false;
  return null;
}

export interface SystemDndDeps {
  /** Best-effort synchronous DND snapshot; null if not yet known (async backends). */
  current(): boolean | null;
  /** Fires on the initial value (possibly async) AND every change. Returns a stopper. */
  watch(onChange: (dnd: boolean) => void): { stop(): void };
}

export interface SystemDndWatcher { current(): boolean; stop(): void }

/** GNOME: gsettings show-banners → DND is the negation (banners off = DND on). */
function gnomeDeps(): SystemDndDeps {
  const read = (): boolean | null => {
    try {
      const b = parseShowBanners(execFileSync('gsettings', ['get', SCHEMA, KEY], { encoding: 'utf8' }));
      return b === null ? null : !b;
    } catch {
      return null;
    }
  };
  return {
    current: read,
    watch(onChange) {
      let child: ReturnType<typeof spawn> | null = null;
      try {
        child = spawn('gsettings', ['monitor', SCHEMA, KEY]);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          for (const line of chunk.split('\n')) {
            const b = parseShowBanners(line);
            if (b !== null) onChange(!b);
          }
        });
        child.on('error', () => {});
      } catch { /* gsettings missing */ }
      return { stop: () => child?.kill() };
    },
  };
}

/** KDE/Plasma: the Inhibited property on org.freedesktop.Notifications. DND = Inhibited directly. */
function kdeDeps(): SystemDndDeps {
  let cached: boolean | null = null;
  return {
    current: () => cached,
    watch(onChange) {
      let stopped = false;
      let cleanup = () => {};
      void (async () => {
        try {
          const bus = dbus.sessionBus();
          const obj = await bus.getProxyObject('org.freedesktop.Notifications', '/org/freedesktop/Notifications');
          const props = obj.getInterface('org.freedesktop.DBus.Properties') as unknown as {
            Get(iface: string, prop: string): Promise<{ value: unknown }>;
            on(ev: 'PropertiesChanged', cb: (iface: string, changed: Record<string, { value: unknown }>, invalidated: string[]) => void): void;
            off?(ev: 'PropertiesChanged', cb: (...a: unknown[]) => void): void;
          };
          const emit = (v: boolean) => { cached = v; if (!stopped) onChange(v); };
          try {
            const variant = await props.Get('org.freedesktop.Notifications', 'Inhibited');
            emit(Boolean(variant.value));
          } catch { /* property unavailable */ }
          const handler = (iface: string, changed: Record<string, { value: unknown }>) => {
            if (iface !== 'org.freedesktop.Notifications') return;
            const c = changed['Inhibited'];
            if (c) emit(Boolean(c.value));
          };
          props.on('PropertiesChanged', handler);
          cleanup = () => { try { props.off?.('PropertiesChanged', handler as never); } catch { /* ignore */ } };
        } catch (e) {
          console.debug('KDE system-DND watch unavailable:', (e as Error)?.message ?? e);
        }
      })();
      return { stop: () => { stopped = true; cleanup(); } };
    },
  };
}

const NOOP_DEPS: SystemDndDeps = { current: () => null, watch: () => ({ stop: () => {} }) };

/** Pick the DND backend for the current desktop (KDE → Plasma, GNOME → gsettings, else none). */
export function defaultSystemDndDeps(env: NodeJS.ProcessEnv): SystemDndDeps {
  if (isKde(env)) return kdeDeps();
  if (isGnome(env)) return gnomeDeps();
  return NOOP_DEPS;
}

export function watchSystemDnd(
  onChange: (dnd: boolean) => void,
  deps: SystemDndDeps = defaultSystemDndDeps(process.env),
): SystemDndWatcher {
  let dnd = deps.current() ?? false;
  const w = deps.watch((next) => {
    if (next !== dnd) { dnd = next; onChange(next); }
  });
  return { current: () => dnd, stop: () => w.stop() };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/systemDnd.test.ts`
Expected: PASS. Then `npm test` (full suite) and `npm run build` (tsc clean — `notifications/index.ts` still calls `watchSystemDnd((dnd)=>...)` with no deps arg, which now auto-selects; unchanged callsite).

- [ ] **Step 5: Commit**

```bash
git add src/main/notifications/systemDnd.ts tests/systemDnd.test.ts
git commit -m "feat(electron): KDE system-DND (Inhibited) + boolean deps seam, DE auto-select"
```

---

### Task 6: Wire the KWin client into `index.ts`

**Files:**
- Modify: `electron/src/main/index.ts`

**Interfaces:**
- Consumes: `isKde` (`./trayBackend`), `createKwinClient`/`KwinClient` (`./kde/kwin`).

- [ ] **Step 1: Add imports**

In `electron/src/main/index.ts`, add `isKde` to the existing `./trayBackend` import and add the KWin import. Change:
```ts
import { isGnome, resolveTrayBackend } from './trayBackend';
```
to:
```ts
import { isGnome, isKde, resolveTrayBackend } from './trayBackend';
import { createKwinClient, type KwinClient } from './kde/kwin';
```

- [ ] **Step 2: Build the KWin client at the DE seam**

Right after the existing GNOME `helper` block (the `const gnome = isGnome(...)` / `let helper ...` block and the `// Stage 4.5 (KDE): ...` marker comment), add:
```ts
// KDE: KWin scripting bypasses focus-stealing prevention (the KDE analog of the
// GNOME helper's FocusWindow/HideWindow). Only when not GNOME. Never let a missing
// bus crash startup.
const kde = !gnome && isKde(process.env);
let kwin: KwinClient | undefined;
if (kde) {
  try { kwin = createKwinClient(); }
  catch (err) { console.error('Failed to create KWin client:', err); }
}

// Route window focus/hide to whichever WM integration is active (GNOME helper xor
// KWin xor nothing). Only one is ever set; both are optional-chained + never-throw.
function focusExternal(key: string): void { helper?.focusWindow(key); kwin?.focusWindow(key); }
function hideExternal(key: string): void { helper?.hideWindow(key); kwin?.hideWindow(key); }
```

- [ ] **Step 3: Replace the four call sites**

Replace every `helper?.focusWindow(<x>)` with `focusExternal(<x>)` and every `helper?.hideWindow(<x>)` with `hideExternal(<x>)`. There are exactly four (verify with the grep in Step 4):
- in `openService` (the early-return for an existing window): `helper?.focusWindow(def.displayName)` → `focusExternal(def.displayName)`
- in `openService` (after creating the window): `helper?.focusWindow(def.displayName)` → `focusExternal(def.displayName)`
- in `toggleService`: `helper?.hideWindow(sw.def.displayName)` → `hideExternal(sw.def.displayName)`
- in `loftDeps.hide`: `helper?.hideWindow(sw.def.displayName)` → `hideExternal(sw.def.displayName)`

- [ ] **Step 4: Verify the call sites moved to the dispatchers, then build + test**

Run (from `electron/`):
```bash
grep -n 'helper?\.\(focus\|hide\)Window' src/main/index.ts   # expect EXACTLY 2 matches
grep -n '\(focus\|hide\)External(' src/main/index.ts          # expect 2 definitions + 4 call sites = 6
npm run build   # tsc + bundles + vite + copy-assets, must exit 0
npm test        # full suite green
```
Expected: the first grep shows **exactly two** matches — the `helper?.focusWindow(key)` and `helper?.hideWindow(key)` lines **inside** `focusExternal`/`hideExternal` (all four original call sites now use the dispatchers, so no other `helper?.focusWindow`/`helper?.hideWindow` remain). Build exits 0; all tests pass. (GNOME behavior is unchanged — the dispatchers call `helper?.` exactly as before when `helper` is set.)

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(electron): route window focus/hide through KWin on KDE (focusExternal/hideExternal)"
```

---

## Post-plan

- **Final whole-branch review** (read-only) over the Stage 4.5 range before sign-off.
- **First `kde-preview` build:** controller runs `gh workflow run kde-preview.yml --ref electron-rewrite`, waits for it, and confirms the `.deb` + `.AppImage` are attached to the `kde-preview` pre-release. That is the authoritative packaging verification (the local `npm run dist` in Task 1 is the early smoke).
- **Keith's manual matrix (Kubuntu Plasma 6):** install the `.deb`; SNI tray + badge; hub Open/Show/Hide **raises the right service window** (incl. from hidden); per-service + tray DND; notifications with avatars + click-nav; **toggle Plasma system DND → Loft goes quiet**, untoggle → resumes; a voice/video call; add/remove/gear.
- **Ledger:** append Stage 4.5 status to `.superpowers/sdd/progress.md`.
- **Unblocks Stage 5** (full packaging — rpm/Flatpak/Flathub/auto-update — extends this electron-builder + CI foundation).

## Self-review notes (author)

- **Spec coverage:** KWin focus/hide title-keyed + Plasma 5/6 (T3 buildKwinScript, T4 client, T6 wire-in) · Plasma DND via `Inhibited` (T5) · boolean deps refactor keeping `parseShowBanners` (T5) · `isKde` (T3) · electron-builder `.deb`+AppImage (T1) · `workflow_dispatch` CI → rolling `kde-preview` (T2) · unit tests for isKde/buildKwinScript/kdeDeps-selection/watch transitions (T3, T5) + kwin client sequence (T4). All spec §-items map.
- **Placeholder scan:** none — every step has concrete code/commands. The icon "crisper from SVG" note is an explicit Stage-5 deferral, not a gap.
- **Type consistency:** `SystemDndDeps` new shape (`current`/`watch`) used identically in gnomeDeps/kdeDeps/NOOP_DEPS/watchSystemDnd/tests. `KwinClient` = the existing stub interface (`focusWindow`/`hideWindow` → `Promise<void>`), consumed unchanged in T6. `buildKwinScript(action,key)` signature identical in T3 (def), T4 (caller), and the tests. `isKde(env)` identical in T3/T5/T6. KWin D-Bus members/paths match the Global Constraints and `kwin.rs`.
