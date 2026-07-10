# Electron Loft — Stage 1: Walking Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable Electron app that opens a per-service frameless window (with our own titlebar view + close-to-tray) for any of the six services, each in its own persistent session with a Chrome UA and the POC permission/display/popup handlers, driven by a data-driven service registry and a single-instance lock.

**Architecture:** One Electron main process. Pure, Electron-free modules (registry, CLI, UA, layout, config) are unit-tested with Vitest; the Electron-integration modules (session, service window, app entry) are wired from those pure pieces and verified by driving the real app. Each service window hosts two `WebContentsView`s — a titlebar view (our chrome) pinned to the top and the service view (remote URL) filling the rest.

**Tech Stack:** Electron 43, TypeScript 5.9 (CommonJS output), Vitest 4.1, Node 22. No renderer framework yet (the titlebar is plain HTML/TS; Svelte arrives with the hub in Stage 4).

**Scope note:** This is Stage 1 of 5 (see `docs/superpowers/specs/2026-07-09-electron-loft-v1-parity-design.md` §15). **Explicitly NOT in this stage:** badge scraping, notifications, DND, tray icon, hub window, GNOME Shell helper / KWin, autostart, packaging. Those are Stages 2–5.

**Repository layout:** The Electron rewrite lives in the tracked sub-folder **`electron/`** at the repo root, alongside the existing Rust app (which stays intact and buildable during the transition; it is flattened to root and retired once the rewrite is ready). **All file paths in this plan are relative to `electron/`** (e.g. `package.json` → `electron/package.json`, `src/main/index.ts` → `electron/src/main/index.ts`), and all `npm`/`electron`/`git` commands are run from inside `electron/`. The one exception: `docs/superpowers/...` paths are repo-root-relative.

## Global Constraints

- Electron `^43.1.0` (bundles Chromium 150). Verify with `npx electron --version` after install.
- TypeScript `~5.9` (CommonJS module output, `target: ES2022`). TS 7.0 exists but is not adopted here.
- Vitest `^4.1` for unit tests.
- App id / appUserModelId: `chat.loft.Loft`.
- Chrome UA string must contain **no** `Electron` (or app-name) token.
- Data dir: `app.setPath('userData', '~/.local/share/loft')` (respect `$XDG_DATA_HOME`). Config file: `$XDG_CONFIG_HOME/loft/config.json` (default `~/.config/loft/config.json`).
- Every npm script that runs `electron` must be prefixed with `env -u ELECTRON_RUN_AS_NODE` (VS Code's integrated terminal exports it and it would make Electron run as plain Node with no window).
- Pure modules (`registry.ts`, `cli.ts`, `ua.ts`, `layout.ts`, `config.ts`) MUST NOT `import` runtime values from `electron` (type-only imports are fine) so Vitest can import them without an Electron runtime.
- Services: `whatsapp`, `messenger`, `slack`, `telegram`, `element`, `talk` (Element + Talk are self-hostable → `customUrl`).

---

## File Structure

- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` — project config
- `src/main/index.ts` — app entry: single-instance lock, app paths, `whenReady`, CLI routing, IPC handlers
- `src/main/cli.ts` — pure argv parser
- `src/main/registry.ts` — pure service registry + `effectiveUrl`
- `src/main/ua.ts` — pure Chrome UA builder
- `src/main/layout.ts` — pure titlebar/service view layout math
- `src/main/config.ts` — JSON config load/save + paths (node fs/os/path only)
- `src/main/session.ts` — `isAllowedPermission` (pure) + `configureSession` (Electron)
- `src/main/serviceWindow.ts` — `createServiceWindow` (Electron: window + views + wiring)
- `src/preload/titlebar.ts` — contextBridge bridge for the titlebar view
- `src/renderer/titlebar/index.html`, `titlebar.ts`, `titlebar.css` — the titlebar UI
- `tests/*.test.ts` — Vitest unit tests for the pure modules

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/main/index.ts` (minimal blank-window entry)

**Interfaces:**
- Consumes: nothing.
- Produces: working `npm run build`, `npm test`, `npm start` (opens a blank window). `dist/main/index.js` is the Electron entry.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "loft",
  "version": "0.3.0-dev",
  "description": "Linux desktop integration for messaging web apps",
  "license": "GPL-3.0-or-later",
  "main": "dist/main/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json && npm run copy-assets",
    "copy-assets": "mkdir -p dist/renderer/titlebar && cp src/renderer/titlebar/index.html src/renderer/titlebar/titlebar.css dist/renderer/titlebar/",
    "start": "npm run build && env -u ELECTRON_RUN_AS_NODE electron .",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install --save-dev electron@^43.1.0 typescript@~5.9 vitest@^4.1 @types/node@^22
```
Expected: installs without errors; `npx electron --version` (after `env -u ELECTRON_RUN_AS_NODE npx electron --version`) prints `v43.x`.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "sourceMap": true,
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Create `.gitignore`**

```gitignore
node_modules/
dist/
*.log
```

- [ ] **Step 6: Create minimal `src/main/index.ts`**

```ts
import { app, BrowserWindow } from 'electron';

app.setName('Loft');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1100, height: 800 });
  win.loadURL('about:blank');
});

app.on('window-all-closed', () => app.quit());
```

- [ ] **Step 7: Verify build + start**

Run: `npm start`
Expected: TypeScript compiles, a blank 1100×800 Electron window opens. Close it; the process exits.

- [ ] **Step 8: Verify the test runner works (no tests yet)**

Run: `npm test`
Expected: Vitest runs and reports "no test files found" (exit 0) — confirms the runner is wired.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/main/index.ts
git commit -m "chore: scaffold Electron + TypeScript + Vitest project"
```

---

## Task 2: Service registry

**Files:**
- Create: `src/main/registry.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ServiceDef { id: string; displayName: string; url: string; selfHosted: boolean; origins: string[]; }`
  - `const SERVICES: readonly ServiceDef[]`
  - `function getService(id: string): ServiceDef | undefined`
  - `function listServices(): readonly ServiceDef[]`
  - `function effectiveUrl(service: ServiceDef, customUrl?: string): string`

- [ ] **Step 1: Write the failing test**

`tests/registry.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { SERVICES, getService, listServices, effectiveUrl } from '../src/main/registry';

describe('service registry', () => {
  it('contains the six services', () => {
    expect(listServices().map((s) => s.id).sort()).toEqual(
      ['element', 'messenger', 'slack', 'talk', 'telegram', 'whatsapp'],
    );
  });

  it('looks up a service by id', () => {
    expect(getService('whatsapp')?.url).toBe('https://web.whatsapp.com/');
    expect(getService('nope')).toBeUndefined();
  });

  it('marks element and talk as self-hosted', () => {
    expect(getService('element')?.selfHosted).toBe(true);
    expect(getService('talk')?.selfHosted).toBe(true);
    expect(getService('whatsapp')?.selfHosted).toBe(false);
  });

  it('effectiveUrl prefers a customUrl only for self-hosted services', () => {
    const el = getService('element')!;
    expect(effectiveUrl(el, 'https://chat.example.org/')).toBe('https://chat.example.org/');
    expect(effectiveUrl(el, undefined)).toBe(el.url);
    const wa = getService('whatsapp')!;
    expect(effectiveUrl(wa, 'https://evil.example/')).toBe(wa.url);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL — cannot find module `../src/main/registry`.

- [ ] **Step 3: Write the implementation**

`src/main/registry.ts`:
```ts
export interface ServiceDef {
  id: string;
  displayName: string;
  url: string;
  selfHosted: boolean;
  origins: string[];
}

export const SERVICES: readonly ServiceDef[] = [
  { id: 'whatsapp', displayName: 'WhatsApp', url: 'https://web.whatsapp.com/', selfHosted: false, origins: ['https://web.whatsapp.com'] },
  { id: 'messenger', displayName: 'Messenger', url: 'https://www.facebook.com/messages/', selfHosted: false, origins: ['https://www.facebook.com'] },
  { id: 'slack', displayName: 'Slack', url: 'https://app.slack.com/client/', selfHosted: false, origins: ['https://app.slack.com'] },
  { id: 'telegram', displayName: 'Telegram', url: 'https://web.telegram.org/a/', selfHosted: false, origins: ['https://web.telegram.org'] },
  { id: 'element', displayName: 'Element', url: 'https://app.element.io/', selfHosted: true, origins: ['https://app.element.io'] },
  { id: 'talk', displayName: 'NextCloud Talk', url: 'https://example.invalid/', selfHosted: true, origins: [] },
];

export function listServices(): readonly ServiceDef[] {
  return SERVICES;
}

export function getService(id: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.id === id);
}

export function effectiveUrl(service: ServiceDef, customUrl?: string): string {
  if (service.selfHosted && customUrl && customUrl.trim().length > 0) return customUrl;
  return service.url;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/registry.ts tests/registry.test.ts
git commit -m "feat: data-driven service registry"
```

---

## Task 3: CLI argument parser

**Files:**
- Create: `src/main/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface CliArgs { service?: string; verbose: boolean; minimized: boolean; }`
  - `function parseArgs(argv: string[]): CliArgs`

- [ ] **Step 1: Write the failing test**

`tests/cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/main/cli';

describe('parseArgs', () => {
  it('defaults to no service, not verbose, not minimized', () => {
    expect(parseArgs(['electron', '.'])).toEqual({ service: undefined, verbose: false, minimized: false });
  });
  it('parses --service=whatsapp', () => {
    expect(parseArgs(['electron', '.', '--service=whatsapp']).service).toBe('whatsapp');
  });
  it('parses --service whatsapp (space form)', () => {
    expect(parseArgs(['electron', '.', '--service', 'slack']).service).toBe('slack');
  });
  it('parses --verbose and --minimized', () => {
    const a = parseArgs(['electron', '.', '--verbose', '--minimized']);
    expect(a.verbose).toBe(true);
    expect(a.minimized).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — cannot find module `../src/main/cli`.

- [ ] **Step 3: Write the implementation**

`src/main/cli.ts`:
```ts
export interface CliArgs {
  service?: string;
  verbose: boolean;
  minimized: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { service: undefined, verbose: false, minimized: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--minimized') args.minimized = true;
    else if (a.startsWith('--service=')) args.service = a.slice('--service='.length);
    else if (a === '--service' && i + 1 < argv.length) args.service = argv[++i];
  }
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/cli.ts tests/cli.test.ts
git commit -m "feat: CLI argument parser"
```

---

## Task 4: Chrome UA builder

**Files:**
- Create: `src/main/ua.ts`
- Test: `tests/ua.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const CHROME_VERSION: string`
  - `function chromeUserAgent(version?: string): string`

- [ ] **Step 1: Write the failing test**

`tests/ua.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { chromeUserAgent, CHROME_VERSION } from '../src/main/ua';

describe('chromeUserAgent', () => {
  it('contains no Electron or app-name token', () => {
    const ua = chromeUserAgent();
    expect(ua).not.toMatch(/electron/i);
    expect(ua).not.toMatch(/loft/i);
  });
  it('embeds the Chrome version and Linux platform', () => {
    expect(chromeUserAgent('150.0.0.0')).toContain('Chrome/150.0.0.0');
    expect(chromeUserAgent()).toContain('X11; Linux x86_64');
    expect(chromeUserAgent()).toContain(CHROME_VERSION);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ua.test.ts`
Expected: FAIL — cannot find module `../src/main/ua`.

- [ ] **Step 3: Write the implementation**

`src/main/ua.ts`:
```ts
// Keep in step with the Chromium major that Electron bundles (Electron 43 → Chromium 150).
export const CHROME_VERSION = '150.0.7871.100';

export function chromeUserAgent(version: string = CHROME_VERSION): string {
  return (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) Chrome/${version} Safari/537.36`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ua.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/ua.ts tests/ua.test.ts
git commit -m "feat: Chrome UA builder (no Electron token)"
```

---

## Task 5: View layout math

**Files:**
- Create: `src/main/layout.ts`
- Test: `tests/layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Rect { x: number; y: number; width: number; height: number; }`
  - `const TITLEBAR_HEIGHT: number`
  - `function computeLayout(width: number, height: number, titlebarHeight?: number): { titlebar: Rect; service: Rect }`

- [ ] **Step 1: Write the failing test**

`tests/layout.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { computeLayout, TITLEBAR_HEIGHT } from '../src/main/layout';

describe('computeLayout', () => {
  it('stacks a fixed-height titlebar above a filling service view', () => {
    const { titlebar, service } = computeLayout(1100, 800);
    expect(titlebar).toEqual({ x: 0, y: 0, width: 1100, height: TITLEBAR_HEIGHT });
    expect(service).toEqual({ x: 0, y: TITLEBAR_HEIGHT, width: 1100, height: 800 - TITLEBAR_HEIGHT });
  });
  it('never gives the service view a negative height', () => {
    const { service } = computeLayout(500, 10);
    expect(service.height).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/layout.test.ts`
Expected: FAIL — cannot find module `../src/main/layout`.

- [ ] **Step 3: Write the implementation**

`src/main/layout.ts`:
```ts
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TITLEBAR_HEIGHT = 40;

export function computeLayout(
  width: number,
  height: number,
  titlebarHeight: number = TITLEBAR_HEIGHT,
): { titlebar: Rect; service: Rect } {
  return {
    titlebar: { x: 0, y: 0, width, height: titlebarHeight },
    service: { x: 0, y: titlebarHeight, width, height: Math.max(0, height - titlebarHeight) },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/layout.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/layout.ts tests/layout.test.ts
git commit -m "feat: titlebar/service view layout math"
```

---

## Task 6: Config load/save

**Files:**
- Create: `src/main/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing (node `fs`/`os`/`path` only).
- Produces:
  - `interface WindowState { x?: number; y?: number; width: number; height: number; zoom: number; }`
  - `interface ServiceConfig { customUrl?: string; window?: WindowState; openOnStartup?: boolean; }`
  - `interface LoftConfig { services: Record<string, ServiceConfig>; }`
  - `function defaultConfig(): LoftConfig`
  - `function configPath(): string`
  - `function loadConfig(path: string): LoftConfig`
  - `function saveConfig(path: string, cfg: LoftConfig): void`

- [ ] **Step 1: Write the failing test**

`tests/config.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, defaultConfig } from '../src/main/config';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loft-cfg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('config', () => {
  it('returns the default config when the file is missing', () => {
    expect(loadConfig(join(dir, 'nope.json'))).toEqual(defaultConfig());
  });
  it('round-trips a saved config', () => {
    const cfg = defaultConfig();
    cfg.services.whatsapp = { window: { width: 900, height: 700, zoom: 1.2 }, openOnStartup: true };
    const p = join(dir, 'config.json');
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
  });
  it('returns the default config when the file is corrupt', () => {
    const p = join(dir, 'bad.json');
    saveConfig(p, defaultConfig());
    require('node:fs').writeFileSync(p, '{ not json');
    expect(loadConfig(p)).toEqual(defaultConfig());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot find module `../src/main/config`.

- [ ] **Step 3: Write the implementation**

`src/main/config.ts`:
```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  zoom: number;
}

export interface ServiceConfig {
  customUrl?: string;
  window?: WindowState;
  openOnStartup?: boolean;
}

export interface LoftConfig {
  services: Record<string, ServiceConfig>;
}

export function defaultConfig(): LoftConfig {
  return { services: {} };
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'loft', 'config.json');
}

export function loadConfig(path: string): LoftConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LoftConfig>;
    return { services: parsed.services ?? {} };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(path: string, cfg: LoftConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/config.ts tests/config.test.ts
git commit -m "feat: JSON config load/save with defaults"
```

---

## Task 7: Session configuration

**Files:**
- Create: `src/main/session.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: `chromeUserAgent` (Task 4), `ServiceDef` (Task 2).
- Produces:
  - `const ALLOWED_PERMISSIONS: ReadonlySet<string>`
  - `function isAllowedPermission(permission: string): boolean`
  - `function configureSession(ses: Electron.Session, partition: string): void`

- [ ] **Step 1: Write the failing test**

`tests/session.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { isAllowedPermission } from '../src/main/session';

describe('isAllowedPermission', () => {
  it('allows media and notifications (call-critical)', () => {
    expect(isAllowedPermission('media')).toBe(true);
    expect(isAllowedPermission('notifications')).toBe(true);
    expect(isAllowedPermission('display-capture')).toBe(true);
  });
  it('denies unrelated permissions', () => {
    expect(isAllowedPermission('geolocation')).toBe(false);
    expect(isAllowedPermission('midi')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL — cannot find module `../src/main/session`.

- [ ] **Step 3: Write the implementation**

`src/main/session.ts` (note the **type-only** electron import so Vitest can load this module):
```ts
import type { Session } from 'electron';
import { chromeUserAgent } from './ua';

export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'media',
  'mediaKeySystem',
  'notifications',
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write',
  'display-capture',
  'speaker-selection',
  'background-sync',
]);

export function isAllowedPermission(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}

export function configureSession(ses: Session, partition: string): void {
  ses.setUserAgent(chromeUserAgent());

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(isAllowedPermission(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => isAllowedPermission(permission));

  // Screen share — desktopCapturer.getSources triggers the Wayland portal picker.
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { desktopCapturer } = require('electron');
      desktopCapturer
        .getSources({ types: ['screen', 'window'] })
        .then((sources: Electron.DesktopCapturerSource[]) =>
          callback(sources[0] ? { video: sources[0] } : {}),
        )
        .catch(() => callback({}));
    },
    { useSystemPicker: true },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/session.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/session.ts tests/session.test.ts
git commit -m "feat: per-session UA + permission/display-media handlers"
```

---

## Task 8: Titlebar renderer + preload

**Files:**
- Create: `src/renderer/titlebar/index.html`
- Create: `src/renderer/titlebar/titlebar.css`
- Create: `src/renderer/titlebar/titlebar.ts`
- Create: `src/preload/titlebar.ts`

**Interfaces:**
- Consumes: nothing (renderer + preload).
- Produces:
  - Preload exposes on `window`: `loft: { zoomIn(): void; zoomOut(): void; close(): void; onSetService(cb: (name: string) => void): void }`
  - IPC to main (from titlebar): `titlebar:zoom-in`, `titlebar:zoom-out`, `titlebar:close` (sender's `webContents` identifies the owning window).
  - IPC from main (to titlebar): `titlebar:set-service` carrying the service display name.

- [ ] **Step 1: Create `src/renderer/titlebar/index.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="titlebar.css" />
  </head>
  <body>
    <div class="titlebar">
      <div class="left"><span id="name">Loft</span></div>
      <div class="drag"></div>
      <div class="controls">
        <button id="zoom-out" title="Smaller text">A<span class="arr">▾</span></button>
        <button id="zoom-in" title="Larger text">A<span class="arr">▴</span></button>
        <button id="close" title="Hide to tray">✕</button>
      </div>
    </div>
    <script src="titlebar.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/renderer/titlebar/titlebar.css`**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 40px; overflow: hidden; font-family: system-ui, sans-serif; }
.titlebar { display: flex; align-items: center; height: 40px; background: #f6f5f4; border-bottom: 1px solid #d8d4d0; }
.left { padding: 0 12px; font-weight: 600; font-size: 14px; }
.drag { flex: 1; height: 100%; -webkit-app-region: drag; }
.controls { display: flex; gap: 2px; padding-right: 6px; }
.controls button { -webkit-app-region: no-drag; border: none; background: transparent; height: 32px; min-width: 36px; border-radius: 6px; font-size: 14px; cursor: pointer; }
.controls button:hover { background: #e5e2df; }
#close:hover { background: #e01b24; color: #fff; }
.arr { font-size: 9px; vertical-align: super; }
```

- [ ] **Step 3: Create `src/renderer/titlebar/titlebar.ts`**

```ts
declare global {
  interface Window {
    loft: {
      zoomIn(): void;
      zoomOut(): void;
      close(): void;
      onSetService(cb: (name: string) => void): void;
    };
  }
}

document.getElementById('zoom-in')!.addEventListener('click', () => window.loft.zoomIn());
document.getElementById('zoom-out')!.addEventListener('click', () => window.loft.zoomOut());
document.getElementById('close')!.addEventListener('click', () => window.loft.close());

// Main sends the service display name once the titlebar has finished loading.
const nameEl = document.getElementById('name')!;
window.loft.onSetService((name: string) => { nameEl.textContent = name; });

export {};
```

- [ ] **Step 4: Create `src/preload/titlebar.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('loft', {
  zoomIn: () => ipcRenderer.send('titlebar:zoom-in'),
  zoomOut: () => ipcRenderer.send('titlebar:zoom-out'),
  close: () => ipcRenderer.send('titlebar:close'),
  onSetService: (cb: (name: string) => void) =>
    ipcRenderer.on('titlebar:set-service', (_e, name: string) => cb(name)),
});
```

- [ ] **Step 5: Extend `copy-assets` so the HTML/CSS reach `dist`**

The `copy-assets` script in Task 1 already copies `index.html` + `titlebar.css` into `dist/renderer/titlebar/`. `tsc` compiles `titlebar.ts` → `dist/renderer/titlebar/titlebar.js` and `preload/titlebar.ts` → `dist/preload/titlebar.js`. Verify:

Run: `npm run build && ls dist/renderer/titlebar dist/preload`
Expected: `index.html titlebar.css titlebar.js` in the first dir; `titlebar.js` in the second.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/titlebar src/preload/titlebar.ts
git commit -m "feat: titlebar view (A-zoom + close-to-tray) and preload bridge"
```

---

## Task 9: Service window

**Files:**
- Create: `src/main/serviceWindow.ts`

**Interfaces:**
- Consumes: `ServiceDef`, `effectiveUrl` (Task 2); `LoftConfig` (Task 6); `configureSession` (Task 7); `computeLayout`, `TITLEBAR_HEIGHT` (Task 5); the preload at `dist/preload/titlebar.js` and the titlebar HTML at `dist/renderer/titlebar/index.html`.
- Produces:
  - `interface ServiceWindow { def: ServiceDef; window: BrowserWindow; serviceView: WebContentsView; show(): void; hide(): void; }`
  - `function createServiceWindow(def: ServiceDef, cfg: LoftConfig, opts: { minimized: boolean; onQuit: () => boolean }): ServiceWindow`
    - `onQuit()` returns `true` when the app is really quitting (so `close` should proceed instead of hiding).

- [ ] **Step 1: Write the implementation**

`src/main/serviceWindow.ts`:
```ts
import { BrowserWindow, WebContentsView, session } from 'electron';
import { join } from 'node:path';
import type { ServiceDef } from './registry';
import { effectiveUrl } from './registry';
import type { LoftConfig } from './config';
import { computeLayout } from './layout';
import { configureSession } from './session';

export interface ServiceWindow {
  def: ServiceDef;
  window: BrowserWindow;
  serviceView: WebContentsView;
  titlebarView: WebContentsView;
  show(): void;
  hide(): void;
}

export function createServiceWindow(
  def: ServiceDef,
  cfg: LoftConfig,
  opts: { minimized: boolean; onQuit: () => boolean },
): ServiceWindow {
  const partition = `persist:${def.id}`;
  const ses = session.fromPartition(partition);
  configureSession(ses, partition);

  const saved = cfg.services[def.id]?.window;
  const width = saved?.width ?? 1100;
  const height = saved?.height ?? 800;

  const window = new BrowserWindow({
    width,
    height,
    x: saved?.x,
    y: saved?.y,
    frame: false,
    show: false,
    title: def.displayName,
  });

  // Titlebar view (our chrome) — its own partition-free session is fine.
  const titlebar = new WebContentsView({
    webPreferences: { preload: join(__dirname, '../preload/titlebar.js') },
  });
  titlebar.webContents.on('did-finish-load', () =>
    titlebar.webContents.send('titlebar:set-service', def.displayName),
  );
  titlebar.webContents.loadFile(join(__dirname, '../renderer/titlebar/index.html'));

  // Service view (remote URL) — the isolated per-service partition.
  const serviceView = new WebContentsView({
    webPreferences: { partition, backgroundThrottling: false },
  });
  serviceView.webContents.setUserAgent(ses.getUserAgent());

  // Calls may open in a window.open popup (Messenger). Allow + inherit UA/session.
  serviceView.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { webPreferences: { partition } },
  }));

  window.contentView.addChildView(titlebar);
  window.contentView.addChildView(serviceView);

  const relayout = () => {
    const [w, h] = window.getContentSize();
    const { titlebar: t, service: s } = computeLayout(w, h);
    titlebar.setBounds(t);
    serviceView.setBounds(s);
  };
  relayout();
  window.on('resize', relayout);

  // Restore zoom.
  const zoom = saved?.zoom ?? 1;
  serviceView.webContents.on('did-finish-load', () => serviceView.webContents.setZoomFactor(zoom));

  // Close-to-tray: hide unless the app is actually quitting.
  window.on('close', (e) => {
    if (!opts.onQuit()) {
      e.preventDefault();
      window.hide();
    }
  });

  // Persist bounds + zoom on the way out (Stage 1: in-memory cfg object; Stage 4 wires saveConfig).
  const persist = () => {
    const [w, h] = window.getSize();
    const [x, y] = window.getPosition();
    cfg.services[def.id] = {
      ...cfg.services[def.id],
      window: { x, y, width: w, height: h, zoom: serviceView.webContents.getZoomFactor() },
    };
  };
  window.on('resize', persist);
  window.on('move', persist);

  serviceView.webContents.loadURL(effectiveUrl(def, cfg.services[def.id]?.customUrl));

  const api: ServiceWindow = {
    def,
    window,
    serviceView,
    titlebarView: titlebar,
    show: () => { window.show(); window.focus(); },
    hide: () => window.hide(),
  };

  if (!opts.minimized) api.show();
  return api;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: `tsc` completes with no errors; `dist/main/serviceWindow.js` exists.

- [ ] **Step 3: Commit**

```bash
git add src/main/serviceWindow.ts
git commit -m "feat: per-service frameless window with titlebar + service views"
```

---

## Task 10: App entry, single-instance, IPC wiring

**Files:**
- Modify: `src/main/index.ts` (replace the Task 1 stub entirely)

**Interfaces:**
- Consumes: `parseArgs` (Task 3); `getService`, `listServices` (Task 2); `loadConfig`, `saveConfig`, `configPath` (Task 6); `createServiceWindow`, `ServiceWindow` (Task 9).
- Produces: the running app.

- [ ] **Step 1: Replace `src/main/index.ts`**

```ts
import { app, ipcMain } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from './cli';
import { getService, ServiceDef } from './registry';
import { loadConfig, saveConfig, configPath, LoftConfig } from './config';
import { createServiceWindow, ServiceWindow } from './serviceWindow';

app.setName('Loft');
app.setAppUserModelId('chat.loft.Loft');

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
app.setPath('userData', join(dataHome, 'loft'));

let quitting = false;

const config: LoftConfig = loadConfig(configPath());
const windows = new Map<string, ServiceWindow>();

function openService(def: ServiceDef, minimized: boolean): void {
  const existing = windows.get(def.id);
  if (existing) { existing.show(); return; }
  const sw = createServiceWindow(def, config, { minimized, onQuit: () => quitting });
  windows.set(def.id, sw);
}

function resolveServiceFromArgs(argv: string[]): ServiceDef | undefined {
  const { service } = parseArgs(argv);
  return service ? getService(service) : undefined;
}

// Single-instance: a second launch routes its --service to us.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const def = resolveServiceFromArgs(argv);
    if (def) openService(def, false);
  });

  ipcMain.on('titlebar:zoom-in', (e) => adjustZoom(e.sender.id, +0.1));
  ipcMain.on('titlebar:zoom-out', (e) => adjustZoom(e.sender.id, -0.1));
  ipcMain.on('titlebar:close', (e) => hideOwningWindow(e.sender.id));

  app.whenReady().then(() => {
    const args = parseArgs(process.argv);
    const def = args.service ? getService(args.service) : undefined;
    if (def) openService(def, args.minimized);
    // With no --service, Stage 1 opens WhatsApp so there is always a window to see.
    else openService(getService('whatsapp')!, args.minimized);
  });

  app.on('window-all-closed', () => { /* stay alive (tray comes in Stage 3); quit only via before-quit */ });
}

// Titlebar IPC events come from the titlebar view's preload; map the sender's
// webContents id back to its ServiceWindow (match titlebar or service view).
function findBySenderId(senderId: number): ServiceWindow | undefined {
  for (const sw of windows.values()) {
    if (sw.titlebarView.webContents.id === senderId || sw.serviceView.webContents.id === senderId) {
      return sw;
    }
  }
  return undefined;
}

function adjustZoom(senderId: number, delta: number): void {
  const sw = findBySenderId(senderId);
  if (!sw) return;
  const wc = sw.serviceView.webContents;
  const next = Math.min(3, Math.max(0.3, wc.getZoomFactor() + delta));
  wc.setZoomFactor(next);
}

function hideOwningWindow(senderId: number): void {
  findBySenderId(senderId)?.hide();
}

app.on('before-quit', () => {
  quitting = true; // fires before window 'close' events, so close-to-tray yields to a real quit
  saveConfig(configPath(), config);
});
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles cleanly.

- [ ] **Step 3: Full unit-test pass**

Run: `npm test`
Expected: all suites PASS (registry, cli, ua, layout, config, session).

- [ ] **Step 4: Manual smoke test — WhatsApp**

Run: `npm start`
Expected & verify:
1. A frameless window opens with our titlebar (name "WhatsApp" once you wire `setService`, or "Loft" placeholder) and the WhatsApp Web QR page below it — **no "unsupported browser" banner**.
2. Open DevTools on the service view (`npm start` then, from a second terminal, not needed — instead temporarily add `serviceView.webContents.openDevTools()` if required) and confirm `navigator.userAgent` contains `Chrome/150` and **no** `Electron`.
3. Click the **✕** in the titlebar → the window **hides** (process stays alive). Re-run `loft --service whatsapp` (`env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --service=whatsapp`) → the existing window re-shows (single-instance routing), it does **not** spawn a second app.
4. Click **A▴ / A▾** → the page zooms in/out.
5. Resize the window → the titlebar stays 40px tall and the service view fills the rest.

- [ ] **Step 5: Manual smoke test — a call (POC parity)**

Log in to WhatsApp (QR), start a voice or video call to confirm media still works end-to-end inside the real window (this is the parity guarantee from the POC).

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: app entry with single-instance routing and titlebar IPC"
```

---

## Self-Review (completed by plan author)

**Spec coverage (Stage 1 scope only):** single-instance ✓ (Task 10), service registry ✓ (Task 2), WebContentsView-per-service in frameless windows ✓ (Task 9), partitions + UA + POC handlers ✓ (Tasks 4/7/9), close-to-tray ✓ (Task 9), titlebar view with A-zoom + close ✓ (Tasks 8/9/10), bounds/zoom persistence ✓ (Tasks 6/9/10), `backgroundThrottling:false` ✓ (Task 9). Deferred items (badges, notifications, tray, hub, GNOME/KWin, autostart, packaging) are explicitly out of Stage 1.

**Placeholders:** none — every code step is complete. The `setService` label wiring is intentionally minimal in Stage 1 (window title carries the name); noted, not a gap.

**Type consistency:** `ServiceDef`, `LoftConfig`, `ServiceConfig`, `WindowState`, `ServiceWindow`, `CliArgs`, `Rect` are defined once and consumed with matching shapes. `createServiceWindow(def, cfg, {minimized, onQuit})` matches its call in `openService`. `configureSession(ses, partition)` matches its call in `serviceWindow.ts`.

**Known Stage-1 simplification:** `findBySenderId` maps an IPC sender to its `ServiceWindow` by comparing the sender's `webContents.id` against each window's `titlebarView`/`serviceView`. If this proves fragile, pass the service id explicitly from the preload (e.g. `ipcRenderer.send('titlebar:close', serviceId)`). Flagged for the implementer.
```
