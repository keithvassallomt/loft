# Unified View — Foundations (09a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the two assumptions the unified view rests on, then land the `ServiceView`/`ServiceHost` split and the config + migration groundwork — with **no user-visible behaviour change**.

**Architecture:** Spec `docs/superpowers/specs/2026-07-17-electron-loft-09-unified-view-design.md` §5a says a service must outlive the window it lives in. Today `src/main/serviceWindow.ts` tangles *what a service is* (session, preload, badge, zoom, nav policy, recovery overlay) with *what a window is* (BrowserWindow, titlebar, close-to-tray, bounds). This plan extracts the former into `serviceView.ts` — mountable into **any** window — and defines `serviceHost.ts`, the interface tray/D-Bus/notifications talk to so they never learn where a service lives. The per-service window stays the only host; the Loft window arrives in plan 09b.

**Tech Stack:** TypeScript, Electron 43.1.0, Vitest, Node ≥ 20 built-ins.

## Global Constraints

- **Branch:** `electron-rewrite`. Do NOT merge to `main`.
- **No behaviour change.** Tasks 2–8 must leave the app doing exactly what it does today. Every existing test stays green; none are deleted or weakened to accommodate a refactor.
- **Domain is `chat.loft`** (never `com.loft`) — D-Bus names, app id.
- **Always check latest versions online** before adding or referencing any dependency (CLAUDE.md). This plan adds **no** new dependencies.
- **Electron in this repo's editor terminal:** `ELECTRON_RUN_AS_NODE=1` is exported by VS Code and makes `electron .` behave like plain Node. Always launch with `env -u ELECTRON_RUN_AS_NODE`.
- **Iterate with `npm run build`**, never `npm run dist` — packaging is only for distribution or packaged-only behaviour.
- Run tests with `npm test` (Vitest, `vitest run`). Renderer type-check is `npm run check`.
- Test files live in `tests/<name>.test.ts` and import from `../src/main/...`. Follow that; do not co-locate.
- Zoom range is **0.3–3.0 in 0.1 steps** — copied from `serviceWindow.ts:300`.
- `TITLEBAR_HEIGHT = 40`, and this plan adds `RAIL_WIDTH = 52` (spec §5b).
- Commit after every task. Conventional-commit prefixes (`feat:`, `refactor:`, `test:`, `docs:`), matching this repo's log.

---

### Task 1: Spike — prove re-parenting and calls survive

**Not TDD.** This is a throwaway probe whose deliverable is *evidence and a go/no-go*. Spec §10 makes it the gate for everything else: if a live `WebContentsView` cannot move between windows with its page intact, `detach` becomes "reload in a new window" and 09b/09c need redesigning before a line of them is written.

**Files:**
- Create: `dev_local/spike_reparent/main.js`
- Create: `dev_local/spike_reparent/package.json`
- Modify: `docs/superpowers/specs/2026-07-17-electron-loft-09-unified-view-design.md` (append findings to §10)

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded go/no-go. No code any later task imports.

- [ ] **Step 1: Write the spike**

`dev_local/spike_reparent/package.json`:

```json
{
  "name": "loft-spike-reparent",
  "version": "0.0.0",
  "private": true,
  "main": "main.js"
}
```

`dev_local/spike_reparent/main.js`:

```js
// Spike for spec 09 §10. Throwaway. Answers exactly two questions:
//   1. Does a live WebContentsView survive re-parenting between BrowserWindows
//      with its page intact (no reload)?
//   2. Does a WebRTC call still work in that view AFTER it has been re-parented?
// Mirrors the real service view's webPreferences from src/main/serviceWindow.ts:86-99.
const { app, BrowserWindow, WebContentsView } = require('electron');

const SIZE = { width: 1100, height: 800 };

app.whenReady().then(async () => {
  const a = new BrowserWindow({ ...SIZE, title: 'Spike Host A' });
  const b = new BrowserWindow({ ...SIZE, title: 'Spike Host B', show: false });

  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:spike',
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: false,
    },
  });

  // If a re-parent silently reloads, these fire again after the move. That is the tell.
  view.webContents.on('did-start-loading', () => console.log('[spike] did-start-loading'));
  view.webContents.on('did-navigate', (_e, url) => console.log('[spike] did-navigate', url));

  // A same-origin call popup inherits the opener's prefs and SIGSEGVs on some GPU
  // stacks unless forced sandboxed+isolated. Same override as serviceWindow.ts:128-145.
  view.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      webPreferences: {
        partition: 'persist:spike',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: [],
      },
    },
  }));

  a.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, ...SIZE });
  await view.webContents.loadURL('https://web.whatsapp.com/');

  const idBefore = view.webContents.id;
  console.log('[spike] webContents id in A:', idBefore);
  console.log('[spike] Log in, open a chat, scroll, type a draft. Re-parent fires in 60s.');

  setTimeout(async () => {
    // A JS global surviving the move is decisive proof no reload happened.
    await view.webContents.executeJavaScript('window.__spike = "set-before-reparent"');

    console.log('[spike] re-parenting A -> B ...');
    a.contentView.removeChildView(view);
    b.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, ...SIZE });
    b.show();
    b.focus();

    const idAfter = view.webContents.id;
    const marker = await view.webContents.executeJavaScript('window.__spike');
    console.log('[spike] id same? ', idBefore === idAfter, `(${idBefore} -> ${idAfter})`);
    console.log('[spike] window.__spike survived?', marker === 'set-before-reparent', `(${marker})`);
    console.log('[spike] url:', view.webContents.getURL());
    console.log('[spike] NOW: place a voice call, then a video call, from window B.');
  }, 60_000);
});
```

- [ ] **Step 2: Run the re-parent probe**

Run: `env -u ELECTRON_RUN_AS_NODE npx electron dev_local/spike_reparent`

Log into WhatsApp in window A, open a chat, scroll up, and type a draft message. Wait for the 60s timer.

Expected on success:

```
[spike] id same?  true (1 -> 1)
[spike] window.__spike survived? true (set-before-reparent)
[spike] url: https://web.whatsapp.com/
```

with **no** `did-start-loading` or `did-navigate` line printed after the `re-parenting A -> B` line. Confirm visually in window B that the chat is still open, still scrolled where you left it, and the draft is still in the box.

- [ ] **Step 3: Run the call probe**

In window B (the re-parented view), place a **voice call**, then a **video call**. Confirm each connects with media flowing, and that the app does not die with exit code 139 (SIGSEGV).

- [ ] **Step 4: Record the findings in the spec**

Append to §10 of `docs/superpowers/specs/2026-07-17-electron-loft-09-unified-view-design.md`, filling in what you actually saw:

```markdown
### 10a. Spike results (<date>)

- **Re-parenting preserves the page:** <yes/no>. `webContents.id` <same/changed>; `window.__spike`
  <survived/lost>; `did-start-loading` <did not fire/fired> after the move; draft and scroll position
  <survived/lost>.
- **Call in a re-parented view:** voice <works/fails>, video <works/fails>. Exit code 139: <not seen/seen>.
- **Verdict:** <GO — 09b proceeds as specced / NO-GO — see below>.
```

**If either probe fails, STOP.** Do not start Task 2. Report to Keith with the log; the spec needs revising, because `detach` and the whole `ServiceView`-moves-between-hosts model rest on this.

- [ ] **Step 5: Commit**

```bash
git add dev_local/spike_reparent docs/superpowers/specs/2026-07-17-electron-loft-09-unified-view-design.md
git commit -m "spike: prove WebContentsView re-parenting preserves page + calls

Gate for spec 09 §10. Records the result in the spec so the finding
outlives the branch."
```

---

### Task 2: `computeLayout` gains a rail region

**Files:**
- Modify: `src/main/layout.ts`
- Modify: `src/main/serviceWindow.ts:181` (the one caller; renames `service` → `content`)
- Modify: `src/main/serviceWindow.ts:237` (second caller, inside `showRecovery`)
- Test: `tests/layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RAIL_WIDTH: number` (52); `Rect`; `Layout { rail: Rect; titlebar: Rect; content: Rect }`; `computeLayout(width: number, height: number, opts?: { railWidth?: number; titlebarHeight?: number }): Layout`. **The `service` key is renamed to `content`** — Task 7 depends on this name.

- [ ] **Step 1: Write the failing test**

Replace `tests/layout.test.ts` entirely:

```ts
import { describe, it, expect } from 'vitest';
import { computeLayout, TITLEBAR_HEIGHT, RAIL_WIDTH } from '../src/main/layout';

describe('computeLayout', () => {
  it('with no rail, reproduces the detached window layout', () => {
    const { rail, titlebar, content } = computeLayout(1100, 800);
    expect(rail).toEqual({ x: 0, y: 0, width: 0, height: 800 });
    expect(titlebar).toEqual({ x: 0, y: 0, width: 1100, height: TITLEBAR_HEIGHT });
    expect(content).toEqual({ x: 0, y: TITLEBAR_HEIGHT, width: 1100, height: 800 - TITLEBAR_HEIGHT });
  });

  it('insets the titlebar and content by the rail width', () => {
    const { rail, titlebar, content } = computeLayout(1100, 800, { railWidth: RAIL_WIDTH });
    expect(rail).toEqual({ x: 0, y: 0, width: RAIL_WIDTH, height: 800 });
    expect(titlebar).toEqual({ x: RAIL_WIDTH, y: 0, width: 1100 - RAIL_WIDTH, height: TITLEBAR_HEIGHT });
    expect(content).toEqual({
      x: RAIL_WIDTH,
      y: TITLEBAR_HEIGHT,
      width: 1100 - RAIL_WIDTH,
      height: 800 - TITLEBAR_HEIGHT,
    });
  });

  it('never gives the content view a negative height', () => {
    expect(computeLayout(500, 10).content.height).toBe(0);
  });

  it('never gives the content view a negative width when the rail exceeds the window', () => {
    expect(computeLayout(20, 800, { railWidth: RAIL_WIDTH }).content.width).toBe(0);
  });

  it('honours a custom titlebar height', () => {
    expect(computeLayout(1100, 800, { titlebarHeight: 10 }).titlebar.height).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/layout.test.ts`
Expected: FAIL — `RAIL_WIDTH` is not exported from `../src/main/layout`, and destructuring `content` yields `undefined`.

- [ ] **Step 3: Write the implementation**

Replace `src/main/layout.ts` entirely:

```ts
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TITLEBAR_HEIGHT = 40;
/** The Loft window's service rail (spec 09 §5b). Detached windows pass railWidth: 0. */
export const RAIL_WIDTH = 52;

export interface Layout {
  rail: Rect;
  titlebar: Rect;
  content: Rect;
}

/**
 * One layout for both hosts. A detached service window omits `railWidth` and gets
 * the two-region result it has always had; the Loft window passes RAIL_WIDTH and
 * the titlebar/content inset to make room.
 */
export function computeLayout(
  width: number,
  height: number,
  opts: { railWidth?: number; titlebarHeight?: number } = {},
): Layout {
  const railWidth = opts.railWidth ?? 0;
  const titlebarHeight = opts.titlebarHeight ?? TITLEBAR_HEIGHT;
  const contentWidth = Math.max(0, width - railWidth);
  return {
    rail: { x: 0, y: 0, width: railWidth, height },
    titlebar: { x: railWidth, y: 0, width: contentWidth, height: titlebarHeight },
    content: {
      x: railWidth,
      y: titlebarHeight,
      width: contentWidth,
      height: Math.max(0, height - titlebarHeight),
    },
  };
}
```

- [ ] **Step 4: Update the two callers**

In `src/main/serviceWindow.ts`, the `relayout` function currently reads:

```ts
    const { titlebar: t, service: s } = computeLayout(w, h);
```

Change it to:

```ts
    const { titlebar: t, content: s } = computeLayout(w, h);
```

And in `showRecovery`, this line:

```ts
    view.setBounds(computeLayout(w, h).service);
```

becomes:

```ts
    view.setBounds(computeLayout(w, h).content);
```

- [ ] **Step 5: Run tests and build**

Run: `npm test && npm run build`
Expected: all tests PASS; `tsc` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/layout.ts src/main/serviceWindow.ts tests/layout.test.ts
git commit -m "feat(layout): add a rail region to computeLayout

One function for both hosts: railWidth 0 reproduces today's detached
two-region layout exactly. Renames the 'service' rect to 'content' —
the Loft window puts the manager view in the same rect."
```

---

### Task 3: Extract `clampZoom` as a pure function

The zoom clamp is currently an untested one-liner welded into `serviceWindow.ts:300`. Task 7 moves zoom into `ServiceView`; pulling the arithmetic out first makes it testable and keeps Task 7 a pure move.

**Files:**
- Create: `src/main/zoom.ts`
- Modify: `src/main/serviceWindow.ts:298-303`
- Test: `tests/zoom.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ZOOM_MIN: number` (0.3), `ZOOM_MAX: number` (3), `clampZoom(factor: number): number`. Tasks 4 and 7 both import `clampZoom`.

- [ ] **Step 1: Write the failing test**

Create `tests/zoom.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { clampZoom, ZOOM_MIN, ZOOM_MAX } from '../src/main/zoom';

describe('clampZoom', () => {
  it('leaves an in-range value on a 0.1 step alone', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(1.2)).toBe(1.2);
  });

  it('rounds to 0.1 steps', () => {
    expect(clampZoom(1.04)).toBe(1);
    expect(clampZoom(1.06)).toBe(1.1);
  });

  it('absorbs float drift from repeated addition', () => {
    // 0.1 + 0.2 === 0.30000000000000004; without rounding this drifts forever.
    expect(clampZoom(0.1 + 0.2)).toBe(0.3);
    expect(clampZoom(1.1 + 0.1)).toBe(1.2);
  });

  it('clamps above the maximum', () => {
    expect(clampZoom(5)).toBe(ZOOM_MAX);
    expect(clampZoom(3.1)).toBe(ZOOM_MAX);
  });

  it('clamps below the minimum', () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(-2)).toBe(ZOOM_MIN);
  });

  it('treats a non-finite factor as 1 rather than poisoning the view', () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(ZOOM_MAX);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/zoom.test.ts`
Expected: FAIL — `Cannot find module '../src/main/zoom'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/zoom.ts`:

```ts
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3;

/**
 * Round to 0.1 steps and clamp to the supported range.
 *
 * The rounding is not cosmetic: zoom is applied by repeated `+= delta`, and
 * without it the factor accumulates float drift (0.1 + 0.2 = 0.30000000000000004)
 * which then gets persisted to config and reloaded forever.
 *
 * NaN cannot be clamped into range by Math.min/Math.max — both propagate it —
 * so it is mapped to 1 explicitly. A NaN zoom factor blanks the view.
 */
export function clampZoom(factor: number): number {
  if (Number.isNaN(factor)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(factor * 10) / 10));
}
```

- [ ] **Step 4: Use it in `serviceWindow.ts`**

Add to the imports at the top of `src/main/serviceWindow.ts`:

```ts
import { clampZoom } from './zoom';
```

Then replace the `setZoom` body. It currently reads:

```ts
    setZoom: (delta: number) => {
      // Round to 0.1 steps to avoid float drift; clamp to the 0.3–3.0 range.
      currentZoom = Math.min(3, Math.max(0.3, Math.round((currentZoom + delta) * 10) / 10));
      serviceView.webContents.setZoomFactor(currentZoom);
      persist();
    },
```

Replace with:

```ts
    setZoom: (delta: number) => {
      currentZoom = clampZoom(currentZoom + delta);
      serviceView.webContents.setZoomFactor(currentZoom);
      persist();
    },
```

- [ ] **Step 5: Run tests and build**

Run: `npm test && npm run build`
Expected: all tests PASS; `tsc` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/zoom.ts src/main/serviceWindow.ts tests/zoom.test.ts
git commit -m "refactor(zoom): extract clampZoom as a tested pure function

Was an untested one-liner inside serviceWindow's setZoom. Pulling it out
before ServiceView moves zoom keeps that move mechanical, and pins the
NaN case (Math.min/max propagate NaN, blanking the view)."
```

---

### Task 4: Config — `Bounds`/`WindowState` split, new fields, per-service validation

Spec §5c. `loadConfig` validates the top level but never an inner `ServiceConfig` — a malformed `window` passes straight through and becomes a `BrowserWindow`'s width and height. 09b adds a *second* bounds path reading the same file, so this gets fixed now.

**Files:**
- Modify: `src/main/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `clampZoom` from Task 3.
- Produces: `Bounds { x?: number; y?: number; width: number; height: number }`; `WindowState extends Bounds { zoom: number }`; `ServiceConfig` gains `detached?: boolean` and `launcher?: boolean`; `LoftConfig` gains `configVersion?: number`, `window?: Bounds`, `reopenDetached?: boolean`, `railOrder?: string[]`; `reopenDetachedEnabled(cfg: LoftConfig): boolean`. Task 5 relies on `LoftConfig.configVersion`; Tasks 5 and 6 on `ServiceConfig.launcher`; Task 7 on `WindowState.zoom`.
- Also exported, with no consumer in this plan: `sanitizeBounds` and `sanitizeServiceConfig`. Exported as testable surface and because 09b validates the Loft window's bounds on the same path — not because a task here imports them.

- [ ] **Step 1: Write the failing test**

Append these cases inside the existing `describe('config', ...)` block in `tests/config.test.ts` (keep every existing case — they must all still pass):

```ts
  it('round-trips the new per-service fields', () => {
    const cfg = defaultConfig();
    cfg.services.slack = { detached: true, launcher: true, openOnStartup: true };
    const p = join(dir, 'new-fields.json');
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
  });

  it('round-trips the new global fields', () => {
    const cfg = defaultConfig();
    cfg.configVersion = 2;
    cfg.window = { x: 10, y: 20, width: 1200, height: 900 };
    cfg.railOrder = ['slack', 'whatsapp'];
    const p = join(dir, 'new-globals.json');
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
  });

  it('drops a service window whose bounds are not numbers', () => {
    const p = join(dir, 'bad-bounds.json');
    writeFileSync(p, '{"services":{"slack":{"window":{"width":"wide","height":null},"dnd":true}}}', 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.services.slack.window).toBeUndefined();
    expect(cfg.services.slack.dnd).toBe(true); // the rest of the entry survives
  });

  it('drops a service window with non-positive dimensions', () => {
    const p = join(dir, 'zero-bounds.json');
    writeFileSync(p, '{"services":{"slack":{"window":{"width":0,"height":800,"zoom":1}}}}', 'utf8');
    expect(loadConfig(p).services.slack.window).toBeUndefined();
  });

  it('clamps a persisted out-of-range zoom instead of trusting it', () => {
    const p = join(dir, 'wild-zoom.json');
    writeFileSync(p, '{"services":{"slack":{"window":{"width":900,"height":700,"zoom":99}}}}', 'utf8');
    expect(loadConfig(p).services.slack.window?.zoom).toBe(3);
  });

  it('defaults a missing zoom to 1 when the bounds are usable', () => {
    const p = join(dir, 'no-zoom.json');
    writeFileSync(p, '{"services":{"slack":{"window":{"width":900,"height":700}}}}', 'utf8');
    expect(loadConfig(p).services.slack.window?.zoom).toBe(1);
  });

  it('drops a service entry that is not an object without losing its siblings', () => {
    const p = join(dir, 'bad-entry.json');
    writeFileSync(p, '{"services":{"slack":"nope","whatsapp":{"dnd":true}}}', 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.services.slack).toEqual({});
    expect(cfg.services.whatsapp.dnd).toBe(true);
  });

  it('ignores non-boolean detached/launcher values', () => {
    const p = join(dir, 'bad-flags.json');
    writeFileSync(p, '{"services":{"slack":{"detached":"yes","launcher":1}}}', 'utf8');
    expect(loadConfig(p).services.slack).toEqual({});
  });

  it('drops the Loft window bounds when malformed', () => {
    const p = join(dir, 'bad-loft-window.json');
    writeFileSync(p, '{"services":{},"window":{"width":"wide"}}', 'utf8');
    expect(loadConfig(p).window).toBeUndefined();
  });

  it('drops non-string entries from railOrder', () => {
    const p = join(dir, 'bad-rail.json');
    writeFileSync(p, '{"services":{},"railOrder":["slack",7,null,"whatsapp"]}', 'utf8');
    expect(loadConfig(p).railOrder).toEqual(['slack', 'whatsapp']);
  });
});

describe('reopenDetachedEnabled', () => {
  it('defaults to true when unset', () => {
    expect(reopenDetachedEnabled(defaultConfig())).toBe(true);
  });
  it('is false only when explicitly false', () => {
    expect(reopenDetachedEnabled({ services: {}, reopenDetached: false })).toBe(false);
    expect(reopenDetachedEnabled({ services: {}, reopenDetached: true })).toBe(true);
  });
```

Note the `});` then `describe(` in the middle: the last block closes `describe('config')` and opens a new one. Update the import line at the top of the file to:

```ts
import { loadConfig, saveConfig, defaultConfig, reopenDetachedEnabled } from '../src/main/config';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `reopenDetachedEnabled` is not exported, and the malformed-bounds cases return the raw object rather than `undefined`.

- [ ] **Step 3: Write the implementation**

Replace `src/main/config.ts` entirely:

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { TrayBackend } from './trayBackend';
import { clampZoom } from './zoom';

/** A window's position and size. The Loft window uses this; zoom is per service. */
export interface Bounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface WindowState extends Bounds {
  zoom: number;
}

export interface ServiceConfig {
  customUrl?: string;
  window?: WindowState;
  openOnStartup?: boolean;
  /** Per-service Do Not Disturb; persisted + reflected in the tray menu. */
  dnd?: boolean;
  /** Per-service badge indicator toggle (tray/title); GetStatus() still reports the true count when false. */
  badgesEnabled?: boolean;
  /** Reopen this service in its own window rather than the Loft window's rail (spec 09 §3). */
  detached?: boolean;
  /** Opt-in per-service .desktop launcher. Absent or false = no launcher (spec 09 §6e). */
  launcher?: boolean;
}

export interface LoftConfig {
  services: Record<string, ServiceConfig>;
  /** Global Do Not Disturb (mutes every service); persisted + reflected in the tray. */
  globalDnd?: boolean;
  /** Tray backend preference ('auto', 'gnome-panel', or 'sni'). */
  trayBackend?: TrayBackend;
  /** Schema version, gating one-shot migrations. Absent = pre-v2 (see migrate.ts). */
  configVersion?: number;
  /** The Loft window's own bounds. No zoom — zoom is per service. */
  window?: Bounds;
  /** "Reopen detached services in their own windows". Absent = true. */
  reopenDetached?: boolean;
  /** Rail order by service id. Ids not listed sort after these, in registry order. */
  railOrder?: string[];
}

export function defaultConfig(): LoftConfig {
  return { services: {} };
}

/** Absent means enabled — the setting is ticked by default (spec 09 §2). */
export function reopenDetachedEnabled(cfg: LoftConfig): boolean {
  return cfg.reopenDetached !== false;
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'loft', 'config.json');
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Bounds are usable only with finite, positive width and height — these values are
 * handed straight to BrowserWindow, and a string or a zero blanks or throws.
 * x/y are optional (absent = let the WM place it), so they are dropped individually.
 */
export function sanitizeBounds(v: unknown): Bounds | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const b = v as Record<string, unknown>;
  if (!isFiniteNumber(b.width) || !isFiniteNumber(b.height)) return undefined;
  if (b.width <= 0 || b.height <= 0) return undefined;
  const out: Bounds = { width: b.width, height: b.height };
  if (isFiniteNumber(b.x)) out.x = b.x;
  if (isFiniteNumber(b.y)) out.y = b.y;
  return out;
}

function sanitizeWindowState(v: unknown): WindowState | undefined {
  const b = sanitizeBounds(v);
  if (!b) return undefined;
  const zoom = (v as Record<string, unknown>).zoom;
  return { ...b, zoom: isFiniteNumber(zoom) ? clampZoom(zoom) : 1 };
}

/**
 * Whitelist a service entry field by field. Unknown keys are dropped: this file is
 * hand-editable and its values reach BrowserWindow and the renderer directly.
 * Absent stays absent — `badgesEnabled` and `reopenDetached` both mean "true when
 * missing", so writing a default here would change their meaning.
 */
export function sanitizeServiceConfig(v: unknown): ServiceConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const s = v as Record<string, unknown>;
  const out: ServiceConfig = {};
  if (typeof s.customUrl === 'string') out.customUrl = s.customUrl;
  const w = sanitizeWindowState(s.window);
  if (w) out.window = w;
  if (typeof s.openOnStartup === 'boolean') out.openOnStartup = s.openOnStartup;
  if (typeof s.dnd === 'boolean') out.dnd = s.dnd;
  if (typeof s.badgesEnabled === 'boolean') out.badgesEnabled = s.badgesEnabled;
  if (typeof s.detached === 'boolean') out.detached = s.detached;
  if (typeof s.launcher === 'boolean') out.launcher = s.launcher;
  return out;
}

export function loadConfig(path: string): LoftConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LoftConfig>;
    const rawServices =
      parsed.services && typeof parsed.services === 'object' && !Array.isArray(parsed.services)
        ? (parsed.services as Record<string, unknown>)
        : {};
    const services: Record<string, ServiceConfig> = {};
    for (const [id, v] of Object.entries(rawServices)) services[id] = sanitizeServiceConfig(v);

    const trayBackend =
      parsed.trayBackend === 'gnome-panel' || parsed.trayBackend === 'sni' || parsed.trayBackend === 'auto'
        ? parsed.trayBackend
        : undefined;

    const base: LoftConfig = { services };
    if (parsed.globalDnd === true) base.globalDnd = true;
    if (trayBackend) base.trayBackend = trayBackend;
    if (isFiniteNumber(parsed.configVersion)) base.configVersion = parsed.configVersion;
    const w = sanitizeBounds(parsed.window);
    if (w) base.window = w;
    if (typeof parsed.reopenDetached === 'boolean') base.reopenDetached = parsed.reopenDetached;
    if (Array.isArray(parsed.railOrder)) {
      base.railOrder = parsed.railOrder.filter((x): x is string => typeof x === 'string');
    }
    return base;
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(path: string, cfg: LoftConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
}
```

- [ ] **Step 4: Run tests and build**

Run: `npm test && npm run build`
Expected: all tests PASS — including every pre-existing `config.test.ts` case. `tsc` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/config.ts tests/config.test.ts
git commit -m "feat(config): add unified-view fields and validate service entries

Adds detached/launcher per service and configVersion/window/reopenDetached/
railOrder globally (spec 09 §5c).

loadConfig validated the top level but never an inner ServiceConfig, so a
malformed window object became a BrowserWindow's width and height. 09b adds
a second bounds path reading the same file, so fix it before it bites twice."
```

---

### Task 5: Config migration to v2 — launcher inferred from disk

Spec §8. From v2, launchers are opt-in per service. Without a migration, the new `launcher: false` default would silently delete the six `.desktop` files every existing user has, on first run.

**Files:**
- Create: `src/main/migrate.ts`
- Modify: `src/main/desktop.ts:73-75` (export `serviceLauncherPath`)
- Modify: `src/main/index.ts` (call the migration at startup)
- Test: `tests/migrate.test.ts`

**Interfaces:**
- Consumes: `LoftConfig` from Task 4.
- Produces: `CONFIG_VERSION: number` (2); `migrateConfig(cfg: LoftConfig, hasLauncher: (id: string) => boolean): { changed: boolean }`; `serviceLauncherPath(id: string, env?: NodeJS.ProcessEnv): string` from `desktop.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/migrate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { migrateConfig, CONFIG_VERSION } from '../src/main/migrate';
import type { LoftConfig } from '../src/main/config';

const cfgWith = (services: LoftConfig['services'], configVersion?: number): LoftConfig => ({
  services,
  ...(configVersion === undefined ? {} : { configVersion }),
});

describe('migrateConfig', () => {
  it('infers launcher from what is actually on disk', () => {
    const cfg = cfgWith({ whatsapp: {}, slack: {} });
    const r = migrateConfig(cfg, (id) => id === 'whatsapp');
    expect(r.changed).toBe(true);
    expect(cfg.services.whatsapp.launcher).toBe(true);
    expect(cfg.services.slack.launcher).toBe(false);
  });

  it('stamps the config version', () => {
    const cfg = cfgWith({});
    migrateConfig(cfg, () => false);
    expect(cfg.configVersion).toBe(CONFIG_VERSION);
  });

  it('is idempotent — a second run changes nothing', () => {
    const cfg = cfgWith({ whatsapp: {} });
    migrateConfig(cfg, () => true);
    // Simulate the user unticking the box after migrating.
    cfg.services.whatsapp.launcher = false;
    const second = migrateConfig(cfg, () => true);
    expect(second.changed).toBe(false);
    expect(cfg.services.whatsapp.launcher).toBe(false);
  });

  it('does not run against an already-migrated config', () => {
    const cfg = cfgWith({ slack: {} }, CONFIG_VERSION);
    expect(migrateConfig(cfg, () => true).changed).toBe(false);
    expect(cfg.services.slack.launcher).toBeUndefined();
  });

  it('does not run against a config from a future version', () => {
    const cfg = cfgWith({ slack: {} }, CONFIG_VERSION + 1);
    expect(migrateConfig(cfg, () => true).changed).toBe(false);
    expect(cfg.services.slack.launcher).toBeUndefined();
  });

  it('never clobbers an explicit flag already present', () => {
    const cfg = cfgWith({ slack: { launcher: false } });
    migrateConfig(cfg, () => true);
    expect(cfg.services.slack.launcher).toBe(false);
  });

  it('migrates an empty install without inventing services', () => {
    const cfg = cfgWith({});
    expect(migrateConfig(cfg, () => true).changed).toBe(true);
    expect(cfg.services).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/migrate.test.ts`
Expected: FAIL — `Cannot find module '../src/main/migrate'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/migrate.ts`:

```ts
import type { LoftConfig } from './config';

/**
 * v2 (spec 09 §8): the per-service `.desktop` launcher became opt-in.
 * Bump this only alongside a new one-shot step in migrateConfig.
 */
export const CONFIG_VERSION = 2;

/**
 * One-shot migration to v2, mutating cfg in place.
 *
 * Before v2 every installed service got a launcher unconditionally, and nothing
 * recorded that. From v2 `launcher` is opt-in and defaults to false — so without
 * this step, the first run of the new version would sweep away the six .desktop
 * files an existing user already has.
 *
 * The flag is inferred from what is on disk rather than defaulted, matching how
 * isAutostartEnabled() judges autostart by reading the entry back instead of
 * trusting a stored flag. Nobody's launchers vanish; nobody gets new ones.
 *
 * @param hasLauncher  Does a launcher exist on disk for this service id?
 * @returns changed — whether cfg was modified and needs saving.
 */
export function migrateConfig(
  cfg: LoftConfig,
  hasLauncher: (id: string) => boolean,
): { changed: boolean } {
  if ((cfg.configVersion ?? 1) >= CONFIG_VERSION) return { changed: false };
  for (const [id, svc] of Object.entries(cfg.services)) {
    if (svc.launcher === undefined) svc.launcher = hasLauncher(id);
  }
  cfg.configVersion = CONFIG_VERSION;
  return { changed: true };
}
```

- [ ] **Step 4: Export the launcher path from `desktop.ts`**

In `src/main/desktop.ts`, the private helper currently reads:

```ts
function launcherPath(def: ServiceDef, env?: Env): string {
  return join(applicationsDir(env), `loft-${def.id}.desktop`);
}
```

Replace it with an id-keyed exported version plus a thin `def` wrapper — the migration iterates config keys, which are ids, and may include an id no longer in the registry:

```ts
/** Where a service's launcher lives. Keyed by id: config keys are ids, and may
 *  outlive their registry entry. */
export function serviceLauncherPath(id: string, env?: Env): string {
  return join(applicationsDir(env), `loft-${id}.desktop`);
}

function launcherPath(def: ServiceDef, env?: Env): string {
  return serviceLauncherPath(def.id, env);
}
```

- [ ] **Step 5: Call the migration at startup**

In `src/main/index.ts`, this import line currently reads:

```ts
import { ensureHubDesktopEntry, writeServiceLauncher } from './desktop';
```

Change it to:

```ts
import { ensureHubDesktopEntry, writeServiceLauncher, serviceLauncherPath } from './desktop';
```

Add these two lines to the imports (`index.ts` currently imports only `node:fs/promises`, so the `existsSync` import is new):

```ts
import { existsSync } from 'node:fs';
import { migrateConfig } from './migrate';
```

Find the line that removes v1's autostart entries — it begins:

```ts
    // Drop v1's per-service autostart entries. They're not merely stale: today's CLI
```

Immediately **above** that comment, insert:

```ts
    // Config migration (spec 09 §8). Must run before the launcher self-heal below:
    // that loop is what would otherwise act on an unmigrated config. Save only when
    // something actually changed, so a migrated install doesn't rewrite on every start.
    try {
      const { changed } = migrateConfig(config, (id) => existsSync(serviceLauncherPath(id)));
      if (changed) {
        saveConfig(configPath(), config);
        console.log('Migrated config to v2 (per-service launchers are now opt-in)');
      }
    } catch (err) { console.error('Config migration failed:', err); }
```

If `existsSync` is not already imported in `index.ts`, add it: `import { existsSync } from 'node:fs';`

- [ ] **Step 6: Run tests and build**

Run: `npm test && npm run build`
Expected: all tests PASS; `tsc` reports no errors.

- [ ] **Step 7: Verify the migration against a real config**

Run: `cat ~/.config/loft/config.json`

Note which services are listed and which of `~/.local/share/applications/loft-*.desktop` exist:

Run: `ls ~/.local/share/applications/loft-*.desktop`

Then: `npm run build && env -u ELECTRON_RUN_AS_NODE electron . --minimized`

Wait for `Migrated config to v2` on stdout, quit the app (tray → Quit Loft), and re-read the config:

Run: `cat ~/.config/loft/config.json`

Expected: `"configVersion": 2` at the top level, and each service that had a `.desktop` file now carries `"launcher": true`. **No `.desktop` file has been deleted** — re-run the `ls` to confirm the same set is present.

- [ ] **Step 8: Commit**

```bash
git add src/main/migrate.ts src/main/desktop.ts src/main/index.ts tests/migrate.test.ts
git commit -m "feat(config): migrate to v2, inferring launcher from disk

From v2 the per-service .desktop launcher is opt-in (spec 09 §6e). Without
this, the new default would silently delete the launchers every existing
user already has, on first run, via the startup self-heal sweep.

Infers the flag from disk rather than guessing, the same way
isAutostartEnabled() judges state by reading it back."
```

---

### Task 6: `addService` records `launcher: true`

Between this plan and 09c, `addService` still writes a launcher for every added service (unchanged behaviour). But the config must now *say so* — otherwise 09c's remove-sweep would delete a launcher added during the 09a/09b window, because its entry has no `launcher` key and migration has already run.

**Files:**
- Modify: `src/main/install.ts:15-23`
- Test: `tests/install.test.ts`

**Interfaces:**
- Consumes: `ServiceConfig.launcher` from Task 4.
- Produces: no signature change. `addService` now sets `cfg.services[id].launcher = true`.

- [ ] **Step 1: Write the failing test**

Add these two cases inside the existing `describe('install', ...)` block in `tests/install.test.ts`. They reuse the file's existing fixtures (`wa` from `getService('whatsapp')!`, the per-test `tmp()`/`env` pair, and `iconSrc()`) — do not add new ones:

```ts
  it('addService records that the added service has a launcher', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: {} };
    addService(wa, cfg, { env, execPath: '/usr/bin/loft', iconSourceDir: iconSrc() });
    expect(cfg.services.whatsapp.launcher).toBe(true);
  });

  it('addService sets launcher on an existing entry without dropping its fields', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { whatsapp: { dnd: true } } };
    addService(wa, cfg, { env, execPath: '/usr/bin/loft', iconSourceDir: iconSrc() });
    expect(cfg.services.whatsapp).toEqual({ dnd: true, launcher: true });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/install.test.ts`
Expected: FAIL — `expected undefined to be true`.

- [ ] **Step 3: Write the implementation**

In `src/main/install.ts`, `addService` currently reads:

```ts
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
```

Replace with:

```ts
/** Idempotent: mark the service configured, set a custom URL if given, write its launcher. */
export function addService(
  def: ServiceDef,
  cfg: LoftConfig,
  opts: { env?: Env; execPath?: string; iconSourceDir: string; customUrl?: string },
): void {
  cfg.services[def.id] = { ...cfg.services[def.id] };
  if (opts.customUrl !== undefined) cfg.services[def.id].customUrl = opts.customUrl;
  // Every added service still gets a launcher, exactly as before — but from config
  // v2 the config has to say so. Migration has already stamped v2 by the time any
  // add can happen, so an entry without this flag would read as "no launcher" and
  // 09c's remove-sweep would delete the file we are about to write.
  cfg.services[def.id].launcher = true;
  writeServiceLauncher(def, { env: opts.env, execPath: opts.execPath, iconSourceDir: opts.iconSourceDir });
}
```

- [ ] **Step 4: Run tests and build**

Run: `npm test && npm run build`
Expected: all tests PASS; `tsc` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/install.ts tests/install.test.ts
git commit -m "feat(install): record launcher: true on add

Behaviour is unchanged — every added service still gets a launcher. But from
config v2 the flag is the source of truth, so an entry that omits it reads as
'no launcher' and 09c's sweep would delete a file we just wrote."
```

---

### Task 7: Extract `ServiceView` from `serviceWindow.ts`

The core refactor (spec §5a). Everything about *a service* moves into a host-agnostic unit that can be mounted into any window; `serviceWindow.ts` keeps only what is about *a window*.

**Files:**
- Create: `src/main/serviceView.ts`
- Modify: `src/main/serviceWindow.ts` (rewritten)
- Test: none new — this is a pure refactor, verified by the existing suite staying green plus a manual smoke test. `ServiceView` is Electron-bound and not unit-testable without a live app; its pure parts (`clampZoom`, `computeLayout`) were extracted and tested in Tasks 2–3 precisely so this move stays mechanical.

**Interfaces:**
- Consumes: `computeLayout`, `Rect`, `RAIL_WIDTH` (Task 2); `clampZoom` (Task 3); `LoftConfig` (Task 4).
- Produces: `ServiceView` (interface below) and `createServiceView(def: ServiceDef, cfg: LoftConfig): ServiceView`. Plan 09b's `loftWindow.ts` mounts many of these into one window. `ServiceWindow` keeps its existing shape, so `index.ts` needs no change in this task.

- [ ] **Step 1: Create `serviceView.ts`**

Create `src/main/serviceView.ts`:

```ts
import { BrowserWindow, WebContentsView, session, shell } from 'electron';
import { join } from 'node:path';
import type { ServiceDef } from './registry';
import { effectiveUrl } from './registry';
import type { LoftConfig } from './config';
import type { Rect } from './layout';
import { configureSession } from './session';
import { dechromeCssFor } from './dechromeCss';
import { clampZoom } from './zoom';
import { createStuckWatcher, clearServiceCaches, startInitialLoad } from './recovery';
import { classifyNavigation, classifyWindowOpen, isExternallyOpenable } from './links';

/**
 * One service's web view and every policy that belongs to the service rather than
 * to a window: its partition, preload, zoom, navigation rules, and recovery overlay.
 *
 * Deliberately host-agnostic. It is mounted into a per-service window today and into
 * the Loft window's content rect in plan 09b — the same object, moved, not rebuilt.
 * That is what lets a detach keep the page's scroll position and half-typed drafts.
 */
export interface ServiceView {
  readonly def: ServiceDef;
  readonly view: WebContentsView;
  /** Add this view (and any live recovery overlay) to a window, at `rect`. */
  mount(window: BrowserWindow, rect: Rect): void;
  /** Remove from the current window WITHOUT destroying the page. */
  unmount(): void;
  /** Re-lay-out within the current window. */
  setRect(rect: Rect): void;
  /** Whether the view is drawn. JS keeps running either way (backgroundThrottling: false). */
  setVisible(visible: boolean): void;
  /** Adjust zoom by delta (rounded to 0.1, clamped 0.3–3.0) and apply it. Does NOT persist. */
  setZoom(delta: number): void;
  /** The live zoom factor — the host reads this when persisting. */
  getZoom(): number;
  /** Push Do Not Disturb to the page (gates Notification-API relays). */
  pushDnd(enabled: boolean): void;
  /** Tell the page whether it is hidden (drives document.hidden/visibilityState). */
  pushHidden(hidden: boolean): void;
  /** Ask the page to navigate to a conversation (notification click). */
  navigate(url: string): void;
  /** Navigate, hiding any stale recovery overlay and re-arming stuck detection. */
  loadUrl(url: string): void;
  /** Reload and re-arm stuck detection. */
  reload(): void;
  /** Clear the service's caches (never cookies), then reload. */
  clearAndReload(): Promise<void>;
  /** True if the id belongs to this service's view or its recovery overlay. */
  ownsWebContents(id: number): boolean;
  /** Tear down the stuck watcher and any overlay. Call from the host's 'closed'. */
  dispose(): void;
}

/**
 * Sending to a view's webContents throws "Render frame was disposed before
 * WebFrameMain could be accessed" when the frame is transiently gone — e.g. a
 * Messenger call opening its popup, or any navigation — and these sends fire from
 * window focus/blur/show/hide handlers that can land in that window. Guard them;
 * dropped state is re-pushed on the view's did-finish-load (registerService).
 */
function safeSend(view: WebContentsView, channel: string, ...args: unknown[]): void {
  const wc = view.webContents;
  if (wc.isDestroyed()) return;
  try {
    wc.send(channel, ...args);
  } catch {
    /* render frame disposed transiently */
  }
}

export function createServiceView(def: ServiceDef, cfg: LoftConfig): ServiceView {
  const partition = `persist:${def.id}`;
  const ses = session.fromPartition(partition);
  configureSession(ses, partition);

  // Service view (remote URL) — the isolated per-service partition + our preload.
  const serviceView = new WebContentsView({
    webPreferences: {
      partition,
      backgroundThrottling: false,
      preload: join(__dirname, '../preload/service.js'),
      additionalArguments: [`--loft-service=${def.id}`],
      // Sandboxed (a same-origin window.open call popup shares this opener's
      // renderer process; a non-sandboxed WebRTC renderer SIGSEGVs on Intel Xe),
      // but contextIsolation:false so the (sandboxed) preload still shares the
      // page's main world and can wrap window.Notification directly.
      sandbox: true,
      contextIsolation: false,
    },
  });
  serviceView.webContents.setUserAgent(ses.getUserAgent());

  // Static de-chrome CSS (the dynamic Messenger-banner bit runs in the preload).
  const dechromeCss = dechromeCssFor(def.id);
  if (dechromeCss) {
    serviceView.webContents.on('did-finish-load', () => {
      void serviceView.webContents.insertCSS(dechromeCss);
    });
  }

  // Hand a URL to the user's default browser (never a scheme we shouldn't, e.g.
  // javascript:/file:). Used by both link-handling paths below.
  const openInBrowser = (url: string): void => {
    if (!isExternallyOpenable(url)) return;
    void shell.openExternal(url).catch((err) => console.error('openExternal failed:', url, err));
  };

  // window.open / target=_blank. A user-clicked external link opens in the browser
  // (classifyWindowOpen); calls and windowed (featured) SSO/auth popups stay in-app.
  // Same-origin ALWAYS stays in-app, which is what guarantees a Messenger call popup
  // (opened same-origin) is never flung to the browser regardless of its disposition.
  //
  // For the in-app case: a child window inherits the OPENER's webPreferences, so
  // without overriding, the popup would inherit the service view's main-world/
  // un-sandboxed prefs (contextIsolation:false, sandbox:false) + our preload +
  // --loft-service, and its renderer SIGSEGVs (exitCode 139) doing WebRTC. Force a
  // plain, sandboxed, isolated child (matching the POC's default popup) with no Loft
  // preload/arg — it needs no integration.
  serviceView.webContents.setWindowOpenHandler((details) => {
    if (
      classifyWindowOpen(serviceView.webContents.getURL(), details.url, details.disposition) === 'external'
    ) {
      openInBrowser(details.url);
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          additionalArguments: [],
        },
      },
    };
  });

  // Top-level navigation of the service view itself. The view must never leave its
  // web app: a cross-origin nav — or, for Messenger (which shares facebook.com with
  // all of Facebook), a nav out of the messaging app to a post/profile/photo — opens
  // in the browser and is prevented in-place, so the user never "loses" the service.
  // isInPlace (same-document fragment nav) is left alone; the initial loadURL and
  // same-origin app/auth navigations are not top-level document changes we hijack.
  serviceView.webContents.on('will-navigate', (e, url, isInPlace) => {
    if (isInPlace) return;
    if (classifyNavigation(def.id, serviceView.webContents.getURL(), url) !== 'external') return;
    // Only intercept schemes we can actually hand off. For anything else (ftp:, a
    // custom app scheme) let Chromium's own external-protocol handling take it rather
    // than dead-ending the click with a bare preventDefault.
    if (!isExternallyOpenable(url)) return;
    e.preventDefault();
    openInBrowser(url);
  });

  // The call popup must present as real Chrome per-webContents (not just via the
  // session default) — mirrors the POC (dev_local/electron_test/main.js), which
  // set the child UA explicitly on did-create-window.
  serviceView.webContents.on('did-create-window', (child) => {
    child.webContents.setUserAgent(ses.getUserAgent());
  });

  // Zoom: track the live factor so user changes survive in-page reloads (Electron
  // resets zoom on a full navigation).
  let currentZoom = cfg.services[def.id]?.window?.zoom ?? 1;
  serviceView.webContents.on('did-finish-load', () =>
    serviceView.webContents.setZoomFactor(currentZoom),
  );

  // Current host + rect. Both are undefined/zero until mount(); the recovery overlay
  // needs them because it is added to whichever window the service currently lives in.
  let host: BrowserWindow | undefined;
  let rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  let recoveryView: WebContentsView | undefined;

  // --- Recovery overlay -------------------------------------------------------
  // A view can end up permanently blank (e.g. a corrupt service worker aborting
  // every navigation). Detect "nothing ever committed" and offer a way out; the
  // user chooses — we never clear their data unasked.

  const showRecovery = (): void => {
    if (recoveryView || !host) return;
    const view = new WebContentsView({
      webPreferences: { preload: join(__dirname, '../preload/recovery.js') },
    });
    recoveryView = view;
    view.webContents.on('did-finish-load', () => safeSend(view, 'recovery:set-service', def.displayName));
    void view.webContents.loadFile(join(__dirname, '../renderer/recovery/index.html'));
    host.contentView.addChildView(view); // above the service view
    view.setBounds(rect);
  };

  const hideRecovery = (): void => {
    if (!recoveryView) return;
    const view = recoveryView;
    recoveryView = undefined;
    // The host (and this view's webContents) may already be gone by the time this
    // runs — e.g. quit/remove-service landing during clearAndReload's await, or a
    // late did-navigate firing after quit. Never throw from a window action.
    if (host && !host.isDestroyed()) host.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  };

  const watcher = createStuckWatcher({
    timeoutMs: 15_000,
    getUrl: () => serviceView.webContents.getURL(),
    onStuck: showRecovery,
    onRecovered: hideRecovery,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  });
  serviceView.webContents.on('did-navigate', (_e, url) => watcher.navigated(url));

  // Single choke point for real navigations: hides a stale overlay and re-arms
  // stuck detection so no navigation path (initial load, customUrl change, ...)
  // can silently bypass the watcher.
  const loadUrl = (url: string): void => {
    hideRecovery();
    void serviceView.webContents.loadURL(url);
    watcher.armed();
  };

  // Ctrl+R / F5 — there is no app menu (Menu.setApplicationMenu(null)), so the
  // usual reload accelerator does not exist. Safe to reference `api` here: the
  // handler only ever fires asynchronously, long after construction returns.
  serviceView.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const isReload = input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r');
    if (isReload) api.reload();
  });

  // Kick off the first navigation. Slack (clearCachesOnStart) has its wedge-prone
  // persisted service worker cleared first so a fresh, working SW registers each
  // launch — see startInitialLoad. A clear failure still loads (never left blank).
  void startInitialLoad(def.clearCachesOnStart ?? false, {
    clearCaches: () => clearServiceCaches(ses),
    load: () => loadUrl(effectiveUrl(def, cfg.services[def.id]?.customUrl)),
    onError: (err) => console.error(`clearCachesOnStart(${def.id}) failed:`, err),
  });

  const api: ServiceView = {
    def,
    view: serviceView,
    mount: (w, r) => {
      host = w;
      rect = r;
      w.contentView.addChildView(serviceView);
      serviceView.setBounds(r);
      // Carry a live overlay across the move — a service can be stuck *while* it is
      // re-parented, and re-adding it here keeps it above the service view.
      if (recoveryView) {
        w.contentView.addChildView(recoveryView);
        recoveryView.setBounds(r);
      }
    },
    unmount: () => {
      if (host && !host.isDestroyed()) {
        if (recoveryView) host.contentView.removeChildView(recoveryView);
        host.contentView.removeChildView(serviceView);
      }
      host = undefined;
    },
    setRect: (r) => {
      rect = r;
      serviceView.setBounds(r);
      recoveryView?.setBounds(r);
    },
    setVisible: (visible) => {
      serviceView.setVisible(visible);
      recoveryView?.setVisible(visible);
    },
    setZoom: (delta) => {
      currentZoom = clampZoom(currentZoom + delta);
      serviceView.webContents.setZoomFactor(currentZoom);
    },
    getZoom: () => currentZoom,
    pushDnd: (enabled) => safeSend(serviceView, 'service:dnd', enabled),
    pushHidden: (hidden) => safeSend(serviceView, 'service:visibility', hidden),
    navigate: (url) => safeSend(serviceView, 'service:navigate', url),
    loadUrl,
    reload: () => {
      hideRecovery();
      serviceView.webContents.reload();
      watcher.armed();
    },
    clearAndReload: async () => {
      await clearServiceCaches(ses);
      api.reload();
    },
    ownsWebContents: (id) =>
      serviceView.webContents.id === id || recoveryView?.webContents.id === id,
    dispose: () => {
      watcher.dispose();
      hideRecovery();
    },
  };

  return api;
}
```

- [ ] **Step 2: Rewrite `serviceWindow.ts` around it**

Replace `src/main/serviceWindow.ts` entirely:

```ts
import { BrowserWindow, WebContentsView } from 'electron';
import { join } from 'node:path';
import type { ServiceDef } from './registry';
import type { LoftConfig } from './config';
import { computeLayout } from './layout';
import { formatWindowTitle } from './serviceTitle';
import { createServiceView } from './serviceView';

/**
 * A detached host: one BrowserWindow showing exactly one service, with our own
 * titlebar strip above it. Everything about the *service* lives in ServiceView;
 * this file is only about the *window* — bounds, close-to-tray, the titlebar.
 */
export interface ServiceWindow {
  def: ServiceDef;
  window: BrowserWindow;
  serviceView: WebContentsView;
  titlebarView: WebContentsView;
  show(): void;
  hide(): void;
  /** Adjust the service view's zoom by delta (clamped 0.3–3.0), apply, and persist. */
  setZoom(delta: number): void;
  /** Write current bounds + zoom into the in-memory config. */
  persist(): void;
  /** Reflect the unread count in the window title. */
  setBadge(count: number): void;
  /** Push the current Do Not Disturb state to the page (gates Notification-API relays). */
  pushDnd(enabled: boolean): void;
  /** Tell the page whether the window is hidden (drives document.hidden/visibilityState). */
  pushHidden(hidden: boolean): void;
  /** Ask the page to navigate to a conversation (Messenger notification click). */
  navigate(url: string): void;
  /** Navigate the service view, hiding any stale recovery overlay and re-arming stuck detection. */
  loadUrl(url: string): void;
  /** Reload the service view and re-arm stuck detection. */
  reload(): void;
  /** Clear the service's caches (never cookies), then reload. */
  clearAndReload(): Promise<void>;
  /** True if the given webContents id belongs to this window (titlebar, service, or recovery overlay). */
  ownsWebContents(id: number): boolean;
}

export function createServiceWindow(
  def: ServiceDef,
  cfg: LoftConfig,
  opts: { minimized: boolean; onQuit: () => boolean },
): ServiceWindow {
  const saved = cfg.services[def.id]?.window;

  const window = new BrowserWindow({
    width: saved?.width ?? 1100,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    frame: false,
    show: false,
    title: def.displayName,
  });

  // Guarded send — the titlebar's frame can be transiently gone during navigation,
  // and setBadge fires from handlers that can land in that window.
  const safeSend = (view: WebContentsView, channel: string, ...args: unknown[]): void => {
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    try {
      wc.send(channel, ...args);
    } catch {
      /* render frame disposed transiently */
    }
  };

  // Titlebar view (our chrome) — its own partition-free session is fine.
  const titlebar = new WebContentsView({
    webPreferences: { preload: join(__dirname, '../preload/titlebar.js') },
  });
  titlebar.webContents.on('did-finish-load', () =>
    safeSend(titlebar, 'titlebar:set-service', def.displayName),
  );
  titlebar.webContents.loadFile(join(__dirname, '../renderer/titlebar/index.html'));

  const sv = createServiceView(def, cfg);

  const relayout = (): void => {
    const [w, h] = window.getContentSize();
    const { titlebar: t, content } = computeLayout(w, h);
    titlebar.setBounds(t);
    sv.setRect(content);
  };

  window.contentView.addChildView(titlebar);
  const [w0, h0] = window.getContentSize();
  sv.mount(window, computeLayout(w0, h0).content); // above the titlebar, as before
  relayout();
  window.on('resize', relayout);

  // Close-to-tray: hide unless the app is actually quitting.
  window.on('close', (e) => {
    if (!opts.onQuit()) {
      e.preventDefault();
      window.hide();
    }
  });

  // Persist bounds + zoom into the in-memory config (index.ts saveConfig runs on
  // before-quit). Bind to resize/move AND hide so a session that only zooms or never
  // moves the window still records its state.
  const persist = (): void => {
    const [w, h] = window.getSize();
    const [x, y] = window.getPosition();
    cfg.services[def.id] = {
      ...cfg.services[def.id],
      window: { x, y, width: w, height: h, zoom: sv.getZoom() },
    };
  };
  window.on('resize', persist);
  window.on('move', persist);
  window.on('hide', persist);

  // Safe only because ServiceView.dispose()'s overlay teardown guards on
  // isDestroyed() — 'closed' fires after the window (and its child views, since
  // win.destroy() doesn't tear down child WebContentsView webContents on its own)
  // is already destroyed.
  window.on('closed', () => sv.dispose());

  const api: ServiceWindow = {
    def,
    window,
    serviceView: sv.view,
    titlebarView: titlebar,
    show: () => {
      window.show();
      window.focus();
    },
    hide: () => window.hide(),
    setZoom: (delta: number) => {
      sv.setZoom(delta);
      persist();
    },
    persist,
    setBadge: (count: number) => {
      const title = formatWindowTitle(def.displayName, count);
      window.setTitle(title); // OS window title (alt-tab / taskbar / overview)
      safeSend(titlebar, 'titlebar:set-service', title); // our visible titlebar strip
    },
    pushDnd: (enabled: boolean) => sv.pushDnd(enabled),
    pushHidden: (hidden: boolean) => sv.pushHidden(hidden),
    navigate: (url: string) => sv.navigate(url),
    loadUrl: (url: string) => sv.loadUrl(url),
    reload: () => sv.reload(),
    clearAndReload: () => sv.clearAndReload(),
    ownsWebContents: (id: number) => titlebar.webContents.id === id || sv.ownsWebContents(id),
  };

  if (!opts.minimized) api.show();
  return api;
}
```

- [ ] **Step 3: Run tests and build**

Run: `npm test && npm run build`
Expected: all tests PASS; `tsc` reports no errors. `index.ts` needs no change — `ServiceWindow`'s shape is unchanged.

- [ ] **Step 4: Smoke-test the refactor**

This task has no new automated test, so the manual check *is* the verification. Do not skip it.

Run: `npm run build && env -u ELECTRON_RUN_AS_NODE electron . --service=whatsapp`

Confirm each of these — every one exercises a path that moved between files:

1. The window opens and WhatsApp loads.
2. The titlebar shows the icon and "WhatsApp".
3. Zoom out then in (the "A" buttons) visibly changes the page.
4. `Ctrl+R` reloads the page, and the zoom level survives the reload.
5. Send yourself a message from your phone: the titlebar and OS title become `WhatsApp (1)`.
6. Click a link in a chat: it opens in your **browser**, not in the view.
7. Click ✕: the window hides, the tray icon stays, and clicking the tray entry brings it back.
8. Quit via the tray, relaunch, and confirm the window's size and zoom were restored.

Then, the one that matters most (spec §10):

9. Place a **voice call** and a **video call**. Both must connect, and the app must not die with exit code 139.

- [ ] **Step 5: Commit**

```bash
git add src/main/serviceView.ts src/main/serviceWindow.ts
git commit -m "refactor: split ServiceView out of serviceWindow

Spec 09 §5a. serviceWindow tangled what a *service* is (partition, preload,
zoom, nav policy, recovery overlay) with what a *window* is (bounds,
close-to-tray, titlebar). The unified view needs a service to outlive its
window, so they had to come apart.

ServiceView is host-agnostic and mount()/unmount()-able, which is what lets
09b put many of them in one window and 09c move one back out with the page
still live. No behaviour change: the per-service window is still the only host.

Drops the TDZ hazard the old recoveryView comment warned about — nothing
reads it eagerly during construction any more."
```

---

### Task 8: `ServiceHost` — the interface consumers talk to

Spec §5a: tray, D-Bus and notifications must never learn *where* a service lives. Defining this now, with one implementer, keeps 09b from having to reach back into `index.ts` — and `tsc` proves `ServiceWindow` is already host-shaped.

**Files:**
- Create: `src/main/serviceHost.ts`
- Modify: `src/main/serviceWindow.ts` (make `ServiceWindow extends ServiceHost`)
- Modify: `src/main/index.ts` (add `hostOf`, route the four host-only call sites through it)
- Test: **none — `tsc` is the gate.** `export interface ServiceWindow extends ServiceHost`, plus the existing `const api: ServiceWindow = {…}` literal, already makes the compiler prove `ServiceWindow` satisfies the interface. A runtime test could only exercise a fake declared in the test file itself, which proves nothing about production code. The one invariant a test *could* add — "ServiceHost is satisfiable without a window" — is proven for real in 09b, when `loftWindow` becomes the second implementer. (Keith's call, pre-flight: drop the test.)

**Interfaces:**
- Consumes: `ServiceWindow` from Task 7.
- Produces: `ServiceHost` — `{ show(): void; hide(): void; setZoom(delta: number): void; setBadge(count: number): void; pushDnd(enabled: boolean): void; pushHidden(hidden: boolean): void; navigate(url: string): void; loadUrl(url: string): void; reload(): void; clearAndReload(): Promise<void>; ownsWebContents(id: number): boolean }`. Plan 09b's Loft window implements this per attached service.

- [ ] **Step 1: Write the implementation**

Create `src/main/serviceHost.ts`:

```ts
/**
 * Everything tray, D-Bus and notifications need from *wherever* a service lives.
 *
 * Implemented today only by the per-service window; in plan 09b the Loft window
 * implements it per attached service, so `Show()` on an attached service means
 * "raise Loft and select that tab" while the caller stays none the wiser. That
 * indifference is the whole point — consumers must never branch on where a
 * service lives.
 *
 * Deliberately excludes anything window-shaped (BrowserWindow, titlebar, bounds):
 * the moment one leaks in, the Loft window can't satisfy this and the abstraction
 * is dead. There is no test for that — 09b's loftWindow is the enforcement, by
 * being the second implementer. Keep this interface window-free by hand until then.
 */
export interface ServiceHost {
  /** Show and focus this service — raising its window, and selecting it if it shares one. */
  show(): void;
  /** Hide this service. For a shared host, hides the whole window (spec 09 §6b). */
  hide(): void;
  /** Adjust zoom by delta (clamped 0.3–3.0), apply, and persist. */
  setZoom(delta: number): void;
  /** Reflect the unread count wherever this service's title is shown. */
  setBadge(count: number): void;
  /** Push Do Not Disturb to the page (gates Notification-API relays). */
  pushDnd(enabled: boolean): void;
  /** Tell the page whether it is hidden (drives document.hidden/visibilityState). */
  pushHidden(hidden: boolean): void;
  /** Ask the page to navigate to a conversation (notification click). */
  navigate(url: string): void;
  /** Navigate, hiding any stale recovery overlay and re-arming stuck detection. */
  loadUrl(url: string): void;
  /** Reload and re-arm stuck detection. */
  reload(): void;
  /** Clear the service's caches (never cookies), then reload. */
  clearAndReload(): Promise<void>;
  /** True if the given webContents id belongs to this service's chrome or page. */
  ownsWebContents(id: number): boolean;
}
```

- [ ] **Step 2: Make `ServiceWindow` extend it**

In `src/main/serviceWindow.ts`, add to the imports:

```ts
import type { ServiceHost } from './serviceHost';
```

Then change the interface declaration and delete the members `ServiceHost` now supplies. It currently reads:

```ts
export interface ServiceWindow {
  def: ServiceDef;
  window: BrowserWindow;
  serviceView: WebContentsView;
  titlebarView: WebContentsView;
  show(): void;
  hide(): void;
  /** Adjust the service view's zoom by delta (clamped 0.3–3.0), apply, and persist. */
  setZoom(delta: number): void;
  /** Write current bounds + zoom into the in-memory config. */
  persist(): void;
  /** Reflect the unread count in the window title. */
  setBadge(count: number): void;
  /** Push the current Do Not Disturb state to the page (gates Notification-API relays). */
  pushDnd(enabled: boolean): void;
  /** Tell the page whether the window is hidden (drives document.hidden/visibilityState). */
  pushHidden(hidden: boolean): void;
  /** Ask the page to navigate to a conversation (Messenger notification click). */
  navigate(url: string): void;
  /** Navigate the service view, hiding any stale recovery overlay and re-arming stuck detection. */
  loadUrl(url: string): void;
  /** Reload the service view and re-arm stuck detection. */
  reload(): void;
  /** Clear the service's caches (never cookies), then reload. */
  clearAndReload(): Promise<void>;
  /** True if the given webContents id belongs to this window (titlebar, service, or recovery overlay). */
  ownsWebContents(id: number): boolean;
}
```

Replace the whole declaration with:

```ts
export interface ServiceWindow extends ServiceHost {
  def: ServiceDef;
  window: BrowserWindow;
  serviceView: WebContentsView;
  titlebarView: WebContentsView;
  /** Write current bounds + zoom into the in-memory config. Window-only: a rail
   *  entry has no bounds of its own, so this is not part of ServiceHost. */
  persist(): void;
}
```

The `api` object literal below is unchanged — it already implements every member.

- [ ] **Step 3: Route the host-only call sites in `index.ts` through `hostOf`**

Add to the imports in `src/main/index.ts`:

```ts
import type { ServiceHost } from './serviceHost';
```

Directly below the `windows` map declaration (`const windows = new Map<string, ServiceWindow>();`), add:

```ts
// Where a service currently lives, as the narrow contract consumers should use.
// Today every host is a ServiceWindow; in 09b an attached service's host is the
// Loft window instead, and nothing below this line has to care.
const hostOf = (id: string): ServiceHost | undefined => windows.get(id);
```

Then switch exactly four call sites — the only ones that touch nothing window-shaped.

`src/main/index.ts:327-329` currently read:

```ts
        navigate: (id, url) => windows.get(id)?.navigate(url),
        pushDnd: (id, v) => windows.get(id)?.pushDnd(v),
        pushHidden: (id, hidden) => windows.get(id)?.pushHidden(hidden),
```

Change to:

```ts
        navigate: (id, url) => hostOf(id)?.navigate(url),
        pushDnd: (id, v) => hostOf(id)?.pushDnd(v),
        pushHidden: (id, hidden) => hostOf(id)?.pushHidden(hidden),
```

`src/main/index.ts:425` currently reads:

```ts
        if (patch.dnd !== undefined) { tray?.setDnd(id, patch.dnd); notifications?.setServiceDnd(id, patch.dnd); windows.get(id)?.pushDnd(patch.dnd); }
```

Change the last call only:

```ts
        if (patch.dnd !== undefined) { tray?.setDnd(id, patch.dnd); notifications?.setServiceDnd(id, patch.dnd); hostOf(id)?.pushDnd(patch.dnd); }
```

**Change nothing else.** In particular, leave these alone — each reaches for something window-shaped that stays on `ServiceWindow` until 09b gives it a home:

- `index.ts:287` and `index.ts:397` — `windows.get(d.id)?.window.isVisible()`.
- `index.ts:104`, `:140`, `:156`, `:427`, `:435`, `:444`, `:490`, `:498` — each binds `const sw = windows.get(id)` and then uses `.window`, `.def`, or `.persist()`.
- `index.ts:241` — `sw.setBadge(...)`, where `sw` comes from `findBySenderId`, not from `windows.get`.

`focusService` also stays as-is: it calls `openService`, because it must be able to **create** a host, which `hostOf` deliberately cannot do.

- [ ] **Step 4: Run tests and build**

Run: `npm test && npm run build`
Expected: all tests PASS; `tsc` reports no errors. If `tsc` complains that `ServiceWindow` does not satisfy `ServiceHost`, that is the interface doing its job — fix the member, don't widen `ServiceHost`.

- [ ] **Step 5: Smoke-test**

Run: `npm run build && env -u ELECTRON_RUN_AS_NODE electron . --service=slack`

Confirm the paths that now route through `hostOf`:

1. Slack loads; its unread count reaches the titlebar and the tray.
2. Toggle per-service DND from the tray; confirm notifications stop and restart.
3. Hide the window and send yourself a Slack message: a desktop notification appears.
4. Click that notification: the Slack window focuses.

- [ ] **Step 6: Commit**

```bash
git add src/main/serviceHost.ts src/main/serviceWindow.ts src/main/index.ts
git commit -m "refactor: add ServiceHost, the where-agnostic service contract

Spec 09 §5a. Tray, D-Bus and notifications must never learn whether a
service lives in its own window or the Loft window's rail. ServiceWindow
now extends it, so tsc proves it is already host-shaped, and index.ts's
window-free call sites go through hostOf().

persist() stays off the interface on purpose: a rail entry has no bounds
of its own. 09b's Loft window is the second implementer."
```

---

## What 09a leaves behind

- **Evidence**, recorded in the spec, that re-parenting and calls survive — or a NO-GO before anything was built on the assumption.
- `ServiceView`, mountable into any window, and `ServiceHost`, the contract that hides which window that is.
- A config that carries `detached`, `launcher`, `configVersion`, the Loft window's bounds, `reopenDetached`, and `railOrder` — validated, and migrated so no existing user's launchers disappear.
- Zero user-visible change.

**Next:** plan 09b (the unified window) — write it *after* the spike reports, since its design depends on what the spike finds.
