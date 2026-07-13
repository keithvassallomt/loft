# Electron Loft — Stage 3c: GNOME System Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Loft native GNOME desktop integration under its single-app Electron identity: a `chat.loft.Loft` D-Bus service, a GNOME-Shell-helper–driven window focus/hide + alt-tab-hiding path, a GNOME-panel tray backend (the default on GNOME) alongside the existing SNI tray, and a GNOME Background-Apps status line — plus the one deferred `bridge.ts` unit test.

**Architecture:** All services run under **one** Electron app (`app.setName('Loft')`), so the GNOME helper can no longer key windows by per-service WM_CLASS. We re-key it onto our **window titles** (which always start with the service display name — `formatWindowTitle` → `"WhatsApp"` / `"WhatsApp (3)"`): the daemon pushes the current set of open-service display-name keys to the helper (`SetLoftWindows`), and `FocusWindow`/`HideWindow` take a single display-name key that the helper matches by title-prefix. A hand-rolled `chat.loft.Loft` D-Bus service (per-service object paths `/chat/loft/<DbusName>` + a root object) exposes Show/Hide/Toggle/Quit/GetStatus/SetDnd/SetBadgesEnabled; the GNOME-panel tray's menu (owned by the helper) routes back through it. The GNOME-panel tray backend ports `run_combined_gnome_panel` and is driven by the same `TrayModel` the SNI tray uses; a `tray_backend` config (`auto|gnome-panel|sni`, `auto`→gnome-panel on GNOME) selects between them. Background status ports `background_status.rs`, simplified to our in-process service set.

**Tech Stack:** Electron 43, TypeScript 5.9 (CommonJS, ES2022), Vitest 4.1, `dbus-next` `^0.10.2` (client via `bus.call(new Message(...))` / `getProxyObject`; server via `dbus.interface.Interface` + `configureMembers` + `bus.export`/`requestName`), GJS (GNOME Shell 47–50) for the helper. Ports from `src/desktop.rs`, `src/daemon/gnome_shell.rs`, `src/daemon/mod.rs`, `src/combined_tray/gnome.rs`, `src/daemon/background_status.rs`, `src/config.rs`, and edits `gnome-shell-extension/extension.js`.

## Global Constraints

- All Node/TS paths are relative to `electron/`; run `npm`/`git`/`npx` from `electron/`. Branch: `electron-rewrite`. GJS extension + repo assets live at the repo root (`gnome-shell-extension/`, `assets/icons/`).
- Electron `^43.1.0`; TS `~5.9` (CommonJS, ES2022); Vitest `^4.1`; `dbus-next` `^0.10.2` (already a dependency — do not bump without checking latest).
- **Single app identity** `chat.loft.Loft`; **one combined tray icon only** (spec §8) — never per-service tray/panel icons.
- **Window keying is by title-prefix**, never WM_CLASS: a window belongs to service *S* iff `title === S.displayName || title.startsWith(S.displayName + ' (')`. The daemon owns titles via `formatWindowTitle`.
- **D-Bus object path per service** = `/chat/loft/<DbusName>` where `DbusName = displayName.replace(/\s+/g, '')` (e.g. `WhatsApp`, `Messenger`, `Slack`, `Telegram`, `Element`, `NextCloudTalk`). Bus name `chat.loft.Loft`; per-service interface `chat.loft.Service`; root object `/chat/loft/Loft`.
- **GNOME helper (re)deploy → prompt logout.** GNOME loads new extension JS only at session start. Deploy only when the bundled `version-name` is strictly newer than the installed one (never downgrade a newer EGO build), or when it's missing.
- **Focus/hide is fire-and-forget + non-blocking:** the helper D-Bus call runs in parallel with (never blocks) Electron's native `window.show()/hide()`. A missing/erroring helper must never hang or crash a window action.
- **KWin + KDE system-DND are DEFERRED** (Keith develops on GNOME; unverifiable here). Leave TODO stubs referencing the Rust sources (`src/daemon/kwin.rs`, spec §7 KDE DND). GNOME must be complete.
- **Deferred to a later "3d":** per-service alt-tab MRU ordering (commit `4884e62`), overview `_isOverviewWindow` hiding, dash/dock `get_running` rebuild. In this stage those extension patches are left physically present but **inert** (they key on `get_wm_class()`, which under one app identity never matches a registered title-key), and re-keyed properly in 3d.
- **dbus-next wire facts** (verified in `node_modules/dbus-next`, carried from Stage 3a/3b): hand-rolled served interfaces use the non-decorator `Class.configureMembers({properties, methods, signals})`; getters = properties, class methods = methods, calling a signal-named method emits it. `a{sv}` = plain object of `dbus.Variant`; `av` = `Variant[]`; `ay` = `Buffer`; struct = array; N out-args = array of N. `Properties.GetAll` throws if any declared property getter returns `undefined` — declare an exhaustive, all-defined property set. Client low-level calls: `bus.call(new dbus.Message({ destination, path, interface, member, signature?, body? }))` returns a reply `Message` (`.body` = out-args array) or rejects.
- Every task ends **green** (`npx tsc -p tsconfig.json --noEmit` clean + `npm test` passing) and is committed. Pure-logic tasks are TDD (failing test first). D-Bus/GJS tasks (no vitest surface) are verified **headlessly over the real session bus** (`gdbus`/`busctl`) and/or flagged for Keith's live GUI check — matching the Stage 3a/3b precedent; their "test" steps are those verification commands.

---

## Task 1: `bridge.ts` unit test (the deferred 3b glue test)

**Files:**
- Test: `tests/notifyBridge.test.ts` (create)
- Read-only reference: `src/preload/notify/bridge.ts`

**Interfaces:**
- Consumes: `startNotifyBridge(serviceId: string, deps: { ipc, win, doc }): void` from `src/preload/notify/bridge.ts` (unchanged). `deps.ipc` = `{ send(ch, ...a), on(ch, cb) }`; `deps.win` = page window; `deps.doc` = `Document`.
- Produces: nothing consumed downstream — this task only adds coverage for the one untested glue file (spec §14; flagged as the highest-value 3b follow-up).

**What to prove (the routing that has no test today):** for `messenger`/`telegram`, a page `new win.Notification()` must be **suppressed only** (no `service:notify` IPC — the DOM scanner is the sole source); for `slack`/`whatsapp`/`element`/`talk`, `new win.Notification()` must **relay** to `service:notify`. Plus the daemon→page IPC wiring: `service:dnd`/`service:visibility` reach the sound gate + override, and `service:navigate` (messenger) navigates.

- [ ] **Step 1: Write the failing test**

Model the fakes on `tests/notifyOverride.test.ts`. jsdom is available (Vitest config already uses it for DOM tests). Use a fake `win`/`doc`/`ipc`.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startNotifyBridge } from '../src/preload/notify/bridge';

(globalThis as any).Event = (globalThis as any).Event || class { constructor(public type: string) {} };

function fakeEnv() {
  class Orig {
    static permission = 'granted';
    static requestPermission = vi.fn(async () => 'granted');
  }
  const win: any = {
    Notification: Orig,
    ServiceWorkerRegistration: function () {},
    location: { href: 'https://example.test/', },
    // HTMLMediaElement gate + timers touch these; provide inert stand-ins.
    HTMLMediaElement: function () {},
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
  };
  win.ServiceWorkerRegistration.prototype = { showNotification: vi.fn() };
  win.HTMLMediaElement.prototype = { play: function () { return Promise.resolve(); } };
  const handlers: Record<string, (e: unknown, ...a: unknown[]) => void> = {};
  const ipc = {
    send: vi.fn(),
    on: (ch: string, cb: (e: unknown, ...a: unknown[]) => void) => { handlers[ch] = cb; },
  };
  // Minimal DOM: no body yet so the scanners' waitForBody loop parks (we assert
  // the Notification-override routing, which does not depend on the scanner).
  const doc: any = {
    body: null,
    visibilityState: 'visible',
    hidden: false,
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    querySelector: vi.fn(() => null),
  };
  return { Orig, win, doc, ipc, handlers };
}

describe('startNotifyBridge routing', () => {
  it('relays a page Notification for slack/whatsapp/element/talk', () => {
    for (const id of ['whatsapp', 'slack', 'element', 'talk']) {
      const { win, doc, ipc } = fakeEnv();
      startNotifyBridge(id, { ipc, win, doc });
      new win.Notification('Ann', { body: 'hi', icon: 'https://x/a.png' });
      const notifyCalls = ipc.send.mock.calls.filter((c) => c[0] === 'service:notify');
      expect(notifyCalls.length, `${id} should relay`).toBe(1);
      expect(notifyCalls[0][1]).toMatchObject({ title: 'Ann', body: 'hi' });
    }
  });

  it('suppresses (does NOT relay) a page Notification for messenger/telegram', () => {
    for (const id of ['messenger', 'telegram']) {
      const { win, doc, ipc } = fakeEnv();
      startNotifyBridge(id, { ipc, win, doc });
      new win.Notification('Ann', { body: 'hi', icon: 'https://x/a.png' });
      const notifyCalls = ipc.send.mock.calls.filter((c) => c[0] === 'service:notify');
      expect(notifyCalls.length, `${id} should be suppression-only`).toBe(0);
    }
  });

  it('routes service:navigate (messenger) to a full-URL fallback when no anchor matches', () => {
    const { win, doc, ipc, handlers } = fakeEnv();
    startNotifyBridge('messenger', { ipc, win, doc });
    doc.querySelector = vi.fn(() => null);
    handlers['service:navigate']({}, '/t/abc');
    expect(win.location.href).toBe('https://www.facebook.com/t/abc');
  });

  it('ignores service:navigate for non-messenger services', () => {
    const { win, doc, ipc, handlers } = fakeEnv();
    const before = win.location.href;
    startNotifyBridge('slack', { ipc, win, doc });
    handlers['service:navigate']?.({}, '/x');
    expect(win.location.href).toBe(before);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- notifyBridge`
Expected: initially FAILS only if the fakes are wrong (bridge already exists). If a fake shape is off (e.g. `installNotificationSoundGate` touches an unmocked API), adjust the fake `win` until the two routing assertions drive real `startNotifyBridge` code. The suppression-vs-relay assertions must exercise the real `handleNotice` early-return at `bridge.ts:57`.

- [ ] **Step 3: Make it green**

No production change expected — the test documents existing behavior. If `startNotifyBridge` throws on a missing `win`/`doc` field the test didn't provide, extend the fake (never weaken the assertion). Confirm the relay path resolves `icon` without network (whatsapp path uses `resolveIconUrl`, which is pure).

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- notifyBridge` → PASS (4 tests). Then `npm test` → full suite still green (91 → 95 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/tests/notifyBridge.test.ts
git commit -m "test(notify): cover bridge.ts suppression-vs-relay routing (3b follow-up)"
```

---

## Task 2: `tray_backend` config + `resolveTrayBackend`

**Files:**
- Modify: `src/main/config.ts`
- Create: `src/main/trayBackend.ts`
- Test: `tests/trayBackend.test.ts` (create), `tests/config.test.ts` (extend)

**Interfaces:**
- Produces:
  - `type TrayBackend = 'auto' | 'gnome-panel' | 'sni'` and `LoftConfig.trayBackend?: TrayBackend` (in `config.ts`).
  - `resolveTrayBackend(value: TrayBackend | undefined, env: NodeJS.ProcessEnv): 'gnome-panel' | 'sni'` (in `trayBackend.ts`). Port of `TrayBackend::resolve()` (`src/config.rs:21-33`): `auto`/unset → `gnome-panel` iff `XDG_CURRENT_DESKTOP` has a colon-separated token equal (case-insensitive) to `GNOME`, else `sni`; a concrete value passes through.
  - `isGnome(env): boolean` helper (same GNOME detection) — reused by Tasks 6/9/10.
- Consumes: `LoftConfig` (Task-2 field) by Tasks 7, 9, 10.

- [ ] **Step 1: Write the failing test** — `tests/trayBackend.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { resolveTrayBackend, isGnome } from '../src/main/trayBackend';

describe('resolveTrayBackend', () => {
  it('auto → gnome-panel on GNOME', () => {
    expect(resolveTrayBackend('auto', { XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('gnome-panel');
    expect(resolveTrayBackend(undefined, { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBe('gnome-panel');
    expect(resolveTrayBackend('auto', { XDG_CURRENT_DESKTOP: 'gnome' })).toBe('gnome-panel'); // case-insensitive
  });
  it('auto → sni off GNOME', () => {
    expect(resolveTrayBackend('auto', { XDG_CURRENT_DESKTOP: 'KDE' })).toBe('sni');
    expect(resolveTrayBackend(undefined, {})).toBe('sni');
    expect(resolveTrayBackend('auto', { XDG_CURRENT_DESKTOP: 'GNOME-Classic' })).toBe('sni'); // token match, not substring
  });
  it('concrete values pass through', () => {
    expect(resolveTrayBackend('sni', { XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('sni');
    expect(resolveTrayBackend('gnome-panel', {})).toBe('gnome-panel');
  });
});

describe('isGnome', () => {
  it('matches a GNOME token, not a substring', () => {
    expect(isGnome({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBe(true);
    expect(isGnome({ XDG_CURRENT_DESKTOP: 'GNOME-Classic' })).toBe(false);
    expect(isGnome({})).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- trayBackend` → FAIL ("Cannot find module '../src/main/trayBackend'").

- [ ] **Step 3: Implement** — `src/main/trayBackend.ts`

```ts
export type TrayBackend = 'auto' | 'gnome-panel' | 'sni';

/** True when XDG_CURRENT_DESKTOP contains a colon-separated token equal (case-insensitive) to GNOME. */
export function isGnome(env: NodeJS.ProcessEnv): boolean {
  const desktop = env.XDG_CURRENT_DESKTOP ?? '';
  return desktop.split(':').some((d) => d.toLowerCase() === 'gnome');
}

/** Port of Rust `TrayBackend::resolve()`: auto → gnome-panel on GNOME, else sni. */
export function resolveTrayBackend(
  value: TrayBackend | undefined,
  env: NodeJS.ProcessEnv,
): 'gnome-panel' | 'sni' {
  if (value === 'gnome-panel' || value === 'sni') return value;
  return isGnome(env) ? 'gnome-panel' : 'sni';
}
```

Then extend `src/main/config.ts`: add `import type { TrayBackend } from './trayBackend';`, add `trayBackend?: TrayBackend;` to `LoftConfig`, and in `loadConfig` carry it through when valid:

```ts
// inside loadConfig, after computing `services`:
const trayBackend =
  parsed.trayBackend === 'gnome-panel' || parsed.trayBackend === 'sni' || parsed.trayBackend === 'auto'
    ? parsed.trayBackend
    : undefined;
const base: LoftConfig = { services };
if (parsed.globalDnd === true) base.globalDnd = true;
if (trayBackend) base.trayBackend = trayBackend;
return base;
```

(Replace the current single-line `return parsed.globalDnd === true ? … : …` with the block above. `saveConfig` already serializes the whole object, so it round-trips.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- trayBackend` → PASS. Add a `config.test.ts` case asserting `loadConfig` preserves `trayBackend: 'sni'` and drops a bogus value. `npm test` full suite green.

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/config.ts electron/src/main/trayBackend.ts electron/tests/trayBackend.test.ts electron/tests/config.test.ts
git commit -m "feat(config): tray_backend field + resolveTrayBackend (auto→gnome-panel on GNOME)"
```

---

## Task 3: GNOME Shell helper D-Bus client (`shellHelper.ts`)

**Files:**
- Create: `src/main/gnome/shellHelper.ts`
- Read-only reference: `src/daemon/gnome_shell.rs`, `src/combined_tray/gnome.rs`

**Interfaces:**
- Produces `ShellHelperClient` with fire-and-forget methods (all return `Promise<void>`, never throw to the caller — internal `.catch`):
  - Window mgmt: `setLoftWindows(keys: string[])`, `focusWindow(key: string)`, `hideWindow(key: string)`.
  - Combined panel tray: `registerCombined(iconName: string)`, `unregisterCombined()`, `updateCombinedService(name, displayName, visible, badge, dnd, key)`, `removeCombinedService(name)`.
  - `onHelperAppeared(cb: () => void): void` — fires when `chat.loft.ShellHelper` (re)appears on the bus (suspend/resume resilience; consumed by Task 7).
  - Factory `createShellHelperClient(): ShellHelperClient` (lazily opens one shared `dbus.sessionBus()`).
- Consumes: `dbus-next`. No introspection of the helper (it may be absent) — use low-level `bus.call(new Message(...))`.

**Design notes:**
- `SetLoftWindows(as)` is a **new** helper method (Task 5 adds it to the extension) that replaces the Rust per-service `RegisterService` for window-management identity. The daemon pushes the full current key set on every open/close; keying is backend-independent.
- `FocusWindow`/`HideWindow` take the display-name **key** (was `wm_class` in `gnome_shell.rs:25/41`). `focusWindow`/`hideWindow` do **not** await the reply (fire-and-forget) so a slow/absent helper never blocks `window.show()`.
- Combined methods mirror `src/combined_tray/gnome.rs` (`RegisterCombined`/`UnregisterCombined`/`UpdateCombinedService`/`RemoveCombinedService`); the 6th `UpdateCombinedService` arg (`wm_class` in Rust) now carries the display-name **key**.

- [ ] **Step 1: Implement `src/main/gnome/shellHelper.ts`**

```ts
// dbus-next API used here is verified against node_modules/dbus-next@0.10.2:
// `new dbus.Message({destination,path,interface,member,signature?,body?})`,
// `bus.call(msg): Promise<Message>`, `bus.getProxyObject`, `dbus.Variant`.
import * as dbus from 'dbus-next';

const NAME = 'chat.loft.ShellHelper';
const PATH = '/chat/loft/ShellHelper';
const IFACE = 'chat.loft.ShellHelper';

export interface ShellHelperClient {
  setLoftWindows(keys: string[]): Promise<void>;
  focusWindow(key: string): Promise<void>;
  hideWindow(key: string): Promise<void>;
  registerCombined(iconName: string): Promise<void>;
  unregisterCombined(): Promise<void>;
  updateCombinedService(
    name: string, displayName: string, visible: boolean, badge: number, dnd: boolean, key: string,
  ): Promise<void>;
  removeCombinedService(name: string): Promise<void>;
  onHelperAppeared(cb: () => void): void;
}

export function createShellHelperClient(): ShellHelperClient {
  const bus = dbus.sessionBus();

  // Fire-and-forget low-level call: build a Message, send it, swallow errors
  // (a missing/erroring helper must never crash or hang a window action).
  const call = (member: string, signature: string | undefined, body: unknown[]): Promise<void> => {
    const msg = new dbus.Message({
      destination: NAME, path: PATH, interface: IFACE, member,
      ...(signature ? { signature } : {}),
      ...(body.length ? { body } : {}),
    });
    return bus.call(msg).then(
      () => {},
      (e) => { console.debug(`ShellHelper.${member} failed:`, e?.message ?? e); },
    );
  };

  // Watch chat.loft.ShellHelper (re)appear on the bus (suspend/resume cycles
  // disable/enable the extension, destroying its panel button — Task 7 re-registers).
  const appearedCbs: Array<() => void> = [];
  void (async () => {
    try {
      const dbo = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
      const di = dbo.getInterface('org.freedesktop.DBus') as unknown as {
        on(ev: 'NameOwnerChanged', cb: (name: string, oldOwner: string, newOwner: string) => void): void;
      };
      di.on('NameOwnerChanged', (name, oldOwner, newOwner) => {
        if (name === NAME && oldOwner === '' && newOwner !== '') for (const cb of appearedCbs) cb();
      });
    } catch (e) {
      console.debug('ShellHelper NameOwnerChanged watch unavailable:', e);
    }
  })();

  return {
    setLoftWindows: (keys) => call('SetLoftWindows', 'as', [keys]),
    focusWindow: (key) => call('FocusWindow', 's', [key]),
    hideWindow: (key) => call('HideWindow', 's', [key]),
    registerCombined: (iconName) => call('RegisterCombined', 's', [iconName]),
    unregisterCombined: () => call('UnregisterCombined', undefined, []),
    updateCombinedService: (name, displayName, visible, badge, dnd, key) =>
      call('UpdateCombinedService', 'ssbubs', [name, displayName, visible, badge, dnd, key]),
    removeCombinedService: (name) => call('RemoveCombinedService', 's', [name]),
    onHelperAppeared: (cb) => { appearedCbs.push(cb); },
  };
}
```

> Note the `UpdateCombinedService` signature is `ssbubs` (name, display, visible:b, badge:u, dnd:b, key:s) — matches the extension XML at `extension.js:62-69`. `SetLoftWindows` is `as`.

- [ ] **Step 2: tsc check** — Run: `npx tsc -p tsconfig.json --noEmit` → clean. (`dbus.Message` and `dbus.sessionBus` are typed by `dbus-next`; if the `Message` options type is loose, keep the object literal as written — it matches the runtime contract used by `notifications/dbus.ts`.)

- [ ] **Step 3: Headless bus verification (deferred to the live extension in Task 5)**

There is no vitest surface (pure I/O). Record in the commit body that end-to-end verification happens in Task 5's live checkpoint (the client is exercised by Task 9's wiring against the re-keyed extension). No standalone command here.

- [ ] **Step 4: Commit**

```bash
git add electron/src/main/gnome/shellHelper.ts
git commit -m "feat(gnome): shell-helper D-Bus client (title-keyed focus/hide + SetLoftWindows + combined tray)"
```

---

## Task 4: `chat.loft.Loft` D-Bus service

**Files:**
- Create: `src/main/dbus/loftService.ts`
- Create: `src/main/dbus/names.ts`
- Test: `tests/dbusNames.test.ts` (create)

**Interfaces:**
- Produces:
  - `dbusName(displayName: string): string` (in `names.ts`) = `displayName.replace(/\s+/g, '')`. Used by Tasks 4, 5-consumers, 7.
  - `startLoftDbusService(deps: LoftServiceDeps): Promise<void>` (in `loftService.ts`). Requests bus name `chat.loft.Loft`, exports one `LoftService` object per registry service at `/chat/loft/<DbusName>`, plus a root object at `/chat/loft/Loft`.
  - `LoftServiceDeps`:
    ```ts
    export interface LoftServiceDeps {
      show(id: string): void;
      hide(id: string): void;
      toggle(id: string): void;
      quitService(id: string): void;      // stop one service (destroy its window)
      getStatus(id: string): [boolean, number, boolean]; // (visible, badge, dnd)
      setDnd(id: string, enabled: boolean): void;         // persists + reflects
      setBadgesEnabled(id: string, enabled: boolean): void;
      quitApp(): void;                    // root object Quit()
    }
    ```
- Consumes: `dbus-next`, the service registry (`src/main/registry.ts`) for the id↔displayName↔path mapping.

**Design notes (port of `src/daemon/dbus.rs`):** methods Show/Hide/Toggle/Quit/GetStatus/SetDnd/SetBadgesEnabled per `chat.loft.Service`; `SetShowTitlebar` is dropped (spec §8 — titlebar is structural). `GetStatus` returns `(bub)` = `(visible, badge, dnd)`. Hand-rolled interface via `dbus.interface.Interface` + `configureMembers` (same pattern as `sniItem.ts`). The **helper's combined menu** (Task 5) calls `Toggle`/`SetDnd`/`Quit` on `/chat/loft/<DbusName>`, so these must map to the same main handlers the SNI tray uses.

- [ ] **Step 1: Write the failing test** — `tests/dbusNames.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { dbusName } from '../src/main/dbus/names';

describe('dbusName', () => {
  it('strips all whitespace (matches extension.js displayName.replace(/\\s+/g,""))', () => {
    expect(dbusName('WhatsApp')).toBe('WhatsApp');
    expect(dbusName('NextCloud Talk')).toBe('NextCloudTalk');
    expect(dbusName('Facebook  Messenger')).toBe('FacebookMessenger');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- dbusNames` → FAIL (module missing).

- [ ] **Step 3: Implement `names.ts`**

```ts
/** D-Bus object-path segment for a service (matches the GNOME helper's
 *  `displayName.replace(/\s+/g, '')` — D-Bus names can't contain spaces). */
export function dbusName(displayName: string): string {
  return displayName.replace(/\s+/g, '');
}
```

- [ ] **Step 4: Implement `loftService.ts`**

```ts
import * as dbus from 'dbus-next';
import { SERVICES } from '../registry';
import { dbusName } from './names';

const { Interface, ACCESS_READ } = dbus.interface;
const BUS = 'chat.loft.Loft';
const IFACE = 'chat.loft.Service';

export interface LoftServiceDeps {
  show(id: string): void;
  hide(id: string): void;
  toggle(id: string): void;
  quitService(id: string): void;
  getStatus(id: string): [boolean, number, boolean];
  setDnd(id: string, enabled: boolean): void;
  setBadgesEnabled(id: string, enabled: boolean): void;
  quitApp(): void;
}

/** Per-service object exported at /chat/loft/<DbusName>, interface chat.loft.Service. */
class LoftServiceObject extends Interface {
  constructor(private id: string, private deps: LoftServiceDeps) { super(IFACE); }
  Show(): void { this.deps.show(this.id); }
  Hide(): void { this.deps.hide(this.id); }
  Toggle(): void { this.deps.toggle(this.id); }
  Quit(): void { this.deps.quitService(this.id); }
  GetStatus(): [boolean, number, boolean] { return this.deps.getStatus(this.id); }
  SetDnd(enabled: boolean): void { this.deps.setDnd(this.id, enabled); }
  SetBadgesEnabled(enabled: boolean): void { this.deps.setBadgesEnabled(this.id, enabled); }
}
LoftServiceObject.configureMembers({
  properties: {},
  methods: {
    Show: { inSignature: '', outSignature: '' },
    Hide: { inSignature: '', outSignature: '' },
    Toggle: { inSignature: '', outSignature: '' },
    Quit: { inSignature: '', outSignature: '' },
    GetStatus: { inSignature: '', outSignature: 'bub' },
    SetDnd: { inSignature: 'b', outSignature: '' },
    SetBadgesEnabled: { inSignature: 'b', outSignature: '' },
  },
  signals: {},
});

/** Root app object at /chat/loft/Loft, interface chat.loft.Loft. */
class LoftRootObject extends Interface {
  constructor(private deps: LoftServiceDeps) { super(BUS); }
  Quit(): void { this.deps.quitApp(); }
}
LoftRootObject.configureMembers({
  properties: {},
  methods: { Quit: { inSignature: '', outSignature: '' } },
  signals: {},
});

export async function startLoftDbusService(deps: LoftServiceDeps): Promise<void> {
  const bus = dbus.sessionBus();
  await bus.requestName(BUS, 0);
  bus.export('/chat/loft/Loft', new LoftRootObject(deps));
  for (const svc of SERVICES) {
    bus.export(`/chat/loft/${dbusName(svc.displayName)}`, new LoftServiceObject(svc.id, deps));
  }
}
```

- [ ] **Step 5: Verify tsc + green** — `npx tsc -p tsconfig.json --noEmit` clean; `npm test -- dbusNames` PASS; full `npm test` green.

- [ ] **Step 6: Headless bus verification**

Add an ad-hoc harness note in the commit body (do NOT ship a script). To manually verify during review: a throwaway `node -e` that imports the built `dist/main/dbus/loftService.js`, calls `startLoftDbusService` with stub deps that `console.log`, then from another shell:

```bash
gdbus call --session -d chat.loft.Loft -o /chat/loft/WhatsApp -m chat.loft.Service.GetStatus
# → expect (false, uint32 0, false) from the stub
gdbus call --session -d chat.loft.Loft -o /chat/loft/NextCloudTalk -m chat.loft.Service.SetDnd true
gdbus call --session -d chat.loft.Loft -o /chat/loft/Loft -m chat.loft.Loft.Quit
```

`busctl`/`gdbus` parse a leading `-1` as a flag — never pass negative literals as args here (none needed).

- [ ] **Step 7: Commit**

```bash
git add electron/src/main/dbus/loftService.ts electron/src/main/dbus/names.ts electron/tests/dbusNames.test.ts
git commit -m "feat(dbus): chat.loft.Loft service (per-service paths Show/Hide/Toggle/Quit/GetStatus/SetDnd/SetBadgesEnabled + root)"
```

---

## Task 5: Re-key the GNOME Shell extension onto window titles

**Files:**
- Modify: `gnome-shell-extension/extension.js`
- Modify: `gnome-shell-extension/metadata.json` (`version-name` `1.3` → `1.4`)

**Interfaces:**
- Produces the runtime contract Tasks 3/6/7/9 depend on: helper method `SetLoftWindows(as)`; `FocusWindow(s)`/`HideWindow(s)` keyed by display-name title-prefix; combined-menu callbacks target `chat.loft.Loft` at `/chat/loft/<DbusName>`.
- No unit tests (GJS/GNOME Shell). Verified by Keith's live logout+GUI check — the **spike**: confirm focus/hide targets the right service window by title and that the combined menu works.

**This is a surgical edit set — keep every unchanged block verbatim.** The goal is maximum reuse of working GJS; only identity matching + the callback target change, plus one new method. The deferred overview/dash/MRU patches stay physically present but inert (they key on `get_wm_class()`, which under one app identity never equals a registered title-key).

- [ ] **Step 1: Add `SetLoftWindows` to the D-Bus interface XML**

In the `DBUS_IFACE` template (after the `HideWindow` method block, `extension.js:33-36`), insert:

```js
    <method name="SetLoftWindows">
      <arg name="keys" type="as" direction="in"/>
    </method>
```

- [ ] **Step 2: Init the title-key set in `enable()`**

In `enable()` (near `this._loftWmClasses = new Set();`, `extension.js:102`), add:

```js
        // Display-name title-keys for the single-app model. A window belongs to
        // Loft iff its title === key or startsWith(key + ' ('). Fed by
        // SetLoftWindows (window mgmt, any tray backend) + UpdateCombinedService.
        this._loftTitleKeys = new Set();
```

- [ ] **Step 3: Dispatch + handle `SetLoftWindows`**

In `_onMethodCall`, before the `RegisterService` branch (`extension.js:943`), add:

```js
        if (method === 'SetLoftWindows') {
            const [keys] = params.deep_unpack();
            this._loftTitleKeys = new Set(keys);
            invocation.return_value(null);
            return;
        }
```

- [ ] **Step 4: Add title-matching helpers (module level, near `_isLoftWindow`, `extension.js:87`)**

```js
function _titleMatchesKey(title, key) {
    return title === key || title.startsWith(key + ' (');
}
function _isLoftTitleWindow(meta, titleKeys) {
    const title = meta.get_title?.() ?? '';
    for (const key of titleKeys)
        if (_titleMatchesKey(title, key)) return true;
    return false;
}
function _isMinimizedLoftTitleWindow(win, titleKeys) {
    return win.minimized && _isLoftTitleWindow(win, titleKeys);
}
```

- [ ] **Step 5: Re-key `_findWindow` to title-prefix (the FocusWindow/HideWindow lookup)**

Replace `_findWindow` (`extension.js:893-901`) with:

```js
    _findWindow(key) {
        let fallback = null;
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win.get_window_type() !== Meta.WindowType.NORMAL)
                continue;
            const title = win.get_title?.() ?? '';
            if (_titleMatchesKey(title, key))
                return win;
        }
        // Spike diagnostic: log candidate titles so a keying mismatch is visible
        // in `journalctl --user -f -o cat /usr/bin/gnome-shell` during Keith's test.
        if (!fallback) {
            const titles = global.get_window_actors()
                .map(a => `${a.meta_window.get_wm_class?.() ?? '?'}::${a.meta_window.get_title?.() ?? '?'}`);
            console.log(`Loft: _findWindow('${key}') no match; windows=[${titles.join(', ')}]`);
        }
        return fallback;
    }
```

(FocusWindow/HideWindow handler bodies at `extension.js:907-939` are unchanged — they call `_findWindow` and then `unminimize/activate/overview.hide` or `minimize`.)

- [ ] **Step 6: Re-key the alt-tab hide-minimized filter**

In the `AppSwitcherPopup.prototype._init` override (`extension.js:142-152`), change the filter predicate from `_isMinimizedLoftWindow(w, wmClasses)` to the title-based one, and source the keys from `_loftTitleKeys`. Capture it alongside the existing `const wmClasses = this._loftWmClasses;` (`extension.js:133`):

```js
        const titleKeys = this._loftTitleKeys;
```

then in the `_init` filter body:

```js
                item.cachedWindows = item.cachedWindows.filter(
                    w => !_isMinimizedLoftTitleWindow(w, titleKeys)
                );
```

Leave `_initialSelection` (MRU, deferred) and all other patches untouched — they remain inert.

- [ ] **Step 7: Feed `_loftTitleKeys` from `UpdateCombinedService`**

In `_updateCombinedService` (`extension.js:721-728`) the 6th arg is now the display-name key. After the existing `this._loftWmClasses?.add(wmClass);` line, add:

```js
        if (wmClass) this._loftTitleKeys?.add(wmClass);
```

(Keep the existing `_loftWmClasses` line — harmless; it only feeds the inert deferred patches.)

- [ ] **Step 8: Retarget the daemon-callback bus name to `chat.loft.Loft`**

In `_callDaemonMethod` (`extension.js:601-604`), change:

```js
        const busName = 'chat.loft.Loft';
        const objPath = `/chat/loft/${dbusName}`;
        const iface = 'chat.loft.Service';
```

(Was `chat.loft.${dbusName}`. The per-service value stays in `objPath` only. All 6 call sites — `extension.js:513/521/529/819/833/845` — pass `dbusName = displayName.replace(/\s+/g,'')`, which already equals our `/chat/loft/<DbusName>` segment.)

- [ ] **Step 9: Retarget the combined-icon liveness watch**

In `_registerCombined` (`extension.js:691-700`), change the watched name from `'chat.loft.Tray'` to `'chat.loft.Loft'` (Electron owns `chat.loft.Loft`, not the old `--tray` process). This drops the combined panel button if the Loft app exits.

- [ ] **Step 10: Bump the version so it redeploys**

In `gnome-shell-extension/metadata.json`, set `"version-name": "1.4"`.

- [ ] **Step 11: Sanity-lint the GJS**

Run: `gjs -c "$(cat gnome-shell-extension/extension.js | sed '1,/^import/d;/^import/d')" 2>&1 | head` is unreliable (imports). Instead do a bytewise syntax check with Node's parser as a smoke test only:

Run: `node --check gnome-shell-extension/extension.js`
Expected: no output (GJS-specific globals aren't resolved by `node --check`, but `--check` still catches syntax errors — the real check is Keith's live load). If `node --check` errors on GJS import syntax, skip it and rely on the live test; note that in the commit body.

- [ ] **Step 12: Commit** (do NOT deploy here — deployment is Task 6; live test is a checkpoint after Task 9)

```bash
git add gnome-shell-extension/extension.js gnome-shell-extension/metadata.json
git commit -m "feat(gnome-ext): re-key window mgmt onto title-prefix + SetLoftWindows + chat.loft.Loft callbacks (v1.4)"
```

---

## Task 6: GNOME helper deployment (version-compare, deploy, enable, logout prompt) + asset bundling

**Files:**
- Create: `src/main/gnome/deploy.ts`
- Modify: `package.json` (`copy-assets` script → also stage the helper + symbolic icon into `dist/`)
- Test: `tests/gnomeDeploy.test.ts` (create)

**Interfaces:**
- Produces:
  - `helperVersion(metadataJson: string): number[]` — port of `helper_version` (`src/desktop.rs:438-447`): parse `version-name` `"1.4"` → `[1,4]`; missing/invalid → `[]`.
  - `compareVersions(a: number[], b: number[]): number` — numeric lexicographic (`[1,10] > [1,2]`; shorter-equal-prefix is smaller; `[]` below all).
  - `deployGnomeExtension(deps: DeployDeps): boolean` — returns `true` iff files were (re)written (caller then prompts logout). Port of `deploy_gnome_shell_extension` (`src/desktop.rs:465-530`) + `ensure_combined_icon` symbolic-icon install (`src/desktop.rs:612-621`).
  - `DeployDeps = { dataHome: string; resourcesDir: string; runGnomeExtensionsEnable(): void }`.
- Consumes: bundled helper assets under `resourcesDir` (staged by `copy-assets`).

**Build staging:** the Rust build `include_str!`s the helper; Electron copies it into `dist/` at build time and reads it at runtime. Extend `copy-assets` to stage: `gnome-shell-extension/{metadata.json,extension.js,icons/show-window-symbolic.svg,icons/hide-window-symbolic.svg}` → `dist/assets/gnome-shell-extension/…`, and `assets/icons/loft-symbolic.svg` → `dist/assets/loft-symbolic.svg`. (Repo root is `..` from `electron/`.)

- [ ] **Step 1: Write the failing test** — `tests/gnomeDeploy.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { helperVersion, compareVersions, deployGnomeExtension } from '../src/main/gnome/deploy';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('helperVersion + compareVersions', () => {
  it('parses version-name like the Rust helper_version', () => {
    expect(helperVersion('{"version-name":"1.4"}')).toEqual([1, 4]);
    expect(helperVersion('{"version-name":"2"}')).toEqual([2]);
    expect(helperVersion('{}')).toEqual([]);
    expect(helperVersion('not json')).toEqual([]);
  });
  it('compares numerically per segment, not as strings', () => {
    expect(compareVersions([1, 10], [1, 2]) > 0).toBe(true);   // 1.10 > 1.2
    expect(compareVersions([1, 2], [1, 2]) === 0).toBe(true);
    expect(compareVersions([1, 2], [1, 2, 0]) < 0).toBe(true); // shorter-equal-prefix is smaller
    expect(compareVersions([], [1]) < 0).toBe(true);
  });
});

describe('deployGnomeExtension', () => {
  let dataHome: string, resourcesDir: string;
  const makeResources = (): string => {
    const r = mkdtempSync(join(tmpdir(), 'loft-res-'));
    const ext = join(r, 'gnome-shell-extension', 'icons');
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(r, 'gnome-shell-extension', 'metadata.json'), '{"version-name":"1.4"}');
    writeFileSync(join(r, 'gnome-shell-extension', 'extension.js'), '// v1.4');
    writeFileSync(join(ext, 'show-window-symbolic.svg'), '<svg/>');
    writeFileSync(join(ext, 'hide-window-symbolic.svg'), '<svg/>');
    writeFileSync(join(r, 'loft-symbolic.svg'), '<svg/>');
    return r;
  };
  beforeEach(() => { dataHome = mkdtempSync(join(tmpdir(), 'loft-data-')); resourcesDir = makeResources(); });
  afterEach(() => { rmSync(dataHome, { recursive: true, force: true }); rmSync(resourcesDir, { recursive: true, force: true }); });

  const run = () => { let enabled = false;
    const wrote = deployGnomeExtension({ dataHome, resourcesDir, runGnomeExtensionsEnable: () => { enabled = true; } });
    return { wrote, enabled };
  };

  it('deploys when missing (returns true, enables, writes all files + symbolic icon)', () => {
    const { wrote, enabled } = run();
    expect(wrote).toBe(true);
    expect(enabled).toBe(true);
    const extDir = join(dataHome, 'gnome-shell/extensions/loft-shell-helper@loft.chat');
    expect(existsSync(join(extDir, 'extension.js'))).toBe(true);
    expect(existsSync(join(extDir, 'icons/show-window-symbolic.svg'))).toBe(true);
    expect(existsSync(join(dataHome, 'icons/hicolor/scalable/apps/loft-symbolic.svg'))).toBe(true);
  });

  it('no-ops when installed version >= bundled (returns false)', () => {
    run();
    writeFileSync(
      join(dataHome, 'gnome-shell/extensions/loft-shell-helper@loft.chat/metadata.json'),
      '{"version-name":"1.4"}',
    );
    expect(run().wrote).toBe(false);
  });

  it('never downgrades a newer EGO build', () => {
    run();
    writeFileSync(
      join(dataHome, 'gnome-shell/extensions/loft-shell-helper@loft.chat/metadata.json'),
      '{"version-name":"1.9"}',
    );
    expect(run().wrote).toBe(false);
  });

  it('redeploys when installed is older', () => {
    const extDir = join(dataHome, 'gnome-shell/extensions/loft-shell-helper@loft.chat');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'metadata.json'), '{"version-name":"1.3"}');
    expect(run().wrote).toBe(true);
    expect(readFileSync(join(extDir, 'extension.js'), 'utf8')).toBe('// v1.4');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- gnomeDeploy` → FAIL (module missing).

- [ ] **Step 3: Implement `src/main/gnome/deploy.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const UUID = 'loft-shell-helper@loft.chat';

export function helperVersion(metadataJson: string): number[] {
  try {
    const v = JSON.parse(metadataJson)?.['version-name'];
    if (typeof v !== 'string') return [];
    return v.split('.').map((p) => Number.parseInt(p, 10)).filter((n) => Number.isInteger(n));
  } catch { return []; }
}

/** Numeric lexicographic compare (Rust Vec<u32> Ord): element-wise, then length. */
export function compareVersions(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -1, y = b[i] ?? -1; // shorter-equal-prefix is smaller
    if (x !== y) return x - y;
  }
  return 0;
}

export interface DeployDeps {
  dataHome: string;        // $XDG_DATA_HOME or ~/.local/share
  resourcesDir: string;    // where copy-assets staged the helper (dist/assets)
  runGnomeExtensionsEnable(): void; // best-effort `gnome-extensions enable <UUID>`
}

/** Deploy the bundled helper if missing or strictly newer than installed. Returns true iff (re)written. */
export function deployGnomeExtension(deps: DeployDeps): boolean {
  const extSrc = join(deps.resourcesDir, 'gnome-shell-extension');
  const extDir = join(deps.dataHome, 'gnome-shell', 'extensions', UUID);

  const bundled = helperVersion(readFileSync(join(extSrc, 'metadata.json'), 'utf8'));
  const installedMetaPath = join(extDir, 'metadata.json');
  if (existsSync(installedMetaPath)) {
    const installed = helperVersion(readFileSync(installedMetaPath, 'utf8'));
    if (compareVersions(installed, bundled) >= 0) return false; // up-to-date / newer EGO build
  }

  mkdirSync(join(extDir, 'icons'), { recursive: true });
  copyFileSync(join(extSrc, 'metadata.json'), join(extDir, 'metadata.json'));
  copyFileSync(join(extSrc, 'extension.js'), join(extDir, 'extension.js'));
  copyFileSync(join(extSrc, 'icons', 'show-window-symbolic.svg'), join(extDir, 'icons', 'show-window-symbolic.svg'));
  copyFileSync(join(extSrc, 'icons', 'hide-window-symbolic.svg'), join(extDir, 'icons', 'hide-window-symbolic.svg'));

  // Combined panel icon is a themed St.Icon({icon_name:'loft-symbolic'}) → install it
  // into the icon theme (port of ensure_combined_icon, src/desktop.rs:612-621).
  const iconThemeDir = join(deps.dataHome, 'icons', 'hicolor', 'scalable', 'apps');
  mkdirSync(iconThemeDir, { recursive: true });
  copyFileSync(join(deps.resourcesDir, 'loft-symbolic.svg'), join(iconThemeDir, 'loft-symbolic.svg'));

  deps.runGnomeExtensionsEnable();
  return true;
}
```

- [ ] **Step 4: Update `package.json` `copy-assets`**

Append to the `copy-assets` script (single line; `..` = repo root from `electron/`):

```
&& mkdir -p dist/assets/gnome-shell-extension/icons && cp ../gnome-shell-extension/metadata.json ../gnome-shell-extension/extension.js dist/assets/gnome-shell-extension/ && cp ../gnome-shell-extension/icons/show-window-symbolic.svg ../gnome-shell-extension/icons/hide-window-symbolic.svg dist/assets/gnome-shell-extension/icons/ && cp ../assets/icons/loft-symbolic.svg dist/assets/loft-symbolic.svg
```

- [ ] **Step 5: Run to verify it passes** — `npm test -- gnomeDeploy` → PASS (all cases). `npm run build` → succeeds and `dist/assets/gnome-shell-extension/extension.js` + `dist/assets/loft-symbolic.svg` exist (`ls dist/assets/gnome-shell-extension dist/assets/loft-symbolic.svg`). Full `npm test` green.

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/gnome/deploy.ts electron/package.json electron/tests/gnomeDeploy.test.ts
git commit -m "feat(gnome): deploy helper (version-compare, never-downgrade) + stage helper/symbolic assets"
```

---

## Task 7: GNOME-panel tray backend + backend dispatch

**Files:**
- Create: `src/main/tray/gnomePanel.ts`
- Create: `src/main/tray/backend.ts` (dispatch)
- Read-only reference: `src/combined_tray/gnome.rs`, `src/main/tray/index.ts`, `src/main/tray/model.ts`

**Interfaces:**
- Produces:
  - `startGnomePanelTray(deps: TrayDeps, helper: ShellHelperClient): Promise<Tray>` — same `Tray` return shape as `startTray` (`addService/setBadge/setRunning/setVisible/setDnd/setGlobalDnd`) so `backend.ts` can return either. Drives the shared `TrayModel`; on model change diffs services and pushes `updateCombinedService`/`removeCombinedService`; registers the combined icon with the `[0,2,4,8,16]s` backoff; re-registers on `helper.onHelperAppeared`.
  - `startTrayBackend(deps: TrayDeps, opts: { backend: 'gnome-panel' | 'sni'; helper: ShellHelperClient }): Promise<Tray>` (in `backend.ts`) — picks `startGnomePanelTray` or the existing `startTray`.
- Consumes: `TrayModel` (`./model`), `TrayDeps`/`Tray`/`TrayServiceSeed` (`./index`), `ShellHelperClient` (Task 3), `dbusName` (Task 4).

**Design notes (port of `run_combined_gnome_panel`, `src/combined_tray/gnome.rs:97-210`):**
- The GNOME-panel **menu is owned by the extension** (`_rebuildCombinedMenu`); its Show/Hide/DND/Quit rows call back via `chat.loft.Loft` (Task 4/5). So `startGnomePanelTray` does **not** use `deps.onToggleService`/`onLaunchService`/`onQuitService`/`onToggleDnd` for the panel menu — those flow through the D-Bus service. It only **pushes state** from the model.
- Model→panel: on each `model.onChange`, compute the current per-service snapshot (`displayName`, `visible`, `badge`, `dnd`, key=`displayName`) and, comparing to the previous snapshot, call `updateCombinedService` only for changed services and `removeCombinedService` for dropped ones — the flash-avoidance diff from `gnome.rs:186-199`. The combined icon's own aggregate dot/dash is computed inside the extension (`_updateCombinedBadges`).
- Registration + resilience: `registerCombined('loft-symbolic')` with the backoff schedule; on `onHelperAppeared`, re-`registerCombined` then re-push every service (parity with `monitor_shell_helper_restart` + `run_combined_gnome_panel`'s restart handling). Unlike Rust there is no separate process and no empty-timeout self-exit — the backend lives for the app's lifetime.

- [ ] **Step 1: Write a focused test for the snapshot-diff helper** — `tests/gnomePanelDiff.test.ts`

Extract the diff as a pure function so it's testable without D-Bus:

```ts
import { describe, it, expect } from 'vitest';
import { diffPanelServices, type PanelSnapshot } from '../src/main/tray/gnomePanel';

const snap = (o: Partial<PanelSnapshot> & { id: string }): PanelSnapshot =>
  ({ displayName: o.id, visible: false, badge: 0, dnd: false, ...o });

describe('diffPanelServices', () => {
  it('emits updates for new + changed services and removes dropped ones', () => {
    const prev = new Map<string, PanelSnapshot>([
      ['a', snap({ id: 'a', badge: 1 })],
      ['b', snap({ id: 'b' })],
    ]);
    const cur = new Map<string, PanelSnapshot>([
      ['a', snap({ id: 'a', badge: 2 })], // changed
      ['c', snap({ id: 'c' })],           // new
    ]);
    const { updates, removals } = diffPanelServices(prev, cur);
    expect(updates.map((u) => u.id).sort()).toEqual(['a', 'c']);
    expect(removals.sort()).toEqual(['b']);
  });
  it('emits nothing when unchanged', () => {
    const m = new Map<string, PanelSnapshot>([['a', snap({ id: 'a', badge: 3, dnd: true })]]);
    const { updates, removals } = diffPanelServices(m, new Map(m));
    expect(updates).toEqual([]);
    expect(removals).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- gnomePanelDiff` → FAIL (module missing).

- [ ] **Step 3: Implement `src/main/tray/gnomePanel.ts`**

```ts
import { TrayModel } from './model';
import type { Tray, TrayDeps } from './index';
import type { ShellHelperClient } from '../gnome/shellHelper';

export interface PanelSnapshot {
  id: string;
  displayName: string;
  visible: boolean;
  badge: number;
  dnd: boolean;
}

/** Pure diff of previous vs current per-service snapshots (flash-avoidance, gnome.rs:186-199). */
export function diffPanelServices(
  prev: Map<string, PanelSnapshot>,
  cur: Map<string, PanelSnapshot>,
): { updates: PanelSnapshot[]; removals: string[] } {
  const updates: PanelSnapshot[] = [];
  const removals: string[] = [];
  for (const id of prev.keys()) if (!cur.has(id)) removals.push(id);
  for (const [id, s] of cur) {
    const p = prev.get(id);
    if (!p || p.displayName !== s.displayName || p.visible !== s.visible || p.badge !== s.badge || p.dnd !== s.dnd)
      updates.push(s);
  }
  return { updates, removals };
}

export async function startGnomePanelTray(deps: TrayDeps, helper: ShellHelperClient): Promise<Tray> {
  const model = new TrayModel();
  model.setGlobalDnd(deps.globalDnd);
  for (const s of deps.configuredServices)
    model.addService({ id: s.id, displayName: s.displayName, badge: 0, dnd: s.dnd, visible: s.visible, running: s.running });

  // Snapshot of only-running services (parity: the combined tray lists running services).
  let prev = new Map<string, PanelSnapshot>();
  const snapshot = (): Map<string, PanelSnapshot> => {
    const mm = model.menuModel();
    const m = new Map<string, PanelSnapshot>();
    for (const r of mm.running) {
      m.set(r.id, { id: r.id, displayName: r.label, visible: r.visible, badge: 0, dnd: r.dnd });
    }
    // menuModel doesn't carry raw badge; read it from the model's per-service view.
    for (const s of model.snapshotServices()) if (m.has(s.id)) m.get(s.id)!.badge = s.badge;
    return m;
  };

  const pushAll = (): void => {
    for (const s of prev.values())
      void helper.updateCombinedService(s.id, s.displayName, s.visible, s.badge, s.dnd, s.displayName);
  };

  const refresh = (): void => {
    const cur = snapshot();
    const { updates, removals } = diffPanelServices(prev, cur);
    for (const id of removals) void helper.removeCombinedService(id);
    for (const u of updates) void helper.updateCombinedService(u.id, u.displayName, u.visible, u.badge, u.dnd, u.displayName);
    prev = cur;
  };

  // Register the combined icon once. The client is fire-and-forget (never
  // rejects), so login/restart races are handled by onHelperAppeared below
  // (re-register whenever chat.loft.ShellHelper (re)appears) rather than a
  // backoff — this replaces gnome.rs's [0,2,4,8,16]s retry, whose purpose was
  // to await a register() that could fail; ours can't.
  await helper.registerCombined('loft-symbolic');
  prev = snapshot();
  pushAll();
  model.onChange = refresh;

  // Suspend/resume: extension disable()/enable() destroys the panel button;
  // a helper restart re-owns the name → re-register + re-push everything
  // (parity with monitor_shell_helper_restart, mod.rs:1307-1383).
  helper.onHelperAppeared(() => {
    void helper.registerCombined('loft-symbolic');
    prev = snapshot();
    pushAll();
  });

  return {
    addService: (seed) => model.addService({ id: seed.id, displayName: seed.displayName, badge: 0, dnd: seed.dnd, visible: false, running: false }),
    setBadge: (id, n) => model.setBadge(id, n),
    setRunning: (id, running) => model.setRunning(id, running),
    setVisible: (id, visible) => model.setVisible(id, visible),
    setDnd: (id, enabled) => model.setDnd(id, enabled),
    setGlobalDnd: (enabled) => model.setGlobalDnd(enabled),
  };
}
```

- [ ] **Step 4: Add `TrayModel.snapshotServices()`**

The panel backend needs raw per-service `{id, badge}` (menuModel hides raw badge). Add to `src/main/tray/model.ts`:

```ts
  /** Read-only per-service snapshot (id + raw badge) for the GNOME-panel backend. */
  snapshotServices(): ReadonlyArray<{ id: string; badge: number }> {
    return this.services.map((s) => ({ id: s.id, badge: s.badge }));
  }
```

- [ ] **Step 5: Implement `src/main/tray/backend.ts`**

```ts
import { startTray } from './index';
import { startGnomePanelTray } from './gnomePanel';
import type { Tray, TrayDeps } from './index';
import type { ShellHelperClient } from '../gnome/shellHelper';

export async function startTrayBackend(
  deps: TrayDeps,
  opts: { backend: 'gnome-panel' | 'sni'; helper: ShellHelperClient },
): Promise<Tray> {
  return opts.backend === 'gnome-panel'
    ? startGnomePanelTray(deps, opts.helper)
    : startTray(deps);
}
```

- [ ] **Step 6: Run to verify it passes** — `npm test -- gnomePanelDiff` PASS; `npx tsc -p tsconfig.json --noEmit` clean; full `npm test` green.

- [ ] **Step 7: Commit**

```bash
git add electron/src/main/tray/gnomePanel.ts electron/src/main/tray/backend.ts electron/src/main/tray/model.ts electron/tests/gnomePanelDiff.test.ts
git commit -m "feat(tray): GNOME-panel backend (port run_combined_gnome_panel) + SNI/panel dispatch"
```

---

## Task 8: `background_status.rs` port (GNOME Background-Apps status line)

**Files:**
- Create: `src/main/gnome/backgroundStatus.ts`
- Test: `tests/backgroundStatus.test.ts` (create)

**Interfaces:**
- Produces:
  - `formatAggregate(services: ReadonlyArray<{ displayName: string; badge: number }>): string` — verbatim port of `format_aggregate` (`src/daemon/background_status.rs:179-209`): 0 → `""`; running-no-unread → `"1 service running"`/`"N services running"`; exactly one unread → `"<Name>: <N> unread"`; multiple → `"<Total> unread (<Name> <N>, …)"`.
  - `setBackgroundStatus(message: string): Promise<void>` — calls `org.freedesktop.portal.Background.SetStatus({message})` via a fire-and-forget low-level `bus.call`. Empty string clears the sub-text.
  - `startBackgroundStatus(deps: { collect(): ReadonlyArray<{ displayName: string; badge: number }> }): { refresh(): void }` — debounced refresh that recomputes + pushes; single-app model means we enumerate our own in-process running services (no cross-daemon D-Bus, unlike Rust `collect_aggregate`).
- Consumes: `dbus-next`.

- [ ] **Step 1: Write the failing test** — `tests/backgroundStatus.test.ts` (port the Rust unit tests, `background_status.rs:238-285`)

```ts
import { describe, it, expect } from 'vitest';
import { formatAggregate } from '../src/main/gnome/backgroundStatus';

const s = (arr: Array<[string, number]>) => arr.map(([displayName, badge]) => ({ displayName, badge }));

describe('formatAggregate', () => {
  it('empty → ""', () => expect(formatAggregate([])).toBe(''));
  it('one running, no unread', () => expect(formatAggregate(s([['WhatsApp', 0]]))).toBe('1 service running'));
  it('many running, no unread', () => expect(formatAggregate(s([['WhatsApp', 0], ['Slack', 0]]))).toBe('2 services running'));
  it('exactly one unread', () => expect(formatAggregate(s([['WhatsApp', 4], ['Slack', 0]]))).toBe('WhatsApp: 4 unread'));
  it('multiple unread', () => expect(formatAggregate(s([['WhatsApp', 4], ['Slack', 3]]))).toBe('7 unread (WhatsApp 4, Slack 3)'));
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- backgroundStatus` → FAIL (module missing).

- [ ] **Step 3: Implement `src/main/gnome/backgroundStatus.ts`**

```ts
import * as dbus from 'dbus-next';

const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const PORTAL_IFACE = 'org.freedesktop.portal.Background';

export interface ServiceBadge { displayName: string; badge: number; }

/** Port of format_aggregate (background_status.rs:179-209). */
export function formatAggregate(services: ReadonlyArray<ServiceBadge>): string {
  const count = services.length;
  if (count === 0) return '';
  const unread = services.filter((x) => x.badge > 0);
  if (unread.length === 0) return count === 1 ? '1 service running' : `${count} services running`;
  if (unread.length === 1) return `${unread[0].displayName}: ${unread[0].badge} unread`;
  const total = unread.reduce((n, x) => n + x.badge, 0);
  const parts = unread.map((x) => `${x.displayName} ${x.badge}`).join(', ');
  return `${total} unread (${parts})`;
}

let bus: dbus.MessageBus | undefined;
export async function setBackgroundStatus(message: string): Promise<void> {
  try {
    bus ??= dbus.sessionBus();
    const msg = new dbus.Message({
      destination: PORTAL, path: PORTAL_PATH, interface: PORTAL_IFACE, member: 'SetStatus',
      signature: 'a{sv}', body: [{ message: new dbus.Variant('s', message) }],
    });
    await bus.call(msg);
  } catch (e) {
    console.debug('SetStatus (Background portal) failed:', (e as Error)?.message ?? e);
  }
}

export function startBackgroundStatus(deps: { collect(): ReadonlyArray<ServiceBadge> }): { refresh(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const refresh = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void setBackgroundStatus(formatAggregate(deps.collect())); }, 500);
  };
  return { refresh };
}
```

- [ ] **Step 4: Run to verify it passes** — `npm test -- backgroundStatus` PASS; tsc clean; full `npm test` green.

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/gnome/backgroundStatus.ts electron/tests/backgroundStatus.test.ts
git commit -m "feat(gnome): background-apps status line (port format_aggregate + portal SetStatus)"
```

---

## Task 9: Main wiring — GNOME window management + D-Bus service startup

**Files:**
- Modify: `src/main/index.ts`
- Read-only reference: `src/daemon/mod.rs:296-304` (startup deploy), `:402-449` (focus/hide parallelism), `src/main/serviceWindow.ts`

**Interfaces:**
- Consumes: `createShellHelperClient` (Task 3), `startLoftDbusService` + `LoftServiceDeps` (Task 4), `deployGnomeExtension` (Task 6), `isGnome` (Task 2), `dbusName` (Task 4).
- Produces: a `windowKeys(): string[]` set-pusher + focus/hide-via-helper wiring consumed by Task 10's tray/status refreshers (via the shared `windows` map). No new exported module.

**Behavior to add (GNOME-gated where noted):**
1. **Startup deploy + logout prompt** (GNOME only): after `app.whenReady`, call `deployGnomeExtension({ dataHome, resourcesDir: join(__dirname, '..', 'assets'), runGnomeExtensionsEnable })`. If it returns `true`, show an Electron `dialog.showMessageBox` (port of the relogin prompt, `daemon/mod.rs:243-282` message text). Dedup within the process (only prompt once).
2. **D-Bus service**: `startLoftDbusService(loftDeps)` mapping to the existing `openService/toggleService/quitService/setServiceDnd` handlers + a new `getStatus`. Wrap in try/catch (a busy name must not crash startup).
3. **Helper client + focus/hide**: create `helper = createShellHelperClient()`. On `openService` show and on `sw.hide()`/close, call `helper.focusWindow(displayName)` / `helper.hideWindow(displayName)` **in parallel** with the native `window.show()/hide()` (fire-and-forget; do not await). Push the current key set via `helper.setLoftWindows(windowKeys())` whenever a service opens or its window is destroyed.
4. **`SetBadgesEnabled` plumbing**: persist `config.services[id].badgesEnabled` and gate the badge push in the `service:badge` IPC handler.

- [ ] **Step 1: Imports + helper/state**

At the top of `index.ts` add:

```ts
import { dialog } from 'electron';
import { createShellHelperClient } from './gnome/shellHelper';
import { startLoftDbusService, type LoftServiceDeps } from './dbus/loftService';
import { deployGnomeExtension } from './gnome/deploy';
import { isGnome } from './trayBackend';
```

(`getService`, `saveConfig`, `configPath`, `join`, `dataHome` are already imported/defined in `index.ts` — reuse them; do not re-import.)

Add module state near the other `let` decls:

```ts
const gnome = isGnome(process.env);
const helper = gnome ? createShellHelperClient() : undefined;
```

- [ ] **Step 2: Window-key pusher + focus/hide integration**

Add a helper that lists open-service display-name keys and pushes them:

```ts
function windowKeys(): string[] {
  return [...windows.values()].map((sw) => sw.def.displayName);
}
function syncLoftWindows(): void { helper?.setLoftWindows(windowKeys()); }
```

In `openService`, after `windows.set(def.id, sw);`, add `syncLoftWindows();` and `helper?.focusWindow(def.displayName);` (parallel to the `sw.show()` that already runs inside `createServiceWindow`/`existing.show()`). In `toggleService` when showing, also `helper?.focusWindow(def.displayName)`; when hiding (`sw.hide()`), `helper?.hideWindow(sw.def.displayName)`. In `quitService`, after `windows.delete(id);`, add `syncLoftWindows();`.

> Rationale (`daemon/mod.rs:402-449`): the helper focus/hide runs concurrently with the native window action and never blocks it — matching the Rust broadcast fan-out. `focusWindow`/`hideWindow` are fire-and-forget (Task 3).

- [ ] **Step 3: `getStatus` + `SetBadgesEnabled` + D-Bus service startup**

Add inside the single-instance owner branch, in `app.whenReady().then(...)` after the notifications block:

```ts
    // chat.loft.Loft D-Bus service (parity/scripting; also the target of the
    // GNOME-panel tray menu callbacks).
    try {
      const loftDeps: LoftServiceDeps = {
        show: (id) => { const d = getService(id); if (d) openService(d, false); },
        hide: (id) => windows.get(id)?.hide(),
        toggle: (id) => toggleService(id),
        quitService: (id) => quitService(id),
        getStatus: (id) => {
          const sw = windows.get(id);
          const visible = sw?.window.isVisible() ?? false;
          const badge = currentBadge.get(id) ?? 0;
          const dnd = config.services[id]?.dnd ?? false;
          return [visible, badge, dnd];
        },
        setDnd: (id, enabled) => { setServiceDnd(id, enabled); tray?.setDnd(id, enabled); notifications?.setServiceDnd(id, enabled); },
        setBadgesEnabled: (id, enabled) => {
          config.services[id] = { ...config.services[id], badgesEnabled: enabled };
          saveConfig(configPath(), config);
        },
        quitApp: () => { quitting = true; app.quit(); },
      };
      await startLoftDbusService(loftDeps);
    } catch (err) {
      console.error('Failed to start chat.loft.Loft D-Bus service:', err);
    }
```

Add a `const currentBadge = new Map<string, number>();` near `windows`, and in the `service:badge` IPC handler set `currentBadge.set(sw.def.id, payload.count);` and skip pushing to tray/title when `config.services[sw.def.id]?.badgesEnabled === false`. Add `badgesEnabled?: boolean;` to `ServiceConfig` in `config.ts`.

- [ ] **Step 4: Startup deploy + logout prompt (GNOME only)**

Add near the top of `app.whenReady().then(...)` (before opening the first window is fine):

```ts
    if (gnome) {
      try {
        const wrote = deployGnomeExtension({
          dataHome,
          resourcesDir: join(__dirname, '..', 'assets'),
          runGnomeExtensionsEnable: () => {
            try { require('node:child_process').execFileSync('gnome-extensions', ['enable', 'loft-shell-helper@loft.chat']); }
            catch { /* CLI absent or already enabled — best effort */ }
          },
        });
        if (wrote) {
          void dialog.showMessageBox({
            type: 'info',
            title: 'Log out to finish updating Loft',
            message: 'Log out to finish updating Loft',
            detail: 'Loft updated its GNOME integration. Log out and back in for window management (show/hide, panel icons) to work correctly.',
            buttons: ['Got it'],
          });
        }
      } catch (err) {
        console.error('GNOME helper deploy failed:', err);
      }
    }
```

- [ ] **Step 5: Verify build + headless bus**

Run: `npm run build` → clean. `npx tsc -p tsconfig.json --noEmit` clean; `npm test` green. Then a headless smoke test (no GUI needed): `env -u ELECTRON_RUN_AS_NODE electron . --service=whatsapp &` then `gdbus call --session -d chat.loft.Loft -o /chat/loft/WhatsApp -m chat.loft.Service.GetStatus` → expect `(true, uint32 0, false)`; `gdbus call --session -d chat.loft.Loft -o /chat/loft/WhatsApp -m chat.loft.Service.Hide` → window hides. Kill the app.

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/index.ts electron/src/main/config.ts
git commit -m "feat(gnome): wire helper focus/hide + SetLoftWindows + chat.loft.Loft service + deploy/logout prompt"
```

---

## Task 10: Main wiring — tray backend selection + background status

**Files:**
- Modify: `src/main/index.ts`
- Read-only reference: `src/main/tray/backend.ts` (Task 7), `src/main/gnome/backgroundStatus.ts` (Task 8)

**Interfaces:**
- Consumes: `startTrayBackend` (Task 7), `resolveTrayBackend` (Task 2), `startBackgroundStatus` (Task 8), `helper` (Task 9).

**Behavior:**
1. Replace the direct `startTray(...)` call with `startTrayBackend(deps, { backend, helper })` where `backend = resolveTrayBackend(config.trayBackend, process.env)`. On non-GNOME (or `helper` undefined) `backend` resolves to `sni`; guard so `gnome-panel` is only used when `helper` exists.
2. Wire `startBackgroundStatus` (GNOME only): `collect()` returns running services' `{displayName, badge}` from `windows` + `currentBadge`; call `.refresh()` whenever a badge changes or a service opens/closes.

- [ ] **Step 1: Tray backend selection**

Replace the `tray = await startTray({...})` call. Build the same `deps` object, then:

```ts
      const backend = helper ? resolveTrayBackend(config.trayBackend, process.env) : 'sni';
      tray = await startTrayBackend(deps, { backend, helper: helper! });
```

(When `helper` is undefined, `backend` is forced to `'sni'` and `startTrayBackend` ignores the helper.) Add imports:

```ts
import { startTrayBackend } from './tray/backend';
import { resolveTrayBackend } from './trayBackend';
```

Keep the SNI `startTray` import only inside `backend.ts`; remove the now-unused direct `startTray` import from `index.ts` if present.

- [ ] **Step 2: Background status**

After the tray + notifications blocks:

```ts
    let bgStatus: { refresh(): void } | undefined;
    if (gnome) {
      bgStatus = startBackgroundStatus({
        collect: () => [...windows.values()].map((sw) => ({
          displayName: sw.def.displayName,
          badge: currentBadge.get(sw.def.id) ?? 0,
        })),
      });
      bgStatus.refresh();
    }
```

Import `import { startBackgroundStatus } from './gnome/backgroundStatus';`. Call `bgStatus?.refresh()` at the end of `openService`, `quitService`, and the `service:badge` handler.

- [ ] **Step 3: Verify build + full green**

Run: `npm run build` clean; `npx tsc -p tsconfig.json --noEmit` clean; `npm test` green.

- [ ] **Step 4: Commit**

```bash
git add electron/src/main/index.ts
git commit -m "feat(gnome): select tray backend (auto→gnome-panel) + wire background-apps status"
```

---

## Live verification checkpoint (Keith, after Task 10)

This is the **spike** for the title-keying + the GNOME-panel default (deferred features excluded). After building, Keith must:

1. **Deploy + logout:** run the app once (`npm run whatsapp`), confirm the "Log out to finish updating Loft" dialog appears, log out and back in (GNOME loads the v1.4 extension only at session start).
2. **Tray:** with `trayBackend` unset (→ `gnome-panel`), confirm a single Loft panel button appears with the correct unread dot / DND dash, and its menu lists running services with working Show/Hide, DND, and Quit (these route through `chat.loft.Loft`). Then set `trayBackend: "sni"` in `~/.config/loft/config.json`, relaunch, confirm the SNI tray still works (Stage 3a path).
3. **Focus/hide:** open two services (`whatsapp`, `messenger`), hide one to tray, click its panel-menu Show → the **correct** window focuses (title-keying works). Check `journalctl --user -f -o cat` for any `Loft: _findWindow('…') no match` lines (keying mismatch signal).
4. **Alt-tab:** minimize a service window (not close-to-tray) → confirm it's hidden from alt-tab; the others remain.
5. **Background apps:** open GNOME Settings → Apps → check "Loft" shows a status line (e.g. "1 service running" / "WhatsApp: 3 unread").
6. **Regression:** calls, notifications, DND, badges still work (Stage 3a/3b).

If title-keying fails to target windows in step 3, the diagnostic log identifies whether `get_title()` returns our titles under Keith's Wayland/GNOME — pivot to the alternate keying (app-id + title) noted in the design memory before proceeding.

---

## Deferred / TODO stubs (leave in-source, GNOME-complete otherwise)

- `src/main/gnome/kwin.ts` — create a stub file with a top-of-file comment: *"KDE window focus/hide via KWin scripting — DEFERRED (Keith develops on GNOME; unverifiable here). Port `src/daemon/kwin.rs` (loadScript/run/unloadScript by window identity, re-keyed to title). Wire as a fallback when the GNOME helper call errors, mirroring `daemon/mod.rs:402-449`."* No exports needed yet.
- KDE system-DND — add a one-line comment in `src/main/notifications/systemDnd.ts` (already has a KDE TODO from 3b): reference spec §7 (Plasma notification inhibition) as the remaining follow-up.
- 3d (later spec/plan): re-key + re-enable the inert extension patches — per-service alt-tab MRU ordering (commit `4884e62`), overview `_isOverviewWindow`, dash/dock `get_running` rebuild — onto title-keying.

---

## Self-Review (run before handing off)

**Spec coverage (§ mapping):**
- §5.1 GNOME helper focus/hide + alt-tab hide-minimized → Tasks 3, 5, 9 (MRU/overview/dash deferred per Keith's decision → stubs).
- §5.1 (re)deploy-if-newer + logout prompt + suspend/resume re-register → Tasks 6, 7 (`onHelperAppeared`), 9.
- §7 background status → Task 8; KDE system-DND → deferred stub.
- §8 `chat.loft.Loft` D-Bus (per-service paths + root, `SetShowTitlebar` dropped) → Task 4; GNOME-panel backend + `tray_backend` auto→gnome-panel → Tasks 2, 7, 10; SNI kept → `backend.ts`.
- §14 bridge.ts test → Task 1.
- KWin (§5.1) / KDE DND (§7) → deferred stubs (Keith's decision).

**Placeholder scan:** every code step contains full code or an exact command; no "TBD"/"handle errors"/"similar to". ✔

**Type consistency:** `ShellHelperClient` method names (`setLoftWindows`/`focusWindow`/`hideWindow`/`registerCombined`/`updateCombinedService`/`removeCombinedService`/`onHelperAppeared`) are identical across Tasks 3, 7, 9. `dbusName` (Task 4) is the single source for path segments used in Tasks 4, 5, 7. `PanelSnapshot`/`diffPanelServices` names match across Task 7 step 1/3. `TrayModel.snapshotServices()` added in Task 7 step 4 and consumed in step 3. `LoftServiceDeps` shape identical in Tasks 4 and 9. `formatAggregate`/`ServiceBadge` match across Task 8. `resolveTrayBackend`/`isGnome` signatures match across Tasks 2, 9, 10.

**Ordering:** client(3) & service(4) precede their consumers (7,9,10); extension(5) & deploy(6) precede the live checkpoint; tray backend(7) precedes selection(10); bg-status(8) precedes wiring(10). ✔
