# Service-view Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A service view that fails to load stops being a dead end — Loft detects it, offers Reload / Clear cache & reload in-window, and the user recovers without a debugger and without losing their login.

**Architecture:** Detection is a pure, injectable watcher in `src/main/recovery.ts` (trigger = "nothing ever committed", i.e. `about:blank` 15s after `loadURL`; `did-fail-load` is unusable because `ERR_ABORTED` fires on healthy redirects). Presentation is a third `WebContentsView` per service window — an overlay error page mirroring the existing titlebar-view pattern — created on stuck, removed on recover. The same `ServiceWindow.reload()` / `clearAndReload()` pair is driven by the overlay, a titlebar button, Ctrl+R/F5, and a hub action.

**Tech Stack:** Electron 43 (`WebContentsView`, `session.clearStorageData`), TypeScript, Svelte 5 (hub), Vitest.

## Global Constraints

- Branch `electron-rewrite`; **NOT merged to main**. All commits land here.
- **Cookies are sacred.** Clearing touches **only** `['serviceworkers', 'cachestorage']` (+ `clearCache()`). **NEVER** `cookies`, `localstorage`, or `indexdb` — that is the user's login and the web app's state. Verified by hand on the live incident (Slack recovered still signed in).
- **Recovery is offered, never auto-applied.** Detection only *shows* the overlay; the user chooses.
- **Detection trigger is `isStuckUrl` (empty or `about:blank`) 15s after load** — never `did-fail-load` (`ERR_ABORTED` fires on Slack's healthy `/client` → `/client/T…` redirect).
- **Network failures are out of scope**: Chromium commits its own error page and `getURL()` returns the real URL, so `isStuckUrl` is false and no overlay appears. Do not try to handle them.
- New renderer/preload code is plain TS compiled by `tsc` (like `src/preload/titlebar.ts` — **not** esbuild-bundled; only `service.ts`/`hub.ts` are bundled, because only they import local modules).
- Gates: `npm test` (Vitest) and `npm run check` (svelte-check, 0 errors/0 warnings) must pass. All npm commands run at the repository root (the app was hoisted out of `electron/`).
- Follow the existing never-throw/`safeSend` discipline in `serviceWindow.ts` — a disposed render frame must never crash a window action.

---

## File Structure

- **Create:** `src/main/recovery.ts` — `isStuckUrl`, `createStuckWatcher`, `clearServiceCaches` (pure logic + the one Electron call, behind a `Session` param)
- **Create:** `src/preload/recovery.ts` — contextBridge for the overlay (mirrors `src/preload/titlebar.ts`)
- **Create:** `src/renderer/recovery/{index.html,recovery.css,recovery.ts,window.d.ts}` — the overlay error page
- **Create:** `tests/recovery.test.ts`
- **Modify:** `src/main/serviceWindow.ts` — overlay lifecycle, watcher wiring, `reload()`/`clearAndReload()`/`ownsWebContents()`, Ctrl+R
- **Modify:** `src/main/index.ts` — `findBySenderId` via `ownsWebContents`; `titlebar:reload`, `recovery:*` IPC; hub `recoverService` dep
- **Modify:** `src/renderer/titlebar/{index.html,titlebar.css,titlebar.ts}` + `src/preload/titlebar.ts` — ⟳ button
- **Modify:** `src/main/hubWindow.ts`, `src/shared/hubTypes.ts`, `src/preload/hub.ts`, `src/renderer/hub/components/ServiceDetail.svelte` — hub Troubleshooting action
- **Modify:** `package.json` — `copy-assets` copies the recovery page

---

## Task 1: Recovery core — detection + cache clearing (`src/main/recovery.ts`)

Pure, injectable logic. No Electron wiring; no UI. This is where the load-bearing cookie guarantee is locked.

**Files:**
- Create: `src/main/recovery.ts`
- Test: `tests/recovery.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 3 and 5):
  - `isStuckUrl(url: string): boolean`
  - `interface StuckWatcherDeps { timeoutMs: number; getUrl(): string; onStuck(): void; onRecovered(): void; setTimer(fn: () => void, ms: number): unknown; clearTimer(handle: unknown): void; }`
  - `interface StuckWatcher { armed(): void; navigated(url: string): void; dispose(): void; }`
  - `createStuckWatcher(deps: StuckWatcherDeps): StuckWatcher`
  - `clearServiceCaches(ses: Session): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/recovery.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { Session } from 'electron';
import { isStuckUrl, createStuckWatcher, clearServiceCaches } from '../src/main/recovery';

describe('isStuckUrl', () => {
  it('treats a view that never committed as stuck', () => {
    expect(isStuckUrl('')).toBe(true);
    expect(isStuckUrl('about:blank')).toBe(true);
  });
  it('treats a committed document as fine', () => {
    expect(isStuckUrl('https://app.slack.com/client/')).toBe(false);
    // Chromium's own error page commits the real URL -> not our problem (spec §3).
    expect(isStuckUrl('https://app.slack.com/client/T1/D2')).toBe(false);
  });
});

/** Fake-timer harness: setTimer captures the callback so the test fires it by hand. */
function harness(initialUrl = 'about:blank') {
  let pending: (() => void) | undefined;
  let url = initialUrl;
  const calls = { stuck: 0, recovered: 0, cleared: 0 };
  const w = createStuckWatcher({
    timeoutMs: 15000,
    getUrl: () => url,
    onStuck: () => { calls.stuck++; },
    onRecovered: () => { calls.recovered++; },
    setTimer: (fn) => { pending = fn; return 1; },
    clearTimer: () => { pending = undefined; calls.cleared++; },
  });
  return {
    w, calls,
    fire: () => { const f = pending; pending = undefined; f?.(); },
    setUrl: (u: string) => { url = u; },
  };
}

describe('createStuckWatcher', () => {
  it('does not report stuck when the page commits before the timeout', () => {
    const h = harness();
    h.w.armed();
    h.setUrl('https://app.slack.com/client/T1/D2');
    h.w.navigated('https://app.slack.com/client/T1/D2');
    h.fire(); // timer was cleared — no-op
    expect(h.calls.stuck).toBe(0);
  });

  it('reports stuck once when still blank at the timeout', () => {
    const h = harness();
    h.w.armed();
    h.fire();
    expect(h.calls.stuck).toBe(1);
  });

  it('ignores a navigation that is itself blank (does not disarm)', () => {
    const h = harness();
    h.w.armed();
    h.w.navigated('about:blank');
    h.fire();
    expect(h.calls.stuck).toBe(1);
  });

  it('recovers when the page commits late (slow network self-correction)', () => {
    const h = harness();
    h.w.armed();
    h.fire();
    expect(h.calls.stuck).toBe(1);
    h.setUrl('https://app.slack.com/client/T1/D2');
    h.w.navigated('https://app.slack.com/client/T1/D2');
    expect(h.calls.recovered).toBe(1);
  });

  it('does not fire onRecovered when it never reported stuck', () => {
    const h = harness();
    h.w.armed();
    h.w.navigated('https://app.slack.com/client/');
    expect(h.calls.recovered).toBe(0);
  });

  it('dispose clears a pending timer', () => {
    const h = harness();
    h.w.armed();
    h.w.dispose();
    expect(h.calls.cleared).toBeGreaterThan(0);
    h.fire();
    expect(h.calls.stuck).toBe(0);
  });
});

describe('clearServiceCaches', () => {
  it('clears ONLY serviceworkers + cachestorage, never cookies/localstorage/indexdb', async () => {
    const seen: string[][] = [];
    let cacheCleared = false;
    const fake = {
      clearStorageData: async (o: { storages: string[] }) => { seen.push(o.storages); },
      clearCache: async () => { cacheCleared = true; },
    } as unknown as Session;

    await clearServiceCaches(fake);

    expect(seen).toEqual([['serviceworkers', 'cachestorage']]);
    expect(cacheCleared).toBe(true);
    const everything = seen.flat();
    for (const forbidden of ['cookies', 'localstorage', 'indexdb', 'websql', 'filesystem']) {
      expect(everything).not.toContain(forbidden);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/recovery.test.ts`
Expected: FAIL — cannot resolve `../src/main/recovery`.

- [ ] **Step 3: Write the implementation**

Create `src/main/recovery.ts`:
```ts
import type { Session } from 'electron';

/**
 * A view that never committed a document sits on about:blank (or ''). This is the
 * ONLY reliable "it didn't load" signature: `did-fail-load` is unusable because
 * ERR_ABORTED fires on healthy redirects too (Slack's /client -> /client/T…/D…
 * supersedes the first navigation and reports ERR_ABORTED, canceled=true).
 * A network failure is deliberately NOT stuck — Chromium commits its own error
 * page with the real URL, and that page is better than anything we'd show.
 */
export function isStuckUrl(url: string): boolean {
  return !url || url === 'about:blank';
}

export interface StuckWatcherDeps {
  timeoutMs: number;
  getUrl(): string;
  onStuck(): void;
  onRecovered(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface StuckWatcher {
  /** Call whenever a load starts (loadURL / reload) — (re)arms the timer. */
  armed(): void;
  /** Call on did-navigate — a real URL disarms and, if we showed recovery, hides it. */
  navigated(url: string): void;
  dispose(): void;
}

export function createStuckWatcher(deps: StuckWatcherDeps): StuckWatcher {
  let handle: unknown;
  let showing = false;

  const clear = (): void => {
    if (handle === undefined) return;
    deps.clearTimer(handle);
    handle = undefined;
  };

  return {
    armed(): void {
      clear();
      handle = deps.setTimer(() => {
        handle = undefined;
        if (!isStuckUrl(deps.getUrl())) return;
        showing = true;
        deps.onStuck();
      }, deps.timeoutMs);
    },
    navigated(url: string): void {
      // A blank "navigation" is not a commit — leave the timer armed.
      if (isStuckUrl(url)) return;
      clear();
      if (!showing) return;
      showing = false;
      deps.onRecovered();
    },
    dispose(): void {
      clear();
    },
  };
}

/**
 * Clear only what can wedge a load: a corrupt/stale service worker and its caches.
 * NEVER cookies/localstorage/indexdb — that is the user's login and the web app's
 * state. Verified live: clearing exactly these restored a wedged Slack while the
 * session stayed signed in.
 */
export async function clearServiceCaches(ses: Session): Promise<void> {
  await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
  await ses.clearCache();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/recovery.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Run the gates**

Run: `npm test && npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/recovery.ts tests/recovery.test.ts
git commit -q -m "feat(recovery): stuck-view detection + cache clearing core

isStuckUrl keys on 'nothing ever committed' (about:blank) — did-fail-load is
unusable because ERR_ABORTED fires on healthy redirects. clearServiceCaches
clears only serviceworkers+cachestorage, never cookies, so the login survives.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Recovery overlay page + preload

The error page the user actually sees. No main wiring yet (Task 3 shows it).

**Files:**
- Create: `src/preload/recovery.ts`, `src/renderer/recovery/index.html`, `src/renderer/recovery/recovery.css`, `src/renderer/recovery/recovery.ts`, `src/renderer/recovery/window.d.ts`
- Modify: `package.json` (`copy-assets`)

**Interfaces:**
- Produces (consumed by Task 3): preload at `dist/preload/recovery.js` exposing `window.loftRecovery`; page at `dist/renderer/recovery/index.html`; IPC channels `recovery:reload`, `recovery:clear-and-reload` (renderer→main) and `recovery:set-service` (main→renderer).

- [ ] **Step 1: Write the preload**

Create `src/preload/recovery.ts` (mirrors `src/preload/titlebar.ts` — plain tsc, contextIsolation on):
```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('loftRecovery', {
  reload: () => ipcRenderer.send('recovery:reload'),
  clearAndReload: () => ipcRenderer.send('recovery:clear-and-reload'),
  onSetService: (cb: (name: string) => void) =>
    ipcRenderer.on('recovery:set-service', (_e, name: string) => cb(name)),
});
```

- [ ] **Step 2: Write the page**

Create `src/renderer/recovery/index.html`:
```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="recovery.css" />
  </head>
  <body>
    <div class="card">
      <h1 id="title">This service didn’t load.</h1>
      <p class="detail">
        The page never finished loading. Reloading usually helps — if it doesn’t,
        clearing this service’s cache will.
      </p>
      <div class="actions">
        <button id="reload">Reload</button>
        <button id="clear" class="primary">
          <span>Clear cache &amp; reload</span>
          <span class="sub">Keeps you signed in</span>
        </button>
      </div>
    </div>
    <script src="recovery.js"></script>
  </body>
</html>
```

Create `src/renderer/recovery/recovery.ts`:
```ts
document.getElementById('reload')!.addEventListener('click', () => window.loftRecovery.reload());
document.getElementById('clear')!.addEventListener('click', () => window.loftRecovery.clearAndReload());

// Main sends the service display name once the overlay has finished loading.
const titleEl = document.getElementById('title')!;
window.loftRecovery.onSetService((name: string) => {
  titleEl.textContent = `${name} didn’t load.`;
});
```

Create `src/renderer/recovery/window.d.ts`:
```ts
export {};
declare global {
  interface Window {
    loftRecovery: {
      reload(): void;
      clearAndReload(): void;
      onSetService(cb: (name: string) => void): void;
    };
  }
}
```

- [ ] **Step 3: Write the stylesheet (system-aware — do NOT hardcode light)**

Create `src/renderer/recovery/recovery.css` (same token palette as the titlebar/hub; the titlebar shipped hardcoded-light and had to be fixed — don't repeat it):
```css
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1a1a1a; --muted: #5c5c5c;
  --card: #f4f4f6; --divider: #e2e2e6; --accent: #3584e4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1e1e20; --fg: #ededed; --muted: #a8a8a8;
    --card: #2a2a2d; --divider: #3a3a3f; --accent: #62a0ea;
  }
}
html, body { height: 100%; font-family: system-ui, sans-serif; }
body { display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--bg); color: var(--fg); }
.card { max-width: 440px; text-align: center; }
h1 { font-size: 18px; font-weight: 600; margin-bottom: 10px; }
.detail { color: var(--muted); font-size: 13px; line-height: 1.5; margin-bottom: 20px; }
.actions { display: flex; gap: 10px; justify-content: center; }
button { border: 1px solid var(--divider); background: var(--card); color: var(--fg); border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; font-family: inherit; }
button:hover { border-color: var(--accent); }
.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.sub { font-size: 10px; opacity: 0.85; }
```

- [ ] **Step 4: Teach `copy-assets` to ship the page**

In `package.json`, replace the `copy-assets` script value with (adds `dist/renderer/recovery` to the `mkdir -p` and copies the two static files; everything else is unchanged):
```
"copy-assets": "mkdir -p dist/renderer/titlebar dist/renderer/recovery dist/assets/icons && cp src/renderer/titlebar/index.html src/renderer/titlebar/titlebar.css dist/renderer/titlebar/ && cp src/renderer/recovery/index.html src/renderer/recovery/recovery.css dist/renderer/recovery/ && cp assets/loft.png dist/assets/ && cp assets/icons/*.png dist/assets/icons/ && cp assets/icons/loft-symbolic.svg dist/assets/loft-symbolic.svg",
```

- [ ] **Step 5: Build and verify the artefacts land**

Run:
```bash
npm run build
ls dist/preload/recovery.js dist/renderer/recovery/index.html dist/renderer/recovery/recovery.css dist/renderer/recovery/recovery.js
```
Expected: build exits 0 and all four files exist (`recovery.js` for both preload and renderer come from `tsc`; the html/css from `copy-assets`).

- [ ] **Step 6: Run the gates**

Run: `npm test && npm run check`
Expected: PASS (no behaviour change yet — nothing loads this page).

- [ ] **Step 7: Commit**

```bash
git add src/preload/recovery.ts src/renderer/recovery package.json
git commit -q -m "feat(recovery): overlay error page + preload

A system-aware Reload / Clear cache & reload page, plus its contextBridge preload,
mirroring the titlebar view. Not wired up yet.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Wire recovery into the service window

Overlay lifecycle + watcher + the shared `reload()`/`clearAndReload()` + Ctrl+R, and route the overlay's IPC.

**Files:**
- Modify: `src/main/serviceWindow.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `createStuckWatcher`, `clearServiceCaches` from `src/main/recovery` (Task 1); `dist/preload/recovery.js` + `dist/renderer/recovery/index.html` and channels `recovery:reload` / `recovery:clear-and-reload` / `recovery:set-service` (Task 2).
- Produces (consumed by Tasks 4 and 5) — three additions to `interface ServiceWindow`:
  - `reload(): void`
  - `clearAndReload(): Promise<void>`
  - `ownsWebContents(id: number): boolean`

- [ ] **Step 1: Extend the `ServiceWindow` interface**

In `src/main/serviceWindow.ts`, add to `interface ServiceWindow` (after `navigate`):
```ts
  /** Reload the service view and re-arm stuck detection. */
  reload(): void;
  /** Clear the service's caches (never cookies), then reload. */
  clearAndReload(): Promise<void>;
  /** True if the given webContents id belongs to this window (titlebar, service, or recovery overlay). */
  ownsWebContents(id: number): boolean;
```

- [ ] **Step 2: Add the imports**

In `src/main/serviceWindow.ts`, add:
```ts
import { createStuckWatcher, clearServiceCaches } from './recovery';
```

- [ ] **Step 3: Add the overlay + watcher (insert immediately before the `serviceView.webContents.loadURL(...)` line)**

```ts
  // --- Recovery overlay -------------------------------------------------------
  // A view can end up permanently blank (e.g. a corrupt service worker aborting
  // every navigation). Detect "nothing ever committed" and offer a way out; the
  // user chooses — we never clear their data unasked.
  let recoveryView: WebContentsView | undefined;

  const showRecovery = (): void => {
    if (recoveryView) return;
    const view = new WebContentsView({
      webPreferences: { preload: join(__dirname, '../preload/recovery.js') },
    });
    recoveryView = view;
    view.webContents.on('did-finish-load', () =>
      safeSend(view, 'recovery:set-service', def.displayName),
    );
    void view.webContents.loadFile(join(__dirname, '../renderer/recovery/index.html'));
    window.contentView.addChildView(view); // above the service view
    const [w, h] = window.getContentSize();
    view.setBounds(computeLayout(w, h).service);
  };

  const hideRecovery = (): void => {
    if (!recoveryView) return;
    const view = recoveryView;
    recoveryView = undefined;
    window.contentView.removeChildView(view);
    view.webContents.close();
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
  window.on('closed', () => watcher.dispose());

  // Ctrl+R / F5 — there is no app menu (Menu.setApplicationMenu(null)), so the
  // usual reload accelerator does not exist.
  serviceView.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const isReload = input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r');
    if (isReload) api.reload();
  });
```

- [ ] **Step 4: Size the overlay on resize**

In `src/main/serviceWindow.ts`, replace the `relayout` function body so the overlay tracks the service rect:
```ts
  const relayout = () => {
    const [w, h] = window.getContentSize();
    const { titlebar: t, service: s } = computeLayout(w, h);
    titlebar.setBounds(t);
    serviceView.setBounds(s);
    recoveryView?.setBounds(s);
  };
```

- [ ] **Step 5: Arm the watcher on the initial load**

In `src/main/serviceWindow.ts`, replace the initial load line:
```ts
  serviceView.webContents.loadURL(effectiveUrl(def, cfg.services[def.id]?.customUrl));
```
with:
```ts
  void serviceView.webContents.loadURL(effectiveUrl(def, cfg.services[def.id]?.customUrl));
  watcher.armed();
```

- [ ] **Step 6: Implement the three new API methods**

In `src/main/serviceWindow.ts`, add to the `const api: ServiceWindow = { … }` object (after `navigate`):
```ts
    reload: () => {
      hideRecovery();
      serviceView.webContents.reload();
      watcher.armed();
    },
    clearAndReload: async () => {
      await clearServiceCaches(ses);
      api.reload();
    },
    ownsWebContents: (id: number) =>
      titlebar.webContents.id === id ||
      serviceView.webContents.id === id ||
      recoveryView?.webContents.id === id,
```

- [ ] **Step 7: Route the overlay's IPC — teach `findBySenderId` about it**

The overlay's webContents is a third view, so the existing `findBySenderId` (which checks only titlebar + service) would not route its messages. In `src/main/index.ts`, replace the whole `findBySenderId` function with:
```ts
function findBySenderId(senderId: number): ServiceWindow | undefined {
  for (const sw of windows.values()) {
    if (sw.ownsWebContents(senderId)) return sw;
  }
  return undefined;
}
```

- [ ] **Step 8: Add the recovery IPC handlers**

In `src/main/index.ts`, next to the existing `ipcMain.on('titlebar:close', …)` line, add:
```ts
  ipcMain.on('recovery:reload', (e) => findBySenderId(e.sender.id)?.reload());
  ipcMain.on('recovery:clear-and-reload', (e) => { void findBySenderId(e.sender.id)?.clearAndReload(); });
```

- [ ] **Step 9: Build and run the gates**

Run: `npm run build && npm test && npm run check`
Expected: build exits 0; tests pass; svelte-check 0/0. (`ownsWebContents` must satisfy `strict` — note `recoveryView?.webContents.id === id` yields `boolean`, since `undefined === number` is `false`.)

- [ ] **Step 10: Commit**

```bash
git add src/main/serviceWindow.ts src/main/index.ts
git commit -q -m "feat(recovery): show a recovery overlay when a service view never loads

Arm a 15s stuck watcher on load; if nothing committed (about:blank), stack a
recovery overlay view offering Reload / Clear cache & reload, and remove it when a
real URL commits (so a slow load self-corrects). Adds ServiceWindow.reload/
clearAndReload/ownsWebContents, routes the overlay's IPC through findBySenderId,
and wires Ctrl+R/F5 (there is no app menu to carry the accelerator).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Titlebar reload button

**Files:**
- Modify: `src/renderer/titlebar/index.html`, `src/renderer/titlebar/titlebar.css`, `src/renderer/titlebar/titlebar.ts`, `src/preload/titlebar.ts`, `src/main/index.ts`

**Interfaces:**
- Consumes: `ServiceWindow.reload()` (Task 3).
- Produces: IPC channel `titlebar:reload` (renderer→main).

- [ ] **Step 1: Add the button to the markup**

In `src/renderer/titlebar/index.html`, inside `<div class="controls">`, add a reload button **before** `zoom-out`:
```html
        <button id="reload" title="Reload">⟳</button>
```

- [ ] **Step 2: Expose it in the preload**

In `src/preload/titlebar.ts`, add to the `exposeInMainWorld('loft', { … })` object:
```ts
  reload: () => ipcRenderer.send('titlebar:reload'),
```

- [ ] **Step 3: Declare it on the window type**

In `src/renderer/titlebar/window.d.ts`, add `reload(): void;` to the `loft` interface (alongside `zoomIn`/`zoomOut`/`close`/`onSetService`).

- [ ] **Step 4: Wire the click**

In `src/renderer/titlebar/titlebar.ts`, add above the existing `zoom-in` listener:
```ts
document.getElementById('reload')!.addEventListener('click', () => window.loft.reload());
```

- [ ] **Step 5: Style it (the glyph is larger than the A-glyphs, so keep it visually even)**

In `src/renderer/titlebar/titlebar.css`, add after the `.controls button` rule:
```css
#reload { font-size: 15px; line-height: 1; }
```

- [ ] **Step 6: Handle the IPC in main**

In `src/main/index.ts`, next to the existing `titlebar:*` handlers, add:
```ts
  ipcMain.on('titlebar:reload', (e) => findBySenderId(e.sender.id)?.reload());
```

- [ ] **Step 7: Build and run the gates**

Run: `npm run build && npm test && npm run check`
Expected: build exits 0; tests pass; svelte-check 0/0.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/titlebar src/preload/titlebar.ts src/main/index.ts
git commit -q -m "feat(titlebar): add a reload button

Drives the same ServiceWindow.reload() as Ctrl+R and the recovery overlay.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Hub Troubleshooting action

Reachable even when the service window is blank or the service isn't running.

**Files:**
- Modify: `src/shared/hubTypes.ts`, `src/preload/hub.ts`, `src/main/hubWindow.ts`, `src/main/index.ts`, `src/renderer/hub/components/ServiceDetail.svelte`

**Interfaces:**
- Consumes: `ServiceWindow.reload()` (Task 3), `clearServiceCaches` (Task 1).
- Produces: `RecoverOpts { clearCaches: boolean }`; `LoftHub.recoverService(id: string, opts: RecoverOpts): void`; IPC `hub:recoverService`; `HubDeps.recoverService(id: string, opts: RecoverOpts): void`.

- [ ] **Step 1: Extend the shared contract**

In `src/shared/hubTypes.ts`, add after `GlobalPatch`:
```ts
export interface RecoverOpts { clearCaches: boolean }
```

- [ ] **Step 2: Extend the preload bridge**

In `src/preload/hub.ts`: add `RecoverOpts` to the type import from `../shared/hubTypes`, add to `interface LoftHub`:
```ts
  recoverService(id: string, opts: RecoverOpts): void;
```
and add to the object returned by `buildBridge`:
```ts
    recoverService: (id, opts) => ipc.send('hub:recoverService', { id, opts }),
```

- [ ] **Step 3: Extend the hub window**

In `src/main/hubWindow.ts`: add `RecoverOpts` to the type import; add to `interface HubDeps` (after `setGlobal`):
```ts
  recoverService(id: string, opts: RecoverOpts): void;
```
add `'hub:recoverService'` to the `CHANNELS` array; and add the handler next to the other `ipcMain.on('hub:…')` registrations:
```ts
  ipcMain.on('hub:recoverService', (_e, m: { id: string; opts: RecoverOpts }) => deps.recoverService(m.id, m.opts));
```
(No `notifyChanged()` — recovery changes no hub-visible state.)

- [ ] **Step 4: Implement the dep in main**

In `src/main/index.ts`, add `RecoverOpts` to the type import from `../shared/hubTypes`, and add to the `HubDeps` object passed to `createHub` (next to `setGlobal`):
```ts
    recoverService: (id, opts) => {
      const sw = windows.get(id);
      if (!opts.clearCaches) { sw?.reload(); return; }
      // Works whether or not the service is running: with no window we still clear,
      // so the next launch loads clean.
      if (sw) { void sw.clearAndReload(); return; }
      void clearServiceCaches(session.fromPartition(`persist:${id}`));
    },
```
Ensure `session` is imported from `electron` and `clearServiceCaches` from `./recovery` in `index.ts`.

- [ ] **Step 5: Add the Troubleshooting section to the hub UI**

In `src/renderer/hub/components/ServiceDetail.svelte`, add **above** the existing `<button class="danger">` line:
```svelte
  <div class="trouble">
    <h3>Troubleshooting</h3>
    <button onclick={() => window.loftHub.recoverService(id, { clearCaches: true })}>Clear cache &amp; reload</button>
    <p class="hint">Keeps you signed in. Fixes {svc.displayName} if it’s stuck on a blank screen.</p>
  </div>
```
and add to the `<style>` block:
```css
  .trouble { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--divider); }
  .trouble h3 { font-size: 13px; margin-bottom: 8px; }
  .trouble button { border: 1px solid var(--divider); background: var(--card); color: var(--fg); border-radius: 999px; padding: 8px 18px; cursor: pointer; }
  .hint { color: var(--muted, #777); font-size: 12px; margin-top: 8px; }
```

- [ ] **Step 6: Build and run the gates**

Run: `npm run build && npm test && npm run check`
Expected: build exits 0; tests pass; **svelte-check 0 errors / 0 warnings** (this gate is what catches Svelte rune/a11y problems — `vite build` does not type-check).

- [ ] **Step 7: Commit**

```bash
git add src/shared/hubTypes.ts src/preload/hub.ts src/main/hubWindow.ts src/main/index.ts src/renderer/hub/components/ServiceDetail.svelte
git commit -q -m "feat(hub): Troubleshooting — clear cache & reload a service

Reachable when the service window is blank or the service isn't running (with no
window we still clear, so the next launch loads clean). Clears only
serviceworkers+cachestorage, so the login survives.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §3 detection (`isStuckUrl`, `createStuckWatcher`, 15s, did-navigate disarm, network-failures-excluded) → **Task 1** (logic + tests) + **Task 3** (wiring). ✓
- §4 recovery actions + the never-clear-cookies rule → **Task 1** (`clearServiceCaches` + the guarantee test) + **Task 3** (`reload`/`clearAndReload`). ✓
- §5 overlay `WebContentsView` (page, preload, lazy create, sized to the service rect, removed on recover, system-aware CSS) → **Task 2** (page/preload/copy-assets) + **Task 3** (lifecycle/layout). ✓
- §5 `ServiceWindow.reload()`/`clearAndReload()` → **Task 3** Step 6. ✓
- §6 manual entry points: titlebar ⟳ → **Task 4**; Ctrl+R/F5 → **Task 3** Step 3; hub Troubleshooting → **Task 5**. ✓
- §7 tests: `isStuckUrl` truth table, watcher arm/disarm/late-commit/dispose, and the cookie guarantee → **Task 1**. ✓ (Preload bridge tests are covered by the existing build/gates; `titlebar.ts`/`recovery.ts` preloads are 5-line contextBridge maps with no logic to unit-test — deliberately not adding a tautological test.)

**Placeholder scan:** No TBD/TODO. Every code step carries the actual code; every command has an expected result.

**Type consistency:** `StuckWatcherDeps`/`StuckWatcher`/`createStuckWatcher`/`isStuckUrl`/`clearServiceCaches` (Task 1) are consumed with those exact names in Tasks 3 and 5. `ServiceWindow.reload`/`clearAndReload`/`ownsWebContents` (Task 3 Steps 1/6) are used by Task 3 Steps 7-8, Task 4 Step 6, and Task 5 Step 4. `RecoverOpts { clearCaches: boolean }` is identical across `hubTypes.ts`, `preload/hub.ts`, `hubWindow.ts`, `index.ts`, and the Svelte call site. IPC channel names match between preload senders and `ipcMain` handlers: `recovery:reload`, `recovery:clear-and-reload`, `recovery:set-service`, `titlebar:reload`, `hub:recoverService`.

**One deviation worth flagging:** the spec's §7 mentions "titlebar/recovery preload bridges build the expected channel map (mirroring the existing tests/bridge-style preload tests)". The existing `service.ts`/`hub.ts` preloads are testable because they export a pure `buildBridge(ipc)` factory; `titlebar.ts` (and the new `recovery.ts`) call `contextBridge` directly with no factory. Rather than refactor them to add a test that only asserts a literal channel-name map, the channels are covered by the manual smoke. If a reviewer disagrees, the fix is to extract `buildBridge` in both — say so and it's a small addition.
