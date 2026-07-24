# Live-View Move (09c-2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detach/attach a service by MOVING its live `ServiceView` between the Loft rail and a dedicated window, instead of tearing it down and reloading — so scroll, drafts, and in-progress calls survive.

**Architecture:** Teach `LoftWindow.attach` and `createServiceWindow` to mount a pre-built `ServiceView`; add `ServiceWindow.releaseView()` (mirror of the existing `LoftWindow.detach()`); rewrite `setDetached` to hand the live view across and re-seed the notification gate. No new UI — the trigger is the existing "Open in its own window" menu toggle.

**Tech Stack:** TypeScript (strict), Electron 43. No renderer/test changes — this is main-process window/view orchestration.

**Spec:** `docs/superpowers/specs/2026-07-18-electron-loft-09c2a-live-view-move-design.md`

## Global Constraints

- **No new dependencies.** TypeScript strict.
- **Move, never dispose, the surviving view.** The one thing that must not happen: disposing a view that's been handed to the other host. `LoftWindow.detach()` already gets this right (unmount + `views.delete`, no dispose); `ServiceWindow.releaseView()` must match, guarding its `'closed'` disposal.
- **A moved view does not reload** — so the `did-finish-load` → `registerService` re-push never fires. The move must re-seed DND/hidden explicitly. The gate's visible/focused/active axes are already re-seeded by `openService`/`attachService`.
- **No behaviour change to fresh loads.** `placeService`/`openService`/`attachService` called without a view build a fresh view exactly as today (the `view?` param defaults undefined).
- **No unit-test seam.** `index.ts`/`loftWindow.ts`/`serviceWindow.ts` are not vitest-importable (same as 09b). Each task is gated by `npm run build` clean + `npm test` staying green (no test should change); behaviour is verified by Keith's smoke test at the end.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Manual GUI smoke is Keith's — agent steps end at build + suite.

## File Structure

**Modify:**
- `src/main/loftWindow.ts` — `attach(def, view?)`.
- `src/main/serviceWindow.ts` — `createServiceWindow` accepts `opts.view?`; new `releaseView()`; `released`-guarded `'closed'` disposal.
- `src/main/index.ts` — `openService(def, minimized, view?)`, `attachService(def, view?)`, rewritten `setDetached`; `ServiceView` import.

No new files, no test files (Electron orchestration — build + smoke gate).

---

### Task 1: View-move primitives

Make both window hosts able to accept a pre-built live view, and let a detached window hand its view back alive.

**Files:**
- Modify: `src/main/loftWindow.ts`, `src/main/serviceWindow.ts`

**Interfaces:**
- Consumes: `ServiceView` (`./serviceView`), already imported in both files' neighbourhood.
- Produces: `LoftWindow.attach(def: ServiceDef, view?: ServiceView): ServiceHost`; `createServiceWindow(def, cfg, opts: { minimized; onQuit; view? })`; `ServiceWindow.releaseView(): ServiceView`.

- [ ] **Step 1: `LoftWindow.attach` accepts a pre-built view**

In `src/main/loftWindow.ts`, update the `attach` method on the interface (the `LoftWindow` interface, currently `attach(def: ServiceDef): ServiceHost;`) to:

```ts
  /** create+mount a view; does NOT select it. Pass a pre-built (live) view to MOVE it in
   *  from a detached window without reloading; omit it to build a fresh one. */
  attach(def: ServiceDef, view?: ServiceView): ServiceHost;
```

and the implementation (the `attach:` property in the returned `api`) — change the first lines so it mounts a handed-in view when given:

```ts
    attach: (def, view) => {
      const existing = views.get(def.id);
      if (existing) return hostFor(def.id)!;
      // A pre-built view is a LIVE view moving in from a detached window — mount it as-is
      // (no reload ⇒ scroll + drafts survive). Otherwise build a fresh one.
      const sv = view ?? createServiceView(def, deps.cfg);
      sv.mount(window, rects().content);
      sv.setVisible(false); // select() decides what's on screen
      views.set(def.id, sv);
      hosts.delete(def.id);
      sv.view.webContents.on('did-finish-load', () => deps.onServiceLoad(def.id));
      refreshAll();
      return hostFor(def.id)!;
    },
```

(Everything after `const sv = …` is unchanged from the current body.)

- [ ] **Step 2: `createServiceWindow` accepts a pre-built view**

In `src/main/serviceWindow.ts`:

- Add the type import — change `import { createServiceView } from './serviceView';` to `import { createServiceView, type ServiceView } from './serviceView';`.
- Add `releaseView` to the `ServiceWindow` interface (after `persist(): void;`):

```ts
  /** Hand this window's LIVE view back for re-mounting elsewhere (the mirror of
   *  LoftWindow.detach), and tear down just the window shell. The returned view is NOT
   *  disposed — the caller re-mounts it. */
  releaseView(): ServiceView;
```

- Widen `opts` to carry an optional pre-built view:

```ts
export function createServiceWindow(
  def: ServiceDef,
  cfg: LoftConfig,
  opts: { minimized: boolean; onQuit: () => boolean; view?: ServiceView },
): ServiceWindow {
```

- Build-or-adopt the view — change `const sv = createServiceView(def, cfg);` (line ~63) to:

```ts
  const sv = opts.view ?? createServiceView(def, cfg);
```

- [ ] **Step 3: `releaseView()` + guard the `'closed'` disposal**

In `src/main/serviceWindow.ts`, add a `released` flag and guard the `'closed'` handler so a handed-away view is never disposed. Change:

```ts
  window.on('closed', () => sv.dispose());
```

to:

```ts
  // Do NOT dispose a view we've handed to another host via releaseView().
  let released = false;
  window.on('closed', () => { if (!released) sv.dispose(); });
```

and add the `releaseView` method to the returned `api` object (next to `persist`):

```ts
    releaseView: () => {
      released = true;   // the 'closed' handler below must not dispose it now
      sv.unmount();      // take the live view out of this window
      window.destroy();  // tear down just the shell; the view lives on
      return sv;
    },
```

- [ ] **Step 4: Build + suite**

Run: `npm run build && npm test`
Expected: build clean; all 314 tests still pass (no test touches these files; behaviour of fresh loads is unchanged since `view` defaults undefined).

- [ ] **Step 5: Commit**

```bash
git add src/main/loftWindow.ts src/main/serviceWindow.ts
git commit -m "feat(windows): attach/createServiceWindow accept a pre-built view; ServiceWindow.releaseView"
```

---

### Task 2: Orchestrate the live move in `setDetached`

Thread the optional view through `openService`/`attachService`, and rewrite `setDetached` to move the live view instead of `quitService` + reload.

**Files:**
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `LoftWindow.attach(def, view?)`, `ServiceWindow.releaseView()`, `LoftWindow.detach(id)` (all from Task 1 / existing); `ServiceView` (`./serviceView`).

- [ ] **Step 1: Import `ServiceView`**

In `src/main/index.ts`, add near the other `./` type imports (if not already present):

```ts
import type { ServiceView } from './serviceView';
```

- [ ] **Step 2: Thread `view?` through `openService`**

Change `openService`'s signature and its `createServiceWindow` call:

```ts
function openService(def: ServiceDef, minimized: boolean, view?: ServiceView): ServiceHost {
```

and (the reuse short-circuit stays as-is) change the create line:

```ts
  const sw = createServiceWindow(def, config, { minimized, onQuit: () => quitting, view });
```

Everything else in `openService` (the window/tray/notification wiring, `setActive(true)`, `refreshRail`) is unchanged — it's exactly what a freshly-detached window needs, and its state-setters are idempotent (the unload→reopen path already calls them on an existing tray entry).

- [ ] **Step 3: Thread `view?` through `attachService`**

Change `attachService`'s signature and its `loft.attach` call:

```ts
function attachService(def: ServiceDef, view?: ServiceView): ServiceHost {
  const l = loft!;
  const host = l.attach(def, view);
```

(The rest of `attachService` — the tray/gate seeding — is unchanged.)

- [ ] **Step 4: Rewrite `setDetached` to move the live view**

Replace the whole `setDetached` function body (keep the JSDoc but update it — see below) with:

```ts
/**
 * Move a service between the rail and its own window, and remember which (spec §3).
 *
 * MOVES the live ServiceView across (09c-2a) rather than unloading + reloading, so the
 * service keeps its scroll position, half-typed drafts, and any in-progress call. The
 * view is taken out of its current host WITHOUT being disposed, then re-mounted in the
 * new one. If for any reason no live view comes back (`moved` undefined), the re-place
 * builds a fresh one — a safe degradation to the old reload behaviour, never a crash.
 */
function setDetached(id: string, v: boolean): void {
  const def = getService(id);
  // `detached` is absent-means-false: compare the normalised flag so this is a no-op when
  // nothing changes.
  if (!def || (config.services[id]?.detached === true) === v) return;
  const host = hostOf(id);
  const loaded = host !== undefined;
  const wasVisible = host?.isVisible() ?? false;

  // Take the LIVE view out of its current home, without disposing it. Do this BEFORE flipping
  // the flag (the ordering note in quitService): loft.detach locates `id` in the attached list.
  let moved: ServiceView | undefined;
  if (loaded) {
    if (loft?.has(id)) {
      moved = loft.detach(id);              // unmount, drop from the rail, re-select next tab
    } else {
      const sw = windows.get(id);
      if (sw) { moved = sw.releaseView(); windows.delete(id); } // unmount + tear down shell, keep view
    }
    syncLoftWindows();                       // the open-window set changed
  }

  config.services[id] = { ...config.services[id], detached: v };
  saveConfig(configPath(), config);

  if (loaded) {
    // Place where the user just asked (reopenDetached governs STARTUP only), handing the
    // live view across so nothing reloads.
    if (v || !loft) openService(def, !wasVisible, moved); else attachService(def, moved);
    // A moved view fires no did-finish-load, so the DND/hidden re-push that binding does
    // (openService's did-finish-load → registerService, and attach's onServiceLoad) never
    // runs — do it explicitly for the new host. (visible/focused/active are already re-seeded
    // by openService/attachService.)
    notifications?.registerService(id);
    if (wasVisible) showService(def); // it was on screen — keep it there
  }
  loft?.refreshRail();
  notifyHub();
}
```

Before writing this, read `notifications.registerService` (in `src/main/notifications/`) to confirm it re-pushes the service's DND + hidden state to whatever host currently owns the view — that is the state a moved view loses and the reason for the explicit call. If it needs the view mounted first, note that it runs AFTER `openService`/`attachService` here (the view is already mounted in its new host by then).

- [ ] **Step 5: Build + suite**

Run: `npm run build && npm test`
Expected: build clean; 314 tests still pass (no test imports these functions).

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(detach): move the live view instead of unload+reload"
```

> **Manual (Keith), the real gate:**
> - Attach a service, scroll its history up and type an unsent draft, then right-click → "Open in its own window": the new window shows the **same scroll position and draft** (no reload).
> - Right-click it back into the rail: still there.
> - Start a **voice/video call**, then detach mid-call: the call survives the move.
> - Notifications after a move: a detached service in the background still notifies; the attached, focused tab still suppresses its own in-page ding.
> - Detach the **currently-active** tab: the Loft window falls to the next tab (or the manager if it was the last).

---

## Self-Review

**Spec coverage:**
- `LoftWindow.attach(def, view?)` mounts a pre-built view → Task 1 Step 1. ✓
- `createServiceWindow(…, view?)` mounts a pre-built view → Task 1 Step 2. ✓
- `ServiceWindow.releaseView()` (mirror of detach) → Task 1 Step 3. ✓
- `'closed'` must not dispose a released view (hazard 1) → Task 1 Step 3 (`released` guard). ✓
- `openService`/`attachService` thread the view → Task 2 Steps 2-3. ✓
- `setDetached` moves instead of reloads → Task 2 Step 4. ✓
- Re-seed DND/hidden after a move (hazard 2) → Task 2 Step 4 (`registerService`). ✓
- Persisted `detached` state / startup placement → unchanged, spec non-goal. ✓
- Fresh loads unaffected (view defaults undefined) → Global Constraints + Task 2 Step 2. ✓
- Detach-active-tab / last-tab edge → handled by `loft.detach`'s `nextActiveId` (existing) + Task 2's `wasVisible`. ✓

**Placeholder scan:** the one "read `registerService` to confirm" note in Task 2 Step 4 is a verification instruction, not a placeholder — the code to write is fully specified; the read confirms the re-seed mechanism is the right call. No other placeholders.

**Type consistency:** `view?: ServiceView` is the same optional type across `LoftWindow.attach`, `createServiceWindow` opts, `openService`, `attachService`, and the `moved` local; `releaseView(): ServiceView` matches what `loft.detach` returns and what `attach` accepts. `openService(def, minimized, view?)` — `placeService`'s existing 2-arg calls stay valid (view defaults undefined).

## Manual Verification Checklist (Keith, folds into the combined Flatpak smoke)

- Detach with scroll + draft → own window keeps both; attach back → still there.
- Call in progress survives a detach and an attach.
- Notification gate correct after a move (background detached notifies; focused attached suppresses).
- Detaching the active tab re-selects correctly; detaching the last one shows the manager.
- Repeatedly toggle detach/attach on one service — no crash, no leaked window, badge count preserved.
