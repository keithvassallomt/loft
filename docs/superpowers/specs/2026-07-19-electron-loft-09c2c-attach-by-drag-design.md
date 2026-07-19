# Electron Loft 09c-2c — Attach by drag, and rail reordering

**Status:** design approved (2026-07-19), pending implementation plan.

Completes the direct-manipulation story for the unified window. **Attach** a detached service by dragging its titlebar handle onto the Loft rail, landing it in a chosen slot; **reorder** the rail by dragging an icon within it. Both show a live insertion indicator. Both drive engines that already exist.

## Why

09c-2b shipped drag-to-detach and a click-only titlebar grab-handle to attach. Its spec ruled out drag-to-attach and the cursor-following drop-slot as "not viable on Wayland" — **that reasoning was wrong and has been retracted** (see the correction at the top of `2026-07-19-electron-loft-09c2b-drag-gestures-design.md`). It reasoned only about *pointer capture*, whose same-surface limitation is real, and never considered compositor-mediated drag-and-drop, which is the platform's sanctioned cross-window mechanism and needs no global cursor.

Separately, `config.railOrder` has existed since 09a and `buildRailModel` sorts by it, but **nothing has ever written it**. The consumer was built; the producer never was. This slice supplies it.

### Spike evidence (`dev_local/dnd_spike/`)

Verified in **4/4 configurations** — Flatpak sandbox, unpackaged native-Wayland, unpackaged X11, unpackaged default:

- **Cross-window HTML5 DnD works**, including a drop onto a window that is **behind, occluded and unfocused** (only its rail exposed). The compositor routes it; no global cursor involved.
- **`dragover` reports live `clientY`** over the rail — the drop-slot signal that pointer capture could never provide.
- **Raising the target on drop is REFUSED on Wayland.** `show() + focus()` left the window unfocused in every config except forced-X11. The unpackaged *default* run also refused, so Electron 43 picks native Wayland by default and **deb/rpm/AppImage need this too**. Attach must raise via the **GNOME helper / KWin**, the route `Show()` already uses.
- **TRAP:** under X11 the drop fired and delivered its payload while `dragend` reported `dropEffect: "none"`. **Act on `drop`; never infer success from `dragend`.**

## Decisions

### Mechanism: split by tool, shared brain

Pointer capture owns the rail icon; HTML5 DnD owns the cross-window drop. Both feed the same slot math and the same indicator, so there is one definition of "where would this land".

The alternatives are ruled out by measurement, not preference:

- **All-HTML5-DnD** (rail icons draggable too; detach = "dragend with no drop") — `dragend` gives no position and an unreliable `dropEffect`. Detach would be guesswork.
- **All-pointer-capture** — cannot cross windows. That is the entire finding.

That the two gestures want different tools is not accidental: detach is defined by leaving *every* target, which is precisely what DnD cannot describe.

### The renderer measures, main decides

`src/renderer/rail/rail.ts` is tsc-`commonjs` loaded as `<script type="module">`, so a value `import` emits `require`/`__esModule` and throws — only inline `type X = import('...').Y` queries are allowed. This is the same constraint that put `railDragOutcome` in `src/main/`, and it holds here.

On drag start the renderer measures each icon's rect **once** and ships it. Main computes the slot and pushes back **only when the index changes**. The indicator snaps between slots rather than tracking pixels, so this is a handful of messages per drag — no lag, and the policy stays unit-testable.

### Gesture matrix

Rail icon (pointer capture) — one gesture, three outcomes decided by where it goes:

| During drag | At release | Outcome |
|---|---|---|
| stays in rail band, same slot | on itself | **select** (today's click, preserved) |
| stays in rail band, moved vertically | different slot | **reorder** → write `railOrder` |
| leaves the band sideways | outside | **detach** (today's behaviour, unchanged) |

Cross-window: detached titlebar `⇤` → drag → rail slot ⇒ **attach + position**.

- **Every rail icon is reorderable** — live, sleeping or detached. Position is a property of the service list, not of load state.
- **Dragging a sleeping or detached icon off the rail is a no-op** that snaps back (there is no view to detach).
- The `⇤` handle **keeps its click behaviour** unchanged as the fallback. It is already `-webkit-app-region: no-drag`, so it can be a DnD source; the titlebar's drag region cannot be, since the compositor owns that for window-moving.

### On drop (attach)

Write `railOrder`, `setDetached(id, false)` (the existing live-view move — no reload), select it as the active tab, and **raise the Loft window via the GNOME helper / KWin**. Dropping is explicit intent aimed at a specific slot, so the user should end up looking at what they dropped.

## Non-goals

- **Converting detach to DnD** — pointer capture is the better tool for it (see above), and it is already shipped and smoke-tested twice.
- **Dragging a service between two Loft windows** — there is only ever one Loft window.
- **Reordering from the manager UI** — the rail is the direct-manipulation surface; a list-based reorder is a separate question.
- **Cross-application drops** (dragging a service to another app) — explicitly rejected, see the MIME guard below.

## Components

| Unit | Purpose |
|---|---|
| `src/main/railSlots.ts` **(new, pure)** | `railSlotIndex(clientY, slots) → index` — the insertion index for a pointer position. |
| `src/main/railOrder.ts` **(new, pure)** | `moveInOrder(ids, id, toIndex) → ids[]` — writes a **full** ordered list (predictable; `buildRailModel` already tolerates partials via its `rank` fallback). |
| `src/main/railDrag.ts` **(extended)** | Gains `'reorder'` alongside `'detach'`/`'select'`, plus a guard so sleeping/detached icons cannot detach. Existing tests extend, not replace. |
| `src/preload/rail.ts` | New channels: `dragBegin(id, slots)`, `dragMove(x, y)`, `dropAttach(id, y)`, `onDropSlot(cb)`. `dragEnd` extended with `clientY`. |
| `src/renderer/rail/rail.ts` | Reports drag positions; renders the insertion line; becomes an HTML5 **drop target**. Stays import-free. |
| `src/renderer/rail/rail.css` | The insertion-line element. |
| `src/renderer/titlebar/*` | `#attach` becomes `draggable`, with `dragstart` carrying the service id. Keeps its click. |
| `src/main/index.ts` | Wires the new IPC; `setRailOrder` persists to config. |

The titlebar renderer currently only receives a **display name** (`titlebar:set-service`) and a boolean (`titlebar:set-attachable`). It needs the **service id** for the drag payload, so `titlebar:set-attachable` carries the id instead of a bare `true`.

## Data flow

**Reorder** — `pointerdown` → renderer measures + `rail:dragBegin{id, slots}` → `pointermove` → `rail:dragMove{x, y}` → main computes → pushes `rail:dropSlot{index}` on change → line renders → `pointerup` → `rail:dragEnd{x, y}` → main picks select / reorder / detach.

**Attach** — titlebar `⇤` `dragstart` (payload = service id) → *compositor* → rail `dragenter`/`dragover` → same `dragMove` path → same indicator → `drop` → main: write `railOrder`, `setDetached(false)`, select, raise via helper.

## Error handling and edge cases

- **Foreign drags must not attach.** The spike used `text/plain`, which would mean dragging *any* text or link onto the rail attempts an attach. The real thing uses a private MIME type **`application/x-loft-service`**, and only calls `preventDefault()` when that type is present — so external drags are rejected by the browser naturally rather than by an id lookup failing.
- **`dragend` is never consulted** for success. Decisions come from `drop` only.
- **Rail re-render mid-drag** (a badge arrives) invalidates cached geometry — the renderer re-sends it whenever it re-renders during an active drag.
- **Unknown payload id**, or a payload naming a service that is not actually detached → ignored.
- **Empty rail** (no installed services) → `railSlotIndex` returns 0; a drop still attaches.
- **Drop while the Loft window is hidden** cannot occur (nothing to drop onto), so no special case.

## Testing

**Unit**
- `railSlots`: above first, between two, below last, empty rail, single item, exactly on a midpoint.
- `railOrder`: move up, move down, move to same index (no-op), unknown id, partial existing order backfilled.
- `railDrag` (extended): the three outcomes, band boundaries, and the sleeping/detached no-detach guard.
- `railPreload` (extended): the new channels round-trip.

**Manual smoke (Keith)**
- Full gesture matrix: click still selects; vertical drag reorders; drag off rail still detaches.
- Drag a detached service onto a chosen slot → attaches there, becomes active, Loft raises.
- Order survives a restart (persisted to config).
- Drag a text selection or link from another app onto the rail → nothing happens.
- **Re-test detach specifically** — this slice modifies that gesture.
- One Flatpak pass.
