# Electron Loft — Stage 2: Web Integration (badges + de-chrome) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each service view scrapes its own unread-count from the page DOM and reports it to main (which reflects it in the window title until the tray lands in Stage 3), and Messenger/Talk service pages are de-chromed to feel like an app — all via a per-service **preload**, replacing the Chrome extension's badge + DOM-cleanup logic.

**Architecture:** The service `WebContentsView` gets a preload (isolated world, but with page-DOM access). The preload is told its service id via `additionalArguments`, runs the matching badge scanner (MutationObserver + poll), and posts counts to main over one typed IPC channel. Main updates the window title. De-chroming is static CSS via `webContents.insertCSS` (from main) plus a dynamic MutationObserver in the preload for the bits React re-renders (Messenger's banner). Pure count-parsers are extracted and unit-tested with jsdom; the live DOM wiring is verified manually.

**Tech Stack:** Electron 43, TypeScript 5.9 (CommonJS), Vitest 4.1 (+ jsdom for DOM tests). Ports from `extension/content.js`.

**Scope note:** Stage 2 of 5 (spec `docs/superpowers/specs/2026-07-09-electron-loft-v1-parity-design.md` §6). Builds on Stage 1 (HEAD of `electron-rewrite`). **Re-cut from the spec:** notification *interception* (main-world `Notification` wrap, Messenger/Telegram notify-on-new, Slack `SilentNotification`) moves to **Stage 3**, next to its delivery (tray/D-Bus/DND) — capturing notifications you can't yet deliver isn't independently testable. Stage 2 does badge **counts** (for Messenger/Telegram, the unread-conversation count via the same scan Stage 3 will extend) + de-chroming. **NOT in Stage 2:** notifications, DND, tray, avatars, GNOME/KWin, hub.

## Global Constraints

- All paths relative to the `electron/` sub-folder; run `npm`/`git` from inside it. Branch: `electron-rewrite`.
- Electron `^43.1.0`; TypeScript `~5.9` (CommonJS, ES2022); Vitest `^4.1`; jsdom `^25` (new devDep).
- Preload runs with the default `contextIsolation: true`, `sandbox` on. It may read/modify the page DOM but exposes nothing to the page except via `contextBridge` (Stage 2 exposes nothing to the page — it only sends to main via `ipcRenderer`).
- Service id is passed to the preload via `webPreferences.additionalArguments: ['--loft-service=<id>']` and read with `process.argv`. Do NOT derive service from origin.
- IPC channel (preload → main): `service:badge` with payload `{ count: number }`. Sender's `webContents.id` identifies the window (reuse Stage 1's `findBySenderId`).
- Badge count semantics per service match `extension/content.js` exactly (it is the source of truth — read it):
  - whatsapp: `[aria-label*="unread message"]` → `^(\d+) unread message`.
  - slack: count of `.p-channel_sidebar__channel--unread:not(:has(.p-channel_sidebar__link--add-more-items))`.
  - element: `document.title` match `/\[(\d+)\]/` (bare `*` → 0).
  - talk: sum of `.counter-bubble__counter` text (non-numeric bubble counts as 1).
  - telegram: count of sidebar unread badges (see `content.js` `scanTelegramUnreads`).
  - messenger: count of unread, non-muted conversations (`a[href*="/messages/"]` containing an `Unread message:` text node, excluding `[style*="--disabled-icon"]`).
- De-chrome CSS matches `content.js` verbatim (slack banner, talk header, messenger header-height + banner removal).
- Window title format: `formatWindowTitle(displayName, count)` → `"WhatsApp"` when count is 0, `"WhatsApp (3)"` when > 0.

---

## File Structure

- `src/preload/service.ts` — the per-service preload: reads service id, starts the scanner + de-chrome observer, sends `service:badge`.
- `src/preload/badge/parsers.ts` — **pure** count extractors (one per service) operating on a passed `Document`/`Element` — jsdom-unit-tested.
- `src/preload/badge/scanner.ts` — wires a parser to MutationObserver + poll + change-detection + IPC send.
- `src/preload/dechrome.ts` — dynamic DOM cleanup (Messenger banner) run in the preload.
- `src/main/dechromeCss.ts` — **pure** map of service id → static CSS string (from `content.js`), applied via `insertCSS`.
- `src/main/serviceTitle.ts` — **pure** `formatWindowTitle(name, count)`.
- Modify: `src/main/serviceWindow.ts` — attach the preload + `additionalArguments`, `insertCSS` the static de-chrome, set title on badge.
- Modify: `src/main/index.ts` — handle `service:badge` → update the owning window's title.
- Modify: `vitest.config.ts` / `package.json` — add jsdom.
- Tests: `tests/badgeParsers.test.ts` (jsdom), `tests/serviceTitle.test.ts`, `tests/dechromeCss.test.ts`.

---

## Task 1: jsdom test environment + pure window-title helper

**Files:**
- Modify: `package.json` (add `jsdom` devDep)
- Create: `src/main/serviceTitle.ts`, `tests/serviceTitle.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function formatWindowTitle(name: string, count: number): string`.

- [ ] **Step 1: Install jsdom**

Run (from `electron/`): `npm install --save-dev jsdom@^25 @types/jsdom@^21`
Expected: installs cleanly.

- [ ] **Step 2: Write the failing test** — `tests/serviceTitle.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { formatWindowTitle } from '../src/main/serviceTitle';

describe('formatWindowTitle', () => {
  it('is the bare name at zero', () => {
    expect(formatWindowTitle('WhatsApp', 0)).toBe('WhatsApp');
  });
  it('appends a parenthesised count when positive', () => {
    expect(formatWindowTitle('WhatsApp', 3)).toBe('WhatsApp (3)');
  });
  it('treats negative/NaN as zero', () => {
    expect(formatWindowTitle('Slack', -1)).toBe('Slack');
    expect(formatWindowTitle('Slack', Number.NaN)).toBe('Slack');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/serviceTitle.test.ts`
Expected: FAIL — cannot find module `../src/main/serviceTitle`.

- [ ] **Step 4: Implement** — `src/main/serviceTitle.ts`

```ts
export function formatWindowTitle(name: string, count: number): string {
  return Number.isFinite(count) && count > 0 ? `${name} (${count})` : name;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/serviceTitle.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main/serviceTitle.ts tests/serviceTitle.test.ts
git commit -m "feat: window-title badge formatter; add jsdom for DOM tests"
```

---

## Task 2: pure badge parsers (jsdom-tested)

**Files:**
- Create: `src/preload/badge/parsers.ts`, `tests/badgeParsers.test.ts`

**Interfaces:**
- Consumes: nothing (operates on a passed `Document`).
- Produces:
  - `type BadgeParser = (doc: Document) => number`
  - `const BADGE_PARSERS: Record<string, BadgeParser>` keyed by service id (`whatsapp`, `slack`, `element`, `talk`, `telegram`, `messenger`).

Each parser is a faithful port of the corresponding scanner body in `extension/content.js` (read it for exact selectors — line refs in Global Constraints), but returns the count instead of calling `safeSendMessage`. For `telegram` and `messenger`, port only the **count** (Messenger: size of the unread, non-muted set; Telegram: number of sidebar unread badges) — no fingerprinting/notification.

- [ ] **Step 1: Write the failing test** — `tests/badgeParsers.test.ts`

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { BADGE_PARSERS } from '../src/preload/badge/parsers';

function docFrom(html: string, title = ''): Document {
  document.title = title;
  document.body.innerHTML = html;
  return document;
}

describe('badge parsers', () => {
  it('whatsapp reads the aria-label count', () => {
    const doc = docFrom('<div aria-label="5 unread messages"></div>');
    expect(BADGE_PARSERS.whatsapp(doc)).toBe(5);
  });
  it('whatsapp is 0 with no unread label', () => {
    expect(BADGE_PARSERS.whatsapp(docFrom('<div></div>'))).toBe(0);
  });
  it('element reads [N] from the title, bare * is 0', () => {
    expect(BADGE_PARSERS.element(docFrom('', 'Element [7]'))).toBe(7);
    expect(BADGE_PARSERS.element(docFrom('', 'Element *'))).toBe(0);
  });
  it('talk sums counter bubbles (non-numeric counts as 1)', () => {
    const doc = docFrom(
      '<div class="counter-bubble__counter">3</div>' +
      '<div class="counter-bubble__counter">2</div>' +
      '<div class="counter-bubble__counter">@</div>',
    );
    expect(BADGE_PARSERS.talk(doc)).toBe(6);
  });
  it('slack counts unread channel rows', () => {
    const doc = docFrom(
      '<div class="p-channel_sidebar__channel--unread"></div>' +
      '<div class="p-channel_sidebar__channel--unread"></div>',
    );
    expect(BADGE_PARSERS.slack(doc)).toBe(2);
  });
  it('messenger counts unread, non-muted conversations', () => {
    const doc = docFrom(
      '<a href="/messages/t/1"><span>Unread message:</span></a>' +
      '<a href="/messages/t/2"><span>Unread message:</span><i style="--disabled-icon:1"></i></a>' +
      '<a href="/messages/t/3">read</a>',
    );
    expect(BADGE_PARSERS.messenger(doc)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/badgeParsers.test.ts`
Expected: FAIL — cannot find module `../src/preload/badge/parsers`.

- [ ] **Step 3: Implement** — `src/preload/badge/parsers.ts`

```ts
export type BadgeParser = (doc: Document) => number;

const whatsapp: BadgeParser = (doc) => {
  const el = doc.querySelector('[aria-label*="unread message"]');
  const m = el?.getAttribute('aria-label')?.match(/^(\d+) unread message/);
  return m ? parseInt(m[1], 10) : 0;
};

const slack: BadgeParser = (doc) =>
  doc.querySelectorAll(
    '.p-channel_sidebar__channel--unread:not(:has(.p-channel_sidebar__link--add-more-items))',
  ).length;

const element: BadgeParser = (doc) => {
  const m = doc.title.match(/\[(\d+)\]/);
  return m ? parseInt(m[1], 10) : 0;
};

const talk: BadgeParser = (doc) => {
  let count = 0;
  doc.querySelectorAll('.counter-bubble__counter').forEach((el) => {
    const n = parseInt((el.textContent || '').trim(), 10);
    count += Number.isFinite(n) ? n : 1;
  });
  return count;
};

const telegram: BadgeParser = (doc) => {
  // Port of content.js scanTelegramUnreads' count: sum the numeric sidebar badges.
  let count = 0;
  doc.querySelectorAll('.ChatBadge, .unread').forEach((el) => {
    const n = parseInt((el.textContent || '').trim(), 10);
    if (Number.isFinite(n)) count += n;
  });
  return count;
};

const messenger: BadgeParser = (doc) => {
  let count = 0;
  for (const a of doc.querySelectorAll('a[href*="/messages/"]')) {
    const walker = doc.createTreeWalker(a, NodeFilter.SHOW_TEXT, null);
    let unread = false;
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if ((n.textContent || '').trim() === 'Unread message:') { unread = true; break; }
    }
    if (unread && !a.querySelector('[style*="--disabled-icon"]')) count++;
  }
  return count;
};

export const BADGE_PARSERS: Record<string, BadgeParser> = {
  whatsapp, slack, element, talk, telegram, messenger,
};
```

> **Implementer note:** verify the Telegram selectors against `extension/content.js` `scanTelegramUnreads` (offset ~712) and the live sidebar before finishing — Telegram's real unread-badge class may differ from the `.ChatBadge, .unread` placeholder above; adjust to match the source/live DOM. Flag if you change it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/badgeParsers.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/preload/badge/parsers.ts tests/badgeParsers.test.ts
git commit -m "feat: pure per-service badge parsers (jsdom-tested)"
```

---

## Task 3: badge scanner (observer + poll + change-detect + IPC)

**Files:**
- Create: `src/preload/badge/scanner.ts`

**Interfaces:**
- Consumes: `BadgeParser` (Task 2).
- Produces: `function startBadgeScanner(serviceId: string, send: (count: number) => void): void` — looks up the parser, runs it on `document` via a `MutationObserver` (childList/subtree/characterData/attributes) + a 2s poll + a 3s initial kick, and calls `send(count)` only when the count changes.

- [ ] **Step 1: Implement** — `src/preload/badge/scanner.ts`

```ts
import { BADGE_PARSERS } from './parsers';

export function startBadgeScanner(serviceId: string, send: (count: number) => void): void {
  const parser = BADGE_PARSERS[serviceId];
  if (!parser) return;

  let last = -1;
  const scan = () => {
    const count = parser(document);
    if (count !== last) {
      last = count;
      send(count);
    }
  };

  const observer = new MutationObserver(scan);
  const observeTarget = () => {
    const target = serviceId === 'element' ? document.querySelector('title') ?? document.body : document.body;
    if (!target) { setTimeout(observeTarget, 500); return; }
    observer.observe(target, {
      childList: true, subtree: true, characterData: true, attributes: true,
    });
  };
  observeTarget();

  setInterval(scan, 2000);
  setTimeout(scan, 3000);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: `tsc` succeeds. (No unit test — this is DOM/timer glue; the parser it calls is covered by Task 2 and behavior is verified live in Task 7.)

- [ ] **Step 3: Commit**

```bash
git add src/preload/badge/scanner.ts
git commit -m "feat: badge scanner (observer + poll + change detection)"
```

---

## Task 4: static de-chrome CSS map (main side)

**Files:**
- Create: `src/main/dechromeCss.ts`, `tests/dechromeCss.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function dechromeCssFor(serviceId: string): string | null` — returns the static CSS for `slack`, `talk`, `messenger`; `null` for services with no static rules.

CSS strings are ported verbatim from `extension/content.js`:
- slack: `[data-qa="workspace-banner-download-app"] { display: none !important; }`
- talk: `#header { display: none !important; } :root, body { --header-height: 0px !important; } #content { margin: 0 !important; } #content-vue { width: 100% !important; height: 100% !important; border-radius: 0 !important; }`
- messenger: `* { --header-height: 0px !important; } [role="dialog"], [role="dialog"] * { --header-height: 56px !important; }`

- [ ] **Step 1: Write the failing test** — `tests/dechromeCss.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { dechromeCssFor } from '../src/main/dechromeCss';

describe('dechromeCssFor', () => {
  it('returns Talk CSS that hides the header and zeroes --header-height', () => {
    const css = dechromeCssFor('talk')!;
    expect(css).toContain('#header { display: none !important; }');
    expect(css).toContain('--header-height: 0px !important');
  });
  it('returns Slack banner-hide CSS', () => {
    expect(dechromeCssFor('slack')).toContain('workspace-banner-download-app');
  });
  it('restores 56px header-height inside dialogs for Messenger', () => {
    expect(dechromeCssFor('messenger')).toContain('[role="dialog"]');
  });
  it('returns null for services with no static de-chrome', () => {
    expect(dechromeCssFor('whatsapp')).toBeNull();
    expect(dechromeCssFor('element')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dechromeCss.test.ts`
Expected: FAIL — cannot find module `../src/main/dechromeCss`.

- [ ] **Step 3: Implement** — `src/main/dechromeCss.ts`

```ts
const CSS: Record<string, string> = {
  slack: '[data-qa="workspace-banner-download-app"] { display: none !important; }',
  talk:
    '#header { display: none !important; } ' +
    ':root, body { --header-height: 0px !important; } ' +
    '#content { margin: 0 !important; } ' +
    '#content-vue { width: 100% !important; height: 100% !important; border-radius: 0 !important; }',
  messenger:
    '* { --header-height: 0px !important; } ' +
    '[role="dialog"], [role="dialog"] * { --header-height: 56px !important; }',
};

export function dechromeCssFor(serviceId: string): string | null {
  return CSS[serviceId] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dechromeCss.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/dechromeCss.ts tests/dechromeCss.test.ts
git commit -m "feat: static de-chrome CSS map (main side)"
```

---

## Task 5: dynamic Messenger de-chrome (preload observer)

**Files:**
- Create: `src/preload/dechrome.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function startDechrome(serviceId: string): void` — for `messenger`, removes the `[role="banner"]` and fixes the nested `top`/`height` (port of `content.js` `cleanMessengerUI`, banner-removal part only — the `--header-height` stylesheet is handled statically in Task 4), debounced via a MutationObserver on `document.body`. No-op for other services.

- [ ] **Step 1: Implement** — `src/preload/dechrome.ts`

```ts
function cleanMessengerBanner(): void {
  const banner = document.querySelector('[role="banner"]');
  if (!banner) return;
  const sibling = banner.nextElementSibling;
  banner.remove();
  const nested = sibling?.querySelector('div');
  const inner = nested?.querySelector('div');
  if (inner && getComputedStyle(inner).top !== 'auto') {
    (inner as HTMLElement).style.top = '0';
    (inner as HTMLElement).style.height = '100%';
  }
}

export function startDechrome(serviceId: string): void {
  if (serviceId !== 'messenger') return;
  let t: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (t) clearTimeout(t);
    t = setTimeout(cleanMessengerBanner, 300);
  };
  const start = () => {
    if (!document.body) { setTimeout(start, 500); return; }
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    setTimeout(cleanMessengerBanner, 2000);
  };
  start();
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: `tsc` succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/preload/dechrome.ts
git commit -m "feat: dynamic Messenger banner de-chrome (preload)"
```

---

## Task 6: service preload entry + service-id handoff

**Files:**
- Create: `src/preload/service.ts`

**Interfaces:**
- Consumes: `startBadgeScanner` (Task 3), `startDechrome` (Task 5).
- Produces: the preload the service view loads. Reads `--loft-service=<id>` from `process.argv`, then starts the scanner (sending `service:badge` via `ipcRenderer`) and the de-chrome observer.

- [ ] **Step 1: Implement** — `src/preload/service.ts`

```ts
import { ipcRenderer } from 'electron';
import { startBadgeScanner } from './badge/scanner';
import { startDechrome } from './dechrome';

function readServiceId(): string {
  const arg = process.argv.find((a) => a.startsWith('--loft-service='));
  return arg ? arg.slice('--loft-service='.length) : '';
}

const serviceId = readServiceId();
if (serviceId) {
  startBadgeScanner(serviceId, (count) => ipcRenderer.send('service:badge', { count }));
  startDechrome(serviceId);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: `tsc` succeeds; `dist/preload/service.js` exists.

- [ ] **Step 3: Commit**

```bash
git add src/preload/service.ts
git commit -m "feat: service preload — badge scanner + de-chrome wiring"
```

---

## Task 7: wire preload + de-chrome + title into serviceWindow/main

**Files:**
- Modify: `src/main/serviceWindow.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `dechromeCssFor` (Task 4), `formatWindowTitle` (Task 1), the service preload (Task 6), Stage 1's `findBySenderId`, `ServiceWindow`.
- Produces: a `setBadge(count: number)` method on `ServiceWindow` that sets the window title via `formatWindowTitle(def.displayName, count)`.

- [ ] **Step 1: Add the preload + additionalArguments + insertCSS to the service view** — in `serviceWindow.ts`, replace the current service-view construction:

```ts
  // Service view (remote URL) — the isolated per-service partition + our preload.
  const serviceView = new WebContentsView({
    webPreferences: {
      partition,
      backgroundThrottling: false,
      preload: join(__dirname, '../preload/service.js'),
      additionalArguments: [`--loft-service=${def.id}`],
    },
  });
  serviceView.webContents.setUserAgent(ses.getUserAgent());

  // Static de-chrome CSS (dynamic bits run in the preload).
  const css = dechromeCssFor(def.id);
  if (css) {
    serviceView.webContents.on('did-finish-load', () => {
      void serviceView.webContents.insertCSS(css);
    });
  }
```

Add the import at the top: `import { dechromeCssFor } from './dechromeCss';` and `import { formatWindowTitle } from './serviceTitle';`

- [ ] **Step 2: Add `setBadge` to the `ServiceWindow` interface and api**

Interface (add): `setBadge(count: number): void;`
api (add):
```ts
    setBadge: (count: number) => { window.setTitle(formatWindowTitle(def.displayName, count)); },
```

- [ ] **Step 3: Handle `service:badge` in `index.ts`** — inside the single-instance owner `else` block, next to the titlebar IPC handlers:

```ts
  ipcMain.on('service:badge', (e, payload: { count: number }) => {
    findBySenderId(e.sender.id)?.setBadge(payload.count);
  });
```

- [ ] **Step 4: Build + full test suite**

Run: `npm run build && npm test`
Expected: compiles; all suites PASS (Stage 1 suites + serviceTitle + badgeParsers + dechromeCss).

- [ ] **Step 5: Commit**

```bash
git add src/main/serviceWindow.ts src/main/index.ts
git commit -m "feat: wire service preload, de-chrome CSS, and title badges into windows"
```

---

## Task 8: manual verification (per service)

**Files:** none (verification only).

- [ ] **Step 1: Build and run each service**

Run: `npm run build` then, per service, `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --service=<id>` (whatsapp/slack/element/talk/telegram/messenger). Log in where needed.

- [ ] **Step 2: Verify per service**
- Window **title** shows the unread count (e.g. "WhatsApp (3)") and updates as conversations are read/arrive.
- **Messenger**: the blue Facebook banner is gone and content sits flush at the top; media/dialog overlays still render correctly (the `[role="dialog"]` 56px restore).
- **Talk**: the NextCloud global header is hidden and content fills the window edge-to-edge.
- **Slack**: the "download the app" banner is hidden.
- Calls still work (Stage 1 parity — the preload must not break WebRTC).

- [ ] **Step 3: Record results** in the commit message / ledger. No code commit unless a scanner selector needed adjusting against the live DOM (expected for Telegram — see Task 2 note).

---

## Self-Review (completed by plan author)

**Spec coverage (Stage 2 re-cut scope):** per-service badge scraping ✓ (Tasks 2/3, all six services), preload model with service-id handoff ✓ (Task 6, `additionalArguments` not origin), IPC contract ✓ (`service:badge`, Task 7), de-chroming Messenger/Talk (+Slack) ✓ (Tasks 4/5), title reflection ✓ (Tasks 1/7). Deferred (documented): notification interception → Stage 3; avatars/DND/tray → Stage 3+.

**Placeholders:** none, except the explicitly-flagged Telegram selector (`.ChatBadge, .unread`), which the plan calls out as needing verification against `content.js`/live DOM — an honest live-DOM unknown, not a hidden gap.

**Type consistency:** `BadgeParser`, `BADGE_PARSERS`, `startBadgeScanner(serviceId, send)`, `startDechrome(serviceId)`, `dechromeCssFor`, `formatWindowTitle`, `setBadge`/`setZoom`/`persist` on `ServiceWindow` are defined once and consumed consistently. `service:badge` payload `{count:number}` matches between `service.ts` sender and `index.ts` handler.

**Known follow-ups for Stage 3:** the preload gains the main-world `Notification` wrap + Messenger/Telegram notify-on-new (reusing these scanners) + Slack `SilentNotification`; badges move from window title to the tray icon; DND gating added.
