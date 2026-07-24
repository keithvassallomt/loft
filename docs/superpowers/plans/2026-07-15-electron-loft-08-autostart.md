# Autostart: derived + XDG portal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Open on startup" work on its own — autostart is derived from the per-service flags, the global "Start at login" toggle is removed, and the Flatpak write path goes through the XDG Background portal.

**Architecture:** A pure `wantsAutostart(services)` derives the desired state from config. `syncAutostart(enabled, opts)` is a facade that dispatches on `isFlatpak()`: portal under Flatpak, existing direct `.desktop` write natively. Reading state stays `existsSync()` in both cases (the autostart dir is bind-mounted into the sandbox), so nothing new is persisted and both backends are judged by the same evidence — the file on disk.

**Tech Stack:** TypeScript, Electron 43 main process, `dbus-next@0.10.2`, Vitest, Svelte 5 (runes).

**Spec:** `docs/superpowers/specs/2026-07-15-electron-loft-08-autostart-design.md` — read §1a before touching any path helper.

## Global Constraints

- **`autostartDir()` and `applicationsDir()` are CORRECT. Do not "fix" them.** Flatpak bind-mounts the host `~/.config/autostart` and `~/.local/share/applications` over the sandbox's `$XDG_CONFIG_HOME`/`$XDG_DATA_HOME` subpaths. This was proven by probe; spec §1a records it.
- **No new config key.** `startAtLogin` was never persisted and must not become persisted. Desired state derives from `config.services[*].openOnStartup`; actual state is read with `isAutostartEnabled()`.
- The rule, exactly: `autostart entry exists ⟺ some installed service has openOnStartup`.
- Portal request options, exact values: `autostart` (`b`), `commandline` (`as`) = `['loft', '--minimized']`, `reason` (`s`) = `Loft opens your messaging services when you log in.`, plus a unique `handle_token` (`s`).
- Background portal is **version 2**: `RequestBackground(in s parent_window, in a{sv} options, out o handle)`. `parent_window` is `''`.
- The reply is **not** the method return: it arrives as `org.freedesktop.portal.Request.Response(u response, a{sv} results)` on the returned handle path. `response` 0 = success, 1 = cancelled, 2 = other. **`results.autostart` (`b`) is authoritative over what was asked for.**
- The portal client **must never throw or reject** — a missing/erroring portal must not break a settings toggle or app startup. Mirror `src/main/gnome/shellHelper.ts` and `src/main/notifications/systemDnd.ts`.
- Deps-seam style for anything touching D-Bus, so it unit-tests without a bus (pattern: `systemDnd.ts`, `kwin.ts`, `helperInstall.ts`).
- `org.freedesktop.portal.Background` is **not** GNOME-specific — the new client goes in `src/main/portal/`, NOT `src/main/gnome/`.
- Do not move or refactor `src/main/gnome/backgroundStatus.ts` (it already uses `SetStatus` on the same interface). Out of scope.
- Run `npm test` and `npm run build` before every commit. **One deliberate exception: Task 4** changes a shared type and leaves `npm run build` failing until Task 6 re-wires `index.ts`; Task 4's own steps bound exactly which errors are expected. Tasks 5 and 6 must not be reordered before Task 4. Every other task must be green before committing.
- `npm run check` (svelte-check) is required for Task 5 — `vite build` does NOT typecheck.
- Tests live in `tests/` which is **excluded from tsconfig and not typechecked by vitest** — a broken mock type will pass both gates. Type test fakes against the real exported interface deliberately.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/main/autostart.ts` (modify) | File backend (unchanged) + `wantsAutostart()` + `syncAutostart()` facade |
| `src/main/portal/background.ts` (create) | `requestAutostart()` — Background portal client, deps seam, never throws |
| `src/main/index.ts` (modify) | `reconcileAutostart()` + 3 call sites; drop `startAtLogin` wiring |
| `src/main/hubState.ts` (modify) | `startAtLogin` → `autostartBlocked` |
| `src/shared/hubTypes.ts` (modify) | `HubGlobals`/`GlobalPatch` contract change |
| `src/renderer/hub/components/GlobalSettings.svelte` (modify) | Remove toggle, add blocked warning |
| `chat.loft.Loft.yml` (modify) | `xdg-config/autostart` `:create` → `:ro` |
| `tests/autostart.test.ts` (modify) | Existing file-backend tests retained + `wantsAutostart` + dispatch |
| `tests/portalBackground.test.ts` (create) | Portal client options + response paths |

---

### Task 1: `wantsAutostart` — the derived rule

**Files:**
- Modify: `src/main/autostart.ts`
- Test: `tests/autostart.test.ts`

**Interfaces:**
- Consumes: `ServiceConfig` from `src/main/config.ts` (fields used: `openOnStartup?: boolean`)
- Produces: `wantsAutostart(services: Record<string, ServiceConfig | undefined>): boolean`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('autostart', ...)` block in `tests/autostart.test.ts`. Add `wantsAutostart` to the existing import from `../src/main/autostart`:

```ts
  it('wantsAutostart is false with no services and no flags', () => {
    expect(wantsAutostart({})).toBe(false);
    expect(wantsAutostart({ slack: {} })).toBe(false);
    expect(wantsAutostart({ slack: { openOnStartup: false } })).toBe(false);
  });
  it('wantsAutostart is true when any service opts in', () => {
    expect(wantsAutostart({ slack: { openOnStartup: true } })).toBe(true);
    expect(wantsAutostart({ slack: { openOnStartup: false }, whatsapp: { openOnStartup: true } })).toBe(true);
    expect(wantsAutostart({ a: { openOnStartup: true }, b: { openOnStartup: true } })).toBe(true);
  });
  it('wantsAutostart tolerates undefined entries', () => {
    expect(wantsAutostart({ slack: undefined })).toBe(false);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/autostart.test.ts`
Expected: FAIL — `wantsAutostart is not a function` / import error.

- [ ] **Step 3: Implement**

Add to `src/main/autostart.ts`. Import the type at the top: `import type { ServiceConfig } from './config';`

```ts
/**
 * The desired autostart state, derived from config — there is no separate
 * "start at login" setting. Loft autostarts iff at least one service asked to
 * open at login; the per-service flags are the single source of truth.
 */
export function wantsAutostart(services: Record<string, ServiceConfig | undefined>): boolean {
  return Object.values(services).some((s) => s?.openOnStartup === true);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/autostart.test.ts` → PASS. Then `npm test` → all pass. Then `npm run build` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/main/autostart.ts tests/autostart.test.ts
git commit -m "feat(autostart): derive the desired state from per-service flags"
```

---

### Task 2: Background portal client

**Files:**
- Create: `src/main/portal/background.ts`
- Test: `tests/portalBackground.test.ts`

**Interfaces:**
- Produces:
  - `export interface PortalDeps { uniqueName(): string; call(handleToken: string, options: Record<string, unknown>): Promise<void>; onResponse(path: string, cb: (response: number, results: Record<string, unknown>) => void): { stop(): void }; }`
  - `export function requestPath(uniqueName: string, handleToken: string): string`
  - `export function backgroundOptions(enabled: boolean, handleToken: string): Record<string, unknown>` — returns **plain** values (not `Variant`s) so it is assertable; the real deps wrap them.
  - `export function requestAutostart(enabled: boolean, deps: PortalDeps): Promise<boolean>` — resolves to the **granted** state; never rejects.
  - `export function defaultPortalDeps(): PortalDeps`

**Context the implementer needs:**

The portal reply is asynchronous and arrives on a `Request` object path, not as the method's return value. Subscribing only *after* `RequestBackground` returns can miss a fast response — so compute the expected path first, subscribe, then call. The path is `/org/freedesktop/portal/desktop/request/<SENDER>/<handle_token>` where `<SENDER>` is the D-Bus unique name (e.g. `:1.42`) with the leading `:` stripped and every `.` replaced by `_` (→ `1_42`).

`dbus-next` usage in this repo (see `src/main/gnome/backgroundStatus.ts` and `src/main/gnome/shellHelper.ts` for working examples): `dbus.sessionBus()`, `new dbus.Message({destination, path, interface, member, signature, body})`, `bus.call(msg): Promise<Message>`, `new dbus.Variant(sig, value)`, and `bus.name` for the unique name. An `a{sv}` body arg is a plain object of `Variant` values.

- [ ] **Step 1: Write the failing tests**

Create `tests/portalBackground.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  requestPath, backgroundOptions, requestAutostart, type PortalDeps,
} from '../src/main/portal/background';

/** Fake portal: records the call, then fires whatever Response we tell it to. */
function fake(opts: { response?: number; granted?: boolean; throws?: boolean } = {}) {
  const calls: Array<{ token: string; options: Record<string, unknown> }> = [];
  let cb: ((r: number, res: Record<string, unknown>) => void) | undefined;
  let subscribed: string | undefined;
  let stopped = false;
  const deps: PortalDeps = {
    uniqueName: () => ':1.42',
    onResponse: (path, f) => { subscribed = path; cb = f; return { stop: () => { stopped = true; } }; },
    call: async (token, options) => {
      calls.push({ token, options });
      if (opts.throws) throw new Error('portal unavailable');
      // The real portal replies on the Request path, asynchronously.
      queueMicrotask(() => cb?.(opts.response ?? 0, { autostart: opts.granted ?? true }));
    },
  };
  return { deps, calls, get subscribed() { return subscribed; }, get stopped() { return stopped; } };
}

describe('requestPath', () => {
  it('strips the leading colon and replaces dots', () => {
    expect(requestPath(':1.42', 'tok')).toBe('/org/freedesktop/portal/desktop/request/1_42/tok');
  });
});

describe('backgroundOptions', () => {
  it('carries the exact contract the portal expects', () => {
    const o = backgroundOptions(true, 'tok');
    expect(o.autostart).toBe(true);
    expect(o.commandline).toEqual(['loft', '--minimized']);
    expect(o.reason).toBe('Loft opens your messaging services when you log in.');
    expect(o.handle_token).toBe('tok');
  });
  it('passes autostart:false through for disable', () => {
    expect(backgroundOptions(false, 'tok').autostart).toBe(false);
  });
});

describe('requestAutostart', () => {
  it('resolves true when granted', async () => {
    const f = fake({ response: 0, granted: true });
    await expect(requestAutostart(true, f.deps)).resolves.toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].options.autostart).toBe(true);
  });

  // The portal decides, not us: asking for autostart does not mean getting it.
  it('resolves FALSE when the portal succeeds but denies autostart', async () => {
    const f = fake({ response: 0, granted: false });
    await expect(requestAutostart(true, f.deps)).resolves.toBe(false);
  });

  it('resolves false when the user cancels', async () => {
    const f = fake({ response: 1, granted: true });
    await expect(requestAutostart(true, f.deps)).resolves.toBe(false);
  });

  it('never rejects when the bus throws', async () => {
    const f = fake({ throws: true });
    await expect(requestAutostart(true, f.deps)).resolves.toBe(false);
  });

  it('subscribes to the response path BEFORE calling, and unsubscribes after', async () => {
    const f = fake({ response: 0, granted: true });
    await requestAutostart(true, f.deps);
    expect(f.subscribed).toMatch(/^\/org\/freedesktop\/portal\/desktop\/request\/1_42\//);
    expect(f.stopped).toBe(true);
  });

  it('uses a fresh handle_token per call', async () => {
    const f = fake();
    await requestAutostart(true, f.deps);
    await requestAutostart(true, f.deps);
    expect(f.calls[0].token).not.toBe(f.calls[1].token);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/portalBackground.test.ts`
Expected: FAIL — cannot resolve `../src/main/portal/background`.

- [ ] **Step 3: Implement**

Create `src/main/portal/background.ts`:

```ts
// org.freedesktop.portal.Background — the sanctioned way for a sandboxed app to
// ask for autostart. Verified live (Fedora 44, xdg-desktop-portal 1.22.1 +
// -gnome 50.0), interface version 2:
//   RequestBackground(in s parent_window, in a{sv} options, out o handle)
// The reply is NOT the return value: it arrives as Request.Response(u, a{sv}) on
// the returned handle path. results.autostart is what we actually GOT, which is
// authoritative over what we asked for.
import * as dbus from 'dbus-next';

const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const IFACE = 'org.freedesktop.portal.Background';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';

/** The flatpak manifest's `command:` plus the flag the autostart entry must carry. */
const COMMANDLINE = ['loft', '--minimized'];
const REASON = 'Loft opens your messaging services when you log in.';

export interface PortalDeps {
  /** The bus's unique name, e.g. ":1.42". */
  uniqueName(): string;
  /** Invoke RequestBackground. Rejecting is fine — requestAutostart absorbs it. */
  call(handleToken: string, options: Record<string, unknown>): Promise<void>;
  /** Subscribe to Response on the request path. Must be called BEFORE call(). */
  onResponse(
    path: string,
    cb: (response: number, results: Record<string, unknown>) => void,
  ): { stop(): void };
}

/**
 * Where the portal will emit Response: the unique name with the leading ':'
 * dropped and '.' → '_'. Computed up front so we can subscribe before calling —
 * subscribing after the call can miss a fast reply.
 */
export function requestPath(uniqueName: string, handleToken: string): string {
  const sender = uniqueName.replace(/^:/, '').replace(/\./g, '_');
  return `/org/freedesktop/portal/desktop/request/${sender}/${handleToken}`;
}

/** Plain (un-Varianted) options, so they stay assertable in tests. */
export function backgroundOptions(enabled: boolean, handleToken: string): Record<string, unknown> {
  return { handle_token: handleToken, reason: REASON, autostart: enabled, commandline: COMMANDLINE };
}

let tokenSeq = 0;

/** Ask the portal to enable/disable autostart. Resolves to the GRANTED state; never rejects. */
export async function requestAutostart(enabled: boolean, deps: PortalDeps): Promise<boolean> {
  const handleToken = `loft_${process.pid}_${++tokenSeq}`;
  let sub: { stop(): void } | undefined;
  try {
    const settled = new Promise<boolean>((resolve) => {
      sub = deps.onResponse(requestPath(deps.uniqueName(), handleToken), (response, results) => {
        // response: 0 ok, 1 cancelled, 2 other. Trust results.autostart, not our request.
        resolve(response === 0 && results.autostart === true);
      });
    });
    await deps.call(handleToken, backgroundOptions(enabled, handleToken));
    return await settled;
  } catch (e) {
    console.debug('RequestBackground failed:', (e as Error)?.message ?? e);
    return false;
  } finally {
    sub?.stop();
  }
}

export function defaultPortalDeps(): PortalDeps {
  const bus = dbus.sessionBus();
  return {
    uniqueName: () => (bus as unknown as { name: string }).name,
    onResponse: (path, cb) => {
      const handler = (msg: dbus.Message): void => {
        if (msg.path !== path || msg.interface !== REQUEST_IFACE || msg.member !== 'Response') return;
        const [response, results] = msg.body as [number, Record<string, dbus.Variant>];
        const plain: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(results ?? {})) plain[k] = v?.value;
        cb(response, plain);
      };
      const match = `type='signal',interface='${REQUEST_IFACE}',member='Response',path='${path}'`;
      void bus.call(new dbus.Message({
        destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [match],
      })).catch(() => {});
      bus.on('message', handler);
      return {
        stop: () => {
          bus.off('message', handler);
          void bus.call(new dbus.Message({
            destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
            interface: 'org.freedesktop.DBus', member: 'RemoveMatch', signature: 's', body: [match],
          })).catch(() => {});
        },
      };
    },
    call: async (handleToken, options) => {
      const body: Record<string, dbus.Variant> = {
        handle_token: new dbus.Variant('s', options.handle_token as string),
        reason: new dbus.Variant('s', options.reason as string),
        autostart: new dbus.Variant('b', options.autostart as boolean),
        commandline: new dbus.Variant('as', options.commandline as string[]),
      };
      await bus.call(new dbus.Message({
        destination: PORTAL, path: PORTAL_PATH, interface: IFACE, member: 'RequestBackground',
        signature: 'sa{sv}', body: ['', body],
      }));
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/portalBackground.test.ts` → PASS (7 tests). Then `npm test` → all pass. Then `npm run build` → exit 0.

- [ ] **Step 5: Verify the wire contract against the REAL portal**

Do not skip — the request-path derivation and signal shape are the two things most likely to be subtly wrong, and no unit test can catch it.

```bash
gdbus introspect --session --dest org.freedesktop.portal.Desktop \
  --object-path /org/freedesktop/portal/desktop 2>/dev/null | \
  sed -n '/interface org.freedesktop.portal.Background/,/};/p'
```

Expected: `RequestBackground(in s parent_window, in a{sv} options, out o handle);` and `readonly u version = 2`. Record the output in your report. If it differs, STOP and report — do not adapt the code silently.

- [ ] **Step 6: Commit**

```bash
git add src/main/portal/background.ts tests/portalBackground.test.ts
git commit -m "feat(portal): Background portal client for autostart requests"
```

---

### Task 3: `syncAutostart` facade

**Files:**
- Modify: `src/main/autostart.ts`
- Test: `tests/autostart.test.ts`

**Interfaces:**
- Consumes: `requestAutostart(enabled, deps)` + `defaultPortalDeps()` from `src/main/portal/background.ts` (Task 2); `isFlatpak(env)` from `src/main/desktop.ts`; `setAutostart(enabled, opts)` (existing, this file)
- Produces: `syncAutostart(enabled: boolean, opts: { env?: Env; execPath?: string; iconSourceDir: string; portal?: (enabled: boolean) => Promise<boolean> }): Promise<void>`

`opts.portal` exists **only** as a test seam; production omits it and gets the real portal.

- [ ] **Step 1: Write the failing tests**

Append to `tests/autostart.test.ts`; add `syncAutostart` to the existing import.

```ts
  it('syncAutostart uses the portal under Flatpak and never touches the file', async () => {
    const cfg = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp(), FLATPAK_ID: 'chat.loft.Loft' } as NodeJS.ProcessEnv;
    const seen: boolean[] = [];
    await syncAutostart(true, {
      env, execPath: '/usr/bin/loft', iconSourceDir: tmp(),
      portal: async (e) => { seen.push(e); return true; },
    });
    expect(seen).toEqual([true]);
    expect(existsSync(join(cfg, 'autostart', 'chat.loft.Loft.desktop'))).toBe(false);
  });

  it('syncAutostart writes the file natively and never calls the portal', async () => {
    const cfg = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp() } as NodeJS.ProcessEnv;
    let portalCalls = 0;
    await syncAutostart(true, {
      env, execPath: '/usr/bin/loft', iconSourceDir: tmp(),
      portal: async () => { portalCalls++; return true; },
    });
    expect(portalCalls).toBe(0);
    expect(existsSync(join(cfg, 'autostart', 'chat.loft.Loft.desktop'))).toBe(true);
  });

  it('syncAutostart(false) removes the file natively', async () => {
    const cfg = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp() } as NodeJS.ProcessEnv;
    const opts = { env, execPath: '/usr/bin/loft', iconSourceDir: tmp() };
    await syncAutostart(true, opts);
    expect(isAutostartEnabled(env)).toBe(true);
    await syncAutostart(false, opts);
    expect(isAutostartEnabled(env)).toBe(false);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/autostart.test.ts`
Expected: FAIL — `syncAutostart is not a function`.

- [ ] **Step 3: Implement**

Add to `src/main/autostart.ts`. Add imports at the top:
`import { desktopExec, isFlatpak } from './desktop';` (extend the existing `desktopExec` import) and
`import { requestAutostart, defaultPortalDeps } from './portal/background';`

```ts
/**
 * Apply the desired autostart state.
 *
 * Under Flatpak this goes through the XDG Background portal — the sanctioned
 * route, which writes a proper X-XDP-Autostart entry using the app's own
 * Name/Icon and lets the manifest keep only :ro on the autostart dir. Natively
 * there is no sandbox app-id for the portal to key on, so we write the file
 * ourselves (unchanged behaviour).
 *
 * Returns nothing on purpose: what was actually granted is read back from disk
 * with isAutostartEnabled(), so both backends are judged by the same evidence
 * rather than by what each claims it did.
 */
export async function syncAutostart(
  enabled: boolean,
  opts: { env?: Env; execPath?: string; iconSourceDir: string; portal?: (enabled: boolean) => Promise<boolean> },
): Promise<void> {
  const env = opts.env ?? process.env;
  if (isFlatpak(env)) {
    const portal = opts.portal ?? ((e: boolean) => requestAutostart(e, defaultPortalDeps()));
    await portal(enabled);
    return;
  }
  setAutostart(enabled, { env, execPath: opts.execPath, iconSourceDir: opts.iconSourceDir });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/autostart.test.ts` → PASS. Then `npm test` → all pass. Then `npm run build` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/main/autostart.ts tests/autostart.test.ts
git commit -m "feat(autostart): syncAutostart facade — portal on Flatpak, file natively"
```

---

### Task 4: Hub contract — `startAtLogin` out, `autostartBlocked` in

**Files:**
- Modify: `src/shared/hubTypes.ts:19`, `src/shared/hubTypes.ts:28`
- Modify: `src/main/hubState.ts:12`, `src/main/hubState.ts:32`
- Test: `tests/hubState.test.ts`

**Interfaces:**
- Produces: `HubGlobals { trayBackend: TrayBackend; autostartBlocked: boolean }`; `GlobalPatch { trayBackend?: TrayBackend }`; `HubStateDeps.autostartBlocked: boolean` (replacing `startAtLogin: boolean`)

- [ ] **Step 1: Write the failing test**

Add to `tests/hubState.test.ts`. It already builds a `HubStateDeps` — find the existing factory/deps object, replace `startAtLogin: <x>` with `autostartBlocked: <x>`, and add:

```ts
  it('surfaces autostartBlocked in globals', () => {
    const base = {
      services: [], config: { services: {} } as never,
      running: () => false, visible: () => false, badge: () => 0,
      trayBackend: 'auto' as const,
    };
    expect(buildHubState({ ...base, autostartBlocked: true }).globals.autostartBlocked).toBe(true);
    expect(buildHubState({ ...base, autostartBlocked: false }).globals.autostartBlocked).toBe(false);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/hubState.test.ts`
Expected: FAIL — `globals.autostartBlocked` is `undefined`.

- [ ] **Step 3: Implement**

`src/shared/hubTypes.ts` — replace lines 19 and 28:

```ts
export interface HubGlobals { trayBackend: TrayBackend; autostartBlocked: boolean }
```
```ts
export interface GlobalPatch { trayBackend?: TrayBackend }
```

`src/main/hubState.ts` — replace line 12 in `HubStateDeps`:

```ts
  /** True when services asked to open at login but no autostart entry exists (e.g. the portal denied). */
  autostartBlocked: boolean;
```

and line 32:

```ts
  return { services, globals: { trayBackend: deps.trayBackend, autostartBlocked: deps.autostartBlocked } };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/hubState.test.ts` → PASS.
`npm run build` will FAIL here — `index.ts` and `GlobalSettings.svelte` still reference `startAtLogin`. That is expected; Tasks 5 and 6 fix them. Confirm the failures are **only** those two files:

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head`
Expected: errors only in `src/main/index.ts` mentioning `startAtLogin`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/hubTypes.ts src/main/hubState.ts tests/hubState.test.ts
git commit -m "feat(hub): replace startAtLogin with autostartBlocked in the hub contract"
```

---

### Task 5: Hub UI — remove the toggle, warn when blocked

**Files:**
- Modify: `src/renderer/hub/components/GlobalSettings.svelte:18-21`

**Interfaces:**
- Consumes: `HubGlobals.autostartBlocked` (Task 4)

**Context:** Svelte 5 runes. `vite build` does NOT typecheck — `npm run check` (svelte-check) is the gate. Do not name a prop `state` alongside a `$state()` rune (a past bug); the existing `let { state }: { state: HubState } = $props()` is fine as-is — leave it.

- [ ] **Step 1: Replace the toggle with the warning**

In `src/renderer/hub/components/GlobalSettings.svelte`, delete lines 18-21 (the whole `<label class="toggle">` block containing the `startAtLogin` checkbox) and put in its place:

```svelte
{#if g.autostartBlocked}
  <p class="warn">
    Loft was denied permission to start at login, so services set to open on startup won't open.
    Allow it in Settings → Apps → Loft.
  </p>
{/if}
```

- [ ] **Step 2: Add the style**

In the same file's `<style>` block, remove the now-unused `.toggle` rules and add:

```css
  .warn { margin: 12px 0; padding: 10px 12px; border-radius: 8px; border: 1px solid #e5a50a; background: #e5a50a1a; font-size: 0.9em; }
```

- [ ] **Step 3: Verify the renderer typechecks**

Run: `npm run check`
Expected: `0 ERRORS 0 WARNINGS`. (This will only pass once Task 6 has removed the `setGlobal({ startAtLogin })` caller — if `check` reports an error in `GlobalSettings.svelte` about `startAtLogin`, you missed a reference in this file.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/hub/components/GlobalSettings.svelte
git commit -m "feat(hub): drop the Start at login toggle, warn when autostart is blocked"
```

---

### Task 6: Wire reconcile into main

**Files:**
- Modify: `src/main/index.ts` (imports at :22; `buildState` at ~:353; `addService`/`removeService`/`setServiceSetting`/`setGlobal` at ~:356-387; startup block near the `openOnStartup` loop at ~:405)

**Interfaces:**
- Consumes: `wantsAutostart(services)` (Task 1), `syncAutostart(enabled, opts)` (Task 3), `isAutostartEnabled(env?)` (existing), `HubGlobals.autostartBlocked` (Task 4)

- [ ] **Step 1: Update the import**

`src/main/index.ts:22` currently reads:

```ts
import { setAutostart, isAutostartEnabled } from './autostart';
```

Replace with:

```ts
import { syncAutostart, isAutostartEnabled, wantsAutostart } from './autostart';
```

- [ ] **Step 2: Add the reconcile helper**

Add near the other top-level helpers in `index.ts` (e.g. just below `setGlobalDnd`):

```ts
// Autostart is derived, not a setting: the entry exists iff some service asked to
// open at login. Called after anything that can change that answer.
function reconcileAutostart(): void {
  void syncAutostart(wantsAutostart(config.services), { execPath: process.execPath, iconSourceDir });
}
```

- [ ] **Step 3: Swap `startAtLogin` for `autostartBlocked` in the hub state**

In `hubDeps.buildState`, replace `startAtLogin: isAutostartEnabled(),` with:

```ts
        autostartBlocked: wantsAutostart(config.services) && !isAutostartEnabled(),
```

- [ ] **Step 4: Drop the removed global, add the reconcile call sites**

In `hubDeps.setGlobal`, delete the `startAtLogin` line so the body is only:

```ts
      setGlobal: (patch: GlobalPatch) => {
        if (patch.trayBackend !== undefined) { config.trayBackend = patch.trayBackend; saveConfig(configPath(), config); }
      },
```

In `hubDeps.setServiceSetting`, add at the end of the function body (after the `customUrl` block):

```ts
        if (patch.openOnStartup !== undefined) reconcileAutostart();
```

In `hubDeps.addService`, after `saveConfig(configPath(), config);` add:

```ts
        reconcileAutostart();
```

In `hubDeps.removeService`, after `saveConfig(configPath(), config);` add:

```ts
        reconcileAutostart();
```

- [ ] **Step 5: Reconcile at startup, only when out of sync**

In the `whenReady` block, immediately **after** the `for (const id of Object.keys(config.services))` loop that opens `openOnStartup` services (~line 405-408) and before the `if (!args.minimized) hub!.open();` line, add:

```ts
    // Self-heal installs whose entry doesn't match their flags (e.g. upgrades from
    // the old global-toggle model, or a hand-deleted entry). Gated on out-of-sync so
    // a granted permission is never re-requested at every login.
    if (wantsAutostart(config.services) !== isAutostartEnabled()) reconcileAutostart();
```

- [ ] **Step 6: Verify the build**

Run: `npm run build` → exit 0. Run: `npm run check` → `0 ERRORS 0 WARNINGS`. Run: `npm test` → all pass.

Then confirm no `startAtLogin` references remain anywhere:

```bash
grep -rn "startAtLogin" src/ tests/ || echo "clean"
```
Expected: `clean`.

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(autostart): reconcile from the per-service flags; drop the global toggle"
```

---

### Task 7: Flatpak manifest — give back the write grant

**Files:**
- Modify: `chat.loft.Loft.yml` (the `finish-args` list)

- [ ] **Step 1: Downgrade the grant**

In `chat.loft.Loft.yml`'s `finish-args`, change:

```yaml
  - --filesystem=xdg-config/autostart:create
```

to:

```yaml
  # :ro — the Background portal now writes the entry; we only read it back to
  # tell whether autostart is actually in effect (isAutostartEnabled).
  - --filesystem=xdg-config/autostart:ro
```

Leave `--filesystem=xdg-data/applications:create` **unchanged** — per-service launchers are still written directly and no portal covers them. Leave `--talk-name=org.freedesktop.portal.Desktop` unchanged (already present; the portal needs no new permission).

- [ ] **Step 2: Verify the manifest still parses**

Run: `python3 -c "import yaml,sys; d=yaml.safe_load(open('chat.loft.Loft.yml')); print('\n'.join(d['finish-args']))"`
Expected: prints the finish-args list, including `--filesystem=xdg-config/autostart:ro` and `--talk-name=org.freedesktop.portal.Desktop`. No `:create` on autostart.

- [ ] **Step 3: Commit**

```bash
git add chat.loft.Loft.yml
git commit -m "build(flatpak): downgrade autostart grant to :ro now the portal writes it"
```

---

### Task 8: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (the `~/.config/autostart/` entry in the File Layout tree)

- [ ] **Step 1: Correct the documented model**

In `CLAUDE.md`'s File Layout block, the `~/.config/autostart/` entry currently reads:

```
~/.config/autostart/
  chat.loft.Loft.desktop           # one login-autostart entry (launches `loft --minimized`); per-service
                                    # autostart is a config flag (openOnStartup), not a separate autostart file
```

Replace with:

```
~/.config/autostart/
  chat.loft.Loft.desktop           # one login-autostart entry (launches `loft --minimized`). DERIVED, not a
                                    # setting: it exists iff some service has openOnStartup. Written by the XDG
                                    # Background portal under Flatpak (so the manifest needs only :ro here) and
                                    # directly otherwise; read back with existsSync in both cases.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: autostart is derived and portal-written under Flatpak"
```

---

## Self-Review

**Spec coverage:** §3 model → Task 1. §4 write/read split + structure → Tasks 2, 3. §5 reconcile points (3) → Task 6 steps 4-5. §6 denial → Tasks 4, 5, 6 step 3. §7 hub changes → Tasks 4, 5, 6. §8 manifest → Task 7. §9 testing → folded into each task. §1a (don't "fix" paths) → Global Constraints. Doc drift → Task 8. No gaps.

**Placeholder scan:** none — every code step carries its literal content; every command carries expected output.

**Type consistency:** `wantsAutostart(Record<string, ServiceConfig|undefined>): boolean` (T1) is consumed with `config.services` in T6. `syncAutostart(enabled, opts): Promise<void>` (T3) is called via `void` in T6. `requestAutostart(enabled, deps): Promise<boolean>` (T2) is consumed by T3's default portal lambda. `HubGlobals.autostartBlocked` (T4) is read as `g.autostartBlocked` in T5 and produced in T6 step 3. `PortalDeps` members (`uniqueName`/`call`/`onResponse`) match between T2's implementation and its fake.

**Ordering note:** Task 4 intentionally leaves `npm run build` red until Task 6; Task 4 step 4 says so and bounds the expected failures. Tasks 5 and 6 must not be reordered before 4.
