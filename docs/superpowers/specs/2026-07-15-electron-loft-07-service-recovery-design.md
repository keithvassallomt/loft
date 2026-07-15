# Electron Loft — Service-view recovery — Design

Status: approved (Keith, 2026-07-15). Branch: `electron-rewrite`. NOT merged to main.

Follows the root migration (HEAD `ddcdebd`). Closes the robustness gap found during Keith's live Flatpak
smoke: **a service view can end up permanently blank with no user-visible way to recover.**

## 1. Why / scope

During the 1.0.0 live smoke, Slack rendered a blank window. Diagnosis (via CDP): the view was stuck on
`about:blank` because a **corrupted service-worker registration** in its partition aborted every navigation
(`net::ERR_ABORTED`, `canceled=true`). The corruption came from a hard `SIGKILL` of an Electron process
mid-write — in that instance caused by the agent's own testing, but **a crash, an OOM kill, or a hard
power-off would do the same to a real user.**

The problem is not that it happened; it is that **the user has no way out**. There is no devtools, no reload,
no clear-site-data, and no error message. The only recourse is removing and re-adding the service, which
risks deleting login data. Recovery required attaching a remote debugger — not a user-accessible path.

In scope: detect the stuck state, present a recovery affordance in the window, and provide the two recovery
actions (reload; clear caches + reload) from the window, the keyboard, and the hub.

Out of scope: any change to the notification/badge/DND paths; auto-*performing* recovery without user
consent (we only *offer* it); recovering non-blank failures (Chromium's own error pages already cover
those — see §3).

## 2. Resolved decisions (from brainstorming)

- **Scope: full path** (Keith) — auto-detect + in-window offer, *plus* the manual entry points (titlebar
  button, Ctrl+R/F5, hub action).
- **Presentation: an overlay `WebContentsView`** (Keith chose (a) over a titlebar banner) — a proper error
  page, mirroring the existing titlebar-view pattern.
- **Recovery is offered, never auto-applied.** Clearing storage without consent is not something to do
  behind a user's back.
- **Cookies are sacred.** See §4.

## 3. Detection — `src/main/recovery.ts` (new)

**`did-fail-load` is unusable as the trigger.** `ERR_ABORTED` fires on the *healthy* path — Slack's own
client-side redirect (`/client` → `/client/T…/D…`) supersedes the first navigation and reports
`ERR_ABORTED, canceled=true`. Keying on it would false-positive on every normal Slack load.

The one reliable signature is **"nothing ever committed"**:

```ts
/** A view that never committed a document sits on about:blank (or ''). */
export function isStuckUrl(url: string): boolean {
  return !url || url === 'about:blank';
}
```

Flow, behind an injectable seam so it unit-tests without Electron (matching `systemDnd.ts` / `kwin.ts`):

```ts
export interface StuckWatcherDeps {
  timeoutMs: number;                        // 15000
  getUrl(): string;                         // webContents.getURL()
  onStuck(): void;                          // show the overlay
  onRecovered(): void;                      // hide the overlay
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
export interface StuckWatcher {
  armed(): void;                 // call on loadURL/reload — starts the timer
  navigated(url: string): void;  // call on did-navigate
  dispose(): void;
}
export function createStuckWatcher(deps: StuckWatcherDeps): StuckWatcher;
```

- `armed()` starts a **15 s** timer. On fire: if `isStuckUrl(getUrl())` → `onStuck()`.
- `navigated(url)`: if `!isStuckUrl(url)` → clear the timer and `onRecovered()`.
- **Slow networks self-correct:** a load that lands at 20 s shows the overlay at 15 s, then `did-navigate`
  fires and hides it. A false positive is a dismissible offer, never data loss.
- **Network failures are deliberately NOT covered:** Chromium commits its own error page and `getURL()`
  returns the attempted URL, so `isStuckUrl` is false and no overlay appears. Chromium's error page is more
  informative than ours. We only handle "nothing committed at all".

## 4. Recovery actions — what is cleared, and what must never be

Two actions. The distinction is load-bearing: **a plain reload would NOT have fixed the real incident** —
the corrupt SW intercepts and aborts the new navigation too.

| Action | Does | Fixes |
|---|---|---|
| **Reload** | `webContents.reload()` | transient load failures |
| **Clear cache & reload** | `clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })` + `clearCache()`, then reload | corrupt/stale service worker — the real incident |

```ts
/** Clear ONLY the caches. Never cookies/localstorage/indexdb — that is the user's login + app state. */
export async function clearServiceCaches(ses: Session): Promise<void> {
  await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
  await ses.clearCache();
}
```

**Hard requirement: `cookies`, `localstorage`, and `indexdb` are NEVER cleared.** Cookies are the login;
`localstorage`/`indexdb` hold app state. Verified by hand on the live incident: clearing exactly
`service_workers,cache_storage` restored Slack **with the session intact**. This is the single most
important regression to lock with a test (§7).

Session is `session.fromPartition('persist:<id>')` — the service's own partition.

## 5. Presentation — overlay `WebContentsView`

A third view per service window, alongside the existing titlebar + service views:

- **`src/renderer/recovery/index.html` + `recovery.css`** — a small error page: the service name, a short
  message ("Slack didn't load."), and two buttons — **Reload** and **Clear cache & reload** (the latter
  subtitled *"Keeps you signed in"*). System-aware (`prefers-color-scheme`) reusing the titlebar's token
  palette — do not repeat the Stage-1 titlebar mistake of hardcoding light values.
- **`src/preload/recovery.ts`** — `contextBridge` (contextIsolation: true, sandbox: true; it loads no remote
  content) exposing `{ reload(), clearAndReload(), onService(cb) }` over `recovery:*` IPC, mirroring
  `src/preload/titlebar.ts`.
- **Lifecycle** (`serviceWindow.ts`): created lazily on first `onStuck()`, added above the service view,
  sized to the service view's rect from `computeLayout` (i.e. below the titlebar), and **removed** on
  `onRecovered()`. Its own preload/partition-free session, like the titlebar.
- The service view is left untouched underneath — recovery reloads *it*, and the overlay disappears when a
  real URL commits.

**`ServiceWindow` gains two methods** (it currently exposes only `show`/`hide`/`setZoom`/`persist`), so the
titlebar, keyboard, hub, and overlay all drive the same code path:

```ts
reload(): void;                        // webContents.reload() + watcher.armed()
clearAndReload(): Promise<void>;       // clearServiceCaches(partition session) then reload()
```

## 6. Manual entry points (work regardless of detection)

- **Titlebar ⟳ button** — `src/renderer/titlebar/index.html` + `titlebar.css` + `src/preload/titlebar.ts`
  (`reload()`), handled in `index.ts` as `titlebar:reload` → `findBySenderId(...)?.reload()`, exactly
  matching the existing `titlebar:zoom-in`/`zoom-out`/`close` trio.
- **Ctrl+R / F5** — `serviceView.webContents.on('before-input-event')` in `serviceWindow.ts`; reload on
  `Ctrl+R` or `F5`. (The app menu is `null`, so there is no accelerator today.)
- **Hub → per-service settings → Troubleshooting** — a **Clear cache & reload** button in
  `ServiceDetail.svelte` with the caption *"Keeps you signed in. Fixes a service stuck on a blank screen."*
  New IPC `hub:recoverService` → `deps.recoverService(id, { clearCaches })`, following the existing
  `hub:setServiceSetting` handler shape; `LoftHub.recoverService(id, opts)` added to `src/preload/hub.ts`
  and the `src/shared/hubTypes.ts` contract. Works whether or not the service is currently running (if not
  running, it clears and the next launch loads clean).

## 7. Testing

**Unit (Vitest):**
- `isStuckUrl`: `''` → true, `'about:blank'` → true, `'https://app.slack.com/client/'` → false.
- `createStuckWatcher` with fake timers/deps: commit before timeout → `onStuck` never called; timeout while
  blank → `onStuck` once; late commit after `onStuck` → `onRecovered` called (the slow-network
  self-correction); `dispose()` clears the timer.
- **`clearServiceCaches` passes exactly `['serviceworkers','cachestorage']` and NEVER `cookies`,
  `localstorage`, or `indexdb`** (fake `Session` capturing the args). This is the regression that protects
  the user's login — the most important test in this change.
- Titlebar/recovery preload bridges build the expected channel map (mirroring the existing
  `tests/bridge`-style preload tests).

**Manual (Keith):** corrupt a partition's SW (or reproduce via a hard kill), confirm: the overlay appears
after ~15 s, **Reload** alone does not fix it, **Clear cache & reload** does — **and Slack is still signed
in**. Also confirm the overlay does *not* appear on a normal (slow) load, and that Chromium's own error
page still shows when offline.

## 8. What this delivers

A service that fails to load stops being a dead end. The user gets told what happened and can fix it
themselves, without a debugger and without losing their login — closing the gap that this stage's own live
smoke exposed.
