# Drag Gestures (09c-2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trigger the (already-built) 09c-2a live-view move by direct gesture — drag a rail icon off the rail to detach; a grab-handle on a detached window's titlebar to attach.

**Architecture:** Detach is renderer-side: the rail button uses `setPointerCapture` (proven to survive the WebContentsView boundary on Wayland) and reports the release X to main, which decides detach-vs-select via a pure `railDragOutcome`. Attach is a titlebar button shown only in detached windows. Both call the existing `setDetached`.

**Tech Stack:** TypeScript (strict), Electron 43. Plain-TS renderers (rail, titlebar — tsc-built, not bundled). No Svelte, no new deps.

**Spec:** `docs/superpowers/specs/2026-07-19-electron-loft-09c2b-drag-gestures-design.md`

## Global Constraints

- **No new dependencies.** TypeScript strict.
- **The rail renderer (`src/renderer/rail/rail.ts`) is tsc-`commonjs` and loaded as `<script type="module">`, so it cannot `import` a value module** (that would emit `require`/`__esModule` and throw). It keeps the inline `import()` *type* trick. Therefore the drag *decision* lives in `src/main/railDrag.ts` (testable), and the renderer only reports the raw release X.
- **Attach handle isolation:** the attach button must render/fire **only** in a detached window's titlebar, never the Loft window's. The titlebar renderer defaults it hidden; only `serviceWindow` sends `titlebar:set-attachable true`.
- **Fresh behaviour preserved:** a plain rail click still selects; right-click still opens the menu; the home button and sleeping/detached items are unchanged.
- **No unit seam for the renderer/main wiring** (like 09c-2a) — build + smoke gate. The one pure unit is `railDragOutcome`.
- **Test commands:** `npx vitest run tests/railDrag.test.ts`; whole suite `npm test`; `npm run build`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Manual GUI smoke is Keith's.

## File Structure

**Create:** `src/main/railDrag.ts`, `tests/railDrag.test.ts` (Task 1).
**Modify:** `src/preload/rail.ts`, `src/renderer/rail/rail.ts`, `src/renderer/rail/rail.css`, `src/main/index.ts` (Task 1); `src/renderer/titlebar/index.html`, `titlebar.css`, `titlebar.ts`, `window.d.ts`, `src/preload/titlebar.ts`, `src/main/serviceWindow.ts`, `src/main/index.ts` (Task 2).

---

### Task 1: Rail drag-to-detach

**Files:**
- Create: `src/main/railDrag.ts`, `tests/railDrag.test.ts`
- Modify: `src/preload/rail.ts`, `src/renderer/rail/rail.ts`, `src/renderer/rail/rail.css`, `src/main/index.ts`

**Interfaces:**
- Produces: `railDragOutcome(releaseClientX: number, railWidth: number, margin?: number): 'detach' | 'select'`; `RailBridge.dragEnd(id: string, releaseX: number): void`; `rail:dragEnd` IPC.
- Consumes: `RAIL_WIDTH` (`./layout`), `setDetached`/`showService`/`getService` (existing).

- [ ] **Step 1: Write the failing decision test**

Create `tests/railDrag.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { railDragOutcome } from '../src/main/railDrag';

describe('railDragOutcome', () => {
  it('selects when released within the rail (a plain click on the icon)', () => {
    expect(railDragOutcome(26, 52)).toBe('select');
    expect(railDragOutcome(52, 52)).toBe('select'); // exactly at the edge
  });
  it('selects when released just past the edge but inside the jitter margin', () => {
    expect(railDragOutcome(62, 52, 24)).toBe('select'); // 62 <= 52+24
    expect(railDragOutcome(76, 52, 24)).toBe('select'); // 76 not > 76
  });
  it('detaches when released comfortably past the rail edge', () => {
    expect(railDragOutcome(77, 52, 24)).toBe('detach'); // 77 > 76
    expect(railDragOutcome(300, 52)).toBe('detach');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/railDrag.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `railDrag.ts`**

Create `src/main/railDrag.ts`:

```ts
/**
 * Decide a rail drag's outcome from where the pointer was released, in coordinates relative to
 * the rail view (so a value past the rail's own width means "released to the right of the rail").
 * A release comfortably past the rail edge detaches; anything within the rail — including a plain
 * click, whose release sits on the icon — is a normal select. The margin absorbs click jitter so
 * an ordinary click can never cross the threshold.
 */
export function railDragOutcome(
  releaseClientX: number,
  railWidth: number,
  margin = 24,
): 'detach' | 'select' {
  return releaseClientX > railWidth + margin ? 'detach' : 'select';
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/railDrag.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `dragEnd` to the rail preload**

In `src/preload/rail.ts`, add to the `RailBridge` interface (after `showManager`):

```ts
  /** Report a drag that ended on a service icon; main decides detach-vs-select from releaseX. */
  dragEnd(id: string, releaseX: number): void;
```

and to `buildRailBridge`'s returned object:

```ts
    dragEnd: (id, releaseX) => ipc.send('rail:dragEnd', { id, releaseX }),
```

- [ ] **Step 6: Drag handling in the rail renderer**

In `src/renderer/rail/rail.ts`, replace the `serviceButton`'s click binding (the line `b.addEventListener('click', () => window.loftRail.select(item.id));`) with drag-aware handling. Replace that single line with:

```ts
  if (!item.sleeping && !item.detached) {
    // A live tab: press + drag it off the rail to detach; a plain click (release on the icon)
    // selects. setPointerCapture keeps the drag on this button even as the cursor crosses into
    // the content view (proven on Wayland). clientX is relative to the rail view — main decides.
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      b.classList.add('dragging');
    });
    const end = (e: PointerEvent): void => {
      if (!b.classList.contains('dragging')) return;
      b.classList.remove('dragging');
      window.loftRail.dragEnd(item.id, e.clientX);
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', () => b.classList.remove('dragging'));
  } else {
    // Sleeping / detached: plain click, unchanged (select / raise its window).
    b.addEventListener('click', () => window.loftRail.select(item.id));
  }
```

(Leave the `contextmenu` binding directly below it untouched.)

- [ ] **Step 7: A minimal "dragging" style**

In `src/renderer/rail/rail.css`, add after the `.item` rules:

```css
.item.dragging { opacity: .5; cursor: grabbing; }
```

- [ ] **Step 8: Handle `rail:dragEnd` in main**

In `src/main/index.ts`, add `RAIL_WIDTH` to the existing `./layout` import if not already imported, and add `import { railDragOutcome } from './railDrag';` near the other `./` imports. Then, next to the `rail:select`/`rail:menu` handlers, add:

```ts
  ipcMain.on('rail:dragEnd', (_e, m: { id: string; releaseX: number }) => {
    if (railDragOutcome(m.releaseX, RAIL_WIDTH) === 'detach') { setDetached(m.id, true); return; }
    const d = getService(m.id);
    if (d) showService(d); // released inside the rail ⇒ a normal click ⇒ select the tab
  });
```

- [ ] **Step 9: Build + full suite**

Run: `npm run build && npm test`
Expected: build clean; suite green including the new `railDrag` test.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(rail): drag a service icon off the rail to detach"
```

> **Manual (Keith):** drag a live service icon off the rail → it opens in its own window keeping scroll/draft/call; a normal click still selects; right-click still opens the menu; a sleeping/detached icon isn't drag-detachable.

---

### Task 2: Titlebar grab-handle to attach

**Files:**
- Modify: `src/renderer/titlebar/index.html`, `src/renderer/titlebar/titlebar.css`, `src/renderer/titlebar/titlebar.ts`, `src/renderer/titlebar/window.d.ts`, `src/preload/titlebar.ts`, `src/main/serviceWindow.ts`, `src/main/index.ts`

**Interfaces:**
- Produces: `window.loft.attach()`, `window.loft.onSetAttachable(cb)`; `titlebar:attach` + `titlebar:set-attachable` IPC.
- Consumes: `titlebarTarget` (existing, returns the host with `.def`), `setDetached` (existing).

- [ ] **Step 1: Add the (hidden) attach button**

In `src/renderer/titlebar/index.html`, add as the first child of `<div class="controls">` (before `#reload`):

```html
        <button id="attach" title="Attach to Loft" hidden>⇤</button>
```

- [ ] **Step 2: Style it**

In `src/renderer/titlebar/titlebar.css`, add:

```css
#attach { font-size: 16px; line-height: 1; }
```

(It inherits the shared `.controls button` styling; the rule just sizes the glyph like `#reload`.)

- [ ] **Step 3: Extend the titlebar preload**

In `src/preload/titlebar.ts`, add to the `exposeInMainWorld('loft', { … })` object:

```ts
  attach: () => ipcRenderer.send('titlebar:attach'),
  onSetAttachable: (cb: (on: boolean) => void) =>
    ipcRenderer.on('titlebar:set-attachable', (_e, on: boolean) => cb(on)),
```

- [ ] **Step 4: Mirror the types**

In `src/renderer/titlebar/window.d.ts`, add to the `loft` interface:

```ts
    attach(): void;
    onSetAttachable(cb: (on: boolean) => void): void;
```

- [ ] **Step 5: Wire the button in the titlebar renderer**

In `src/renderer/titlebar/titlebar.ts`, add (after the existing button wiring):

```ts
const attachEl = document.getElementById('attach')!;
attachEl.addEventListener('click', () => window.loft.attach());
window.loft.onSetAttachable((on) => { (attachEl as HTMLButtonElement).hidden = !on; });
```

- [ ] **Step 6: Mark a detached window's titlebar attachable**

In `src/main/serviceWindow.ts`, the titlebar's `did-finish-load` currently sends only the service name. Change it to also send attachable:

```ts
  titlebar.webContents.on('did-finish-load', () => {
    safeSend(titlebar, 'titlebar:set-service', def.displayName);
    safeSend(titlebar, 'titlebar:set-attachable', true);
  });
```

(The Loft window's titlebar, in `loftWindow.ts`, never sends `titlebar:set-attachable`, so its button stays hidden — no change there.)

- [ ] **Step 7: Handle `titlebar:attach` in main**

In `src/main/index.ts`, next to the other `titlebar:*` handlers, add:

```ts
  ipcMain.on('titlebar:attach', (e) => {
    const id = titlebarTarget(e.sender.id)?.def.id;
    if (id) setDetached(id, false);
  });
```

- [ ] **Step 8: Build + full suite**

Run: `npm run build && npm test`
Expected: build clean; suite green (no test touches these files).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(titlebar): grab-handle to attach a detached service back into the rail"
```

> **Manual (Keith):** a detached window's titlebar shows a `⇤` handle; clicking it moves the service back into the rail (keeping its page). The Loft window's own titlebar shows no such handle.

---

## Self-Review

**Spec coverage:**
- Detach = drag rail icon off rail → `setDetached(true)` → Task 1. ✓
- Only attached+loaded items are drag-detachable (not sleeping/detached) → Task 1 Step 6 (`!item.sleeping && !item.detached`). ✓
- Click still selects; right-click still menus; home unchanged → Task 1 Step 6 (else-branch + untouched contextmenu). ✓
- Pure, tested decision (`railDragOutcome`) → Task 1 Steps 1-4. ✓
- Attach = titlebar handle → `setDetached(false)`, only in detached windows → Task 2 (hidden by default; only `serviceWindow` sends attachable). ✓
- Both call the 09c-2a engine → Tasks 1 Step 8 / 2 Step 7 call `setDetached`. ✓
- Attach isolation from the Loft titlebar → Task 2 Step 6 note (loftWindow never sends attachable). ✓

**Placeholder scan:** none — every step has complete code.

**Type consistency:** `railDragOutcome(releaseClientX, railWidth, margin?)` matches its test, the `rail:dragEnd` handler, and takes `RAIL_WIDTH`. `RailBridge.dragEnd(id, releaseX)` matches the renderer call and the preload send. `window.loft.attach()`/`onSetAttachable` match preload, `window.d.ts`, and `titlebar.ts`. `titlebarTarget(...)?.def.id` — `ServiceHost.def` exists (added in 09b).

## Manual Verification Checklist (Keith)

- Drag a live service off the rail → own window, page preserved (scroll/draft/call); click the `⇤` handle → back in the rail.
- Plain rail click selects; right-click opens the menu; the home button and sleeping/detached icons don't drag-detach.
- The Loft window's own titlebar has no `⇤` handle.
- Detaching the active tab re-selects the next (or the manager).
