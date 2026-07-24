# Electron Loft 09c-2a — Live-view detach/attach (no reload)

**Status:** design approved (2026-07-18), pending implementation plan.

The first half of 09c-2. This is the **engine**: detaching a service into its own window (and attaching it back) *moves the live view* instead of tearing it down and reloading, so scroll position and half-typed drafts survive. The **drag gesture** that will trigger it is 09c-2b, spiked and built separately (the cross-window attach-drag is Wayland-uncertain). This slice ships behind the trigger that already exists — the rail/tray "Open in its own window" toggle.

## Why

Today `setDetached(id, v)` (`src/main/index.ts:353-387`) unloads and reloads: it `quitService`s the running service (destroying the view and closing its `webContents`) and re-places it via `openService`/`attachService`, which build a fresh view. Scroll and drafts are lost. `LoftWindow.detach(id)` (`loftWindow.ts:294-310`) already does the right thing — unmounts and returns a **still-live** `ServiceView` — but nothing can accept one, so it's dead code. The doc at `index.ts:353-363` names this exact plan.

The hard question — *does a live `WebContentsView` survive re-parenting between windows, calls included?* — was already answered GO by the 09a re-parenting spike and the 09b `mount()/unmount()` spike. So this slice is wiring proven primitives into the real paths, not new territory.

## Decisions

- **Engine only, no new UI.** The trigger is the existing "Open in its own window" checkbox in the per-service menu (`buildServiceMenu`, which calls `setDetached`). Drag is 09c-2b.
- **Move, don't reload.** Detach hands the live view from the Loft window to a new `ServiceWindow`; attach hands it back.
- **Persisted state is untouched** — the `detached` flag + `wantsOwnWindow`/`reopenDetached` already remember attachment across launches (`index.ts:112-113`, `config.ts:28,44`). This slice only changes *how* the transition happens at runtime, not what's remembered.

## Non-goals

- The drag-to-attach/detach gesture, the rail drop-slot indicator, cursor tracking — all 09c-2b.
- Any change to startup placement (`placeService`/`wantsOwnWindow`) — it already reads `detached` correctly.

## Components

### 1. `LoftWindow.attach(def, view?)` — accept a pre-built view

`attach` (`loftWindow.ts:275-292`) currently always `createServiceView(def, deps.cfg)`. Add an optional `view?: ServiceView`: when given, mount **it** instead of creating one; still `views.set`, still wire the `did-finish-load` → `onServiceLoad` binding, still `refreshAll`. The `existing` short-circuit (a view already attached for this id) stays. Signature becomes `attach(def: ServiceDef, view?: ServiceView): ServiceHost`.

### 2. `ServiceWindow`: mount a pre-built view + `releaseView()`

- `createServiceWindow(def, cfg, opts, view?)` (`serviceWindow.ts:25-29`) — currently always `createServiceView(def, cfg)` at `:63`. Add an optional pre-built `view`: mount it instead of creating. Its lifecycle bindings already reference the local `sv`, so they carry over unchanged.
- **New `ServiceWindow.releaseView(): ServiceView`** — the mirror of `LoftWindow.detach()`. Unmount the live view from this window, hand it back, and tear down **just the window shell** without disposing the view.

### 3. `openService` / `attachService` thread the optional view

- `openService(def, minimized, view?)` (`index.ts:173-211`) passes `view` to `createServiceWindow`. All its other work — register into `windows`, wire tray/notification handlers, `focusExternal` — is unchanged and is exactly what a freshly-detached window needs.
- `attachService(def, view?)` passes `view` to `loft.attach(def, view)`.

### 4. `setDetached(id, v)` — orchestrate the live move

Replace the `quitService` + reopen body with a move:

- **Detaching (`v === true`), currently attached:** `const view = loft.detach(id)` → `openService(def, /*minimized*/ !wasVisible, view)`. `loft.detach` already unmounts, drops the id from `views`/`hosts`, and re-selects the next tab.
- **Attaching (`v === false`), currently in its own window:** `const view = sw.releaseView()` → remove it from `windows` → `attachService(def, view)` → if `wasVisible`, `showService(def)` (which selects the tab and raises the Loft window).
- Persist `detached: v` and `saveConfig` as today. When the service isn't loaded at all, keep the current behaviour (just flip the flag; next launch places it).

## The two correctness hazards (call these out for the implementer)

1. **`closed` must not dispose a released view.** `ServiceWindow`'s `'closed'` handler disposes its `ServiceView` (`serviceWindow.ts:105`). After `releaseView()` hands the view to the Loft window, destroying the shell must **not** dispose it. Fix: `releaseView()` sets a `released` flag (and unmounts); the `'closed'` handler disposes only when `!released`. (The Loft side already gets this right — `detach()` unmounts + `views.delete` and never disposes.)

2. **A moved view never reloads, so the `did-finish-load` re-push won't fire.** Both hosts re-push per-service state (DND, `document.hidden`, focus/visible/active for the notification gate) on `did-finish-load` — but a *move* triggers no navigation, so that binding is silent. The transition must **explicitly re-seed** the surviving view's pushed state for its new host: re-assert DND/hidden via the same path `onServiceLoad(id)` uses, and re-seed the notification gate's focused/visible/active for the new host (a detached window's "active" defaults true; an attached tab's depends on whether it's the selected tab). Without this, a detached service could keep suppressing its own notifications (thinking it's still a background tab) or vice-versa.

## Data flow

```
Right-click "Open in its own window" ✔ ─▶ setDetached(id, true)
    view = loft.detach(id)            // live view out of the rail, next tab selected
    openService(def, !wasVisible, view)  // mounts the SAME view in a new window; re-seed gate/DND
Right-click "Open in its own window" ✘ ─▶ setDetached(id, false)
    view = sw.releaseView()           // live view out of the window; shell torn down, view kept
    windows.delete(id); attachService(def, view)  // mounts the SAME view in the rail; re-seed
    if (wasVisible) showService(def)
```

## Testing

- This is Electron window/view orchestration — `index.ts`/`loftWindow.ts`/`serviceWindow.ts` are not vitest-importable (same as 09b). The gate is `npm run build` clean plus Keith's smoke test:
  - Detach a service that has a **scrolled-up conversation and a half-typed draft** → its own window keeps both (no reload).
  - Attach it back → still there.
  - A **voice/video call in progress** survives the move (the reason Loft exists — the re-parenting spike covered this, confirm end-to-end).
  - Notifications behave after a move: a detached service in the background still notifies; the attached, focused tab still suppresses its own.
- No pure unit seam is worth carving here — the logic is inseparable from the Electron view lifecycle. Rely on the build gate + smoke, consistent with 09b.

## Edge cases

- **Detaching the active tab:** `loft.detach` re-selects via `nextActiveId` (already handled); the Loft window shows the next tab or the manager.
- **Detaching the last attached service:** the Loft window falls to the manager (`nextActiveId → undefined`). Fine.
- **Service hidden when toggled:** carry `wasVisible` (as `setDetached` already computes) so a hidden service moves without being forced on-screen (`minimized: !wasVisible`).
- **Not-loaded service:** unchanged — flip `detached`, persist, let next launch place it. No view to move.
- **Rapid re-toggle:** each `setDetached` runs to completion; preserve the `mount()` same-synchronous-tick contract on the surviving view so the stuck-watcher doesn't misfire.

## File-level impact (orientation for the plan)

- `src/main/loftWindow.ts` — `attach(def, view?)`.
- `src/main/serviceWindow.ts` — `createServiceWindow(…, view?)`; new `releaseView()`; `released`-guarded `'closed'` disposal.
- `src/main/index.ts` — `openService(def, minimized, view?)`, `attachService(def, view?)`, rewritten `setDetached`; the re-seed-after-move call.
