# Electron Loft — Stage 3b: Notifications & DND — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Desktop notifications for every service — intercepted in the page, delivered from main over D-Bus (`org.freedesktop.Notifications`) with avatars and click-to-navigate — gated by Do-Not-Disturb (per-service, global, system) and by window focus.

**Architecture:** The service view's **preload runs in the page's main world** (`contextIsolation:false`) so it can wrap `window.Notification` / `ServiceWorkerRegistration.prototype.showNotification` directly (no CSP-blocked `<script>` injection). Notification-based services (WhatsApp/Slack/Element/Talk) relay each notification to the preload, which resolves an avatar URL (Slack: DOM lookup; Talk: display-name→avatar lookup; blob→data-URI) and sends it to main via IPC. DOM-scrape services (Messenger/Telegram) are scanned in the preload for newly-unread conversations. Main holds a **DND gate** (`shouldNotify = !systemDnd && !globalDnd && !serviceDnd && !(focused && visible)`), resolves the avatar with the service's session cookies (`session.fetch`, ~1h file cache), and calls `Notify` on a persistent `dbus-next` connection. `ActionInvoked("default")` focuses the window and navigates to the conversation. System DND is watched live (GNOME `gsettings`); effective DND + a page-visibility override are pushed back to the view.

**Tech Stack:** Electron 43 (`session.fetch`, `ipcMain`/`ipcRenderer`), TypeScript 5.9 (CommonJS), Vitest 4.1 (+ jsdom), `dbus-next` 0.10 (already a dep), Node `crypto`/`child_process` (built-in). No new npm deps.

## Global Constraints

- All paths relative to `electron/`; run `npm`/`git` from there. Branch: `electron-rewrite`.
- Electron `^43.1.0`; TS `~5.9` (CommonJS, ES2022, lib DOM+DOM.Iterable); Vitest `^4.1`; `dbus-next` `^0.10`.
- **DND gate (exact rule):** show a notification only when `!systemDnd && !globalDnd && !serviceDnd[id] && !(focused && visible)`. `globalDnd`/`serviceDnd` come from config (Stage 3a persisted them); `systemDnd` is the OS setting; `focused`+`visible` are the window's live state.
- **Effective DND pushed to the view** = `systemDnd || globalDnd || serviceDnd[id]` — the Messenger/Telegram scanners use it to *silently mark* conversations handled (no re-notify storm when DND lifts). Main still gates delivery authoritatively (defence-in-depth + the focus gate the scanner can't see).
- **Delivery is `dbus-next` → `org.freedesktop.Notifications` directly** (NOT Electron's built-in `Notification`) on a **persistent** connection (KDE closes notifications when the sender disconnects). Port of `src/daemon/notifications.rs`.
- **`Notify` args (parity with notifications.rs):** `app_name=<service display name>`, `replaces_id=0`, `app_icon=<service icon path>`, `summary`, `body`, `actions=["default","Open"]`, `hints`, `expire_timeout=-1`. Hints: `image-path=<avatar file>` (when resolved) + `desktop-entry="chat.loft.Loft"`.
- **Avatars resolved in MAIN** via the service's `session.fetch(url)` (carries cookies → authenticated Element/Talk work) for `http(s)`, and by decoding `data:` URIs; ~1h file cache in `~/.local/share/loft/avatars/`; reject responses < 100 bytes. Only in-page avatar work: Slack DOM lookup, Talk display-name→URL lookup, and `blob:`→`data:` conversion (main can't read a renderer blob URL).
- **Only Google-Chrome-parity behaviours are in scope.** Slack invariants preserved verbatim: `SilentNotification.prototype === OrigNotification.prototype`; `.name`/`.toString()` spoof native; `permission` getter + `requestPermission` delegate to the original; the `"New message from {Name}"` title regex; the sidebar/message avatar `-NN`→`-128` upscale.
- **Startup grace 15 000 ms** for DOM-scrape notify-on-new; conversations seen during grace/DND are tracked (fingerprinted) but not notified.
- **Trust model / security:** the service view runs `contextIsolation:false, sandbox:false, nodeIntegration:false`. These are trusted first-party origins (the old app ran an extension with host permissions on them); the page still has no `require`. Documented tradeoff, not an oversight.

---

## File Structure

**Main (`src/main/notifications/`)**
- `gate.ts` — pure `shouldNotify()` + `NotificationGate` state holder (system/global/per-service DND + per-service focused/visible). No Electron imports.
- `avatars.ts` — `resolveAvatar()` + pure helpers (cache dir/key, data-URI parse, freshness). Fetch/fs injected for testability.
- `dbus.ts` — `NotificationServer` (persistent `dbus-next` connection, `notify()`, `ActionInvoked`/`NotificationClosed` listeners) + pure `buildHints()`/`buildNotifyArgs()`.
- `systemDnd.ts` — pure `parseShowBanners()` + `watchSystemDnd()` (GNOME `gsettings monitor`; KDE best-effort, verify at impl).
- `index.ts` — `startNotifications(deps)`: builds gate + server + system-DND watcher; `handle()` gates→resolves→notifies; DND/focus/visible setters push effective DND + visibility to views; wires `ActionInvoked`→focus+navigate.

**Preload (`src/preload/notify/`)**
- `override.ts` — `installNotificationOverride(win, doc, onNotify)`: wraps `Notification` (Slack-safe) + `showNotification`, page-visibility override; returns `{ setHidden }`.
- `avatar.ts` — in-page helpers: `resolveIconUrl()`, `pickTalkAvatarSrc()`, `slackSenderFromTitle()`, `findSlackAvatar()`, `scanSlackAvatars()`, `blobToDataUri()`.
- `messenger.ts` — `MessengerNotifier` (scan → new-unread payloads; fingerprint map, grace, DND silent-add, muted exclusion).
- `telegram.ts` — `TelegramNotifier` (same shape; icon = raw blob/https URL, converted by the bridge).
- `bridge.ts` — `startNotifyBridge(serviceId, deps)`: install override (onNotify → resolve icon → IPC), run scanners+observers, wire `service:dnd` / `service:visibility` / `service:navigate`.

**Modified**
- `src/preload/service.ts` — call `startNotifyBridge`.
- `src/main/serviceWindow.ts` — `pushDnd()`, `pushHidden()`, `navigate()` (send to the service view); re-push on `did-finish-load`.
- `src/main/index.ts` — start notifications; `service:notify` IPC → `handle`; window `focus`/`blur`/`show`/`hide` → gate; tray DND callbacks → gate; service-view webPreferences → main-world.

**Tests (`tests/`)**
- `notificationGate.test.ts`, `notificationAvatars.test.ts`, `notificationDbus.test.ts` (pure arg builders), `systemDnd.test.ts`, `notifyOverride.test.ts`, `notifyAvatar.test.ts`, `messengerNotifier.test.ts`, `telegramNotifier.test.ts`.

---

## Task 1: DND gate (pure)

**Files:** Create `src/main/notifications/gate.ts`, `tests/notificationGate.test.ts`.

**Interfaces produced:**
- `interface NotifyDecisionInput { systemDnd: boolean; globalDnd: boolean; serviceDnd: boolean; focused: boolean; visible: boolean }`
- `function shouldNotify(i: NotifyDecisionInput): boolean`
- `class NotificationGate` — `setSystemDnd(v)`, `setGlobalDnd(v)`, `setServiceDnd(id,v)`, `setFocused(id,v)`, `setVisible(id,v)`, `effectiveDnd(id): boolean`, `shouldNotify(id): boolean`, getters `systemDnd`/`globalDnd`.

- [ ] **Step 1: Write the failing test** — `tests/notificationGate.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { shouldNotify, NotificationGate } from '../src/main/notifications/gate';

const base = { systemDnd: false, globalDnd: false, serviceDnd: false, focused: false, visible: false };

describe('shouldNotify', () => {
  it('allows when nothing suppresses', () => {
    expect(shouldNotify(base)).toBe(true);
  });
  it('suppresses on any DND flag', () => {
    expect(shouldNotify({ ...base, systemDnd: true })).toBe(false);
    expect(shouldNotify({ ...base, globalDnd: true })).toBe(false);
    expect(shouldNotify({ ...base, serviceDnd: true })).toBe(false);
  });
  it('suppresses only when focused AND visible', () => {
    expect(shouldNotify({ ...base, focused: true, visible: true })).toBe(false);
    expect(shouldNotify({ ...base, focused: true, visible: false })).toBe(true);
    expect(shouldNotify({ ...base, focused: false, visible: true })).toBe(true);
  });
});

describe('NotificationGate', () => {
  it('tracks per-service state and computes effective DND + decision', () => {
    const g = new NotificationGate();
    g.setServiceDnd('slack', false);
    g.setFocused('slack', false);
    g.setVisible('slack', true);
    expect(g.effectiveDnd('slack')).toBe(false);
    expect(g.shouldNotify('slack')).toBe(true); // visible but not focused

    g.setGlobalDnd(true);
    expect(g.effectiveDnd('slack')).toBe(true);
    expect(g.shouldNotify('slack')).toBe(false);
    g.setGlobalDnd(false);

    g.setSystemDnd(true);
    expect(g.effectiveDnd('whatsapp')).toBe(true); // system DND applies to unknown services too
    g.setSystemDnd(false);

    g.setFocused('slack', true);
    expect(g.shouldNotify('slack')).toBe(false); // focused + visible
  });
  it('defaults unknown-service focus/visible/dnd to false', () => {
    const g = new NotificationGate();
    expect(g.effectiveDnd('x')).toBe(false);
    expect(g.shouldNotify('x')).toBe(true);
  });
});
```
- [ ] **Step 2: Run → fail.** `npx vitest run tests/notificationGate.test.ts` → cannot find module.
- [ ] **Step 3: Implement** `src/main/notifications/gate.ts`:
```ts
export interface NotifyDecisionInput {
  systemDnd: boolean;
  globalDnd: boolean;
  serviceDnd: boolean;
  focused: boolean;
  visible: boolean;
}

/** Show a notification only when no DND flag is set and the window is not focused+visible. */
export function shouldNotify(i: NotifyDecisionInput): boolean {
  if (i.systemDnd || i.globalDnd || i.serviceDnd) return false;
  if (i.focused && i.visible) return false;
  return true;
}

export class NotificationGate {
  private _systemDnd = false;
  private _globalDnd = false;
  private serviceDnd = new Map<string, boolean>();
  private focused = new Map<string, boolean>();
  private visible = new Map<string, boolean>();

  setSystemDnd(v: boolean): void { this._systemDnd = v; }
  setGlobalDnd(v: boolean): void { this._globalDnd = v; }
  setServiceDnd(id: string, v: boolean): void { this.serviceDnd.set(id, v); }
  setFocused(id: string, v: boolean): void { this.focused.set(id, v); }
  setVisible(id: string, v: boolean): void { this.visible.set(id, v); }

  get systemDnd(): boolean { return this._systemDnd; }
  get globalDnd(): boolean { return this._globalDnd; }

  /** System OR global OR this service's DND — what the view is told to suppress on. */
  effectiveDnd(id: string): boolean {
    return this._systemDnd || this._globalDnd || (this.serviceDnd.get(id) ?? false);
  }

  shouldNotify(id: string): boolean {
    return shouldNotify({
      systemDnd: this._systemDnd,
      globalDnd: this._globalDnd,
      serviceDnd: this.serviceDnd.get(id) ?? false,
      focused: this.focused.get(id) ?? false,
      visible: this.visible.get(id) ?? false,
    });
  }
}
```
- [ ] **Step 4: Run → pass.** `npx vitest run tests/notificationGate.test.ts`, then `npm test`.
- [ ] **Step 5: Commit** — `feat(notify): DND gate (system/global/per-service + focus)`.

---

## Task 2: Avatar resolver (main)

**Files:** Create `src/main/notifications/avatars.ts`, `tests/notificationAvatars.test.ts`.

**Interfaces produced:**
- `function avatarCacheDir(dataHome?: string): string`
- `function avatarCacheKey(input: string): string` — sha1 hex; for `data:` URIs hash only the first 200 chars (avoid hashing megabytes).
- `function parseDataUri(uri: string): Buffer | null`
- `function isFresh(mtimeMs: number, nowMs: number, ttlMs: number): boolean`
- `const AVATAR_TTL_MS = 3_600_000`
- `interface AvatarDeps { fetch(url: string): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>; statMtimeMs(path: string): number | null; writeFile(path: string, data: Buffer): void; now(): number }`
- `async function resolveAvatar(icon: string | undefined, deps: AvatarDeps, cacheDir?: string): Promise<string | undefined>`

**Behaviour (port of notifications.rs `decode_data_uri_avatar` + `download_avatar`):** empty/undefined → `undefined`. `data:` → decode base64 after the first comma, write cache file keyed on the URI, return path (reuse if fresh). `http(s)` → fetch, require `ok` and `arrayBuffer().byteLength >= 100`, write cache file keyed on the URL, return path (reuse if fresh). Anything else (`blob:`, relative) → `undefined` (the preload converts blobs before they reach main).

- [ ] **Step 1: Write the failing test** — `tests/notificationAvatars.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import {
  avatarCacheKey, parseDataUri, isFresh, resolveAvatar, AVATAR_TTL_MS,
} from '../src/main/notifications/avatars';

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function fakeDeps(over: Partial<Parameters<typeof resolveAvatar>[1]> = {}) {
  return {
    fetch: vi.fn(async (_url: string) => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(200).buffer })),
    statMtimeMs: vi.fn(() => null),
    writeFile: vi.fn(),
    now: () => 1_000_000,
    ...over,
  };
}

describe('avatar pure helpers', () => {
  it('cache key is stable and hashes long data URIs by prefix', () => {
    expect(avatarCacheKey('https://x/a.png')).toBe(avatarCacheKey('https://x/a.png'));
    const long = 'data:image/png;base64,' + 'A'.repeat(5000);
    const long2 = 'data:image/png;base64,' + 'A'.repeat(200 - 'data:image/png;base64,'.length) + 'B'.repeat(5000);
    // First 200 chars identical → same key despite different tails.
    expect(avatarCacheKey(long)).toBe(avatarCacheKey(long2));
  });
  it('parses data URIs and rejects malformed ones', () => {
    expect(parseDataUri(PNG_1x1)?.length).toBeGreaterThan(0);
    expect(parseDataUri('data:image/png;base64')).toBeNull(); // no comma
    expect(parseDataUri('https://x')).toBeNull();
  });
  it('freshness respects the TTL', () => {
    expect(isFresh(1000, 1000 + AVATAR_TTL_MS - 1, AVATAR_TTL_MS)).toBe(true);
    expect(isFresh(1000, 1000 + AVATAR_TTL_MS + 1, AVATAR_TTL_MS)).toBe(false);
  });
});

describe('resolveAvatar', () => {
  it('returns undefined for empty / blob / relative', async () => {
    const d = fakeDeps();
    expect(await resolveAvatar(undefined, d)).toBeUndefined();
    expect(await resolveAvatar('', d)).toBeUndefined();
    expect(await resolveAvatar('blob:https://x/abc', d)).toBeUndefined();
    expect(await resolveAvatar('/avatar/x/64', d)).toBeUndefined();
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it('decodes and caches a data URI without fetching', async () => {
    const d = fakeDeps();
    const p = await resolveAvatar(PNG_1x1, d, '/cache');
    expect(p).toMatch(/^\/cache\/loft-avatar-/);
    expect(d.writeFile).toHaveBeenCalledOnce();
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it('fetches and caches an http URL, rejecting tiny responses', async () => {
    const ok = fakeDeps();
    expect(await resolveAvatar('https://x/a.png', ok, '/cache')).toMatch(/^\/cache\//);
    expect(ok.fetch).toHaveBeenCalledOnce();

    const tiny = fakeDeps({ fetch: vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(10).buffer })) });
    expect(await resolveAvatar('https://x/a.png', tiny, '/cache')).toBeUndefined();

    const bad = fakeDeps({ fetch: vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new Uint8Array(0).buffer })) });
    expect(await resolveAvatar('https://x/a.png', bad, '/cache')).toBeUndefined();
  });
  it('reuses a fresh cache file without fetching', async () => {
    const d = fakeDeps({ statMtimeMs: vi.fn(() => 1_000_000 - 1000) });
    const p = await resolveAvatar('https://x/a.png', d, '/cache');
    expect(p).toMatch(/^\/cache\//);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.writeFile).not.toHaveBeenCalled();
  });
});
```
- [ ] **Step 2: Run → fail.** `npx vitest run tests/notificationAvatars.test.ts`.
- [ ] **Step 3: Implement** `src/main/notifications/avatars.ts`:
```ts
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const AVATAR_TTL_MS = 3_600_000;

export function avatarCacheDir(dataHome?: string): string {
  const base = dataHome || process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'loft', 'avatars');
}

export function avatarCacheKey(input: string): string {
  const seed = input.startsWith('data:') ? input.slice(0, 200) : input;
  return createHash('sha1').update(seed).digest('hex');
}

/** Decode a `data:[mime];base64,<data>` URI to bytes; null if not a base64 data URI with a comma. */
export function parseDataUri(uri: string): Buffer | null {
  if (!uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  try {
    return Buffer.from(uri.slice(comma + 1), 'base64');
  } catch {
    return null;
  }
}

export function isFresh(mtimeMs: number, nowMs: number, ttlMs: number): boolean {
  return nowMs - mtimeMs < ttlMs;
}

export interface AvatarDeps {
  fetch(url: string): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  statMtimeMs(path: string): number | null;
  writeFile(path: string, data: Buffer): void;
  now(): number;
}

/** Resolve an icon reference to a cached local file path (or undefined). Port of notifications.rs. */
export async function resolveAvatar(
  icon: string | undefined,
  deps: AvatarDeps,
  cacheDir: string = avatarCacheDir(),
): Promise<string | undefined> {
  if (!icon) return undefined;

  const cachePath = join(cacheDir, `loft-avatar-${avatarCacheKey(icon)}`);
  const mtime = deps.statMtimeMs(cachePath);
  if (mtime !== null && isFresh(mtime, deps.now(), AVATAR_TTL_MS)) return cachePath;

  if (icon.startsWith('data:')) {
    const bytes = parseDataUri(icon);
    if (!bytes || bytes.length === 0) return undefined;
    deps.writeFile(cachePath, bytes);
    return cachePath;
  }

  if (icon.startsWith('http://') || icon.startsWith('https://')) {
    try {
      const res = await deps.fetch(icon);
      if (!res.ok) return undefined;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) return undefined; // too small to be an image (parity with notifications.rs)
      deps.writeFile(cachePath, buf);
      return cachePath;
    } catch {
      return undefined;
    }
  }

  return undefined; // blob: / relative — resolved in-page before reaching main
}
```
- [ ] **Step 4: Run → pass.** `npx vitest run tests/notificationAvatars.test.ts`, then `npm test`.
- [ ] **Step 5: Commit** — `feat(notify): main-side avatar resolver (data-URI + session fetch, 1h cache)`.

---

## Task 3: Notification D-Bus server (main)

**Files:** Create `src/main/notifications/dbus.ts`, `tests/notificationDbus.test.ts`.

**Interfaces produced:**
- `function buildHints(o: { imagePath?: string; desktopEntry: string }): Record<string, unknown>` — returns `{ 'desktop-entry': Variant('s', …), ['image-path': Variant('s', …)] }`.
- `function buildNotifyArgs(p: { appName: string; appIcon: string; summary: string; body: string; hints: Record<string, unknown> }): unknown[]` — `[appName, 0, appIcon, summary, body, ['default','Open'], hints, -1]`.
- `interface NotifyParams { appName: string; appIcon: string; summary: string; body: string; imagePath?: string; desktopEntry?: string }`
- `interface NotificationServer { notify(p: NotifyParams): Promise<number>; onActionDefault(cb: (id: number) => void): void }`
- `async function connectNotificationServer(): Promise<NotificationServer>`

**Notes for the implementer (verify against `dbus-next` at impl time — see the Stage 3a ledger for the wire-format facts):**
- Persistent connection: `dbus.sessionBus()` kept for the process lifetime (KDE closes notifications when the sender disconnects — this is why we do NOT use Electron's built-in `Notification`).
- Method call + signals via a proxy: `const obj = await bus.getProxyObject('org.freedesktop.Notifications', '/org/freedesktop/Notifications'); const n = obj.getInterface('org.freedesktop.Notifications');` then `await n.Notify(...args)` returns the `u` id; `n.on('ActionInvoked', (id, action) => …)` and `n.on('NotificationClosed', (id, reason) => …)`. The proxy introspects the server, so it marshals from the real signature.
- `hints` is `a{sv}` → a **plain object** whose values are `new dbus.Variant('s', str)`.
- `onActionDefault` fires for **every** `ActionInvoked` with `action === 'default'` (other apps share the bus); the caller (Task 5 wiring) filters by the ids it actually sent. `NotificationClosed` is logged only — do NOT remove tracking there (it races `ActionInvoked`), matching notifications.rs.

- [ ] **Step 1: Write the failing test** (pure arg builders only; the live call is verified headlessly in Step 4) — `tests/notificationDbus.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildHints, buildNotifyArgs } from '../src/main/notifications/dbus';

describe('buildHints', () => {
  it('always includes desktop-entry, adds image-path only when present', () => {
    const bare = buildHints({ desktopEntry: 'chat.loft.Loft' });
    expect(Object.keys(bare)).toEqual(['desktop-entry']);
    const withImg = buildHints({ desktopEntry: 'chat.loft.Loft', imagePath: '/a/b.png' });
    expect(Object.keys(withImg).sort()).toEqual(['desktop-entry', 'image-path']);
  });
});

describe('buildNotifyArgs', () => {
  it('matches the notifications.rs Notify shape', () => {
    const hints = buildHints({ desktopEntry: 'chat.loft.Loft' });
    const args = buildNotifyArgs({ appName: 'WhatsApp', appIcon: '/i/wa.png', summary: 'Ann', body: 'hi', hints });
    expect(args[0]).toBe('WhatsApp');   // app_name
    expect(args[1]).toBe(0);            // replaces_id
    expect(args[2]).toBe('/i/wa.png');  // app_icon
    expect(args[3]).toBe('Ann');        // summary
    expect(args[4]).toBe('hi');         // body
    expect(args[5]).toEqual(['default', 'Open']); // actions
    expect(args[6]).toBe(hints);        // hints
    expect(args[7]).toBe(-1);           // expire_timeout
  });
});
```
- [ ] **Step 2: Run → fail.** `npx vitest run tests/notificationDbus.test.ts`.
- [ ] **Step 3: Implement** `src/main/notifications/dbus.ts`:
```ts
import * as dbus from 'dbus-next';

const BUS = 'org.freedesktop.Notifications';
const PATH = '/org/freedesktop/Notifications';

export function buildHints(o: { imagePath?: string; desktopEntry: string }): Record<string, unknown> {
  const hints: Record<string, unknown> = { 'desktop-entry': new dbus.Variant('s', o.desktopEntry) };
  if (o.imagePath) hints['image-path'] = new dbus.Variant('s', o.imagePath);
  return hints;
}

export function buildNotifyArgs(p: {
  appName: string; appIcon: string; summary: string; body: string; hints: Record<string, unknown>;
}): unknown[] {
  return [p.appName, 0, p.appIcon, p.summary, p.body, ['default', 'Open'], p.hints, -1];
}

export interface NotifyParams {
  appName: string; appIcon: string; summary: string; body: string;
  imagePath?: string; desktopEntry?: string;
}

export interface NotificationServer {
  notify(p: NotifyParams): Promise<number>;
  onActionDefault(cb: (id: number) => void): void;
}

/** Persistent connection to the freedesktop notification server (KDE closes on disconnect). */
export async function connectNotificationServer(): Promise<NotificationServer> {
  const bus = dbus.sessionBus();
  const obj = await bus.getProxyObject(BUS, PATH);
  const iface = obj.getInterface(BUS) as unknown as {
    Notify(...a: unknown[]): Promise<number>;
    on(ev: 'ActionInvoked', cb: (id: number, action: string) => void): void;
    on(ev: 'NotificationClosed', cb: (id: number, reason: number) => void): void;
  };

  const actionCbs: Array<(id: number) => void> = [];
  iface.on('ActionInvoked', (id, action) => {
    if (action === 'default') for (const cb of actionCbs) cb(id);
  });
  iface.on('NotificationClosed', (id, reason) => {
    // Logged only — removing tracking here races ActionInvoked (parity with notifications.rs).
    void id; void reason;
  });

  return {
    async notify(p: NotifyParams): Promise<number> {
      const hints = buildHints({ imagePath: p.imagePath, desktopEntry: p.desktopEntry ?? 'chat.loft.Loft' });
      const args = buildNotifyArgs({ appName: p.appName, appIcon: p.appIcon, summary: p.summary, body: p.body, hints });
      return iface.Notify(...args);
    },
    onActionDefault(cb) { actionCbs.push(cb); },
  };
}
```
- [ ] **Step 4: Run → pass + headless live check.** `npx vitest run tests/notificationDbus.test.ts`, then `npm test`. Then verify the real call against the session bus (pops a real banner on the dev machine):
```bash
npm run build
node -e "require('./dist/main/notifications/dbus').connectNotificationServer().then(s=>s.notify({appName:'Loft',appIcon:'',summary:'Test',body:'hello from stage 3b'})).then(id=>{console.log('id',id);setTimeout(()=>process.exit(0),500)})"
```
Expected: a desktop notification appears and an id is printed. (If `dbus-next` proxy signal names differ, adjust per its introspection — verify online.)
- [ ] **Step 5: Commit** — `feat(notify): dbus-next notification server (persistent conn, Notify + ActionInvoked)`.

---

## Task 4: System-DND watcher (main)

**Files:** Create `src/main/notifications/systemDnd.ts`, `tests/systemDnd.test.ts`.

**Interfaces produced:**
- `function parseShowBanners(text: string): boolean | null` — extracts the `show-banners` boolean from `gsettings get` (`true`/`false`) or `gsettings monitor` (`show-banners: false`) output; null if unparseable. **System DND = `!show-banners`.**
- `interface SystemDndWatcher { current(): boolean; stop(): void }`
- `function watchSystemDnd(onChange: (dnd: boolean) => void, deps?: SystemDndDeps): SystemDndWatcher`
- `interface SystemDndDeps { getInitial(): string | null; spawnMonitor(onLine: (line: string) => void): { kill(): void } }`

**Behaviour:** GNOME path — `getInitial()` shells `gsettings get org.gnome.desktop.notifications show-banners`; `spawnMonitor()` runs `gsettings monitor org.gnome.desktop.notifications show-banners` and calls `onLine` per stdout line. Parse each with `parseShowBanners`; on a change call `onChange(!showBanners)`. Non-GNOME/`gsettings` missing → `getInitial()` returns null, `current()` stays `false` (no DND), `spawnMonitor` is a no-op. **KDE:** documented follow-up (spec §13 open item) — verify the Plasma "Do Not Disturb"/notification-inhibition D-Bus interface online at impl; wire it as an alternative source feeding the same `onChange`. Not blocking for this stage (Keith runs GNOME).

- [ ] **Step 1: Write the failing test** — `tests/systemDnd.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { parseShowBanners, watchSystemDnd } from '../src/main/notifications/systemDnd';

describe('parseShowBanners', () => {
  it('parses gsettings get output', () => {
    expect(parseShowBanners('true')).toBe(true);
    expect(parseShowBanners('false\n')).toBe(false);
  });
  it('parses gsettings monitor output', () => {
    expect(parseShowBanners('show-banners: false')).toBe(false);
    expect(parseShowBanners("  show-banners: true ")).toBe(true);
  });
  it('returns null for noise', () => {
    expect(parseShowBanners('')).toBeNull();
    expect(parseShowBanners('nonsense')).toBeNull();
  });
});

describe('watchSystemDnd', () => {
  it('seeds from the initial value and updates on monitor lines (DND = !show-banners)', () => {
    let emit: (line: string) => void = () => {};
    const changes: boolean[] = [];
    const w = watchSystemDnd((dnd) => changes.push(dnd), {
      getInitial: () => 'true',                         // banners on → DND off
      spawnMonitor: (onLine) => { emit = onLine; return { kill: vi.fn() }; },
    });
    expect(w.current()).toBe(false);
    emit('show-banners: false');                        // banners off → DND on
    expect(w.current()).toBe(true);
    expect(changes).toEqual([true]);                    // only real transitions emit
    emit('show-banners: false');                        // no change
    expect(changes).toEqual([true]);
    w.stop();
  });
  it('treats a missing initial value as no DND', () => {
    const w = watchSystemDnd(() => {}, { getInitial: () => null, spawnMonitor: () => ({ kill: () => {} }) });
    expect(w.current()).toBe(false);
    w.stop();
  });
});
```
- [ ] **Step 2: Run → fail.** `npx vitest run tests/systemDnd.test.ts`.
- [ ] **Step 3: Implement** `src/main/notifications/systemDnd.ts`:
```ts
import { spawn, execFileSync } from 'node:child_process';

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
  getInitial(): string | null;
  spawnMonitor(onLine: (line: string) => void): { kill(): void };
}

export interface SystemDndWatcher { current(): boolean; stop(): void }

function gnomeDeps(): SystemDndDeps {
  return {
    getInitial() {
      try {
        return execFileSync('gsettings', ['get', SCHEMA, KEY], { encoding: 'utf8' });
      } catch {
        return null;
      }
    },
    spawnMonitor(onLine) {
      let child: ReturnType<typeof spawn> | null = null;
      try {
        child = spawn('gsettings', ['monitor', SCHEMA, KEY]);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          for (const line of chunk.split('\n')) if (line.trim()) onLine(line);
        });
        child.on('error', () => {});
      } catch { /* gsettings missing */ }
      return { kill: () => child?.kill() };
    },
  };
}

export function watchSystemDnd(
  onChange: (dnd: boolean) => void,
  deps: SystemDndDeps = gnomeDeps(),
): SystemDndWatcher {
  const banners = parseShowBanners(deps.getInitial() ?? '');
  let dnd = banners === null ? false : !banners; // no reading → assume notifications allowed

  const monitor = deps.spawnMonitor((line) => {
    const b = parseShowBanners(line);
    if (b === null) return;
    const next = !b;
    if (next !== dnd) { dnd = next; onChange(dnd); }
  });

  return { current: () => dnd, stop: () => monitor.kill() };
}
```
- [ ] **Step 4: Run → pass.** `npx vitest run tests/systemDnd.test.ts`, then `npm test`. Optional live check: toggle GNOME's "Do Not Disturb" in the Quick Settings and confirm `gsettings get org.gnome.desktop.notifications show-banners` flips.
- [ ] **Step 5: Commit** — `feat(notify): system-DND watcher (GNOME gsettings; KDE TODO)`.

---

## Task 5: Notification override (preload, main world)

**Files:** Create `src/preload/notify/override.ts`, `tests/notifyOverride.test.ts`.

**Interfaces produced:**
- `interface OverrideNotice { title: string; body: string; icon: string; tag: string }`
- `interface OverrideHandle { setHidden(hidden: boolean): void }`
- `function installNotificationOverride(win: any, doc: any, onNotify: (n: OverrideNotice) => void): OverrideHandle`

**Behaviour (port of `notification-override.js`, minus `chrome.*` and `window.open`):**
- Save `Orig = win.Notification`. Define `SilentNotification(title, options)` that calls `onNotify({ title: String(title), body: options?.body ?? '', icon: options?.icon ?? '', tag: options?.tag ?? '' })` and creates **no** visible notification.
- **Slack invariants:** `SilentNotification.prototype = Orig.prototype`; `Object.defineProperty(SilentNotification,'name',{value:'Notification',configurable:true})`; `SilentNotification.toString = () => 'function Notification() { [native code] }'`; `permission` getter → `Orig.permission`; `requestPermission` → `Orig.requestPermission?.bind(Orig)` (fallback to a resolved `'granted'` when absent). Guard the whole block on `Orig` existing.
- Assign `win.Notification = SilentNotification`.
- Wrap `win.ServiceWorkerRegistration.prototype.showNotification` (guard on existence) to call `onNotify(...)` and resolve without showing.
- **Visibility override:** internal `hidden=false`; `Object.defineProperty(doc,'visibilityState',{get:()=>hidden?'hidden':'visible',configurable:true})` and `doc.hidden` likewise (wrap in try/catch — some envs make these non-configurable). `setHidden(v)` sets `hidden` and dispatches `doc.dispatchEvent(new Event('visibilitychange'))` (guard on `Event`/`dispatchEvent`). This lets apps that gate `new Notification()` on `document.hidden` fire while the window is unfocused; main still gates delivery.
- Idempotent: set `win.__loft_notify_installed`; if already set, return a handle whose `setHidden` still works (store it on `win`).

- [ ] **Step 1: Write the failing test** — `tests/notifyOverride.test.ts` (uses plain fake objects — no jsdom needed since the function only touches the passed `win`/`doc`):
```ts
import { describe, it, expect, vi } from 'vitest';
import { installNotificationOverride } from '../src/preload/notify/override';

function fakeEnv() {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  class Orig {
    static permission = 'granted';
    static requestPermission = vi.fn(async () => 'granted');
  }
  const swProto: any = { showNotification: vi.fn() };
  const win: any = {
    Notification: Orig,
    ServiceWorkerRegistration: function () {},
  };
  win.ServiceWorkerRegistration.prototype = swProto;
  const doc: any = {
    _props: {} as Record<string, unknown>,
    dispatchEvent: vi.fn(),
    addEventListener: (t: string, cb: (e: unknown) => void) => { (listeners[t] ||= []).push(cb); },
  };
  return { Orig, win, doc, swProto };
}

// Provide a minimal global Event for the visibilitychange dispatch.
(globalThis as any).Event = (globalThis as any).Event || class { constructor(public type: string) {} };

describe('installNotificationOverride', () => {
  it('relays new Notification() and preserves the Slack prototype invariant', () => {
    const { Orig, win, doc } = fakeEnv();
    const onNotify = vi.fn();
    installNotificationOverride(win, doc, onNotify);

    expect(win.Notification).not.toBe(Orig);
    expect(win.Notification.prototype).toBe(Orig.prototype); // Slack checks this
    expect(win.Notification.name).toBe('Notification');
    expect(String(win.Notification)).toContain('[native code]');
    expect(win.Notification.permission).toBe('granted');

    new win.Notification('Ann', { body: 'hi', icon: 'https://x/a.png', tag: 't1' });
    expect(onNotify).toHaveBeenCalledWith({ title: 'Ann', body: 'hi', icon: 'https://x/a.png', tag: 't1' });
  });

  it('relays showNotification and shows nothing', () => {
    const { win, doc, swProto } = fakeEnv();
    const onNotify = vi.fn();
    installNotificationOverride(win, doc, onNotify);
    win.ServiceWorkerRegistration.prototype.showNotification('Grp', { body: 'yo' });
    expect(onNotify).toHaveBeenCalledWith({ title: 'Grp', body: 'yo', icon: '', tag: '' });
  });

  it('setHidden flips the page visibility and fires visibilitychange', () => {
    const { win, doc } = fakeEnv();
    const h = installNotificationOverride(win, doc, vi.fn());
    expect(doc.visibilityState).toBe('visible');
    expect(doc.hidden).toBe(false);
    h.setHidden(true);
    expect(doc.visibilityState).toBe('hidden');
    expect(doc.hidden).toBe(true);
    expect(doc.dispatchEvent).toHaveBeenCalled();
  });
});
```
- [ ] **Step 2: Run → fail.** `npx vitest run tests/notifyOverride.test.ts`.
- [ ] **Step 3: Implement** `src/preload/notify/override.ts` per the behaviour above. Key skeleton:
```ts
export interface OverrideNotice { title: string; body: string; icon: string; tag: string }
export interface OverrideHandle { setHidden(hidden: boolean): void }

/* eslint-disable @typescript-eslint/no-explicit-any */
export function installNotificationOverride(
  win: any, doc: any, onNotify: (n: OverrideNotice) => void,
): OverrideHandle {
  let hidden = false;
  const setHidden = (v: boolean): void => {
    hidden = v;
    try { if (typeof doc.dispatchEvent === 'function' && typeof (globalThis as any).Event === 'function') doc.dispatchEvent(new (globalThis as any).Event('visibilitychange')); } catch { /* ignore */ }
  };

  if (win.__loft_notify_installed) {
    return (win.__loft_notify_handle as OverrideHandle) ?? { setHidden };
  }
  win.__loft_notify_installed = true;

  const relay = (title: unknown, options: any): void =>
    onNotify({ title: String(title ?? ''), body: options?.body ?? '', icon: options?.icon ?? '', tag: options?.tag ?? '' });

  const Orig = win.Notification;
  function SilentNotification(this: unknown, title: unknown, options: any = {}) { relay(title, options); }
  if (Orig) {
    (SilentNotification as any).prototype = Orig.prototype; // Slack inspects the prototype
    try { Object.defineProperty(SilentNotification, 'name', { value: 'Notification', configurable: true }); } catch { /* ignore */ }
    (SilentNotification as any).toString = () => 'function Notification() { [native code] }';
    try {
      Object.defineProperty(SilentNotification, 'permission', { get() { return Orig.permission; }, enumerable: true, configurable: true });
    } catch { /* ignore */ }
    (SilentNotification as any).requestPermission = typeof Orig.requestPermission === 'function'
      ? Orig.requestPermission.bind(Orig)
      : async () => 'granted';
    win.Notification = SilentNotification;
  }

  const SWReg = win.ServiceWorkerRegistration;
  if (SWReg && SWReg.prototype) {
    SWReg.prototype.showNotification = function (title: unknown, options: any = {}) { relay(title, options); return Promise.resolve(); };
  }

  try { Object.defineProperty(doc, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible'), configurable: true }); } catch { /* ignore */ }
  try { Object.defineProperty(doc, 'hidden', { get: () => hidden, configurable: true }); } catch { /* ignore */ }

  const handle: OverrideHandle = { setHidden };
  win.__loft_notify_handle = handle;
  return handle;
}
```
- [ ] **Step 4: Run → pass.** `npx vitest run tests/notifyOverride.test.ts`, then `npm test`.
- [ ] **Step 5: Commit** — `feat(notify): main-world Notification/showNotification override (Slack-safe) + visibility`.

---

## Task 6: In-page avatar helpers (preload)

**Files:** Create `src/preload/notify/avatar.ts`, `tests/notifyAvatar.test.ts`.

**Interfaces produced:**
- `function resolveIconUrl(icon: string, pageHref: string): string` — `''` for empty/`blob:`; pass `data:` through; resolve relative → absolute against `pageHref`; return only `http(s)`/`data:`, else `''`. (Blobs are handled separately via `blobToDataUri` because main can't read them.)
- `function pickTalkAvatarSrc(doc: Document, title: string): string` — port of `talkAvatarIcon`: scan `.conversation-icon__avatar[title]`, pick the row whose `title` is contained in the notification `title` (longest match wins), return its `<img>` `src` (root-relative — the bridge resolves it), else `''`.
- `function slackSenderFromTitle(title: string): string` — `"New message from {Name}"` → `Name`, else `''`.
- `function findSlackAvatar(doc: Document, cache: Map<string,string>, title: string, tag: string): string` — port of `content.js findSlackAvatar` ((1) message by `data-msg-ts` from `tag`, (2) name cache, (3) sidebar), upscaling `-NN`→`-128`.
- `function scanSlackAvatars(doc: Document, cache: Map<string,string>): void` — port of `content.js scanSlackAvatars`.
- `async function blobToDataUri(url: string, fetchFn?: typeof fetch): Promise<string>` — fetch a `blob:` URL, FileReader→data URI; `''` on failure.

- [ ] **Step 1: Write the failing test** — `tests/notifyAvatar.test.ts` (jsdom via `new JSDOM`; mirror `tests/badgeParsers.test.ts` setup):
```ts
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  resolveIconUrl, pickTalkAvatarSrc, slackSenderFromTitle, findSlackAvatar, scanSlackAvatars,
} from '../src/preload/notify/avatar';

const doc = (html: string): Document => new JSDOM(html).window.document;

describe('resolveIconUrl', () => {
  it('passes data:, resolves relative, drops blob/empty/other', () => {
    expect(resolveIconUrl('', 'https://p/')).toBe('');
    expect(resolveIconUrl('blob:https://p/xyz', 'https://p/')).toBe('');
    expect(resolveIconUrl('data:image/png;base64,AAAA', 'https://p/')).toBe('data:image/png;base64,AAAA');
    expect(resolveIconUrl('/avatar/x/64', 'https://cloud.example/index.php/')).toBe('https://cloud.example/avatar/x/64');
    expect(resolveIconUrl('https://cdn/x.png', 'https://p/')).toBe('https://cdn/x.png');
    expect(resolveIconUrl('ftp://x', 'https://p/')).toBe('');
  });
});

describe('pickTalkAvatarSrc', () => {
  it('matches the longest conversation name contained in the title', () => {
    const d = doc(`
      <span class="conversation-icon__avatar" title="Ann"><img src="/avatar/Ann/64"></span>
      <span class="conversation-icon__avatar" title="Ann Marie"><img src="/avatar/AnnMarie/64"></span>`);
    expect(pickTalkAvatarSrc(d, 'Ann Marie sent you a message')).toBe('/avatar/AnnMarie/64');
    expect(pickTalkAvatarSrc(d, 'Nobody here')).toBe('');
  });
});

describe('slack helpers', () => {
  it('extracts the DM sender name', () => {
    expect(slackSenderFromTitle('New message from Keith')).toBe('Keith');
    expect(slackSenderFromTitle('#general')).toBe('');
  });
  it('finds an avatar by message timestamp and upscales to -128', () => {
    const d = doc(`<div data-msg-ts="171.5">
      <div class="c-base_icon__width_only_container"><img src="https://ca.slack-edge.com/AAA-24"></div></div>`);
    expect(findSlackAvatar(d, new Map(), 'New message from X', 'tag_171.5')).toBe('https://ca.slack-edge.com/AAA-128');
  });
  it('builds a name→avatar cache from rendered messages', () => {
    const d = doc(`<div data-msg-ts="1"><button data-qa="message_sender_name">Keith</button>
      <div class="c-base_icon__width_only_container"><img src="https://ca.slack-edge.com/BBB-48"></div></div>`);
    const cache = new Map<string, string>();
    scanSlackAvatars(d, cache);
    expect(cache.get('Keith')).toBe('https://ca.slack-edge.com/BBB-128');
    expect(findSlackAvatar(doc('<div></div>'), cache, 'New message from Keith', '')).toBe('https://ca.slack-edge.com/BBB-128');
  });
});
```
- [ ] **Step 2: Run → fail.** `npx vitest run tests/notifyAvatar.test.ts`.
- [ ] **Step 3: Implement** `src/preload/notify/avatar.ts`:
```ts
export function resolveIconUrl(icon: string, pageHref: string): string {
  if (typeof icon !== 'string' || !icon) return '';
  if (icon.startsWith('data:')) return icon;
  if (icon.startsWith('blob:')) return ''; // read via blobToDataUri instead
  let abs = icon;
  if (!/^https?:/.test(icon)) {
    try { abs = new URL(icon, pageHref).href; } catch { return ''; }
  }
  return /^https?:\/\//.test(abs) ? abs : '';
}

export function pickTalkAvatarSrc(doc: Document, title: string): string {
  if (typeof title !== 'string') return '';
  let best: { name: string; src: string } | null = null;
  for (const span of Array.from(doc.querySelectorAll('.conversation-icon__avatar[title]'))) {
    const name = span.getAttribute('title');
    const src = span.querySelector('img')?.getAttribute('src') ?? null;
    if (name && src && title.includes(name) && (!best || name.length > best.name.length)) best = { name, src };
  }
  return best ? best.src : '';
}

export function slackSenderFromTitle(title: string): string {
  const m = typeof title === 'string' ? title.match(/^New message from (.+)$/) : null;
  return m ? m[1].trim() : '';
}

const to128 = (src: string): string => src.replace(/-\d+$/, '-128');

export function scanSlackAvatars(doc: Document, cache: Map<string, string>): void {
  for (const msg of Array.from(doc.querySelectorAll('[data-msg-ts]'))) {
    const name = msg.querySelector('[data-qa="message_sender_name"]')?.textContent?.trim();
    if (!name || cache.has(name)) continue;
    const img = msg.querySelector('.c-base_icon__width_only_container img[src*="slack-edge"]') as HTMLImageElement | null;
    if (img && img.src.startsWith('https://')) cache.set(name, to128(img.src));
  }
}

export function findSlackAvatar(doc: Document, cache: Map<string, string>, title: string, tag: string): string {
  if (tag) {
    const ts = tag.replace(/^tag_/, '');
    const el = doc.querySelector(`[data-msg-ts="${ts}"]`);
    const img = el?.querySelector('.c-base_icon__width_only_container img[src*="slack-edge"]') as HTMLImageElement | null;
    if (img && img.src.startsWith('https://')) return to128(img.src);
  }
  const sender = slackSenderFromTitle(title);
  if (sender && cache.has(sender)) return cache.get(sender)!;
  if (sender) {
    for (const ch of Array.from(doc.querySelectorAll('.p-channel_sidebar__channel--unread'))) {
      const nameSpan = ch.querySelector('.p-channel_sidebar__name > span:first-child');
      if (nameSpan?.textContent?.trim() !== sender) continue;
      const img = ch.querySelector('.c-base_icon__width_only_container img[src*="slack-edge"]') as HTMLImageElement | null;
      if (img && img.src.startsWith('https://')) return to128(img.src);
    }
  }
  return '';
}

export async function blobToDataUri(url: string, fetchFn: typeof fetch = fetch): Promise<string> {
  try {
    const resp = await fetchFn(url);
    const blob = await resp.blob();
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  } catch {
    return '';
  }
}
```
Note: in the jsdom test, `img.src` reflects the attribute as an absolute URL only if the doc has a base; using bare `https://` srcs keeps it exact. If jsdom normalises `src`, assert against `getAttribute('src')` in the helper instead (verify at impl and prefer whichever the live Chromium returns — the live values are absolute `https://ca.slack-edge.com/...`).
- [ ] **Step 4: Run → pass.** `npx vitest run tests/notifyAvatar.test.ts`, then `npm test`.
- [ ] **Step 5: Commit** — `feat(notify): in-page avatar helpers (Slack/Talk lookup, icon resolve, blob→data)`.

---

## Task 7: Messenger notify scanner (preload)

**Files:** Create `src/preload/notify/messenger.ts`, `tests/messengerNotifier.test.ts`.

**Interfaces produced:**
- `interface NotifyPayload { sender: string; body: string; icon: string; href: string }`
- `class MessengerNotifier` — `constructor(opts?: { graceMs?: number; now?: () => number })`; `setDnd(v: boolean): void`; `scan(doc: Document): NotifyPayload[]`.

**Behaviour (port of `content.js` messenger block):** on each `scan`, walk `a[href*="/messages/"]`; a row is unread if it contains a text node `"Unread message:"`; skip muted (`[style*="--disabled-icon"]`). Build a fingerprint (first two substantial text nodes after the marker, ignoring `Nh/Nm/Ns` timestamps, `·`, `Active…`; fall back to short emoji `img[alt]` not on fbcdn). Maintain `notifiedConversations: Map<href,fingerprint>` and `avatarCache: Map<href,url>` (populate from ALL rows, unread or not). Emit a payload **only** when the fingerprint changed AND we're past the startup grace AND not in DND — in the grace/DND cases still record the fingerprint (silent-add). Drop tracking for hrefs no longer unread. `scan` returns the payloads to notify (avatar = fbcdn/https `img` src, or cached).

- [ ] **Step 1: Write the failing test** — `tests/messengerNotifier.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { MessengerNotifier } from '../src/preload/notify/messenger';

function row(href: string, sender: string, preview: string, opts: { muted?: boolean; img?: string } = {}): string {
  return `<a href="${href}">
    ${opts.muted ? '<i style="--disabled-icon:1"></i>' : ''}
    <span>Unread message:</span><span>${sender}</span><span>${preview}</span>
    ${opts.img ? `<img src="${opts.img}">` : ''}
  </a>`;
}
const doc = (html: string): Document => new JSDOM(`<div>${html}</div>`).window.document;

describe('MessengerNotifier', () => {
  it('suppresses during the startup grace, then notifies new unreads', () => {
    let t = 0;
    const n = new MessengerNotifier({ graceMs: 1000, now: () => t });
    const d = doc(row('/messages/t/1', 'Ann', 'hi', { img: 'https://scontent.fbcdn.net/a.jpg' }));
    expect(n.scan(d)).toEqual([]);           // within grace → silent-add
    t = 2000;
    expect(n.scan(d)).toEqual([]);           // same fingerprint → nothing new
  });
  it('notifies a fresh conversation after grace with sender/body/icon/href', () => {
    let t = 5000;
    const n = new MessengerNotifier({ graceMs: 1000, now: () => t });
    const out = n.scan(doc(row('/messages/t/2', 'Bob', 'yo', { img: 'https://scontent.fbcdn.net/b.jpg' })));
    expect(out).toEqual([{ sender: 'Bob', body: 'yo', icon: 'https://scontent.fbcdn.net/b.jpg', href: '/messages/t/2' }]);
  });
  it('re-notifies when the preview (fingerprint) changes', () => {
    let t = 5000;
    const n = new MessengerNotifier({ graceMs: 0, now: () => t });
    expect(n.scan(doc(row('/messages/t/3', 'Cy', 'first'))).length).toBe(1);
    expect(n.scan(doc(row('/messages/t/3', 'Cy', 'first'))).length).toBe(0); // unchanged
    expect(n.scan(doc(row('/messages/t/3', 'Cy', 'second'))).length).toBe(1); // changed
  });
  it('skips muted conversations and honours DND silent-add', () => {
    let t = 5000;
    const n = new MessengerNotifier({ graceMs: 0, now: () => t });
    expect(n.scan(doc(row('/messages/t/4', 'D', 'x', { muted: true })))).toEqual([]);
    n.setDnd(true);
    expect(n.scan(doc(row('/messages/t/5', 'E', 'x')))).toEqual([]); // DND → silent-add
    n.setDnd(false);
    expect(n.scan(doc(row('/messages/t/5', 'E', 'x')))).toEqual([]); // already tracked → no burst
  });
});
```
- [ ] **Step 2: Run → fail.** `npx vitest run tests/messengerNotifier.test.ts`.
- [ ] **Step 3: Implement** `src/preload/notify/messenger.ts` porting `getConversationFingerprint`, `extractConversationData`, `scanForUnreadMessages`, `scanMessengerAvatars` from `content.js` (lines ~860–1080) into methods. Shape:
```ts
export interface NotifyPayload { sender: string; body: string; icon: string; href: string }

export class MessengerNotifier {
  private notified = new Map<string, string>();
  private avatarCache = new Map<string, string>();
  private dnd = false;
  private readonly loadTime: number;
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(opts: { graceMs?: number; now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.graceMs = opts.graceMs ?? 15_000;
    this.loadTime = this.now();
  }

  setDnd(v: boolean): void { this.dnd = v; }

  scan(doc: Document): NotifyPayload[] {
    const out: NotifyPayload[] = [];
    const currentlyUnread = new Set<string>();
    this.cacheAllAvatars(doc);

    for (const anchor of Array.from(doc.querySelectorAll('a[href*="/messages/"]'))) {
      const href = anchor.getAttribute('href');
      if (!href || !this.isUnread(doc, anchor)) continue;
      if (anchor.querySelector('[style*="--disabled-icon"]')) continue; // muted
      currentlyUnread.add(href);

      const fp = this.fingerprint(doc, anchor);
      if (this.notified.get(href) === fp) continue;

      const inGrace = this.now() - this.loadTime < this.graceMs;
      this.notified.set(href, fp);            // record in all paths (grace/DND/emit)
      if (inGrace || this.dnd) continue;

      const payload = this.extract(doc, anchor, href);
      if (payload) out.push(payload);
    }
    for (const [href] of this.notified) if (!currentlyUnread.has(href)) this.notified.delete(href);
    return out;
  }

  // ... isUnread(), fingerprint(), extract(), cacheAllAvatars() ported verbatim from content.js ...
}
```
Port the private helpers faithfully (TreeWalker marker scan, emoji `img[alt]` fallback, sender = first leaf `span` that isn't utility text, preview walking text+`IMG` alt in document order, avatar `img[src*="fbcdn.net"] || img[src^="https://"]` with cache fallback). Use `doc.createTreeWalker` (jsdom supports it). Return `null` from `extract` when both sender and body are empty (parity).
- [ ] **Step 4: Run → pass.** `npx vitest run tests/messengerNotifier.test.ts`, then `npm test`.
- [ ] **Step 5: Commit** — `feat(notify): Messenger DOM notify scanner (fingerprint, grace, DND, muted)`.

---

## Task 8: Telegram notify scanner (preload)

**Files:** Create `src/preload/notify/telegram.ts`, `tests/telegramNotifier.test.ts`.

**Interfaces produced:**
- `class TelegramNotifier` — `constructor(opts?: { graceMs?: number; now?: () => number })`; `setDnd(v: boolean): void`; `scan(doc: Document): NotifyPayload[]` (reuses `NotifyPayload` from `./messenger`). Emitted `icon` is the raw avatar URL (`blob:`/`https:`); the bridge converts `blob:` → `data:` before IPC.

**Behaviour (port of `content.js` telegram block, lines ~594–794):** walk `.chat-badge-transition` whose text is all digits (skip action buttons); find the chat row (`a[href]` ancestor, or `.chatlist-chat`/`.ListItem`); skip muted (`.chat-muted-icon, .muted-icon, .icon-muted`); key = href/data-peer-id/text; fingerprint = `senderName + '|' + preview` (`h3.fullName` + `.last-message-summary`, strip `Draft:`); grace + DND silent-add exactly like Messenger; avatar = `.Avatar img` src (raw — no in-scanner fetch).

- [ ] **Step 1: Write the failing test** — `tests/telegramNotifier.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { TelegramNotifier } from '../src/preload/notify/telegram';

function row(href: string, name: string, preview: string, opts: { badge?: string; muted?: boolean; avatar?: string } = {}): string {
  return `<a href="${href}" class="ListItem">
    <div class="Avatar">${opts.avatar ? `<img src="${opts.avatar}">` : ''}</div>
    <div class="title"><h3 class="fullName">${name}</h3></div>
    <div class="last-message-summary">${preview}</div>
    ${opts.muted ? '<i class="chat-muted-icon"></i>' : ''}
    <div class="chat-badge-transition">${opts.badge ?? '1'}</div>
  </a>`;
}
const doc = (html: string): Document => new JSDOM(`<div>${html}</div>`).window.document;

describe('TelegramNotifier', () => {
  it('notifies a fresh numeric-badge chat after grace', () => {
    const n = new TelegramNotifier({ graceMs: 0, now: () => 5000 });
    const out = n.scan(doc(row('#/im?p=1', 'Ann', 'hi', { avatar: 'blob:tg/aaa' })));
    expect(out).toEqual([{ sender: 'Ann', body: 'hi', icon: 'blob:tg/aaa', href: '#/im?p=1' }]);
  });
  it('ignores non-numeric badges (action buttons)', () => {
    const n = new TelegramNotifier({ graceMs: 0, now: () => 5000 });
    expect(n.scan(doc(row('#/im?p=2', 'Bot', 'x', { badge: 'Open' })))).toEqual([]);
  });
  it('suppresses during grace and skips muted; DND silent-adds', () => {
    const n = new TelegramNotifier({ graceMs: 1000, now: () => 0 });
    expect(n.scan(doc(row('#/im?p=3', 'C', 'x')))).toEqual([]); // grace
    const n2 = new TelegramNotifier({ graceMs: 0, now: () => 5000 });
    expect(n2.scan(doc(row('#/im?p=4', 'D', 'x', { muted: true })))).toEqual([]); // muted
    n2.setDnd(true);
    expect(n2.scan(doc(row('#/im?p=5', 'E', 'x')))).toEqual([]); // DND silent-add
  });
  it('re-notifies on preview change', () => {
    const n = new TelegramNotifier({ graceMs: 0, now: () => 5000 });
    expect(n.scan(doc(row('#/im?p=6', 'F', 'one'))).length).toBe(1);
    expect(n.scan(doc(row('#/im?p=6', 'F', 'one'))).length).toBe(0);
    expect(n.scan(doc(row('#/im?p=6', 'F', 'two'))).length).toBe(1);
  });
});
```
- [ ] **Step 2: Run → fail.** `npx vitest run tests/telegramNotifier.test.ts`.
- [ ] **Step 3: Implement** `src/preload/notify/telegram.ts` porting `findTelegramChatRow`, `getTelegramChatKey`, `extractTelegramData`, `getTelegramFingerprint`, `scanTelegramUnreads` into a class mirroring `MessengerNotifier`'s structure (same grace/DND/tracking flow). Import `NotifyPayload` from `./messenger`. Do **not** fetch/convert the avatar here — return the raw src.
- [ ] **Step 4: Run → pass.** `npx vitest run tests/telegramNotifier.test.ts`, then `npm test`.
- [ ] **Step 5: Commit** — `feat(notify): Telegram DOM notify scanner (numeric-badge, grace, DND, muted)`.

---

## Task 9: Notify bridge + switch the service view to the main world (preload)

**Files:** Create `src/preload/notify/bridge.ts`; modify `src/preload/service.ts`, `src/main/serviceWindow.ts`.

**Interfaces produced:**
- `interface BridgeDeps { ipc: { send(ch: string, ...a: unknown[]): void; on(ch: string, cb: (e: unknown, ...a: unknown[]) => void): void }; win: any; doc: Document }`
- `function startNotifyBridge(serviceId: string, deps: BridgeDeps): void`

**Behaviour:** Ties the pieces together in the page:
- `installNotificationOverride(win, doc, onNotify)` where `onNotify(n)` resolves the icon then `ipc.send('service:notify', payload)`:
  - Slack: if `n.icon` empty, `icon = findSlackAvatar(doc, slackCache, n.title, n.tag)` (keep a module-level `slackCache: Map` populated by a `scanSlackAvatars` MutationObserver on Slack). Summary = `n.title`, body = `n.body`.
  - Talk: `icon = resolveIconUrl(pickTalkAvatarSrc(doc, n.title) || n.icon, location.href)`.
  - Others: `icon = n.icon.startsWith('blob:') ? await blobToDataUri(n.icon) : resolveIconUrl(n.icon, location.href)`.
  - Payload: `{ title: n.title, body: n.body, icon, href: '' }` (Notification-API services have no conversation href).
- Messenger/Telegram: create the notifier, run it on a debounced `MutationObserver(document.body)` + interval + timed retries (mirror `content.js`: 3s/8s/15s + 10s interval). For each returned payload, for Telegram convert `blob:` icon via `blobToDataUri` first, then `ipc.send('service:notify', { title: p.sender, body: p.body, icon, href: p.href })`.
- `ipc.on('service:dnd', (_e, enabled) => { messenger?.setDnd(enabled); telegram?.setDnd(enabled); })`.
- `ipc.on('service:visibility', (_e, hidden) => overrideHandle.setHidden(!!hidden))`.
- `ipc.on('service:navigate', (_e, url) => { ... })` — Messenger only: click `a[href="<url>"]` if present, else `location.href = 'https://www.facebook.com' + url` (port of `content.js` `navigate_to_conversation`). Other services: no-op (focus already happened in main).

**Service-view main-world switch (`serviceWindow.ts`):** add to the service `WebContentsView` `webPreferences`: `sandbox: false, contextIsolation: false` (keep `nodeIntegration` default false). This lets the bundled preload wrap the page's real `window.Notification`. **Verify at impl:** WebRTC calls still work with these flags (Keith's live test — Task 10 Step 4); they are orthogonal to media, but confirm. The titlebar view is unchanged (keeps isolation + `contextBridge`).

- [ ] **Step 1** — Implement `src/preload/notify/bridge.ts` per the behaviour above (import from `./override`, `./avatar`, `./messenger`, `./telegram`). Keep it dependency-injected on `ipc`/`win`/`doc` so it stays unit-testable later; no direct `require('electron')` inside (the caller passes `ipcRenderer`).
- [ ] **Step 2** — Wire it in `src/preload/service.ts`:
```ts
import { ipcRenderer } from 'electron';
import { startBadgeScanner } from './badge/scanner';
import { startDechrome } from './dechrome';
import { startNotifyBridge } from './notify/bridge';

function readServiceId(): string {
  const arg = process.argv.find((a) => a.startsWith('--loft-service='));
  return arg ? arg.slice('--loft-service='.length) : '';
}

const serviceId = readServiceId();
if (serviceId) {
  startNotifyBridge(serviceId, { ipc: ipcRenderer, win: window, doc: document });
  startBadgeScanner(serviceId, (count) => ipcRenderer.send('service:badge', { count }));
  startDechrome(serviceId);
}
```
- [ ] **Step 3** — In `serviceWindow.ts`, add `sandbox: false, contextIsolation: false` to the service view's `webPreferences`, and add three methods to the returned `ServiceWindow` (and its interface):
```ts
pushDnd: (enabled: boolean) => serviceView.webContents.send('service:dnd', enabled),
pushHidden: (hidden: boolean) => serviceView.webContents.send('service:visibility', hidden),
navigate: (url: string) => serviceView.webContents.send('service:navigate', url),
```
- [ ] **Step 4** — Build + confirm the bundle is self-contained (the memory gotcha: sandboxed preloads can't `require` local files — we now run un-sandboxed, but keep the esbuild bundle):
```bash
npm run build
grep -c "require('electron')" dist/preload/service.js   # expect >=1 (external), no local requires
```
Expected: `tsc` clean, build OK.
- [ ] **Step 5: Commit** — `feat(notify): preload bridge + run service view in the page main world`.

---

## Task 10: Wire notifications into main

**Files:** Create `src/main/notifications/index.ts`; modify `src/main/index.ts`.

**Interfaces produced:**
- `interface NotificationsDeps { displayName(id): string; serviceIconPath(id): string; sessionFetch(id, url): Promise<{ok:boolean;status:number;arrayBuffer():Promise<ArrayBuffer>}>; focusService(id): void; navigate(id, url): void; pushDnd(id, effectiveDnd): void; pushHidden(id, hidden): void }`
- `interface Notifications { handle(id, p: {title;body;icon?;href?}): Promise<void>; setServiceDnd(id, v): void; setGlobalDnd(v): void; setFocused(id, v): void; setVisible(id, v): void; registerService(id): void }`
- `async function startNotifications(deps): Promise<Notifications>`

**Behaviour of `startNotifications`:**
- Build a `NotificationGate`, `connectNotificationServer()`, and `watchSystemDnd(dnd => { gate.setSystemDnd(dnd); pushDndToAll(); })`; seed `gate.setSystemDnd(watcher.current())`.
- Keep `pending: Map<number, { id: string; href?: string }>`. `server.onActionDefault((notifId) => { const m = pending.get(notifId); if (!m) return; pending.delete(notifId); deps.focusService(m.id); if (m.href) deps.navigate(m.id, m.href); })` — the `pending` filter is what limits us to our own notifications (parity with `sent_ids`).
- `handle(id, p)`: `if (!gate.shouldNotify(id)) return;` then `const imagePath = await resolveAvatar(p.icon, { fetch: (u) => deps.sessionFetch(id, u), statMtimeMs, writeFile, now: () => Date.now() })` (create the avatars dir with `mkdirSync(recursive)` before write; `statMtimeMs` via `statSync(...).mtimeMs` catch→null). `const notifId = await server.notify({ appName: deps.displayName(id), appIcon: deps.serviceIconPath(id), summary: p.title, body: p.body, imagePath, href: p.href })`. `pending.set(notifId, { id, href: p.href })`.
- `setServiceDnd(id,v)`: `gate.setServiceDnd(id,v); deps.pushDnd(id, gate.effectiveDnd(id))`.
- `setGlobalDnd(v)`: `gate.setGlobalDnd(v); pushDndToAll()`.
- `setFocused(id,v)` / `setVisible(id,v)`: update gate, then `deps.pushHidden(id, !(gate-focused(id) && gate-visible(id)))` — i.e. tell the page it is "hidden" whenever it is not focused-and-visible, so apps that gate on `document.hidden` fire. (Track focused/visible inside the gate; expose read-back or recompute here.)
- `registerService(id)`: push current effective DND + current hidden state to the freshly (re)loaded view.
- `pushDndToAll()`: iterate known service ids → `deps.pushDnd(id, gate.effectiveDnd(id))`. (Maintain a `Set` of ids seen via `setServiceDnd`/`registerService`/`handle`.)

**Wiring in `src/main/index.ts`:**
- Add a module `serviceIconPath(id)` = `join(__dirname, '..', '..', 'assets', 'icons', `${id}.png`)` (the `copy-assets`-deployed dir, same as the tray).
- After `startTray(...)`, `startNotifications({...})` with:
  - `displayName: (id) => getService(id)?.displayName ?? id`
  - `serviceIconPath`
  - `sessionFetch: (id, url) => session.fromPartition(`persist:${id}`).fetch(url)` (verify `session.fetch` signature online; it returns a `Response`).
  - `focusService: (id) => { const d = getService(id); if (d) openService(d, false); }` (shows/focuses; opens if somehow gone).
  - `navigate: (id, url) => windows.get(id)?.navigate(url)`
  - `pushDnd: (id, v) => windows.get(id)?.pushDnd(v)`
  - `pushHidden: (id, hidden) => windows.get(id)?.pushHidden(hidden)`
- `ipcMain.on('service:notify', (e, p) => { const sw = findBySenderId(e.sender.id); if (sw && p) void notifications?.handle(sw.def.id, p); })`.
- In `openService`, after wiring `show`/`hide`, add:
  ```ts
  sw.window.on('focus', () => notifications?.setFocused(def.id, true));
  sw.window.on('blur', () => notifications?.setFocused(def.id, false));
  sw.window.on('show', () => notifications?.setVisible(def.id, true));
  sw.window.on('hide', () => notifications?.setVisible(def.id, false));
  sw.serviceView.webContents.on('did-finish-load', () => notifications?.registerService(def.id));
  ```
  and seed `notifications?.setVisible(def.id, sw.window.isVisible()); notifications?.setFocused(def.id, sw.window.isFocused());`.
- Tray DND callbacks also drive the gate: `onToggleDnd: (id, enabled) => { setServiceDnd(id, enabled); tray?.setDnd(id, enabled); notifications?.setServiceDnd(id, enabled); }` and `onToggleGlobalDnd: (enabled) => { setGlobalDnd(enabled); notifications?.setGlobalDnd(enabled); }`.
- Seed per-service DND into the gate on startup (`for (const id of Object.keys(config.services)) notifications?.setServiceDnd(id, config.services[id]?.dnd ?? false)`), and global (`notifications?.setGlobalDnd(config.globalDnd ?? false)`).

- [ ] **Step 1** — Implement `src/main/notifications/index.ts` (`startNotifications`) per the behaviour above, importing `NotificationGate`, `resolveAvatar`/`avatarCacheDir`, `connectNotificationServer`, `watchSystemDnd`. Wrap `connectNotificationServer()` + `watchSystemDnd()` in try/catch so a bus/gsettings failure logs and degrades (no notifications) rather than crashing the app.
- [ ] **Step 2** — Wire `src/main/index.ts` (icon path, `startNotifications`, `service:notify` handler, window focus/blur/show/hide + did-finish-load, tray DND callbacks, startup gate seeding). Keep `let notifications: Notifications | undefined;` at module scope alongside `tray`.
- [ ] **Step 3** — Build: `npm run build` → tsc clean; `npm test` → all suites green.
- [ ] **Step 4 — LIVE verification (Keith).** `npm run build`, kill any stale instances, then per service:
```bash
pkill -f 'electron .' 2>/dev/null; true
env -u ELECTRON_RUN_AS_NODE npx electron . --service=whatsapp
```
Confirm, across WhatsApp / Slack / Element / Talk / Messenger / Telegram:
  1. **A message with the window unfocused pops a desktop notification** with the sender name + body + **avatar** (Slack/Messenger/Telegram/Element/Talk avatars resolve; WhatsApp shows the app icon if it only supplies a blob).
  2. **Focused + visible window → no notification** (focus gate). Unfocused or hidden → notification fires.
  3. **Per-service DND** (tray menu) suppresses that service; **global DND** suppresses all; **GNOME Quick-Settings Do-Not-Disturb** suppresses all (system DND) and lifting it restores them.
  4. **Clicking a notification** focuses the window (and, for Messenger, opens the conversation).
  5. **No duplicate/startup-storm** notifications on launch (15s grace holds); **calls still work** (audio/video/screenshare) with the main-world service view.
- [ ] **Step 5: Commit** — `feat(notify): wire notifications + DND gating into main (Stage 3b complete)`.

---

## Self-Review

**Spec coverage (§6 interception, §7 Notifications & DND):**
- Main-world `Notification`/`showNotification` wrap, Slack invariants, visibility override → Tasks 5, 9. ✔
- Messenger/Telegram DOM notify-on-new (`Map<href,fingerprint>`, 15s grace, DND silent-add, muted) → Tasks 7, 8. ✔
- D-Bus delivery via `dbus-next` (persistent conn, `Notify` shape, actions) → Task 3. ✔
- Avatars in main via `session.fetch` (public + authenticated), data-URI decode, 1h cache; in-page Slack/Talk lookup + blob→data → Tasks 2, 6, 9. ✔
- Click-to-navigate (`ActionInvoked("default")` → focus + navigate) → Tasks 3, 10. ✔
- DND = `!systemDnd && !globalDnd && !serviceDnd && !(focused && visible)`; system DND (GNOME gsettings, live), per-service + global pushed to views → Tasks 1, 4, 10. ✔

**Deviations from the spec (intentional, logged):**
- Interception via **`contextIsolation:false` preload** instead of a main-world `<script>` — page CSP blocks inline scripts; this is simpler, testable, and matches the old app's trust model (Global Constraints). 
- **Background status** (`background_status.rs`, spec §7 last bullet) is **DEFERRED to Stage 3c** — it is a GNOME portal (`org.freedesktop.portal.Background.SetStatus`) system integration that belongs with the other GNOME work (shell helper, panel backend), and my recorded Stage 3b scope is "interception + delivery + DND gating." Note in the ledger.
- **Open-external-links** (`window.open`/anchor → default browser), the `beforeunload` close-guard, and the first-run bubble from the old `content.js`/`notification-override.js` are **out of scope** (not notifications) — carry to a later polish/Stage 4.
- **KDE system-DND** is a documented follow-up (spec §13 open item); GNOME path is complete.

**Placeholder scan:** none — every code step has complete code or a precise verbatim-port instruction against named `content.js`/`notifications.rs` line ranges.

**Type consistency:** `NotifyPayload {sender,body,icon,href}` (preload, Tasks 7/8) vs the IPC `service:notify` payload `{title,body,icon?,href?}` (main `handle`, Task 10) — the bridge (Task 9) maps `sender→title`; documented there. `resolveAvatar`'s `AvatarDeps.fetch` matches the `session.fetch` `Response` subset used in Task 10. `NotificationGate` methods used identically in Tasks 1 and 10.

**Verify-online reminders (per repo rule):** `session.fetch` signature/return; `dbus-next` proxy signal event names for `org.freedesktop.Notifications`; GNOME `gsettings` schema/key `org.gnome.desktop.notifications show-banners`; that WebRTC survives `contextIsolation:false`.
