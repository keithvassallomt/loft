# Electron Loft 09c-2b — Drag to detach, grab-handle to attach

**Status:** design approved (2026-07-19), pending implementation plan.

The second half of 09c-2: the direct gestures that trigger the (already-built, smoke-tested) 09c-2a live-view move. **Detach** by dragging a rail icon off the rail; **attach** by a grab-handle on the detached window's titlebar.

## Why

09c-2a moves the live view but its only trigger is the right-click "Open in its own window" toggle. This adds the gestures Keith asked for. Two throwaway spikes settled what's possible on Wayland:

- **Global cursor is blocked.** `screen.getCursorScreenPoint()` returns a frozen value everywhere on Wayland — the main process cannot track the cursor across windows. So a *cross-window* drag (drag a detached window onto the rail) can't be tracked, and the cursor-following drop-slot isn't achievable. **Attach is therefore a same-surface titlebar handle, not a drag onto the rail.**
- **A rail `WebContentsView` keeps its captured pointer across the internal view boundary.** Spike 2: pressing a rail icon and dragging right, the rail's captured `pointermove` tracked `clientX` from 23 → 391 straight across the 60px rail→content boundary, and the **rail received the `pointerup`** at 391 (deep in the content view). **So drag-a-rail-icon-off-the-rail is fully trackable renderer-side, release included.**

## Decisions

- **Detach:** press a rail icon, drag it past the rail's edge, release → `setDetached(id, true)`. Renderer-side via `setPointerCapture` on the icon; no main-process cursor tracking.
- **Attach:** a grab-handle on the detached window's own titlebar; click it → `setDetached(id, false)`. Shown **only** in detached windows, never the Loft window's titlebar.
- Both triggers call the existing 09c-2a engine (`setDetached`), which does the live move + gate re-seed. This slice adds *only* the gestures + wiring.

## Non-goals

- **Cursor-following drop-slot on attach** — Wayland blocks the cross-window cursor, so it's not achievable; the titlebar handle is the chosen substitute (a service returns to its rail position, briefly highlighted).
- **Rail reordering** (drag to change `railOrder`) — out of scope; the rail drag here means detach only. A future slice could add reorder for vertical drags.
- **Drag-to-attach** (drag a window onto the rail) — not viable on Wayland.

## Components

### 1. Rail drag-to-detach

- **`src/renderer/rail/rail.ts`** — a **drag-detachable** rail item (attached + loaded, i.e. **not sleeping and not detached**) gets pointer handling on its button:
  - `pointerdown` → `setPointerCapture(pointerId)`, record `startX`; do **not** select yet.
  - `pointermove` → once past the rail edge, add a "will detach" visual state.
  - `pointerup` → if the release is past the rail edge (`shouldDetach`), call `window.loftRail.detach(id)`; otherwise it was a click → the existing `select(id)`.
  - Sleeping / detached / the home button keep today's plain click + context-menu behaviour (no drag-detach).
- **Pure seam — `src/renderer/rail/railDrag.ts`** (tsc-built, vitest-testable; `src/renderer/rail` is *not* excluded from tsconfig):
  - `isDraggableForDetach(item: RailItem): boolean` → `!item.sleeping && !item.detached`.
  - `shouldDetach(releaseClientX: number, railWidth: number, margin?: number): boolean` → `releaseClientX > railWidth + margin` (margin default e.g. 24). `clientX` is relative to the rail view, so a value past `railWidth` means "released to the right of the rail."
- **`src/preload/rail.ts`** — add `detach(id: string): void` → `ipc.send('rail:detach', id)`.
- **`src/renderer/rail/window.d.ts`** — auto-covered (re-exports `RailBridge`).
- **`src/main/index.ts`** — `ipcMain.on('rail:detach', (_e, id: string) => setDetached(id, true))`.
- **`rail.css`** — a subtle "will detach" style (e.g. lifted/dashed). Minimal for v1: the rail view is 52px wide and clips, so no ghost icon can follow the cursor outside it — the feedback lives inside the rail.

### 2. Titlebar grab-handle to attach

- The titlebar renderer (`src/renderer/titlebar/`) is shared by the Loft window and every detached window, so it must be **told** which it is.
- **`src/main`** — when a detached `ServiceWindow`'s titlebar loads, main sends it `titlebar:set-attachable` `true`; the Loft window's titlebar gets `false` (or simply never receives true). Fold into the existing titlebar setup (it already sends `titlebar:set-service`).
- **`src/renderer/titlebar/titlebar.ts`** — render an attach control (a dock-left glyph, e.g. `⇤`, with an accessible label "Attach to Loft") only when attachable; click → `window.loftTitlebar.attach()`.
- **`src/preload/titlebar.ts`** — add `attach(): void` → `ipc.send('titlebar:attach')`.
- **`src/main/index.ts`** — `ipcMain.on('titlebar:attach', (e) => { const id = titlebarTarget(e.sender.id)?.def.id; if (id) setDetached(id, false); })` (same `titlebarTarget` mapping the existing zoom/close handlers use).

## Data flow

```
Rail: pointerdown icon → capture → drag past rail edge → pointerup(past) → loftRail.detach(id)
      → rail:detach → setDetached(id, true)   [09c-2a moves the live view into its own window]
      (release still inside rail ⇒ treated as a click ⇒ select(id), unchanged)

Titlebar (detached window only): click ⇤ → loftTitlebar.attach()
      → titlebar:attach → titlebarTarget(sender).def.id → setDetached(id, false)   [moves it back into the rail]
```

## Testing

- **Vitest — `railDrag.ts`:** `isDraggableForDetach` (sleeping ⇒ false, detached ⇒ false, plain attached ⇒ true); `shouldDetach` boundaries (at, just under, well past `railWidth + margin`).
- The renderer/main wiring has no unit seam (like 09c-2a) — **build + smoke gate.** Regressions to check in the smoke: a normal rail **click still selects**; **right-click** menu still works; the **home button** doesn't drag-detach; the **Loft window's own titlebar shows no attach handle**.
- **Manual (Keith), the payoff:** drag a service off the rail → it opens in its own window keeping scroll/draft/call (the 09c-2a engine); click the titlebar handle → it slides back into the rail.

## Edge cases

- **Click vs drag:** release inside the rail (or a tiny movement) = click = select, exactly as today; only a release past the rail edge detaches.
- **Sleeping / detached / home items:** not drag-detachable — plain click behaviour (select / raise / open manager).
- **Detaching the active tab:** the 09c-2a engine re-selects the next tab (or manager) — already handled.
- **Attach handle isolation:** it must never render or fire in the Loft window's titlebar — only detached windows are told `attachable: true`.
- **Accidental micro-drag on click:** the `shouldDetach` margin absorbs jitter so a normal click never crosses the threshold.

## File-level impact

- `src/renderer/rail/rail.ts` + `rail.css` — drag handling + will-detach style.
- new `src/renderer/rail/railDrag.ts` + `tests/railDrag.test.ts` — pure decisions.
- `src/preload/rail.ts` — `detach(id)`.
- `src/renderer/titlebar/titlebar.ts` + its html/css — attach control + attachable state.
- `src/preload/titlebar.ts` — `attach()`.
- `src/main/index.ts` — `rail:detach` + `titlebar:attach` handlers; mark detached titlebars attachable.
