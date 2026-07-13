# Electron Loft — Stage 4: Hub Window & App/UX Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Loft hub/manager window (installed-service list, per-service settings, global settings, About), plus autostart and `.desktop` generation, to the single-process Electron app.

**Architecture:** The hub is one more window in the existing single Electron process. "Open" calls the existing in-process `openService()`. Live status is pushed to the hub renderer over IPC (no polling). New main-side modules port the Rust `.desktop`/autostart writers. The renderer is a small Svelte 5 app built with Vite; main + preload keep their existing esbuild/tsc pipeline.

**Tech Stack:** Electron 43, TypeScript 5.9 (main/preload via `tsc` + esbuild), Svelte 5 + Vite 8 (hub renderer), Vitest 4 (`node` env; jsdom for the optional component test), dbus-next (unchanged).

**Spec:** `docs/superpowers/specs/2026-07-13-electron-loft-04-hub-design.md`.

## Global Constraints

- **All code lives under `electron/`.** Branch: `electron-rewrite`. Run all commands from `electron/`.
- **App identity:** `app.setName('Loft')`, `app.setAppUserModelId('chat.loft.Loft')` (already set in `src/main/index.ts`). All windows share WM_CLASS `chat.loft.Loft`; window targeting is title-keyed (GNOME helper, Stage 3c).
- **Dependency versions (verified against npm 2026-07-13):** `svelte@^5.56.4`, `vite@^8.1.4`, `@sveltejs/vite-plugin-svelte@^7.2.0`, `@testing-library/svelte@^5.4.2`, `@testing-library/jest-dom@^6.9.1`. Installed already: `electron@43.1.0`, `typescript@5.9.3`, `esbuild@0.28.1`, `vitest@4.1.10`, `jsdom`. Node `v22.22.2` (Vite 8 needs ≥20.19/≥22.12 ✓).
- **Config file:** single `~/.config/loft/config.json`; `configPath()`/`loadConfig()`/`saveConfig()` in `src/main/config.ts`. `loadConfig` already preserves all per-service fields (it casts `parsed.services` wholesale) — **no loader change is needed** for `openOnStartup`/`customUrl`.
- **XDG paths (host):** applications → `$XDG_DATA_HOME|~/.local/share /applications`; icons → `~/.local/share/loft/icons`; autostart → `$XDG_CONFIG_HOME|~/.config /autostart`; partitions → `~/.local/share/loft/Partitions/<id>`.
- **TDD:** pure logic is test-first with Vitest. Svelte UI is build-verified + manual matrix (one optional component test at the end). Commit after every task.
- **Test runner:** `npx vitest run tests/<file>.test.ts` for one file; `npm test` for all. Build: `npm run build` (runs `tsc` then esbuild bundles then `vite build` then copy-assets).

---

## File structure

**New (main):**
- `src/main/paths.ts` — XDG path helpers (pure, env-injectable).
- `src/main/desktop.ts` — `.desktop` content generators + writers + icon deploy + exec/flatpak detection.
- `src/main/autostart.ts` — autostart `.desktop` content + enable/disable/query.
- `src/main/install.ts` — `addService`/`removeService`/`removePartitionData` orchestration.
- `src/main/hubState.ts` — `buildHubState()` pure snapshot builder.
- `src/main/hubWindow.ts` — `createHub()` (ipcMain handlers + open/notify).

**New (shared / preload / renderer):**
- `src/shared/hubTypes.ts` — IPC types (`HubState`, `HubService`, `HubGlobals`, patches) imported by main, preload, and renderer.
- `src/preload/hub.ts` — `contextBridge` `loftHub` API (esbuild-bundled).
- `src/renderer/hub/` — Svelte app: `index.html`, `main.ts`, `App.svelte`, `app.css`, `lib/store.ts`, `lib/hub.d.ts`, `components/*.svelte`.
- `vite.config.ts`, `svelte.config.js` — renderer build config.

**Modified:**
- `package.json` — deps/devDeps + `bundle-hub-preload`/`bundle-renderer` scripts + `build` order.
- `tsconfig.json` — exclude `src/renderer/hub` (Vite/`svelte-check` own it; `tsc` can't parse `.svelte`).
- `vitest.config.ts` — add the Svelte plugin (for the optional component test only).
- `src/main/index.ts` — CLI no-service → hub; construct deps; first-launch auto-add; `openOnStartup` at boot; tray `onShowHub` → hub; `notifyChanged` at state-change sites; `setServiceSetting`/`setGlobal`.

---

### Task 1: Build scaffolding — Vite + Svelte, provable pipeline

Add the renderer toolchain and a **placeholder** hub app, so the build produces `dist/renderer/hub/` before any real UI exists. Tasks 8–9 replace the placeholder.

**Files:**
- Modify: `package.json` (deps, devDeps, scripts)
- Create: `vite.config.ts`, `svelte.config.js`
- Modify: `tsconfig.json:13-14` (exclude list)
- Create: `src/renderer/hub/index.html`, `src/renderer/hub/main.ts`, `src/renderer/hub/App.svelte`, `src/renderer/hub/app.css`

**Interfaces:**
- Produces: a `vite build` step emitting `dist/renderer/hub/index.html` + hashed assets; `npm run build` green; `tsc` still excludes the Svelte sources.

- [ ] **Step 1: Install dependencies**

Run (from `electron/`):

```bash
npm install --save svelte@^5.56.4
npm install --save-dev vite@^8.1.4 @sveltejs/vite-plugin-svelte@^7.2.0 @testing-library/svelte@^5.4.2 @testing-library/jest-dom@^6.9.1
```

- [ ] **Step 2: Create `svelte.config.js`**

```js
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default { preprocess: vitePreprocess() };
```

- [ ] **Step 3: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

// Renderer-only Vite build. base:'./' makes asset URLs relative so the bundle
// loads over file:// inside Electron. Main + preload stay on esbuild/tsc.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer/hub'),
  base: './',
  plugins: [svelte()],
  build: {
    outDir: resolve(__dirname, 'dist/renderer/hub'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'src/renderer/hub/index.html') },
  },
});
```

- [ ] **Step 4: Create the placeholder renderer**

`src/renderer/hub/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" />
    <title>Loft</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`src/renderer/hub/main.ts`:

```ts
import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

export default mount(App, { target: document.getElementById('app')! });
```

`src/renderer/hub/App.svelte`:

```svelte
<main><h1>Loft</h1><p>Hub placeholder — replaced in Task 8.</p></main>
```

`src/renderer/hub/app.css`:

```css
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; }
```

- [ ] **Step 5: Exclude the Svelte sources from `tsc`**

In `tsconfig.json`, change the `exclude` array to:

```json
  "exclude": ["node_modules", "dist", "tests", "src/renderer/hub"]
```

- [ ] **Step 6: Wire the build scripts**

In `package.json` `scripts`, add two scripts and update `build`:

```json
    "build": "tsc -p tsconfig.json && npm run bundle-preload && npm run bundle-hub-preload && npm run bundle-renderer && npm run copy-assets",
    "bundle-hub-preload": "esbuild src/preload/hub.ts --bundle --platform=node --format=cjs --external:electron --outfile=dist/preload/hub.js",
    "bundle-renderer": "vite build",
```

Note: `bundle-hub-preload` references `src/preload/hub.ts`, created in Task 6. Until then it will fail, so **for Task 1 only** verify via the two commands in Step 7 rather than the full `build`.

- [ ] **Step 7: Verify the renderer builds**

Run:

```bash
npx vite build
ls dist/renderer/hub/index.html
```

Expected: Vite reports built modules; `dist/renderer/hub/index.html` exists.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vite.config.ts svelte.config.js tsconfig.json src/renderer/hub
git commit -m "build(electron): add Svelte 5 + Vite renderer pipeline for the hub (placeholder)"
```

---

### Task 2: `paths.ts` — XDG path helpers

**Files:**
- Create: `src/main/paths.ts`
- Test: `tests/paths.test.ts`

**Interfaces:**
- Produces:
  - `dataHome(env?): string` · `configHome(env?): string`
  - `applicationsDir(env?): string` — `<dataHome>/applications`
  - `loftDataDir(env?): string` — `<dataHome>/loft`
  - `iconsDir(env?): string` — `<dataHome>/loft/icons`
  - `partitionDir(id, env?): string` — `<dataHome>/loft/Partitions/<id>`
  - `autostartDir(env?): string` — `<configHome>/autostart`
  - each takes `env: NodeJS.ProcessEnv = process.env`.

- [ ] **Step 1: Write the failing test**

`tests/paths.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  dataHome, configHome, applicationsDir, loftDataDir, iconsDir, partitionDir, autostartDir,
} from '../src/main/paths';

const xdg = { XDG_DATA_HOME: '/x/data', XDG_CONFIG_HOME: '/x/cfg', HOME: '/home/u' };
const noXdg = { HOME: '/home/u' } as NodeJS.ProcessEnv;

describe('paths', () => {
  it('honours XDG_DATA_HOME/XDG_CONFIG_HOME', () => {
    expect(dataHome(xdg)).toBe('/x/data');
    expect(configHome(xdg)).toBe('/x/cfg');
    expect(applicationsDir(xdg)).toBe('/x/data/applications');
    expect(loftDataDir(xdg)).toBe('/x/data/loft');
    expect(iconsDir(xdg)).toBe('/x/data/loft/icons');
    expect(partitionDir('whatsapp', xdg)).toBe('/x/data/loft/Partitions/whatsapp');
    expect(autostartDir(xdg)).toBe('/x/cfg/autostart');
  });

  it('falls back to ~/.local/share and ~/.config', () => {
    expect(dataHome(noXdg)).toBe('/home/u/.local/share');
    expect(configHome(noXdg)).toBe('/home/u/.config');
    expect(applicationsDir(noXdg)).toBe('/home/u/.local/share/applications');
    expect(autostartDir(noXdg)).toBe('/home/u/.config/autostart');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/paths.test.ts`
Expected: FAIL — cannot find module `../src/main/paths`.

- [ ] **Step 3: Implement `src/main/paths.ts`**

```ts
import { join } from 'node:path';
import { homedir } from 'node:os';

type Env = NodeJS.ProcessEnv;

export function dataHome(env: Env = process.env): string {
  return env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share');
}

export function configHome(env: Env = process.env): string {
  return env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
}

export function applicationsDir(env: Env = process.env): string {
  return join(dataHome(env), 'applications');
}

export function loftDataDir(env: Env = process.env): string {
  return join(dataHome(env), 'loft');
}

export function iconsDir(env: Env = process.env): string {
  return join(loftDataDir(env), 'icons');
}

export function partitionDir(id: string, env: Env = process.env): string {
  return join(loftDataDir(env), 'Partitions', id);
}

export function autostartDir(env: Env = process.env): string {
  return join(configHome(env), 'autostart');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/paths.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/paths.ts tests/paths.test.ts
git commit -m "feat(electron): XDG path helpers (paths.ts)"
```

---

### Task 3: `desktop.ts` + `autostart.ts` — `.desktop` and autostart writers

Ports of `src/desktop.rs` (`desktop_exec`, `create_desktop_entry`, `ensure_manager_desktop_entry`, icon deploy) and `set_autostart`, minus all Chrome-era cruft (no `StartupWMClass`/`chrome_desktop_id`, no NM host).

**Files:**
- Create: `src/main/desktop.ts`, `src/main/autostart.ts`
- Test: `tests/desktop.test.ts`, `tests/autostart.test.ts`

**Interfaces:**
- Consumes: `paths.ts` (`applicationsDir`, `iconsDir`, `autostartDir`); `registry.ts` `ServiceDef`.
- Produces (`desktop.ts`):
  - `isFlatpak(env?): boolean`
  - `desktopExec(opts: { env?: NodeJS.ProcessEnv; execPath?: string }): string`
  - `serviceLauncherContent(def: ServiceDef, exec: string, iconPath: string): string`
  - `hubDesktopContent(exec: string, iconPath: string): string`
  - `writeServiceLauncher(def, opts: { env?; execPath?; iconSourceDir: string }): void`
  - `removeServiceLauncher(def, env?): void`
  - `deployServiceIcon(def, opts: { env?; iconSourceDir: string }): string` — copies `<iconSourceDir>/<id>.png` → `iconsDir/<id>.png`, returns the destination path
  - `ensureHubDesktopEntry(opts: { env?; execPath?; iconSourceDir: string }): void` — skipped in dev / Flatpak
- Produces (`autostart.ts`):
  - `autostartContent(exec: string, iconPath: string): string`
  - `setAutostart(enabled: boolean, opts: { env?; execPath?; iconSourceDir: string }): void`
  - `isAutostartEnabled(env?): boolean`

- [ ] **Step 1: Write the failing test — `tests/desktop.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isFlatpak, desktopExec, serviceLauncherContent, hubDesktopContent,
  writeServiceLauncher, removeServiceLauncher, deployServiceIcon,
} from '../src/main/desktop';
import { getService } from '../src/main/registry';

const wa = getService('whatsapp')!;
const tmps: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'loft-')); tmps.push(d); return d; }
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('desktop exec + flatpak', () => {
  it('prefers APPIMAGE, then flatpak, then execPath', () => {
    expect(desktopExec({ env: { APPIMAGE: '/a/Loft.AppImage' }, execPath: '/x' })).toBe('/a/Loft.AppImage');
    expect(desktopExec({ env: { FLATPAK_ID: 'chat.loft.Loft' }, execPath: '/x' })).toBe('flatpak run chat.loft.Loft');
    expect(desktopExec({ env: {}, execPath: '/usr/bin/loft' })).toBe('/usr/bin/loft');
  });
  it('isFlatpak reads FLATPAK_ID', () => {
    expect(isFlatpak({ FLATPAK_ID: 'x' })).toBe(true);
    expect(isFlatpak({})).toBe(false);
  });
});

describe('desktop content', () => {
  it('service launcher has Exec --service and the icon path', () => {
    const c = serviceLauncherContent(wa, '/usr/bin/loft', '/i/whatsapp.png');
    expect(c).toContain('[Desktop Entry]');
    expect(c).toContain('Name=WhatsApp');
    expect(c).toContain('Exec=/usr/bin/loft --service=whatsapp');
    expect(c).toContain('Icon=/i/whatsapp.png');
    expect(c).toContain('Categories=Network;InstantMessaging;');
    expect(c).not.toContain('StartupWMClass'); // all windows share chat.loft.Loft
  });
  it('hub entry execs the bare binary', () => {
    const c = hubDesktopContent('/usr/bin/loft', '/i/loft.png');
    expect(c).toContain('Name=Loft');
    expect(c).toMatch(/Exec=\/usr\/bin\/loft\n/);
  });
});

describe('desktop writers', () => {
  it('deploys icon, writes then removes the launcher', () => {
    const data = tmp();
    const src = tmp();
    mkdirSync(join(src), { recursive: true });
    writeFileSync(join(src, 'whatsapp.png'), 'PNG');
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;

    const iconDst = deployServiceIcon(wa, { env, iconSourceDir: src });
    expect(existsSync(iconDst)).toBe(true);
    expect(readFileSync(iconDst, 'utf8')).toBe('PNG');

    writeServiceLauncher(wa, { env, execPath: '/usr/bin/loft', iconSourceDir: src });
    const launcher = join(data, 'applications', 'loft-whatsapp.desktop');
    expect(existsSync(launcher)).toBe(true);
    expect(readFileSync(launcher, 'utf8')).toContain('Exec=/usr/bin/loft --service=whatsapp');

    removeServiceLauncher(wa, env);
    expect(existsSync(launcher)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/desktop.test.ts`
Expected: FAIL — cannot find module `../src/main/desktop`.

- [ ] **Step 3: Implement `src/main/desktop.ts`**

```ts
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceDef } from './registry';
import { applicationsDir, iconsDir } from './paths';

type Env = NodeJS.ProcessEnv;

export function isFlatpak(env: Env = process.env): boolean {
  return Boolean(env.FLATPAK_ID) || existsSync('/.flatpak-info');
}

/** The Exec= prefix: AppImage path, else `flatpak run chat.loft.Loft`, else the binary. */
export function desktopExec(opts: { env?: Env; execPath?: string } = {}): string {
  const env = opts.env ?? process.env;
  if (env.APPIMAGE) return env.APPIMAGE;
  if (isFlatpak(env)) return 'flatpak run chat.loft.Loft';
  return opts.execPath ?? process.execPath;
}

export function serviceLauncherContent(def: ServiceDef, exec: string, iconPath: string): string {
  return (
    `[Desktop Entry]\n` +
    `Type=Application\n` +
    `Name=${def.displayName}\n` +
    `Comment=Open ${def.displayName} via Loft\n` +
    `Exec=${exec} --service=${def.id}\n` +
    `Icon=${iconPath}\n` +
    `Terminal=false\n` +
    `Categories=Network;InstantMessaging;\n`
  );
}

export function hubDesktopContent(exec: string, iconPath: string): string {
  return (
    `[Desktop Entry]\n` +
    `Type=Application\n` +
    `Name=Loft\n` +
    `Comment=Manage Loft web app services\n` +
    `Exec=${exec}\n` +
    `Icon=${iconPath}\n` +
    `Terminal=false\n` +
    `Categories=Network;InstantMessaging;\n`
  );
}

/** Copy the bundled per-service PNG into the user's loft icons dir; return the dest path. */
export function deployServiceIcon(def: ServiceDef, opts: { env?: Env; iconSourceDir: string }): string {
  const dir = iconsDir(opts.env);
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, `${def.id}.png`);
  const srcFile = join(opts.iconSourceDir, `${def.id}.png`);
  if (existsSync(srcFile)) copyFileSync(srcFile, dst);
  return dst;
}

function launcherPath(def: ServiceDef, env?: Env): string {
  return join(applicationsDir(env), `loft-${def.id}.desktop`);
}

export function writeServiceLauncher(
  def: ServiceDef,
  opts: { env?: Env; execPath?: string; iconSourceDir: string },
): void {
  const icon = deployServiceIcon(def, { env: opts.env, iconSourceDir: opts.iconSourceDir });
  const dir = applicationsDir(opts.env);
  mkdirSync(dir, { recursive: true });
  const exec = desktopExec({ env: opts.env, execPath: opts.execPath });
  writeFileSync(launcherPath(def, opts.env), serviceLauncherContent(def, exec, icon), 'utf8');
}

export function removeServiceLauncher(def: ServiceDef, env: Env = process.env): void {
  const p = launcherPath(def, env);
  if (existsSync(p)) rmSync(p, { force: true });
}

/** The hub's own launcher — for dev/AppImage; packaged/Flatpak provide their own. */
export function ensureHubDesktopEntry(opts: { env?: Env; execPath?: string; iconSourceDir: string }): void {
  const env = opts.env ?? process.env;
  if (isFlatpak(env)) return;
  const exec = opts.execPath ?? process.execPath;
  // Skip a working copy run straight out of the Electron binary in dev.
  if (!env.APPIMAGE && (exec.includes('/node_modules/') || exec.endsWith('/electron'))) return;
  const dir = applicationsDir(env);
  const p = join(dir, 'chat.loft.Loft.desktop');
  if (existsSync(p)) return;
  mkdirSync(dir, { recursive: true });
  mkdirSync(iconsDir(env), { recursive: true });
  const iconSrc = join(opts.iconSourceDir, 'loft.png');
  const iconDst = join(iconsDir(env), 'loft.png');
  if (existsSync(iconSrc)) copyFileSync(iconSrc, iconDst);
  writeFileSync(p, hubDesktopContent(desktopExec({ env, execPath: exec }), iconDst), 'utf8');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/desktop.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test — `tests/autostart.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autostartContent, setAutostart, isAutostartEnabled } from '../src/main/autostart';

const tmps: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'loft-as-')); tmps.push(d); return d; }
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('autostart', () => {
  it('content execs --minimized and enables gnome autostart', () => {
    const c = autostartContent('/usr/bin/loft', '/i/loft.png');
    expect(c).toContain('Exec=/usr/bin/loft --minimized');
    expect(c).toContain('X-GNOME-Autostart-enabled=true');
    expect(c).toContain('Name=Loft');
  });
  it('enable writes, query reports true, disable removes', () => {
    const cfg = tmp();
    const src = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp() } as NodeJS.ProcessEnv;
    const path = join(cfg, 'autostart', 'chat.loft.Loft.desktop');

    expect(isAutostartEnabled(env)).toBe(false);
    setAutostart(true, { env, execPath: '/usr/bin/loft', iconSourceDir: src });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('--minimized');
    expect(isAutostartEnabled(env)).toBe(true);

    setAutostart(false, { env, execPath: '/usr/bin/loft', iconSourceDir: src });
    expect(existsSync(path)).toBe(false);
    expect(isAutostartEnabled(env)).toBe(false);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run tests/autostart.test.ts`
Expected: FAIL — cannot find module `../src/main/autostart`.

- [ ] **Step 7: Implement `src/main/autostart.ts`**

```ts
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { autostartDir, iconsDir } from './paths';
import { desktopExec } from './desktop';

type Env = NodeJS.ProcessEnv;

const FILE = 'chat.loft.Loft.desktop';

export function autostartContent(exec: string, iconPath: string): string {
  return (
    `[Desktop Entry]\n` +
    `Type=Application\n` +
    `Name=Loft\n` +
    `Comment=Loft\n` +
    `Exec=${exec} --minimized\n` +
    `Icon=${iconPath}\n` +
    `Terminal=false\n` +
    `X-GNOME-Autostart-enabled=true\n`
  );
}

function entryPath(env?: Env): string {
  return join(autostartDir(env), FILE);
}

export function isAutostartEnabled(env: Env = process.env): boolean {
  return existsSync(entryPath(env));
}

export function setAutostart(
  enabled: boolean,
  opts: { env?: Env; execPath?: string; iconSourceDir: string },
): void {
  const env = opts.env ?? process.env;
  const path = entryPath(env);
  if (enabled) {
    mkdirSync(autostartDir(env), { recursive: true });
    mkdirSync(iconsDir(env), { recursive: true });
    const iconSrc = join(opts.iconSourceDir, 'loft.png');
    const iconDst = join(iconsDir(env), 'loft.png');
    if (existsSync(iconSrc)) copyFileSync(iconSrc, iconDst);
    writeFileSync(path, autostartContent(desktopExec({ env, execPath: opts.execPath }), iconDst), 'utf8');
  } else if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run tests/autostart.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/desktop.ts src/main/autostart.ts tests/desktop.test.ts tests/autostart.test.ts
git commit -m "feat(electron): .desktop launcher + autostart writers (desktop.ts, autostart.ts)"
```

---

### Task 4: `install.ts` — add/remove orchestration

**Files:**
- Create: `src/main/install.ts`
- Test: `tests/install.test.ts`

**Interfaces:**
- Consumes: `desktop.ts` (`writeServiceLauncher`, `removeServiceLauncher`), `paths.ts` (`partitionDir`), `registry.ts` `ServiceDef`, `config.ts` `LoftConfig`.
- Produces:
  - `addService(def: ServiceDef, cfg: LoftConfig, opts: { env?; execPath?; iconSourceDir: string; customUrl?: string }): void` — idempotent: ensures `cfg.services[def.id]`, sets `customUrl` if given, writes the launcher + icon. (Caller persists `cfg`.)
  - `removeService(def: ServiceDef, cfg: LoftConfig, deleteData: boolean, env?): void` — removes the launcher, deletes `cfg.services[def.id]`, and (if `deleteData`) removes the partition dir.
  - `removePartitionData(id: string, env?): void`

- [ ] **Step 1: Write the failing test**

`tests/install.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addService, removeService } from '../src/main/install';
import { getService } from '../src/main/registry';
import type { LoftConfig } from '../src/main/config';

const wa = getService('whatsapp')!;
const tmps: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'loft-inst-')); tmps.push(d); return d; }
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function iconSrc(): string { const d = tmp(); writeFileSync(join(d, 'whatsapp.png'), 'PNG'); return d; }

describe('install', () => {
  it('addService marks config, sets customUrl, writes launcher', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: {} };
    addService(wa, cfg, { env, execPath: '/usr/bin/loft', iconSourceDir: iconSrc(), customUrl: 'https://x' });
    expect(cfg.services.whatsapp).toBeDefined();
    expect(cfg.services.whatsapp.customUrl).toBe('https://x');
    expect(existsSync(join(data, 'applications', 'loft-whatsapp.desktop'))).toBe(true);
  });

  it('removeService deletes launcher + config, and partition when asked', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { whatsapp: {} } };
    addService(wa, cfg, { env, execPath: '/usr/bin/loft', iconSourceDir: iconSrc() });
    const part = join(data, 'loft', 'Partitions', 'whatsapp');
    mkdirSync(part, { recursive: true });

    removeService(wa, cfg, true, env);
    expect(cfg.services.whatsapp).toBeUndefined();
    expect(existsSync(join(data, 'applications', 'loft-whatsapp.desktop'))).toBe(false);
    expect(existsSync(part)).toBe(false);
  });

  it('removeService keeps the partition when deleteData is false', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { whatsapp: {} } };
    const part = join(data, 'loft', 'Partitions', 'whatsapp');
    mkdirSync(part, { recursive: true });
    removeService(wa, cfg, false, env);
    expect(existsSync(part)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/install.test.ts`
Expected: FAIL — cannot find module `../src/main/install`.

- [ ] **Step 3: Implement `src/main/install.ts`**

```ts
import { existsSync, rmSync } from 'node:fs';
import type { ServiceDef } from './registry';
import type { LoftConfig } from './config';
import { writeServiceLauncher, removeServiceLauncher } from './desktop';
import { partitionDir } from './paths';

type Env = NodeJS.ProcessEnv;

export function removePartitionData(id: string, env: Env = process.env): void {
  const dir = partitionDir(id, env);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Idempotent: mark the service configured, set a custom URL if given, write its launcher. */
export function addService(
  def: ServiceDef,
  cfg: LoftConfig,
  opts: { env?: Env; execPath?: string; iconSourceDir: string; customUrl?: string },
): void {
  cfg.services[def.id] = { ...cfg.services[def.id] };
  if (opts.customUrl !== undefined) cfg.services[def.id].customUrl = opts.customUrl;
  writeServiceLauncher(def, { env: opts.env, execPath: opts.execPath, iconSourceDir: opts.iconSourceDir });
}

export function removeService(
  def: ServiceDef,
  cfg: LoftConfig,
  deleteData: boolean,
  env: Env = process.env,
): void {
  removeServiceLauncher(def, env);
  delete cfg.services[def.id];
  if (deleteData) removePartitionData(def.id, env);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/install.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/install.ts tests/install.test.ts
git commit -m "feat(electron): add/remove service orchestration (install.ts)"
```

---

### Task 5: `hubTypes.ts` + `hubState.ts` — IPC types and snapshot builder

**Files:**
- Create: `src/shared/hubTypes.ts`, `src/main/hubState.ts`
- Test: `tests/hubState.test.ts`

**Interfaces:**
- Produces (`hubTypes.ts`):
  ```ts
  export type TrayBackend = 'auto' | 'gnome-panel' | 'sni';
  export interface HubService {
    id: string; displayName: string; selfHosted: boolean;
    installed: boolean; running: boolean; visible: boolean;
    badge: number; badgesEnabled: boolean; dnd: boolean;
    openOnStartup: boolean; customUrl: string;
  }
  export interface HubGlobals { trayBackend: TrayBackend; startAtLogin: boolean; }
  export interface HubState { services: HubService[]; globals: HubGlobals; }
  export interface ServicePatch { openOnStartup?: boolean; badgesEnabled?: boolean; dnd?: boolean; customUrl?: string; }
  export interface GlobalPatch { trayBackend?: TrayBackend; startAtLogin?: boolean; }
  ```
  Note: reuse the existing `TrayBackend` from `../main/trayBackend`; re-export it here to keep one definition. (`trayBackend.ts` defines `export type TrayBackend = 'auto' | 'gnome-panel' | 'sni'`.)
- Produces (`hubState.ts`): `buildHubState(deps: HubStateDeps): HubState` where
  ```ts
  export interface HubStateDeps {
    services: readonly ServiceDef[];
    config: LoftConfig;
    running(id: string): boolean;
    visible(id: string): boolean;
    badge(id: string): number;      // true unread count, independent of badgesEnabled
    trayBackend: TrayBackend;
    startAtLogin: boolean;
  }
  ```
- Consumes: `registry.ts` `ServiceDef`, `config.ts` `LoftConfig`, `trayBackend.ts` `TrayBackend`.

- [ ] **Step 1: Write the failing test**

`tests/hubState.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildHubState } from '../src/main/hubState';
import { SERVICES } from '../src/main/registry';
import type { LoftConfig } from '../src/main/config';

const base = {
  services: SERVICES,
  running: () => false,
  visible: () => false,
  badge: () => 0,
  trayBackend: 'auto' as const,
  startAtLogin: false,
};

describe('buildHubState', () => {
  it('marks installed only for services present in config', () => {
    const config: LoftConfig = { services: { whatsapp: {} } };
    const s = buildHubState({ ...base, config });
    expect(s.services.find((x) => x.id === 'whatsapp')!.installed).toBe(true);
    expect(s.services.find((x) => x.id === 'slack')!.installed).toBe(false);
    expect(s.services).toHaveLength(SERVICES.length);
  });

  it('reports the true badge even when the indicator is disabled', () => {
    const config: LoftConfig = { services: { whatsapp: { badgesEnabled: false } } };
    const s = buildHubState({ ...base, config, badge: (id) => (id === 'whatsapp' ? 5 : 0) });
    const wa = s.services.find((x) => x.id === 'whatsapp')!;
    expect(wa.badge).toBe(5);
    expect(wa.badgesEnabled).toBe(false);
  });

  it('derives running/visible/dnd/openOnStartup/customUrl + globals', () => {
    const config: LoftConfig = {
      services: { telegram: { dnd: true, openOnStartup: true, customUrl: 'https://t' } },
    };
    const s = buildHubState({
      ...base, config, trayBackend: 'sni', startAtLogin: true,
      running: (id) => id === 'telegram', visible: (id) => id === 'telegram',
    });
    const tg = s.services.find((x) => x.id === 'telegram')!;
    expect(tg).toMatchObject({ running: true, visible: true, dnd: true, openOnStartup: true, customUrl: 'https://t' });
    expect(s.globals).toEqual({ trayBackend: 'sni', startAtLogin: true });
  });

  it('defaults badgesEnabled to true when unset', () => {
    const config: LoftConfig = { services: { slack: {} } };
    const s = buildHubState({ ...base, config });
    expect(s.services.find((x) => x.id === 'slack')!.badgesEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/hubState.test.ts`
Expected: FAIL — cannot find module `../src/main/hubState`.

- [ ] **Step 3: Implement `src/shared/hubTypes.ts`**

```ts
import type { TrayBackend } from '../main/trayBackend';

export type { TrayBackend };

export interface HubService {
  id: string;
  displayName: string;
  selfHosted: boolean;
  installed: boolean;
  running: boolean;
  visible: boolean;
  badge: number;
  badgesEnabled: boolean;
  dnd: boolean;
  openOnStartup: boolean;
  customUrl: string;
}

export interface HubGlobals { trayBackend: TrayBackend; startAtLogin: boolean; }
export interface HubState { services: HubService[]; globals: HubGlobals; }

export interface ServicePatch {
  openOnStartup?: boolean;
  badgesEnabled?: boolean;
  dnd?: boolean;
  customUrl?: string;
}
export interface GlobalPatch { trayBackend?: TrayBackend; startAtLogin?: boolean; }
```

- [ ] **Step 4: Implement `src/main/hubState.ts`**

```ts
import type { ServiceDef } from './registry';
import type { LoftConfig } from './config';
import type { HubState, TrayBackend } from '../shared/hubTypes';

export interface HubStateDeps {
  services: readonly ServiceDef[];
  config: LoftConfig;
  running(id: string): boolean;
  visible(id: string): boolean;
  badge(id: string): number;
  trayBackend: TrayBackend;
  startAtLogin: boolean;
}

export function buildHubState(deps: HubStateDeps): HubState {
  const services = deps.services.map((def) => {
    const c = deps.config.services[def.id];
    return {
      id: def.id,
      displayName: def.displayName,
      selfHosted: def.selfHosted,
      installed: c !== undefined,
      running: deps.running(def.id),
      visible: deps.visible(def.id),
      badge: deps.badge(def.id),
      badgesEnabled: c?.badgesEnabled !== false,
      dnd: c?.dnd ?? false,
      openOnStartup: c?.openOnStartup ?? false,
      customUrl: c?.customUrl ?? '',
    };
  });
  return { services, globals: { trayBackend: deps.trayBackend, startAtLogin: deps.startAtLogin } };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/hubState.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/hubTypes.ts src/main/hubState.ts tests/hubState.test.ts
git commit -m "feat(electron): hub IPC types + buildHubState snapshot builder"
```

---

### Task 6: `preload/hub.ts` — the `loftHub` bridge

**Files:**
- Create: `src/preload/hub.ts`
- Test: `tests/hubPreload.test.ts`

**Interfaces:**
- Consumes: `hubTypes.ts` (`HubState`, `ServicePatch`, `GlobalPatch`).
- Produces: a `contextBridge` object `loftHub` exposing `getState`, `onStateChanged`, `openService`, `addService`, `removeService`, `setServiceSetting`, `setGlobal`, `quit`. To make it testable, factor the object into a pure `buildBridge(ipc)` that Task 6's test drives with a mock, and register it via `contextBridge.exposeInMainWorld('loftHub', buildBridge(ipcRenderer))`.

- [ ] **Step 1: Write the failing test**

`tests/hubPreload.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

// hub.ts calls contextBridge.exposeInMainWorld at import time; outside Electron
// `electron` resolves to a path string, so the API objects are undefined and the
// import would throw. Mock it. (buildBridge itself takes an injected ipc below.)
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

import { buildBridge } from '../src/preload/hub';

function mockIpc() {
  return {
    invoke: vi.fn().mockResolvedValue({ services: [], globals: { trayBackend: 'auto', startAtLogin: false } }),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

describe('hub preload bridge', () => {
  it('getState invokes hub:getState', async () => {
    const ipc = mockIpc();
    await buildBridge(ipc as never).getState();
    expect(ipc.invoke).toHaveBeenCalledWith('hub:getState');
  });

  it('actions send the right channels + payloads', () => {
    const ipc = mockIpc();
    const b = buildBridge(ipc as never);
    b.openService('slack');
    b.addService('talk', 'https://cloud.example.com/apps/spreed/');
    b.removeService('slack', true);
    b.setServiceSetting('slack', { dnd: true });
    b.setGlobal({ startAtLogin: true });
    b.quit();
    expect(ipc.send).toHaveBeenCalledWith('hub:openService', 'slack');
    expect(ipc.send).toHaveBeenCalledWith('hub:addService', { id: 'talk', customUrl: 'https://cloud.example.com/apps/spreed/' });
    expect(ipc.send).toHaveBeenCalledWith('hub:removeService', { id: 'slack', deleteData: true });
    expect(ipc.send).toHaveBeenCalledWith('hub:setServiceSetting', { id: 'slack', patch: { dnd: true } });
    expect(ipc.send).toHaveBeenCalledWith('hub:setGlobal', { startAtLogin: true });
    expect(ipc.send).toHaveBeenCalledWith('hub:quit');
  });

  it('onStateChanged subscribes and returns an unsubscribe', () => {
    const ipc = mockIpc();
    const cb = vi.fn();
    const off = buildBridge(ipc as never).onStateChanged(cb);
    expect(ipc.on).toHaveBeenCalledWith('hub:state', expect.any(Function));
    // simulate a push
    const handler = ipc.on.mock.calls[0][1] as (e: unknown, s: unknown) => void;
    handler({}, { services: [], globals: { trayBackend: 'auto', startAtLogin: false } });
    expect(cb).toHaveBeenCalledOnce();
    off();
    expect(ipc.removeListener).toHaveBeenCalledWith('hub:state', expect.any(Function));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/hubPreload.test.ts`
Expected: FAIL — cannot find module `../src/preload/hub`.

- [ ] **Step 3: Implement `src/preload/hub.ts`**

```ts
import { contextBridge, ipcRenderer, type IpcRenderer } from 'electron';
import type { HubState, ServicePatch, GlobalPatch } from '../shared/hubTypes';

export interface LoftHub {
  getState(): Promise<HubState>;
  onStateChanged(cb: (s: HubState) => void): () => void;
  openService(id: string): void;
  addService(id: string, customUrl?: string): void;
  removeService(id: string, deleteData: boolean): void;
  setServiceSetting(id: string, patch: ServicePatch): void;
  setGlobal(patch: GlobalPatch): void;
  quit(): void;
}

// Pure factory (testable with a mock ipc); the real bridge passes ipcRenderer.
export function buildBridge(ipc: IpcRenderer): LoftHub {
  return {
    getState: () => ipc.invoke('hub:getState'),
    onStateChanged: (cb) => {
      const handler = (_e: unknown, s: HubState) => cb(s);
      ipc.on('hub:state', handler);
      return () => ipc.removeListener('hub:state', handler);
    },
    openService: (id) => ipc.send('hub:openService', id),
    addService: (id, customUrl) => ipc.send('hub:addService', { id, customUrl }),
    removeService: (id, deleteData) => ipc.send('hub:removeService', { id, deleteData }),
    setServiceSetting: (id, patch) => ipc.send('hub:setServiceSetting', { id, patch }),
    setGlobal: (patch) => ipc.send('hub:setGlobal', patch),
    quit: () => ipc.send('hub:quit'),
  };
}

contextBridge.exposeInMainWorld('loftHub', buildBridge(ipcRenderer));
```

Note: `buildBridge` is the pure, tested factory. The bottom `exposeInMainWorld` line runs at import time and needs the `vi.mock('electron', …)` at the top of the test (Step 1) — without it the import throws, because outside the Electron runtime `import … from 'electron'` yields a path string, not the API.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/hubPreload.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify the preload bundles**

Run: `npm run bundle-hub-preload && ls dist/preload/hub.js`
Expected: `dist/preload/hub.js` exists.

- [ ] **Step 6: Commit**

```bash
git add src/preload/hub.ts tests/hubPreload.test.ts
git commit -m "feat(electron): hub preload bridge (loftHub)"
```

---

### Task 7: `hubWindow.ts` — window + ipcMain handlers

**Files:**
- Create: `src/main/hubWindow.ts`
- Test: `tests/hubWindow.test.ts`

**Interfaces:**
- Consumes: `hubTypes.ts` types.
- Produces:
  ```ts
  export interface HubDeps {
    buildState(): HubState;
    openService(id: string): void;
    addService(id: string, customUrl?: string): void;
    removeService(id: string, deleteData: boolean): void;
    setServiceSetting(id: string, patch: ServicePatch): void;
    setGlobal(patch: GlobalPatch): void;
    quitApp(): void;
    preloadPath: string;
    htmlPath: string;
    iconPath: string;
  }
  export interface Hub { open(): void; notifyChanged(): void; }
  export function createHub(deps: HubDeps): Hub;
  ```
- Behaviour: `createHub` registers the `ipcMain` handlers once (guarded against double-registration via `ipcMain.removeHandler`/`removeAllListeners` on the hub channels first). `open()` creates the window if absent (or focuses it) and loads `htmlPath`. `notifyChanged()` sends `hub:state` with `buildState()` to the open window. The registered handlers call the matching dep and then `notifyChanged()` for mutating actions.

- [ ] **Step 1: Write the failing test**

`tests/hubWindow.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture ipcMain registrations against a mock Electron.
const handlers = new Map<string, (...a: unknown[]) => unknown>();
const listeners = new Map<string, (...a: unknown[]) => void>();
const sent: Array<{ channel: string; arg: unknown }> = [];

vi.mock('electron', () => {
  const win = {
    isDestroyed: () => false,
    loadFile: vi.fn(),
    focus: vi.fn(),
    show: vi.fn(),
    on: vi.fn(),
    webContents: { send: (channel: string, arg: unknown) => sent.push({ channel, arg }) },
  };
  return {
    ipcMain: {
      handle: (c: string, fn: (...a: unknown[]) => unknown) => handlers.set(c, fn),
      removeHandler: (c: string) => handlers.delete(c),
      on: (c: string, fn: (...a: unknown[]) => void) => listeners.set(c, fn),
      removeAllListeners: (c: string) => listeners.delete(c),
    },
    BrowserWindow: vi.fn(() => win),
  };
});

import { createHub, type HubDeps } from '../src/main/hubWindow';

function deps(over: Partial<HubDeps> = {}): HubDeps {
  return {
    buildState: () => ({ services: [], globals: { trayBackend: 'auto', startAtLogin: false } }),
    openService: vi.fn(), addService: vi.fn(), removeService: vi.fn(),
    setServiceSetting: vi.fn(), setGlobal: vi.fn(), quitApp: vi.fn(),
    preloadPath: '/p', htmlPath: '/h', iconPath: '/i',
    ...over,
  };
}

beforeEach(() => { handlers.clear(); listeners.clear(); sent.length = 0; });

describe('createHub', () => {
  it('getState handler returns buildState()', async () => {
    createHub(deps());
    const state = await handlers.get('hub:getState')!();
    expect(state).toEqual({ services: [], globals: { trayBackend: 'auto', startAtLogin: false } });
  });

  it('openService listener dispatches to the dep', () => {
    const openService = vi.fn();
    createHub(deps({ openService }));
    listeners.get('hub:openService')!({}, 'slack');
    expect(openService).toHaveBeenCalledWith('slack');
  });

  it('addService dispatches id + customUrl', () => {
    const addService = vi.fn();
    createHub(deps({ addService }));
    listeners.get('hub:addService')!({}, { id: 'talk', customUrl: 'https://x' });
    expect(addService).toHaveBeenCalledWith('talk', 'https://x');
  });

  it('open() then notifyChanged() pushes hub:state', () => {
    const hub = createHub(deps());
    hub.open();
    hub.notifyChanged();
    expect(sent.some((m) => m.channel === 'hub:state')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/hubWindow.test.ts`
Expected: FAIL — cannot find module `../src/main/hubWindow`.

- [ ] **Step 3: Implement `src/main/hubWindow.ts`**

```ts
import { BrowserWindow, ipcMain } from 'electron';
import type { HubState, ServicePatch, GlobalPatch } from '../shared/hubTypes';

export interface HubDeps {
  buildState(): HubState;
  openService(id: string): void;
  addService(id: string, customUrl?: string): void;
  removeService(id: string, deleteData: boolean): void;
  setServiceSetting(id: string, patch: ServicePatch): void;
  setGlobal(patch: GlobalPatch): void;
  quitApp(): void;
  preloadPath: string;
  htmlPath: string;
  iconPath: string;
}

export interface Hub { open(): void; notifyChanged(): void; }

const CHANNELS = [
  'hub:openService', 'hub:addService', 'hub:removeService',
  'hub:setServiceSetting', 'hub:setGlobal', 'hub:quit',
];

export function createHub(deps: HubDeps): Hub {
  let win: BrowserWindow | undefined;

  const notifyChanged = (): void => {
    if (win && !win.isDestroyed()) win.webContents.send('hub:state', deps.buildState());
  };

  // Register handlers once; guard against a second createHub (dev reloads).
  ipcMain.removeHandler('hub:getState');
  for (const c of CHANNELS) ipcMain.removeAllListeners(c);

  ipcMain.handle('hub:getState', () => deps.buildState());
  ipcMain.on('hub:openService', (_e, id: string) => { deps.openService(id); notifyChanged(); });
  ipcMain.on('hub:addService', (_e, m: { id: string; customUrl?: string }) => { deps.addService(m.id, m.customUrl); notifyChanged(); });
  ipcMain.on('hub:removeService', (_e, m: { id: string; deleteData: boolean }) => { deps.removeService(m.id, m.deleteData); notifyChanged(); });
  ipcMain.on('hub:setServiceSetting', (_e, m: { id: string; patch: ServicePatch }) => { deps.setServiceSetting(m.id, m.patch); notifyChanged(); });
  ipcMain.on('hub:setGlobal', (_e, patch: GlobalPatch) => { deps.setGlobal(patch); notifyChanged(); });
  ipcMain.on('hub:quit', () => deps.quitApp());

  const open = (): void => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
    win = new BrowserWindow({
      width: 520,
      height: 640,
      title: 'Loft',
      icon: deps.iconPath,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.on('closed', () => { win = undefined; });
    void win.loadFile(deps.htmlPath);
  };

  return { open, notifyChanged };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/hubWindow.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/hubWindow.ts tests/hubWindow.test.ts
git commit -m "feat(electron): hub window + ipcMain handlers (hubWindow.ts)"
```

---

### Task 8: Svelte UI — main page (list / grid / welcome)

Replace the Task-1 placeholder with the real store + main page. Verified by build + manual (a component test lands in Task 11).

**Files:**
- Create: `src/renderer/hub/lib/store.ts`, `src/renderer/hub/lib/hub.d.ts`
- Create: `src/renderer/hub/components/ServiceRow.svelte`, `AvailableTile.svelte`, `ServiceList.svelte`
- Modify: `src/renderer/hub/App.svelte`, `src/renderer/hub/app.css`

**Interfaces:**
- Consumes: `window.loftHub` (Task 6), `HubState`/`HubService` (Task 5).
- Produces: `store.ts` exports `hubState` (a Svelte store of `HubState | null`) and `initStore()`.

- [ ] **Step 1: Ambient type for `window.loftHub` — `src/renderer/hub/lib/hub.d.ts`**

```ts
import type { HubState, ServicePatch, GlobalPatch } from '../../../shared/hubTypes';

declare global {
  interface Window {
    loftHub: {
      getState(): Promise<HubState>;
      onStateChanged(cb: (s: HubState) => void): () => void;
      openService(id: string): void;
      addService(id: string, customUrl?: string): void;
      removeService(id: string, deleteData: boolean): void;
      setServiceSetting(id: string, patch: ServicePatch): void;
      setGlobal(patch: GlobalPatch): void;
      quit(): void;
    };
  }
}
export {};
```

- [ ] **Step 2: `src/renderer/hub/lib/store.ts`**

```ts
import { writable } from 'svelte/store';
import type { HubState } from '../../../shared/hubTypes';

export const hubState = writable<HubState | null>(null);

export async function initStore(): Promise<void> {
  hubState.set(await window.loftHub.getState());
  window.loftHub.onStateChanged((s) => hubState.set(s));
}
```

- [ ] **Step 3: `src/renderer/hub/components/ServiceRow.svelte`**

```svelte
<script lang="ts">
  import type { HubService } from '../../../shared/hubTypes';
  let { svc, onGear }: { svc: HubService; onGear: (id: string) => void } = $props();
</script>

<div class="row">
  <img class="icon" src={`loft://icon/${svc.id}`} alt="" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')} />
  <div class="meta">
    <span class="name">{svc.displayName}</span>
    <span class="status" class:on={svc.running}>{svc.running ? 'Running' : 'Not running'}</span>
  </div>
  {#if svc.badgesEnabled && svc.badge > 0}<span class="badge">{svc.badge}</span>{/if}
  <button class="primary" onclick={() => window.loftHub.openService(svc.id)}>Open</button>
  <button class="gear" title="Settings" onclick={() => onGear(svc.id)}>⚙</button>
</div>

<style>
  .row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; }
  .icon { width: 28px; height: 28px; border-radius: 6px; }
  .meta { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .name { font-weight: 600; }
  .status { font-size: 0.8em; opacity: 0.6; }
  .status.on { color: var(--accent); opacity: 1; }
  .badge { background: var(--accent); color: #fff; border-radius: 999px; padding: 1px 8px; font-size: 0.8em; font-weight: 700; }
  button { border: 0; border-radius: 8px; padding: 6px 12px; cursor: pointer; font: inherit; }
  .primary { background: var(--accent); color: #fff; }
  .gear { background: transparent; font-size: 1.1em; }
</style>
```

Note on `loft://icon/<id>`: register a custom protocol in Task 11 (`protocol.handle('loft', …)`) that serves `iconsDir/<id>.png`. This keeps images CSP-clean (`img-src 'self'`) and avoids `file://` path juggling in the renderer.

- [ ] **Step 4: `src/renderer/hub/components/AvailableTile.svelte`**

```svelte
<script lang="ts">
  import type { HubService } from '../../../shared/hubTypes';
  let { svc }: { svc: HubService } = $props();

  function add() {
    if (svc.selfHosted) {
      const url = window.prompt(`Server URL for ${svc.displayName}`, '');
      if (url === null) return;
      window.loftHub.addService(svc.id, url.trim() || undefined);
    } else {
      window.loftHub.addService(svc.id);
    }
  }
</script>

<div class="tile">
  <img class="icon" src={`loft://icon/${svc.id}`} alt="" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')} />
  <span class="name">{svc.displayName}</span>
  <button class="pill" onclick={add}>Add</button>
</div>

<style>
  .tile { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px; background: var(--card); border-radius: 12px; }
  .icon { width: 44px; height: 44px; border-radius: 10px; }
  .name { font-weight: 600; }
  .pill { border: 0; border-radius: 999px; padding: 5px 16px; background: var(--accent); color: #fff; cursor: pointer; font: inherit; }
</style>
```

- [ ] **Step 5: `src/renderer/hub/components/ServiceList.svelte`**

```svelte
<script lang="ts">
  import type { HubState } from '../../../shared/hubTypes';
  import ServiceRow from './ServiceRow.svelte';
  import AvailableTile from './AvailableTile.svelte';
  let { state, onGear }: { state: HubState; onGear: (id: string) => void } = $props();

  const installed = $derived(state.services.filter((s) => s.installed));
  const available = $derived(state.services.filter((s) => !s.installed));
</script>

{#if installed.length === 0}
  <section class="welcome">
    <img class="logo" src="loft://icon/loft" alt="" />
    <h2>Welcome to Loft</h2>
    <p>Add a messaging service below to get started.</p>
  </section>
{:else}
  <section>
    <h3>Installed</h3>
    <div class="list">
      {#each installed as svc (svc.id)}<ServiceRow {svc} {onGear} />{/each}
    </div>
  </section>
{/if}

{#if available.length > 0}
  <section>
    <h3>Available</h3>
    <div class="grid">
      {#each available as svc (svc.id)}<AvailableTile {svc} />{/each}
    </div>
  </section>
{/if}

<style>
  section { margin: 18px 0; }
  h3 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; margin: 0 0 8px; }
  .list { background: var(--card); border-radius: 12px; overflow: hidden; }
  .list > :global(.row + .row) { border-top: 1px solid var(--divider); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .welcome { text-align: center; padding: 32px 0; }
  .logo { width: 64px; height: 64px; }
</style>
```

- [ ] **Step 6: Rewrite `src/renderer/hub/App.svelte`**

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { hubState, initStore } from './lib/store';
  import ServiceList from './components/ServiceList.svelte';

  let view = $state<{ page: 'main' } | { page: 'detail'; id: string } | { page: 'settings' } | { page: 'about' }>({ page: 'main' });
  let menuOpen = $state(false);
  onMount(initStore);

  function gear(id: string) { view = { page: 'detail', id }; }
</script>

<header>
  <span class="title">Loft</span>
  <div class="menu">
    <button class="hamburger" onclick={() => (menuOpen = !menuOpen)} aria-label="Menu">≡</button>
    {#if menuOpen}
      <div class="dropdown" role="menu">
        <button onclick={() => { view = { page: 'settings' }; menuOpen = false; }}>Settings</button>
        <button onclick={() => { view = { page: 'about' }; menuOpen = false; }}>About</button>
        <button onclick={() => window.loftHub.quit()}>Quit</button>
      </div>
    {/if}
  </div>
</header>

<main>
  {#if $hubState}
    {#if view.page === 'main'}
      <ServiceList state={$hubState} onGear={gear} />
    {:else}
      <button class="back" onclick={() => (view = { page: 'main' })}>‹ Back</button>
      <!-- detail / settings / about panels land in Task 9 -->
    {/if}
  {/if}
</main>

<style>
  header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--divider); }
  .title { font-weight: 700; }
  .menu { position: relative; }
  .hamburger { border: 0; background: transparent; font-size: 1.3em; cursor: pointer; }
  .dropdown { position: absolute; right: 0; top: 100%; background: var(--card); border: 1px solid var(--divider); border-radius: 8px; display: flex; flex-direction: column; min-width: 140px; z-index: 10; }
  .dropdown button { border: 0; background: transparent; text-align: left; padding: 8px 12px; cursor: pointer; }
  .dropdown button:hover { background: var(--divider); }
  main { padding: 0 16px 16px; }
  .back { border: 0; background: transparent; cursor: pointer; padding: 12px 0; font: inherit; opacity: 0.7; }
</style>
```

- [ ] **Step 7: Fill in the theme — `src/renderer/hub/app.css`**

```css
:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, sans-serif;
  --bg: #ffffff; --card: #f4f4f6; --divider: #e2e2e6; --accent: #3584e4; --fg: #1a1a1a;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #1e1e20; --card: #2a2a2d; --divider: #3a3a3f; --accent: #62a0ea; --fg: #ededed; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); }
```

- [ ] **Step 8: Build and manually verify**

Run: `npx vite build && ls dist/renderer/hub/index.html`
Expected: build succeeds. (Runtime verification is part of the Task 11 manual matrix, once the protocol + wiring exist.)

- [ ] **Step 9: Commit**

```bash
git add src/renderer/hub
git commit -m "feat(electron): hub main page (Svelte store + installed list + available grid)"
```

---

### Task 9: Svelte UI — service detail, global settings, about

**Files:**
- Create: `src/renderer/hub/components/ServiceDetail.svelte`, `GlobalSettings.svelte`, `About.svelte`
- Modify: `src/renderer/hub/App.svelte` (render the panels)

**Interfaces:**
- Consumes: `window.loftHub`, `$hubState`.

- [ ] **Step 1: `src/renderer/hub/components/ServiceDetail.svelte`**

```svelte
<script lang="ts">
  import type { HubState } from '../../../shared/hubTypes';
  let { state, id, onBack }: { state: HubState; id: string; onBack: () => void } = $props();
  const svc = $derived(state.services.find((s) => s.id === id)!);

  function set(patch: Parameters<typeof window.loftHub.setServiceSetting>[1]) {
    window.loftHub.setServiceSetting(id, patch);
  }
  let urlDraft = $state('');
  $effect(() => { urlDraft = svc?.customUrl ?? ''; });

  function remove() {
    const del = window.confirm(`Remove ${svc.displayName}?\n\nClick OK to also delete its login data, Cancel to keep it.`);
    // Two-step: confirm removal, then whether to wipe data.
    if (!window.confirm(`Remove ${svc.displayName}?`)) return;
    window.loftHub.removeService(id, del);
    onBack();
  }
</script>

{#if svc}
  <h2>{svc.displayName}</h2>

  {#if svc.selfHosted}
    <label class="field">
      <span>Server URL</span>
      <input bind:value={urlDraft} placeholder="cloud.example.com" onchange={() => set({ customUrl: urlDraft.trim() })} />
    </label>
  {/if}

  <label class="toggle">
    <input type="checkbox" checked={svc.openOnStartup} onchange={(e) => set({ openOnStartup: e.currentTarget.checked })} />
    <span>Open on startup</span>
  </label>
  <label class="toggle">
    <input type="checkbox" checked={svc.badgesEnabled} onchange={(e) => set({ badgesEnabled: e.currentTarget.checked })} />
    <span>Show unread badge</span>
  </label>
  <label class="toggle">
    <input type="checkbox" checked={svc.dnd} onchange={(e) => set({ dnd: e.currentTarget.checked })} />
    <span>Do Not Disturb</span>
  </label>

  <button class="danger" onclick={remove}>Remove {svc.displayName}…</button>
{/if}

<style>
  h2 { margin: 8px 0 16px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin: 12px 0; }
  .field input { padding: 8px; border-radius: 8px; border: 1px solid var(--divider); background: var(--bg); color: var(--fg); }
  .toggle { display: flex; align-items: center; gap: 10px; padding: 10px 0; }
  .toggle span { flex: 1; }
  .danger { margin-top: 24px; border: 0; border-radius: 999px; padding: 8px 18px; background: #c01c28; color: #fff; cursor: pointer; }
</style>
```

Note: the two-`confirm` remove flow above is intentionally simple (no custom dialog). First confirm = "also delete data?", second = "remove?". Keep exactly as written; a nicer modal is post-v1.

- [ ] **Step 2: `src/renderer/hub/components/GlobalSettings.svelte`**

```svelte
<script lang="ts">
  import type { HubState, TrayBackend } from '../../../shared/hubTypes';
  let { state }: { state: HubState } = $props();
  const g = $derived(state.globals);
</script>

<h2>Settings</h2>

<label class="field">
  <span>Tray backend <em>(applies on restart)</em></span>
  <select value={g.trayBackend} onchange={(e) => window.loftHub.setGlobal({ trayBackend: e.currentTarget.value as TrayBackend })}>
    <option value="auto">Auto (recommended)</option>
    <option value="gnome-panel">GNOME Panel</option>
    <option value="sni">System Tray (SNI)</option>
  </select>
</label>

<label class="toggle">
  <input type="checkbox" checked={g.startAtLogin} onchange={(e) => window.loftHub.setGlobal({ startAtLogin: e.currentTarget.checked })} />
  <span>Start Loft at login</span>
</label>

<style>
  h2 { margin: 8px 0 16px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin: 12px 0; }
  .field em { opacity: 0.6; font-style: normal; font-size: 0.85em; }
  .field select { padding: 8px; border-radius: 8px; border: 1px solid var(--divider); background: var(--bg); color: var(--fg); }
  .toggle { display: flex; align-items: center; gap: 10px; padding: 10px 0; }
  .toggle span { flex: 1; }
</style>
```

- [ ] **Step 3: `src/renderer/hub/components/About.svelte`**

```svelte
<script lang="ts">
  let { version }: { version: string } = $props();
</script>

<section class="about">
  <img class="logo" src="loft://icon/loft" alt="" />
  <h2>Loft</h2>
  <p class="ver">Version {version}</p>
  <p>Desktop integration for messaging apps on Linux.</p>
  <p><a href="https://github.com/keithvassallomt/loft" target="_blank" rel="noreferrer">github.com/keithvassallomt/loft</a></p>
  <p class="lic">GPL-3.0-or-later</p>
</section>

<style>
  .about { text-align: center; padding: 24px 0; }
  .logo { width: 72px; height: 72px; }
  .ver { opacity: 0.7; }
  .lic { opacity: 0.5; font-size: 0.85em; }
</style>
```

- [ ] **Step 4: Wire the panels into `App.svelte`**

Replace the `{:else}` block inside `<main>` (the `<!-- detail / settings / about panels land in Task 9 -->` placeholder) with:

```svelte
      <button class="back" onclick={() => (view = { page: 'main' })}>‹ Back</button>
      {#if view.page === 'detail'}
        <ServiceDetail state={$hubState} id={view.id} onBack={() => (view = { page: 'main' })} />
      {:else if view.page === 'settings'}
        <GlobalSettings state={$hubState} />
      {:else if view.page === 'about'}
        <About version={__LOFT_VERSION__} />
      {/if}
```

And add the imports to the `<script>` block of `App.svelte`:

```ts
  import ServiceDetail from './components/ServiceDetail.svelte';
  import GlobalSettings from './components/GlobalSettings.svelte';
  import About from './components/About.svelte';
```

- [ ] **Step 5: Define `__LOFT_VERSION__` at build time**

In `vite.config.ts`, add a `define` so the About panel gets the version without importing `package.json` at runtime. Add near the top of the config object:

```ts
  define: {
    __LOFT_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0-dev'),
  },
```

And declare it for the renderer typecheck in `src/renderer/hub/lib/hub.d.ts`. Because that file is a module (it has `import`/`export`), a bare `declare const` would be module-scoped, not global — so add the declaration **inside** the existing `declare global { … }` block, alongside `interface Window`:

```ts
declare global {
  const __LOFT_VERSION__: string;
  interface Window {
    // …existing loftHub declaration unchanged…
  }
}
```

- [ ] **Step 6: Build**

Run: `npx vite build`
Expected: build succeeds with all panels compiled.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/hub vite.config.ts
git commit -m "feat(electron): hub service-detail, global settings, about panels"
```

---

### Task 10: Wire the hub into `index.ts`

The integration task: CLI no-service → hub; construct the deps; first-launch auto-add; `openOnStartup` at boot; tray `onShowHub` → hub; `notifyChanged` at every state-change site; the `loft://icon` protocol.

**Files:**
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `createHub`/`HubDeps` (Task 7), `buildHubState`/`HubStateDeps` (Task 5), `addService`/`removeService` (Task 4), `setAutostart`/`isAutostartEnabled` (Task 3), `ensureHubDesktopEntry` (Task 3), `iconsDir` (Task 2).

- [ ] **Step 1: Add imports (top of `src/main/index.ts`, with the other `./` imports)**

```ts
import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { createHub, type HubDeps } from './hubWindow';
import { buildHubState } from './hubState';
import { addService, removeService } from './install';
import { setAutostart, isAutostartEnabled } from './autostart';
import { ensureHubDesktopEntry } from './desktop';
import { iconsDir } from './paths';
import type { ServicePatch, GlobalPatch } from '../shared/hubTypes';
```

- [ ] **Step 2: Add module-level `hub` handle + the icon source dir**

Below `let bgStatus …` near the top:

```ts
let hub: ReturnType<typeof createHub> | undefined;
// Bundled PNGs live in dist/assets/icons (copy-assets); one dir up from dist/main.
const iconSourceDir = join(__dirname, '..', 'assets', 'icons');
```

- [ ] **Step 3: First-launch auto-add inside `openService`**

In `openService`, replace:

```ts
  if (!config.services[def.id]) config.services[def.id] = {};
```

with:

```ts
  // First launch of a service implicitly Adds it (writes its launcher + icon) so a
  // directly-launched service shows up as Installed in the hub.
  if (!config.services[def.id]) {
    addService(def, config, { execPath: process.execPath, iconSourceDir });
    saveConfig(configPath(), config);
  }
```

- [ ] **Step 4: `notifyChanged` at state-change sites**

Add `hub?.notifyChanged();` immediately after each existing `bgStatus?.refresh();` call (in `openService` and `quitService`), and at the end of `setServiceDnd`, `setGlobalDnd`, and the `service:badge` ipc handler (after `bgStatus?.refresh()`). Example — the badge handler becomes:

```ts
    currentBadge.set(sw.def.id, payload.count);
    bgStatus?.refresh();
    hub?.notifyChanged();
```

- [ ] **Step 5: Register the `loft://icon/<id>` protocol scheme (before `app.whenReady`)**

Add near the top, right after `app.setPath('userData', …)`:

```ts
// Custom scheme the hub renderer uses for service/app icons (keeps img-src 'self'
// clean and avoids file:// path juggling). Registered as privileged so it can load
// from the renderer under CSP.
protocol.registerSchemesAsPrivileged([
  { scheme: 'loft', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
```

- [ ] **Step 6: Serve `loft://` + build the hub inside `app.whenReady`**

At the start of the `app.whenReady().then(async () => {` body (before the GNOME deploy block), add the protocol handler:

```ts
    // loft://icon/<id> -> the deployed icon (added services) or the bundled asset
    // (available/not-yet-added services + the 'loft' app icon). Read from disk and
    // return the bytes: the main-process global fetch() does NOT support file://.
    protocol.handle('loft', async (req) => {
      const name = new URL(req.url).pathname.replace(/^\/+/, '') || 'loft';
      for (const file of [join(iconsDir(), `${name}.png`), join(iconSourceDir, `${name}.png`)]) {
        try {
          return new Response(await readFile(file), { headers: { 'content-type': 'image/png' } });
        } catch { /* try the next candidate */ }
      }
      return new Response(null, { status: 404 });
    });
```

Then, after the tray/notifications setup (near where `startLoftDbusService` is called), construct the hub:

```ts
    // Ensure the hub's own launcher exists for dev/AppImage (packaged/Flatpak ship it).
    try {
      ensureHubDesktopEntry({ execPath: process.execPath, iconSourceDir });
    } catch (err) { console.error('ensureHubDesktopEntry failed:', err); }

    const hubDeps: HubDeps = {
      buildState: () => buildHubState({
        services: SERVICES,
        config,
        running: (id) => windows.has(id),
        visible: (id) => windows.get(id)?.window.isVisible() ?? false,
        badge: (id) => currentBadge.get(id) ?? 0,
        trayBackend: config.trayBackend ?? 'auto',
        startAtLogin: isAutostartEnabled(),
      }),
      openService: (id) => { const d = getService(id); if (d) openService(d, false); },
      addService: (id, customUrl) => {
        const d = getService(id); if (!d) return;
        addService(d, config, { execPath: process.execPath, iconSourceDir, customUrl });
        saveConfig(configPath(), config);
      },
      removeService: (id, deleteData) => {
        const d = getService(id); if (!d) return;
        quitService(id); // tear down a running window first
        removeService(d, config, deleteData);
        saveConfig(configPath(), config);
      },
      setServiceSetting: (id, patch: ServicePatch) => {
        config.services[id] = { ...config.services[id], ...patch };
        saveConfig(configPath(), config);
        if (patch.dnd !== undefined) { tray?.setDnd(id, patch.dnd); notifications?.setServiceDnd(id, patch.dnd); windows.get(id)?.pushDnd(patch.dnd); }
        if (patch.badgesEnabled !== undefined) {
          const sw = windows.get(id);
          const count = currentBadge.get(id) ?? 0;
          // Re-push the current badge so enabling shows it immediately; disabling clears the indicator.
          sw?.setBadge(patch.badgesEnabled ? count : 0);
          tray?.setBadge(id, patch.badgesEnabled ? count : 0);
        }
        if (patch.customUrl !== undefined) {
          const d = getService(id); const sw = windows.get(id);
          if (d && sw) sw.serviceView.webContents.loadURL(effectiveUrl(d, patch.customUrl || undefined));
        }
      },
      setGlobal: (patch: GlobalPatch) => {
        if (patch.trayBackend !== undefined) { config.trayBackend = patch.trayBackend; saveConfig(configPath(), config); }
        if (patch.startAtLogin !== undefined) setAutostart(patch.startAtLogin, { execPath: process.execPath, iconSourceDir });
      },
      quitApp: () => { quitting = true; app.quit(); },
      preloadPath: join(__dirname, '..', 'preload', 'hub.js'),
      htmlPath: join(__dirname, '..', 'renderer', 'hub', 'index.html'),
      iconPath: join(iconSourceDir, 'loft.png'),
    };
    hub = createHub(hubDeps);
```

Note: add `effectiveUrl` and `SERVICES` to the existing `./registry` import (`import { getService, listServices, SERVICES, ServiceDef, effectiveUrl } from './registry';` — keep whatever is already imported, just add the missing names).

- [ ] **Step 7: CLI no-service → hub; open-on-startup at boot**

**Delete** the current fallback block from its position near the top of `whenReady` (it currently runs right after the GNOME deploy block, before the tray setup):

```ts
    const args = parseArgs(process.argv);
    const def = args.service ? getService(args.service) : undefined;
    if (def) openService(def, args.minimized);
    // With no --service, Stage 1 opens WhatsApp so there is always a window to see.
    else openService(getService('whatsapp')!, args.minimized);
```

and **add** the following in its place **immediately after `hub = createHub(hubDeps);`** (Step 6), so `hub`, `tray`, and `notifications` all exist before the first window opens — this also removes the old bootstrap-ordering hazard (the "reflect windows already open" loops in the tray/notifications setup then simply find nothing and `openService` does all the wiring itself):

```ts
    const args = parseArgs(process.argv);
    const def = args.service ? getService(args.service) : undefined;
    if (def) {
      openService(def, args.minimized);
    } else {
      // No --service: open every service flagged open-on-startup (minimized to tray),
      // and show the hub as the app's home surface.
      for (const id of Object.keys(config.services)) {
        if (config.services[id]?.openOnStartup) { const d = getService(id); if (d) openService(d, true); }
      }
      if (!args.minimized) hub!.open();
    }
```

- [ ] **Step 8: Tray `onShowHub` → open the hub**

Replace:

```ts
        onShowHub: () => { for (const sw of windows.values()) { sw.show(); break; } }, // Stage 4: real hub
```

with:

```ts
        onShowHub: () => hub?.open(),
```

- [ ] **Step 9: Build + full test suite**

Run: `npm run build && npm test`
Expected: `tsc` clean, all bundles + `vite build` succeed, all tests pass (the pre-existing suite plus Tasks 2–7).

- [ ] **Step 10: Manual smoke (Keith)**

```bash
npm run start   # no --service → hub window opens
```

Verify: Available grid shows all six; Add moves a service to Installed and writes `~/.local/share/applications/loft-<id>.desktop`; Open launches/focuses the right window and the row flips to Running with a live badge; gear toggles persist to `~/.config/loft/config.json`; Settings → Start-at-login writes/removes `~/.config/autostart/chat.loft.Loft.desktop`; Remove (with delete-data) removes the launcher and wipes `~/.local/share/loft/Partitions/<id>`; tray → Show Hub reopens it.

- [ ] **Step 11: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(electron): wire hub into app entry (CLI, auto-add, open-on-startup, tray, loft:// icons)"
```

---

### Task 11 (optional): one Svelte component test + `svelte-check`

Highest-value UI safety net. Skip if the `@testing-library/svelte` + Vitest setup fights the environment — the core logic is already covered by Tasks 2–7.

**Files:**
- Modify: `vitest.config.ts`
- Modify: `package.json` (add a `check` script)
- Create: `tests/serviceRow.test.ts`

- [ ] **Step 1: Add the Svelte plugin to `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Add the Svelte plugin so `.svelte` imports compile under Vitest. Env stays 'node'
// for the whole suite; the one component test opts into jsdom via its first-line
// `// @vitest-environment jsdom` docblock (environmentMatchGlobs was removed in Vitest 4).
export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 2: Write the component test — `tests/serviceRow.test.ts`**

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ServiceRow from '../src/renderer/hub/components/ServiceRow.svelte';
import type { HubService } from '../src/shared/hubTypes';

const svc: HubService = {
  id: 'whatsapp', displayName: 'WhatsApp', selfHosted: false, installed: true,
  running: true, visible: true, badge: 3, badgesEnabled: true, dnd: false,
  openOnStartup: false, customUrl: '',
};

beforeEach(() => {
  (globalThis as unknown as { window: { loftHub: unknown } }).window.loftHub = { openService: vi.fn() };
});

describe('ServiceRow', () => {
  it('shows name, running status and badge', () => {
    render(ServiceRow, { props: { svc, onGear: vi.fn() } });
    expect(screen.getByText('WhatsApp')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('hides the badge when badgesEnabled is false', () => {
    render(ServiceRow, { props: { svc: { ...svc, badgesEnabled: false }, onGear: vi.fn() } });
    expect(screen.queryByText('3')).toBeNull();
  });
});
```

- [ ] **Step 3: Add a `check` script to `package.json`**

```json
    "check": "svelte-check --tsconfig ./tsconfig.json --workspace src/renderer/hub",
```

Install the checker: `npm install --save-dev svelte-check@^4.7.2`.

- [ ] **Step 4: Run the component test**

Run: `npx vitest run tests/serviceRow.test.ts`
Expected: PASS (2 tests). If the Svelte-in-Vitest harness errors, revert `vitest.config.ts`, delete this test, and note it skipped in the ledger — the stage is still complete.

- [ ] **Step 5: Run the whole suite once more**

Run: `npm test`
Expected: all green (node tests unaffected by the added plugin).

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts package.json package-lock.json tests/serviceRow.test.ts
git commit -m "test(electron): ServiceRow component test + svelte-check script"
```

---

## Post-plan

- **Final whole-branch review** (read-only) before sign-off, per the project's SDD flow.
- **Manual matrix** is Task 10 Step 10 + Task 9's panels, run by Keith on GNOME.
- **Ledger:** append Stage 4 status to `.superpowers/sdd/progress.md`.
- **Unblocks:** Stage 4.5 (KDE) then Stage 5 (electron-builder packaging — which then owns the canonical `chat.loft.Loft.desktop` + icon install that `ensureHubDesktopEntry`/`deployServiceIcon` write at runtime for dev).

## Self-review notes (author)

- **Spec coverage:** hub window (T7,T10) · installed list/available grid/welcome (T8) · gear per-service settings incl. custom URL/open-on-startup/badges/DND/remove+delete-data (T9,T4,T10) · global tray-backend + start-at-login (T9,T3,T10) · About (T9) · live push IPC / no polling (T5,T6,T7,T10) · `.desktop` per-service + hub entry (T3) · autostart one-entry + openOnStartup (T3,T10) · first-run welcome, no Chrome page (T8) · Svelte+Vite build (T1). All spec §-items map to a task.
- **Deferred (per spec §6), intentionally absent:** notifications-on/off, per-service start-minimized, default-zoom, explicit theme override, tray-backend live switch.
- **Type consistency:** `HubService`/`HubState`/`ServicePatch`/`GlobalPatch` defined once in `shared/hubTypes.ts` (T5) and consumed unchanged by preload (T6), hubWindow (T7), renderer (T8,T9). `HubStateDeps.badge` = true count everywhere. `desktopExec({env,execPath})` signature identical in T3 and its callers (T3,T10). `addService(def,cfg,opts)` / `removeService(def,cfg,deleteData,env)` identical in T4 and T10.
