# Attach by Drag + Rail Reordering (09c-2c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drag a detached service's titlebar handle onto the Loft rail to re-attach it into a chosen slot, and drag a rail icon vertically to reorder the rail — both showing a live insertion indicator.

**Architecture:** Two input mechanisms feeding one shared brain. The rail icon keeps **pointer capture** (it natively reports releases outside the window, which is what detach means); the cross-window drop uses **HTML5 drag-and-drop** (compositor-mediated, the only thing that crosses windows). Both report positions to main, which owns all policy in pure functions and pushes back only the insertion index. The engines being driven — `setDetached`'s live-view move and `showService`'s helper-routed raise — already exist and are smoke-tested.

**Tech Stack:** TypeScript, Electron 43, Vitest. No new dependencies.

## Global Constraints

- **`src/renderer/rail/rail.ts` MUST stay import-free.** It is tsc-`commonjs` loaded as `<script type="module">`; a value `import` emits `require`/`__esModule` and throws at runtime. Only inline `type X = import('...').Y` type queries are allowed. All policy lives in `src/main/`.
- **Never infer drop success from `dragend`.** Under X11 a successful drop reported `dropEffect: "none"`. Act on the `drop` event only.
- **Foreign drags must not attach.** Use the private MIME type `application/x-loft-service` and only call `preventDefault()` when that type is present, so external drags are rejected by the browser itself.
- **`dataTransfer.getData()` returns empty during `dragover`** (browser security) — the payload id is readable only in `drop`. Nothing may depend on knowing *which* service is being dragged before the drop.
- **Raising the Loft window must go through `showService()`**, which calls `focusExternal()` (GNOME helper / KWin). A plain `focus()` is refused on Wayland.
- Run tests with `npm test`; build with `npm run build`.

---

### Task 1: `railSlotIndex` — where would this land?

**Files:**
- Create: `src/main/railSlots.ts`
- Test: `tests/railSlots.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface RailSlot { id: string; top: number; height: number }` and `export function railSlotIndex(clientY: number, slots: readonly RailSlot[]): number` — returns an insertion index in `0..slots.length`.

- [ ] **Step 1: Write the failing test**

Create `tests/railSlots.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { railSlotIndex, type RailSlot } from '../src/main/railSlots';

// Three 34px icons with a 6px gap, as the rail renders them.
const SLOTS: RailSlot[] = [
  { id: 'whatsapp', top: 50, height: 34 },
  { id: 'slack', top: 90, height: 34 },
  { id: 'telegram', top: 130, height: 34 },
];

describe('railSlotIndex', () => {
  it('returns 0 above the first icon', () => {
    expect(railSlotIndex(0, SLOTS)).toBe(0);
    expect(railSlotIndex(60, SLOTS)).toBe(0); // still in the first icon's top half
  });

  it('returns the following index once past an icon\'s midpoint', () => {
    expect(railSlotIndex(68, SLOTS)).toBe(1); // 50 + 34/2 = 67
    expect(railSlotIndex(108, SLOTS)).toBe(2); // 90 + 17 = 107
  });

  it('returns the last index below the final icon', () => {
    expect(railSlotIndex(200, SLOTS)).toBe(3);
  });

  it('treats a point exactly on a midpoint as belonging to the lower slot', () => {
    // 67 is exactly the first icon's midpoint. The test is `clientY < top + height/2`, so a
    // point ON the midpoint is not "above" it — it belongs to the slot below. 66 still is.
    expect(railSlotIndex(67, SLOTS)).toBe(1);
    expect(railSlotIndex(66, SLOTS)).toBe(0);
  });

  it('returns 0 for an empty rail', () => {
    expect(railSlotIndex(123, [])).toBe(0);
  });

  it('handles a single icon', () => {
    const one: RailSlot[] = [{ id: 'slack', top: 50, height: 34 }];
    expect(railSlotIndex(55, one)).toBe(0);
    expect(railSlotIndex(80, one)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/railSlots.test.ts`
Expected: FAIL — `Failed to resolve import "../src/main/railSlots"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/railSlots.ts`:

```ts
/** One rail icon's geometry, in coordinates relative to the rail view. */
export interface RailSlot {
  id: string;
  top: number;
  height: number;
}

/**
 * The insertion index for a pointer at `clientY` — 0 means "before the first icon",
 * `slots.length` means "after the last". An icon claims the slot above it until the
 * pointer passes its vertical midpoint, which is what makes the indicator line feel
 * like it snaps to the gap nearest the cursor.
 *
 * The renderer measures (it owns the DOM); this decides (it is testable). Slots must
 * be in visual order.
 */
export function railSlotIndex(clientY: number, slots: readonly RailSlot[]): number {
  for (let i = 0; i < slots.length; i++) {
    if (clientY < slots[i].top + slots[i].height / 2) return i;
  }
  return slots.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/railSlots.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/railSlots.ts tests/railSlots.test.ts
git commit -m "feat(rail): railSlotIndex — insertion index for a pointer position"
```

---

### Task 2: Rail ordering — read the current order, write a new one

**Files:**
- Create: `src/main/railOrder.ts`
- Modify: `src/main/railModel.ts` (extract `orderedRailIds`, have `buildRailModel` use it)
- Test: `tests/railOrder.test.ts`, `tests/railModel.test.ts` (add cases)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function orderedRailIds(services: readonly ServiceDef[], config: LoftConfig): string[]` (from `src/main/railModel.ts`) — installed service ids in rail order.
  - `export function moveInOrder(ids: readonly string[], id: string, toIndex: number): string[]` (from `src/main/railOrder.ts`) — the full new order.

- [ ] **Step 1: Write the failing test for `moveInOrder`**

Create `tests/railOrder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { moveInOrder } from '../src/main/railOrder';

const IDS = ['whatsapp', 'slack', 'telegram', 'element'];

describe('moveInOrder', () => {
  it('moves an item down to a later slot', () => {
    // insertion index 3 = "before element", i.e. after telegram
    expect(moveInOrder(IDS, 'whatsapp', 3)).toEqual(['slack', 'telegram', 'whatsapp', 'element']);
  });

  it('moves an item up to an earlier slot', () => {
    expect(moveInOrder(IDS, 'element', 1)).toEqual(['whatsapp', 'element', 'slack', 'telegram']);
  });

  it('moves an item to the very end', () => {
    expect(moveInOrder(IDS, 'slack', 4)).toEqual(['whatsapp', 'telegram', 'element', 'slack']);
  });

  it('is a no-op when dropped on its own slot (either side)', () => {
    // slack is at index 1: insertion index 1 (before itself) and 2 (after itself)
    // both mean "stay put".
    expect(moveInOrder(IDS, 'slack', 1)).toEqual(IDS);
    expect(moveInOrder(IDS, 'slack', 2)).toEqual(IDS);
  });

  it('returns the list unchanged for an unknown id', () => {
    expect(moveInOrder(IDS, 'nope', 0)).toEqual(IDS);
  });

  it('clamps an out-of-range index', () => {
    expect(moveInOrder(IDS, 'slack', 99)).toEqual(['whatsapp', 'telegram', 'element', 'slack']);
    expect(moveInOrder(IDS, 'slack', -5)).toEqual(['slack', 'whatsapp', 'telegram', 'element']);
  });

  it('does not mutate its input', () => {
    const src = [...IDS];
    moveInOrder(src, 'slack', 4);
    expect(src).toEqual(IDS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/railOrder.test.ts`
Expected: FAIL — cannot resolve `../src/main/railOrder`.

- [ ] **Step 3: Implement `moveInOrder`**

Create `src/main/railOrder.ts`:

```ts
/**
 * Move `id` to `toIndex` and return the FULL new order.
 *
 * `toIndex` is an insertion index measured against the list as it looks WITH `id` still
 * in it (that is what railSlotIndex reports), so dropping on either side of an item's own
 * slot must mean "stay put" — hence the -1 adjustment when moving down. Writing the whole
 * list rather than a delta keeps the persisted railOrder predictable; buildRailModel
 * already tolerates partial lists via its rank fallback, but there is no reason to rely
 * on that here.
 */
export function moveInOrder(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from === -1) return [...ids];
  const without = ids.filter((x) => x !== id);
  // Removing the item shifts every later position down by one.
  const adjusted = toIndex > from ? toIndex - 1 : toIndex;
  const clamped = Math.max(0, Math.min(adjusted, without.length));
  without.splice(clamped, 0, id);
  return without;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/railOrder.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Write the failing test for `orderedRailIds`**

Add to `tests/railModel.test.ts` (keep existing imports; add `orderedRailIds` to the import from `../src/main/railModel`):

```ts
describe('orderedRailIds', () => {
  const services = [
    { id: 'whatsapp', displayName: 'WhatsApp', url: 'u' },
    { id: 'slack', displayName: 'Slack', url: 'u' },
    { id: 'telegram', displayName: 'Telegram', url: 'u' },
  ] as never;

  it('lists only installed services, in registry order when railOrder is absent', () => {
    const config = { services: { whatsapp: {}, telegram: {} } } as never;
    expect(orderedRailIds(services, config)).toEqual(['whatsapp', 'telegram']);
  });

  it('honours railOrder, with unlisted ids after it in registry order', () => {
    const config = {
      services: { whatsapp: {}, slack: {}, telegram: {} },
      railOrder: ['telegram', 'slack'],
    } as never;
    expect(orderedRailIds(services, config)).toEqual(['telegram', 'slack', 'whatsapp']);
  });

  it('ignores railOrder entries for services that are not installed', () => {
    const config = { services: { slack: {} }, railOrder: ['telegram', 'slack'] } as never;
    expect(orderedRailIds(services, config)).toEqual(['slack']);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/railModel.test.ts`
Expected: FAIL — `orderedRailIds is not exported` / not a function.

- [ ] **Step 7: Extract `orderedRailIds` and use it in `buildRailModel`**

In `src/main/railModel.ts`, add this exported function above `buildRailModel`:

```ts
/**
 * Installed service ids in rail order. Extracted so main can compute the same order the
 * rail renders without duplicating the ranking rule — a drag writes railOrder, and it must
 * agree with what the user saw.
 */
export function orderedRailIds(services: readonly ServiceDef[], config: LoftConfig): string[] {
  const installed = services.filter((d) => config.services[d.id] !== undefined);
  const order = config.railOrder ?? [];
  const rank = (id: string): number => {
    const at = order.indexOf(id);
    return at === -1 ? order.length + installed.findIndex((d) => d.id === id) : at;
  };
  return [...installed].sort((a, b) => rank(a.id) - rank(b.id)).map((d) => d.id);
}
```

Then replace the ordering block inside `buildRailModel` so it defers to it. Change:

```ts
  const installed = i.services.filter((d) => i.config.services[d.id] !== undefined);
  const order = i.config.railOrder ?? [];
  const rank = (id: string): number => {
    const at = order.indexOf(id);
    return at === -1 ? order.length + installed.findIndex((d) => d.id === id) : at;
  };

  return [...installed]
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((d) => {
```

to:

```ts
  const byId = new Map(i.services.map((d) => [d.id, d]));

  return orderedRailIds(i.services, i.config)
    .map((id) => byId.get(id)!)
    .map((d) => {
```

- [ ] **Step 8: Run the full suite to verify nothing regressed**

Run: `npm test`
Expected: PASS — all files, including the existing `railModel` ordering tests unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/main/railOrder.ts src/main/railModel.ts tests/railOrder.test.ts tests/railModel.test.ts
git commit -m "feat(rail): orderedRailIds + moveInOrder, the railOrder producer"
```

---

### Task 3: `railGestureOutcome` — select vs reorder vs detach

**Files:**
- Modify: `src/main/railDrag.ts` (add a function; leave `railDragOutcome` untouched)
- Test: `tests/railDrag.test.ts` (add cases; existing ones stay as-is)

**Interfaces:**
- Consumes: the existing `railDragOutcome(releaseClientX, railWidth, margin?)` in the same file.
- Produces: `export function railGestureOutcome(i: RailGesture): 'detach' | 'reorder' | 'select' | 'none'` where
  `export interface RailGesture { releaseX: number; railWidth: number; margin?: number; canDetach: boolean; fromIndex: number; toIndex: number }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/railDrag.test.ts` (add `railGestureOutcome` to the existing import):

```ts
describe('railGestureOutcome', () => {
  const base = { railWidth: 52, margin: 24, canDetach: true, fromIndex: 1, toIndex: 1 };

  it('detaches when released outside the rail band', () => {
    expect(railGestureOutcome({ ...base, releaseX: 300 })).toBe('detach');
    expect(railGestureOutcome({ ...base, releaseX: -140 })).toBe('detach');
  });

  it('does NOTHING when an un-detachable icon is dragged out (sleeping/detached snap back)', () => {
    expect(railGestureOutcome({ ...base, releaseX: 300, canDetach: false })).toBe('none');
    expect(railGestureOutcome({ ...base, releaseX: -140, canDetach: false })).toBe('none');
  });

  it('selects when released in the band on its own slot (a plain click)', () => {
    expect(railGestureOutcome({ ...base, releaseX: 26, fromIndex: 1, toIndex: 1 })).toBe('select');
    // toIndex === fromIndex + 1 is the other side of the same gap — still "stay put".
    expect(railGestureOutcome({ ...base, releaseX: 26, fromIndex: 1, toIndex: 2 })).toBe('select');
  });

  it('reorders when released in the band on a different slot', () => {
    expect(railGestureOutcome({ ...base, releaseX: 26, fromIndex: 1, toIndex: 0 })).toBe('reorder');
    expect(railGestureOutcome({ ...base, releaseX: 26, fromIndex: 1, toIndex: 3 })).toBe('reorder');
  });

  it('still reorders an un-detachable icon dragged within the band', () => {
    // A sleeping service has no view to detach, but its rail position is still its own.
    expect(railGestureOutcome({ ...base, releaseX: 26, canDetach: false, fromIndex: 1, toIndex: 3 }))
      .toBe('reorder');
  });

  it('selects when the icon is not in the order at all (fromIndex -1) and did not leave the band', () => {
    // toIndex deliberately far from fromIndex + 1 (which would be 0): this must resolve via the
    // explicit fromIndex < 0 branch, not by coincidentally looking like "stay put".
    expect(railGestureOutcome({ ...base, releaseX: 26, fromIndex: -1, toIndex: 5 })).toBe('select');
  });

  it('prefers the out-of-band decision over the fromIndex -1 check', () => {
    // Guards the branch ORDER: an unknown-index icon dragged clear of the rail must still
    // detach (or snap back), never fall through to select.
    expect(railGestureOutcome({ ...base, releaseX: 300, fromIndex: -1, toIndex: 5 })).toBe('detach');
    expect(railGestureOutcome({ ...base, releaseX: 300, fromIndex: -1, toIndex: 5, canDetach: false }))
      .toBe('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/railDrag.test.ts`
Expected: FAIL — `railGestureOutcome is not a function`.

- [ ] **Step 3: Implement `railGestureOutcome`**

Append to `src/main/railDrag.ts`:

```ts
export interface RailGesture {
  /** Release X, relative to the rail view. */
  releaseX: number;
  railWidth: number;
  margin?: number;
  /** Only a loaded, attached service has a view to pull out into its own window. */
  canDetach: boolean;
  /** The dragged icon's current index in the rail order, or -1 if unknown. */
  fromIndex: number;
  /** The insertion index the release landed on (railSlotIndex). */
  toIndex: number;
}

/**
 * Resolve one rail-icon gesture. The horizontal axis decides whether the user left the
 * rail at all (railDragOutcome, unchanged from 09c-2b); only if they stayed does the
 * vertical axis matter.
 *
 * Dropping on either side of an icon's own gap — toIndex === fromIndex or fromIndex + 1 —
 * means "stay put", which is what keeps an ordinary click a select: its release sits on
 * the icon it started from.
 */
export function railGestureOutcome(i: RailGesture): 'detach' | 'reorder' | 'select' | 'none' {
  const left = railDragOutcome(i.releaseX, i.railWidth, i.margin) === 'detach';
  // Out of the band: pull it into its own window, or — with nothing to pull — snap back
  // rather than quietly selecting something the user was trying to throw away.
  if (left) return i.canDetach ? 'detach' : 'none';
  if (i.fromIndex < 0) return 'select';
  const samePlace = i.toIndex === i.fromIndex || i.toIndex === i.fromIndex + 1;
  return samePlace ? 'select' : 'reorder';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/railDrag.test.ts`
Expected: PASS — the 3 original `railDragOutcome` tests plus 6 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/main/railDrag.ts tests/railDrag.test.ts
git commit -m "feat(rail): railGestureOutcome — select vs reorder vs detach"
```

---

### Task 4: Rail preload — the new channels

**Files:**
- Modify: `src/preload/rail.ts`
- Test: `tests/railPreload.test.ts` (add cases)

**Interfaces:**
- Consumes: `RailSlot` from `src/main/railSlots.ts` (type-only import).
- Produces: `RailBridge` gains
  `dragBegin(slots: RailSlot[]): void`,
  `dragMove(clientX: number, clientY: number): void`,
  `dropAttach(id: string, clientY: number): void`,
  `onDropSlot(cb: (index: number) => void): () => void`,
  and `dragEnd` becomes `dragEnd(id: string, releaseX: number, releaseY: number): void`.

- [ ] **Step 1: Write the failing test**

Append to `tests/railPreload.test.ts`:

```ts
describe('rail bridge — drag channels', () => {
  it('sends drag geometry, movement, end and cross-window drop', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    const slots = [{ id: 'slack', top: 50, height: 34 }];
    b.dragBegin(slots);
    b.dragMove(10, 120);
    b.dragEnd('slack', -140, 120);
    b.dropAttach('slack', 96);
    expect(ipc.sent).toEqual([
      ['rail:dragBegin', { slots }],
      ['rail:dragMove', { clientX: 10, clientY: 120 }],
      ['rail:dragEnd', { id: 'slack', releaseX: -140, releaseY: 120 }],
      ['rail:dropAttach', { id: 'slack', clientY: 96 }],
    ]);
  });

  it('delivers the drop-slot index and unsubscribes cleanly', () => {
    const ipc = fakeIpc();
    const b = buildRailBridge(ipc as never);
    const cb = vi.fn();
    const off = b.onDropSlot(cb);
    ipc.listeners.get('rail:dropSlot')!(null, 2);
    expect(cb).toHaveBeenCalledWith(2);
    off();
    expect(ipc.listeners.has('rail:dropSlot')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/railPreload.test.ts`
Expected: FAIL — `b.dragBegin is not a function`.

- [ ] **Step 3: Implement the channels**

In `src/preload/rail.ts`, add the type import at the top (type-only, so no runtime require):

```ts
import type { RailSlot } from '../main/railSlots';
```

Replace the `dragEnd` line in the `RailBridge` interface with:

```ts
  /** Report a drag that ended on a service icon; main decides the outcome from the release. */
  dragEnd(id: string, releaseX: number, releaseY: number): void;
  /** Hand main the rail's icon geometry at drag start; it computes insertion indices from it. */
  dragBegin(slots: RailSlot[]): void;
  /** Live pointer/dragover position during a drag. */
  dragMove(clientX: number, clientY: number): void;
  /** A cross-window HTML5 drop landed on the rail — attach this service at this position. */
  dropAttach(id: string, clientY: number): void;
  /** Insertion index to draw the indicator at; -1 hides it. Returns an unsubscribe. */
  onDropSlot(cb: (index: number) => void): () => void;
```

And in `buildRailBridge`, replace the `dragEnd` property with:

```ts
    dragEnd: (id, releaseX, releaseY) => ipc.send('rail:dragEnd', { id, releaseX, releaseY }),
    dragBegin: (slots) => ipc.send('rail:dragBegin', { slots }),
    dragMove: (clientX, clientY) => ipc.send('rail:dragMove', { clientX, clientY }),
    dropAttach: (id, clientY) => ipc.send('rail:dropAttach', { id, clientY }),
    onDropSlot(cb) {
      const h = (_e: unknown, index: number): void => cb(index);
      ipc.on('rail:dropSlot', h);
      return () => ipc.removeListener('rail:dropSlot', h);
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/railPreload.test.ts`
Expected: PASS — existing 4 tests plus 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/preload/rail.ts tests/railPreload.test.ts
git commit -m "feat(rail): preload channels for drag geometry, movement and cross-window drop"
```

---

### Task 5: Titlebar — make the `⇤` handle a drag source

**Files:**
- Modify: `src/renderer/titlebar/index.html`
- Modify: `src/renderer/titlebar/titlebar.ts`
- Modify: `src/renderer/titlebar/window.d.ts`
- Modify: `src/preload/titlebar.ts`
- Modify: `src/main/serviceWindow.ts:65-68` (send the service id, not a bare `true`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the rail's drop payload — MIME `application/x-loft-service`, value = the service id string.

**Note:** these are renderer/preload wiring changes with no vitest-importable seam (the titlebar preload calls `contextBridge` at import time and has no factory, unlike `buildRailBridge`). They are covered by the build and the manual smoke test, matching how this codebase already treats `loftWindow`/`index.ts`. Do not refactor the titlebar preload as part of this task.

- [ ] **Step 1: Make the handle draggable in the markup**

In `src/renderer/titlebar/index.html`, replace the attach button line:

```html
        <button id="attach" title="Attach to Loft" hidden>⇤</button>
```

with:

```html
        <button id="attach" title="Attach to Loft — click, or drag onto the Loft rail" draggable="true" hidden>⇤</button>
```

- [ ] **Step 2: Carry the service id to the renderer**

In `src/preload/titlebar.ts`, replace the `onSetAttachable` line with one that passes an id-or-null:

```ts
  onSetAttachable: (cb: (id: string | null) => void) =>
    ipcRenderer.on('titlebar:set-attachable', (_e, id: string | null) => cb(id)),
```

In `src/renderer/titlebar/window.d.ts`, change the matching signature:

```ts
    onSetAttachable(cb: (id: string | null) => void): void;
```

In `src/main/serviceWindow.ts`, in the titlebar `did-finish-load` handler (currently lines 65–68), replace:

```ts
    safeSend(titlebar, 'titlebar:set-attachable', true);
```

with:

```ts
    // The id, not a bare flag: the renderer needs it as the drag payload so the rail
    // knows which service was dropped (dataTransfer is unreadable until 'drop').
    safeSend(titlebar, 'titlebar:set-attachable', def.id);
```

- [ ] **Step 3: Wire the drag source in the titlebar renderer**

In `src/renderer/titlebar/titlebar.ts`, replace the last two lines:

```ts
const attachEl = document.getElementById('attach')!;
attachEl.addEventListener('click', () => window.loft.attach());
window.loft.onSetAttachable((on) => { (attachEl as HTMLButtonElement).hidden = !on; });
```

with:

```ts
// The ⇤ handle attaches this service two ways: click (unchanged), or drag it onto the
// Loft window's rail to choose the slot it lands in. It must be the drag source rather
// than the titlebar itself — the titlebar's drag region belongs to the compositor for
// moving the window, and HTML5 drags cannot start there.
const RAIL_MIME = 'application/x-loft-service';
const attachEl = document.getElementById('attach') as HTMLButtonElement;
let serviceId: string | null = null;

attachEl.addEventListener('click', () => window.loft.attach());
window.loft.onSetAttachable((id) => {
  serviceId = id;
  attachEl.hidden = id === null;
});

attachEl.addEventListener('dragstart', (e) => {
  if (!serviceId || !e.dataTransfer) { e.preventDefault(); return; }
  // A private type, so dragging text or a link from any other app can never look like
  // an attach. Some platforms also want a plain-text fallback for the drag to start.
  e.dataTransfer.setData(RAIL_MIME, serviceId);
  e.dataTransfer.setData('text/plain', serviceId);
  e.dataTransfer.effectAllowed = 'move';
});
```

- [ ] **Step 4: Build to verify it compiles**

Run: `npm run build`
Expected: completes with no TypeScript errors.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/titlebar src/preload/titlebar.ts src/main/serviceWindow.ts
git commit -m "feat(titlebar): the attach handle is a drag source carrying the service id"
```

---

### Task 6: Rail renderer — report drags, draw the indicator, accept drops

**Files:**
- Modify: `src/renderer/rail/rail.ts`
- Modify: `src/renderer/rail/rail.css`
- Modify: `src/renderer/rail/index.html`

**Interfaces:**
- Consumes: `window.loftRail.dragBegin/dragMove/dragEnd/dropAttach/onDropSlot` (Task 4).
- Produces: nothing for later tasks except the IPC traffic Task 7 handles.

**Note:** `rail.ts` MUST remain import-free — no `import` statements of any kind beyond inline `type X = import('...').Y`. Verify by eye before committing.

- [ ] **Step 1: Add the indicator element to the markup**

In `src/renderer/rail/index.html`, add the indicator as a sibling of the nav (the nav's children are replaced on every render, so the line must live outside it):

```html
    <nav id="rail" aria-label="Services"></nav>
    <div id="slot" aria-hidden="true"></div>
```

- [ ] **Step 2: Style the indicator**

Append to `src/renderer/rail/rail.css`:

```css
/* Insertion indicator: where a dragged icon would land. Fixed-position so it is not a
   child of #rail, whose children are replaced on every render. */
#slot {
  position: fixed; left: 5px; width: 42px; height: 3px;
  background: #0071e3; border-radius: 2px;
  display: none; pointer-events: none;
}
#slot.show { display: block; }
@media (prefers-color-scheme: dark) {
  #slot { background: #0a84ff; }
}
```

- [ ] **Step 3: Rewrite the drag wiring in the renderer**

In `src/renderer/rail/rail.ts`:

**(a)** Add module-level state just below the existing `const root = ...` line:

```ts
const slotLine = document.getElementById('slot')!;
const RAIL_MIME = 'application/x-loft-service';

type Slot = import('../../main/railSlots').RailSlot;
let slots: Slot[] = [];
let dragging = false;

/** Measure every icon so main can compute insertion indices from real geometry. */
function measure(): Slot[] {
  return [...root.querySelectorAll<HTMLElement>('.item')].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.id ?? '', top: r.top, height: r.height };
  });
}

/** Draw the insertion line at an index, or hide it for -1. */
function showSlot(index: number): void {
  if (index < 0 || slots.length === 0) { slotLine.classList.remove('show'); return; }
  const y = index < slots.length
    ? slots[index].top - 2
    : slots[slots.length - 1].top + slots[slots.length - 1].height - 1;
  slotLine.style.top = `${y}px`;
  slotLine.classList.add('show');
}

function beginDrag(): void {
  slots = measure();
  dragging = true;
  window.loftRail.dragBegin(slots);
}

function endDrag(): void {
  dragging = false;
  showSlot(-1);
  // Apply whatever we refused to render mid-gesture.
  if (pendingState) {
    const s = pendingState;
    pendingState = null;
    render(s);
  }
}
```

Also declare, beside `dragging`:

```ts
/** A rail:state that arrived mid-drag; applied once the gesture ends (see render). */
let pendingState: RailState | null = null;
```

**(b)** Replace the whole `if (!item.sleeping && !item.detached) { ... } else { ... }` block in `serviceButton` with the version below. Every icon is now draggable — position belongs to the service list, not to load state — and main decides what the gesture meant:

```ts
  b.dataset.id = item.id;

  // Every icon drags: vertically to reorder, off the rail to detach. Main resolves which
  // (railGestureOutcome) — it knows whether this service even has a view to pull out.
  // setPointerCapture keeps the whole gesture on this button even once the cursor leaves
  // the window, which is what makes "drag it out to the desktop" detectable at all.
  b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // primary button only — middle/right fall through
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    b.classList.add('dragging');
    beginDrag();
  });
  b.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    window.loftRail.dragMove(e.clientX, e.clientY);
  });
  b.addEventListener('pointerup', (e) => {
    if (!b.classList.contains('dragging')) return;
    b.classList.remove('dragging');
    endDrag();
    window.loftRail.dragEnd(item.id, e.clientX, e.clientY);
  });
  b.addEventListener('pointercancel', () => { b.classList.remove('dragging'); endDrag(); });
  // Keyboard activation (Enter/Space) dispatches a synthetic click with detail 0, not
  // pointer events; mouse clicks (detail >= 1) stay owned by the pointer path above.
  b.addEventListener('click', (e) => { if (e.detail === 0) window.loftRail.select(item.id); });
```

**(c)** Append the drop-target wiring and the indicator subscription at the very bottom of the file, after the existing `window.loftRail.onState(render);` line:

```ts
// --- cross-window drop target (attach) --------------------------------------
// A drag from a detached window's titlebar. Only OUR type is accepted: preventDefault is
// what tells the browser a drop is allowed, so withholding it for anything else makes the
// rail reject stray text/link/file drags automatically. dataTransfer.getData() is empty
// until 'drop' by design, so the service id is unknown until then — which is fine, the
// indicator only needs a position.
const ours = (e: DragEvent): boolean =>
  Boolean(e.dataTransfer && [...e.dataTransfer.types].includes(RAIL_MIME));

root.addEventListener('dragenter', (e) => {
  if (!ours(e)) return;
  e.preventDefault();
  beginDrag();
});
root.addEventListener('dragover', (e) => {
  if (!ours(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';
  window.loftRail.dragMove(e.clientX, e.clientY);
});
root.addEventListener('dragleave', (e) => {
  // Only when the pointer actually leaves the rail, not on every child transition.
  if (e.relatedTarget && root.contains(e.relatedTarget as Node)) return;
  endDrag();
});
root.addEventListener('drop', (e) => {
  if (!ours(e)) return;
  e.preventDefault();
  const id = e.dataTransfer!.getData(RAIL_MIME);
  endDrag();
  if (id) window.loftRail.dropAttach(id, e.clientY);
});

// Main pushes the insertion index only when it changes.
window.loftRail.onDropSlot(showSlot);
```

**(d)** Defer re-renders that land mid-drag. `replaceChildren` destroys and recreates every icon button — including the one holding pointer capture — and the replacement node never receives the `pointerup`, orphaning the gesture. Replace the body of `render` with:

```ts
function render(state: RailState): void {
  // Never re-render mid-drag. replaceChildren would destroy the very button holding pointer
  // capture, and the replacement node never receives the pointerup — orphaning the gesture:
  // `dragging` stuck true, dragEnd never sent, the indicator stranded, and every later hover
  // reporting movement. A badge landing a second late is invisible next to that. Deferred
  // state is flushed by endDrag(). This also makes the drag's measured geometry stay valid
  // for its whole duration, which is why no mid-drag re-measure is needed.
  if (dragging) { pendingState = state; return; }
  const divider = document.createElement('div');
  divider.className = 'divider';
  divider.setAttribute('aria-hidden', 'true');
  root.replaceChildren(
    homeButton(state.managerActive),
    ...(state.items.length ? [divider, ...state.items.map(serviceButton)] : []),
  );
}
```

- [ ] **Step 4: Verify `rail.ts` has no runtime imports**

Run: `grep -n "^import\|require(" src/renderer/rail/rail.ts`
Expected: no output (the only `import` is inline inside a `type` alias, which does not match `^import`).

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: completes with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/rail src/renderer/rail/rail.css
git commit -m "feat(rail): drop indicator, drag reporting, and cross-window drop target"
```

---

### Task 7: Main — wire the gestures to the engines

**Files:**
- Modify: `src/main/index.ts` (the `rail:*` IPC block around line 550)
- Modify: `src/main/loftWindow.ts` (add `sendRail`)

**Interfaces:**
- Consumes: `railSlotIndex`/`RailSlot` (Task 1), `orderedRailIds`/`moveInOrder` (Task 2), `railGestureOutcome` (Task 3), the preload channels (Task 4), the renderer traffic (Task 6).
- Produces: the finished feature. Nothing later depends on it.

- [ ] **Step 1: Let main push to the rail view**

In `src/main/loftWindow.ts`, add to the `LoftWindow` interface, directly below `sendManager`:

```ts
  /** Push to the rail view (e.g. the live drop-slot index during a drag). */
  sendRail(channel: string, ...args: unknown[]): void;
```

and to the `api` object, directly below the `sendManager` property:

```ts
    sendRail: (channel, ...args) => safeSend(rail, channel, ...args),
```

- [ ] **Step 2: Add the imports in index.ts**

In `src/main/index.ts`, beside the existing `import { railDragOutcome } from './railDrag';` line, replace it with and add:

```ts
import { railDragOutcome, railGestureOutcome } from './railDrag';
import { railSlotIndex, type RailSlot } from './railSlots';
import { moveInOrder } from './railOrder';
import { orderedRailIds } from './railModel';
```

Keep whatever `railModel` import already exists on one line if there is one.
`railDragOutcome` stays imported only if still referenced; if the old `rail:dragEnd` handler was its only user, drop it from the import to avoid an unused-symbol error.

- [ ] **Step 3: Replace the `rail:dragEnd` handler with the full gesture wiring**

In `src/main/index.ts`, replace the entire existing handler:

```ts
  ipcMain.on('rail:dragEnd', (_e, m: { id: string; releaseX: number }) => {
    const d = getService(m.id);
    if (!d) return;
    if (railDragOutcome(m.releaseX, RAIL_WIDTH) === 'detach') setDetached(m.id, true);
    showService(d);
  });
```

with:

```ts
  // --- rail drag gestures -----------------------------------------------------
  // The renderer measures and reports; main owns every decision (see railSlots/
  // railGestureOutcome). One cached geometry snapshot serves both gesture kinds: a
  // pointer-capture drag of a rail icon, and a cross-window HTML5 drop from a detached
  // window's titlebar.
  let railDrag: { slots: RailSlot[]; lastIndex: number } | undefined;

  const railIds = (): string[] => orderedRailIds(listServices(), config);

  const setRailOrder = (ids: string[]): void => {
    config.railOrder = ids;
    saveConfig(configPath(), config);
    loft?.refreshRail();
  };

  const clearRailDrag = (): void => {
    railDrag = undefined;
    loft?.sendRail('rail:dropSlot', -1);
  };

  ipcMain.on('rail:dragBegin', (_e, m: { slots: RailSlot[] }) => {
    // lastIndex starts at a value no real index can equal, so the first move always pushes.
    railDrag = { slots: m.slots, lastIndex: -2 };
  });

  ipcMain.on('rail:dragMove', (_e, m: { clientX: number; clientY: number }) => {
    if (!railDrag) return;
    // Outside the rail band the gesture means detach, not reorder — hide the indicator
    // rather than promising a slot the release will not honour.
    const outside = railDragOutcome(m.clientX, RAIL_WIDTH) === 'detach';
    const index = outside ? -1 : railSlotIndex(m.clientY, railDrag.slots);
    if (index === railDrag.lastIndex) return;
    railDrag.lastIndex = index;
    loft?.sendRail('rail:dropSlot', index);
  });

  ipcMain.on('rail:dragEnd', (_e, m: { id: string; releaseX: number; releaseY: number }) => {
    const slots = railDrag?.slots ?? [];
    clearRailDrag();
    const d = getService(m.id);
    if (!d) return;
    const ids = railIds();
    // Only a service that is loaded AND currently a tab of the Loft window has a view to
    // pull out; a sleeping or already-detached icon snaps back instead.
    const canDetach = loft?.has(m.id) === true && config.services[m.id]?.detached !== true;
    const toIndex = railSlotIndex(m.releaseY, slots);
    switch (railGestureOutcome({
      releaseX: m.releaseX,
      railWidth: RAIL_WIDTH,
      canDetach,
      fromIndex: ids.indexOf(m.id),
      toIndex,
    })) {
      case 'detach':
        setDetached(m.id, true);
        showService(d);
        break;
      case 'reorder':
        setRailOrder(moveInOrder(ids, m.id, toIndex));
        break;
      case 'select':
        showService(d);
        break;
      case 'none':
        break;
    }
  });

  // A detached service dragged back onto the rail: land it in the dropped slot, move the
  // live view home (no reload), select it, and raise the Loft window — showService routes
  // through the GNOME helper / KWin because a plain focus() is refused on Wayland.
  ipcMain.on('rail:dropAttach', (_e, m: { id: string; clientY: number }) => {
    const slots = railDrag?.slots ?? [];
    clearRailDrag();
    const d = getService(m.id);
    if (!d || config.services[m.id]?.detached !== true) return;
    setRailOrder(moveInOrder(railIds(), m.id, railSlotIndex(m.clientY, slots)));
    setDetached(m.id, false);
    showService(d);
  });
```

- [ ] **Step 4: Verify `listServices` is imported**

Run: `grep -n "listServices" src/main/index.ts | head -3`
Expected: at least one line showing it imported from `./registry`. If absent, add it to the existing `./registry` import.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: completes with no TypeScript errors.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — all tests including the new `railSlots`, `railOrder`, `railDrag` and `railPreload` cases.

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts src/main/loftWindow.ts
git commit -m "feat(rail): wire drag gestures to reorder, detach and attach-by-drop"
```

---

### Task 8: Verify end to end

**Files:** none modified — this task is verification only.

**Interfaces:**
- Consumes: everything above.
- Produces: a smoke-test result.

- [ ] **Step 1: Full build and test**

Run: `npm run build && npm test`
Expected: build clean; all tests pass.

- [ ] **Step 2: Confirm the renderer constraint held**

Run: `grep -n "^import\|require(" src/renderer/rail/rail.ts`
Expected: no output. (A runtime import here throws at load and silently kills the rail.)

- [ ] **Step 3: Build the Flatpak**

Run:
```bash
flatpak-builder --user --disable-cache --force-clean --repo=.flatpak-repo build-dir chat.loft.Loft.yml
```
Expected: exit 0.

If it fails with `rofiles-fuse ... Permission denied`, a previous interrupted build left a stale FUSE mountpoint. Clear it and retry:
```bash
rm -rf .flatpak-builder/rofiles
```

- [ ] **Step 4: Install and verify the bytes**

Run:
```bash
flatpak update --user -y chat.loft.Loft
grep -n "railGestureOutcome" ~/.local/share/flatpak/app/chat.loft.Loft/current/active/files/main/dist/main/index.js
```
Expected: the grep prints at least one line.

- [ ] **Step 5: Hand the smoke test to Keith**

Do NOT launch the Flatpak GUI from automation (zypak's renderer spawn breaks). Report that the build is installed and ask Keith to quit and relaunch Loft, then check:

1. **Click still selects** a rail icon (mouse and keyboard).
2. **Drag an icon vertically** within the rail → insertion line follows; release → it moves there.
3. **Order survives a restart** (quit, relaunch, order is as left).
4. **Drag an icon off the rail** (left onto the desktop, and right into the content) → still detaches. *This gesture was modified — it needs re-testing.*
5. **Drag a sleeping or detached icon off the rail** → nothing happens, no detach.
6. **Drag a detached window's `⇤` onto a rail slot** → attaches there, becomes the active tab, Loft raises.
7. **Click `⇤`** (no drag) → still attaches, as before.
8. **Drag a text selection or a link from another app onto the rail** → nothing happens.

- [ ] **Step 6: Record the result**

Once Keith confirms, tick the smoke boxes in `dev_local/scratchpad.md` under the 09c-2c entry and append the outcome to `.superpowers/sdd/progress.md`.

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: mechanism split (Tasks 6+7), renderer-measures/main-decides (1, 6, 7), gesture matrix (3, 6, 7), every-icon-reorderable and the sleeping/detached no-op (3, 6, 7), `⇤` as drag source keeping its click (5), on-drop attach + select + helper raise (7), `railSlots`/`railOrder`/`railDrag` units (1–3), preload channels (4), titlebar id plumbing (5), the private MIME guard (5, 6), `dragend` never consulted (6 — only `drop` sends), mid-drag re-measure (6d), unknown/not-detached payload ignored (7), empty rail (1), and the full test list (1–4 unit, 8 smoke).

**Placeholders.** None — every code step contains the actual code, every command its expected output.

**Type consistency.** `RailSlot { id, top, height }` is defined in Task 1 and used verbatim in 4, 6, 7. `railSlotIndex(clientY, slots)`, `moveInOrder(ids, id, toIndex)`, `orderedRailIds(services, config)` and `railGestureOutcome(RailGesture)` keep identical signatures at every call site. The `dragEnd` signature change (adding `releaseY`) is made in Task 4 and consumed consistently in 6 and 7. `sendRail` is added in Task 7 Step 1 before its first use in Step 3.

**One deliberate deviation from strict TDD:** Tasks 5–7 are renderer/preload/main wiring with no vitest-importable seam, so they are verified by build plus the Task 8 smoke test rather than by unit tests. This matches how this codebase already treats `loftWindow.ts` and `index.ts`. All policy that *can* be unit-tested was pushed into Tasks 1–3 precisely so this remainder is thin.
