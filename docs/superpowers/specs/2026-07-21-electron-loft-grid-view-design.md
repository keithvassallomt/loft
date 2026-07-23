# Grid View

Status: design
Date: 2026-07-21

## 1. Goal

Let the user watch several services at once instead of switching between them. A new
**Grid** view in the Loft window tiles live service views side by side, arranged by
dragging, resized by dragging the dividers, and persisted across restarts.

The services in the grid are the same live `WebContentsView` objects the rail already
owns — not second copies, not reloads. A call running in a cell survives being tiled,
resized, and moved, for the same reason it survives detach today (spec 09 §10a/§10b).

## 2. Decisions

Settled during brainstorming, each with the alternative that lost:

| # | Decision | Rejected |
|---|----------|----------|
| D1 | Grid is a **pinned rail entry** at the top of the rail. Selecting it fills the content rect with the tiled arrangement. | A separate grid window; a titlebar mode toggle |
| D2 | Grid membership and rail selection are **independent facts**. Clicking a service in the rail always shows it full-size and merely deselects Grid; the arrangement is untouched and repopulates when Grid is selected again. | Placeholder-in-cell while borrowed; rail icon focuses the cell instead |
| D3 | Layout is a **binary split tree**, i3-style. A drop splits a cell; a divider resizes exactly its two neighbours; removing a cell collapses its sibling into the space. Holes and overlaps are unrepresentable. | Row/column tracks with spans; preset layouts by cell count |
| D4 | Each cell carries a **22px header strip** — icon, name, badge, drag handle, ✕. | Hover-revealed floating controls; a separate Arrange mode |
| D5 | A drag aims with **edge zones**: the closest edge of the cell under the pointer decides the split axis and side. | Auto-place into the largest cell |
| D6 | The titlebar zoom buttons act on the **focused cell**. | Per-cell zoom in each header; no zoom in grid |

D4 is not a taste decision. See §4.

## 3. What the user sees

**Empty.** Clicking Grid the first time shows a centred `＋` and "Drag a service here
from the rail, or click ＋ to add one". Zoom buttons are dimmed — nothing is focused.

**Populated.** Each cell is a 22px header strip above the live service. The header shows
the service icon, its name, its unread badge, a drag handle (`⠿`) and a `✕`. Cells are
separated by 6px gutters. The focused cell's header takes an accent tint.

**Adding.** Drag a rail icon into the content area: the cell under the pointer shows a
blue preview rectangle of exactly the half you would take. Release to split. Or click
`＋` in the titlebar for a menu of services not already in the grid, which auto-places.

**Removing.** A cell's `✕` removes it from the grid only. The service keeps running and
stays in the rail. Its sibling expands to reclaim the space.

## 4. Architecture: why nothing overlaps

A `WebContentsView` has no click-through. A transparent view stacked over a live service
still swallows every pointer event in its rect — [electron#49039][i49039] is open with no
implementation in sight, and [electron#23863][i23863] (`setIgnoreMouseEvents` for views)
has been open since 2020. Any design that paints chrome *over* a page is therefore
buying a permanent input bug.

So the grid inverts the stack:

```
                    ┌─────────────────────────────────────┐
  content rect      │  grid chrome view  (bottom, always) │
                    │   ├── header strip per cell         │
                    │   ├── gutters between cells         │
                    │   └── empty state when tree is null │
                    ├─────────────────────────────────────┤
                    │  service view ×N   (mounted above,  │
                    │                     body rect only) │
                    ├─────────────────────────────────────┤
                    │  drag overlay view (top, hidden     │
                    │                     except in drag) │
                    └─────────────────────────────────────┘
```

One **grid chrome view** fills the whole content rect and renders all the furniture.
Each service view is then mounted *on top of it*, occupying only the body rect below its
own header. Headers and gutters are simply the regions no service view covers — so the
chrome view receives those clicks natively, the pages receive theirs, and no view ever
overlaps another. The click-through problem is designed out rather than worked around.

The one thing that must appear *over* a live cell is the blue drop preview. That gets a
**drag overlay view** with `setBackgroundColor('#00000000')`, created once when the grid
is built and toggled with `setVisible()`. It is created eagerly and never per drag,
because [electron#47351][i47351] (open) reports a freshly created view failing to cover
lower views until its page finishes loading — a flicker we avoid by never creating one
mid-gesture. It swallowing pointer events is harmless: during a drag the events are
already going to the rail via pointer capture.

**Stacking.** `addChildView` appends, and appending a view that is already a child
re-raises it to topmost — that is the documented and maintainer-endorsed way to reorder
(there is no raise/lower API). Index-to-depth direction is *not* documented, so the
design never relies on it. Instead, any structural change ends with a `restack()` that
re-adds in order: chrome, each service view, overlay. Deterministic, and immune to the
undocumented part.

A service view is **not one view**. A stuck or crashed service has a recovery overlay
stacked above its page, so restacking must re-add *both*, page first — hence
`ServiceView.raise()` rather than `addChildView(sv.view)` at the call site. Re-adding the
page alone raises it above its own recovery overlay and buries the UI that exists to
rescue it, and a badge tick is enough to trigger it (`setBadge` → `refreshAll` →
`refreshGrid` → `restack`). `raise()` also re-asserts `setVisible`, because a re-add is
not documented to carry a `false` across and the grid restacks views it has deliberately
hidden — every service not in the tree.

[i49039]: https://github.com/electron/electron/issues/49039
[i23863]: https://github.com/electron/electron/issues/23863
[i47351]: https://github.com/electron/electron/issues/47351

## 5. The layout model

```ts
export type GridNode =
  | { kind: 'leaf'; service: string }
  | { kind: 'split'; dir: 'row' | 'col'; ratio: number; a: GridNode; b: GridNode };
```

`dir: 'row'` splits left/right (children side by side); `'col'` splits top/bottom.
`ratio` is the fraction of the axis given to `a`, clamped to keep both children above
the minimum. An empty grid is `null`.

Invariants, enforced by construction rather than validation:

- Every service appears **at most once**. A single view object cannot render twice.
- A `split` always has exactly two children. Removing a leaf replaces its parent with
  the surviving sibling, so no split is ever left with one child.
- The tree is the whole arrangement. There is no separate list of members — membership
  *is* being a leaf.

### Operations (pure, in `src/main/gridTree.ts`)

Every operation takes and returns a whole tree, and identifies positions by **service id**
and **path**, never by node reference — an operation may rebuild the nodes around its
target, so a held reference goes stale. A `Path` is a string of `a`/`b` steps from the
root (`''` is the root, `'ab'` is the root's `a` child's `b` child).

```ts
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export type Path = string;
```

`left`/`right` imply a `row` split, `top`/`bottom` a `col` split; `left` and `top` place
the newcomer as child `a`, `right` and `bottom` as child `b`.

| Function | Behaviour |
|----------|-----------|
| `insert(tree, service, target: string, edge: Edge)` | Replace the leaf holding `target` with a split whose children are that leaf and a new leaf for `service`, ordered by `edge`, `ratio: 0.5`. On a `null` tree, `service` becomes the root leaf and `target`/`edge` are ignored. |
| `remove(tree, service)` | Replace the leaf's parent split with the sibling subtree. Removing the root leaf yields `null`. Absent service ⇒ tree returned unchanged. |
| `move(tree, service, target: string, edge: Edge)` | `remove` then `insert`. A no-op if `target === service`, **and if `target` is not a leaf in the tree** — that second guard is load-bearing, not defensive: without it `remove` drops `service` and `insert` finds nowhere to put it back, so the leaf vanishes silently and the caller gets a tree that looks deliberately edited. With `target` checked present, the removal cannot have deleted it: a collapse never deletes a leaf other than the removed one. |
| `resize(tree, path: Path, ratio)` | Set that split's ratio. A path that is absent or names a leaf returns the tree unchanged. Clamping is split in two: `gridTree` applies only structural bounds (0.05–0.95), because it has no idea how big the split is; `gridLayout.clampRatio(dir, axisPx, ratio)` applies the pixel minimum. The interaction handler composes them. |
| `autoPlace(tree, service, rectOf)` | Where `＋` puts a service: split the largest leaf, choosing the axis from its aspect so the result stays roughly square. The only auto-placement in the design — a drag always aims (§5, D5). |
| `services(tree)` | The leaf services, in tree order. |
| `findPath(tree, service)` | The `Path` to a leaf, or undefined. |
| `prune(tree, valid: Set<string>)` | Drop leaves whose service is not in `valid`, collapsing as it goes. Used on load. |

### Geometry (pure, in `src/main/gridLayout.ts`)

```ts
computeGridLayout(tree: GridNode | null, content: Rect): {
  cells: Array<{ service: string; header: Rect; body: Rect }>;
  gutters: Array<{ path: string; dir: 'row' | 'col'; rect: Rect }>;
}
```

One function, one source of truth. Main sets each service view's bounds from `body`, and
pushes `cells` + `gutters` to the chrome renderer, which absolutely-positions the header
strips and gutter strips it is told about. The renderer computes no geometry of its own —
the same "main decides, renderer draws" split the rail already uses, and the reason all
of this is unit-testable without a window.

Constants, alongside the existing `TITLEBAR_HEIGHT` / `RAIL_WIDTH` in `layout.ts`:

```ts
export const CELL_HEADER_HEIGHT = 22;
export const GRID_GUTTER = 6;
export const MIN_CELL_WIDTH = 240;
export const MIN_CELL_HEIGHT = 160;   // body, excluding the header
```

A split subtracts `GRID_GUTTER` from the axis before dividing by `ratio`, so gutters
never come out of the content edges.

### Edge-zone hit test (pure, in `src/main/gridDrop.ts`)

```ts
gridDropTarget(point: {x: number; y: number}, cells: Cell[]):
  { target: string; edge: Edge } | 'root' | null
```

Find the cell whose **header + body** contains the point, normalise the point within that
combined rect to `rx, ry ∈ [0,1]`, then:

```
dx = min(rx, 1 - rx)          // normalised distance to nearest vertical edge
dy = min(ry, 1 - ry)          // ... nearest horizontal edge
dx < dy  →  edge = rx < 0.5 ? 'left' : 'right'      (a 'row' split)
else     →  edge = ry < 0.5 ? 'top'  : 'bottom'     (a 'col' split)
```

Closest edge wins, with no dead zone — every point inside a cell yields exactly one
answer, so the preview is never ambiguous. Points not inside any cell resolve by which
case they fall in:

| Point | Result | Preview |
|-------|--------|---------|
| Inside a cell | `{target, edge}` | The half it would take |
| Anywhere in the content rect, tree is `null` | `'root'` | The whole content rect |
| In a gutter, or outside the content rect, tree is non-null | `null` | Hidden; release is a no-op |

A split that would put either child below `MIN_CELL_WIDTH`/`MIN_CELL_HEIGHT` is refused:
the preview does not render and the release is a no-op. This is what bounds the cell
count — there is no arbitrary maximum.

## 6. Persistence

One new top-level field in `LoftConfig` (`src/main/config.ts:33-47`):

```ts
/** Grid view arrangement (grid-view spec §5). Absent or null means an empty grid. */
grid?: GridNode | null;
```

Per the established rule that unknown keys are dropped and the file is hand-editable,
`loadConfig` gets a recursive validator beside the existing `railOrder` array handling
(`config.ts:140-142`): a node survives only if it is a well-formed leaf or a split with
`dir` in `{row, col}`, a finite `ratio` in `(0,1)`, and two valid children. Anything
malformed collapses to `null` rather than throwing — a corrupt grid must cost you your
arrangement, never your ability to start Loft.

Two details make that guarantee real rather than aspirational, both found by review after
the naive version shipped:

- **A depth cap (64), enforced by the validator itself.** Unbounded recursion over a
  deeply nested or cyclic input throws `RangeError` instead of returning `null`. Relying
  on `loadConfig`'s outer `try/catch` to absorb that is not equivalent: it discards the
  *whole* config — services, tray backend, window bounds, rail order — so a corrupt grid
  costs far more than the arrangement. 64 is far above any real grid (the minimum cell
  size refuses splits past about ten levels) and far below the stack limit.

  **The cap bounds depth, not total work, and that distinction is load-bearing.** A
  review built a *shared-reference* graph — every level's `a` and `b` pointing at the
  same child object, a DAG with no self-reference, so nothing the cycle reasoning catches
  — and reached roughly 33.5 million calls at depth 24, then an uncatchable V8
  out-of-memory abort by depth 25. That is strictly worse than the `RangeError` the cap
  exists to prevent, and it happens comfortably inside the depth budget. It is
  unreachable today because the only caller is `loadConfig` on `JSON.parse` output, and
  JSON cannot express aliased references. Structured clone can. **So if a later task
  hands this validator a renderer-submitted arrangement over IPC, the depth cap alone is
  not enough — that caller must bound its own input.** The validator is deliberately not
  hardened for a caller that does not exist yet; a node-visit counter without a real
  consumer would be speculative work.
- **An out-of-range `ratio` is clamped, not rejected.** The loader admits `(0,1)` but
  `gridTree` clamps interactive resizes to 0.05–0.95, so a hand-edited `0.001` would
  otherwise load into a split the app's own logic could never produce. Clamping reads the
  user's intent — make this pane small — instead of discarding it. `0`, `1`, and
  non-finite values stay rejected outright: those are structurally invalid, not extreme.

No `migrate.ts` step and no `CONFIG_VERSION` bump: absent means empty, which is the
correct state for every existing install.

On load, after the registry is known, `prune(tree, configuredServiceIds)` drops leaves
for services that were removed or are marked `detached` (§7.1). Each surviving leaf's
service is woken — grid membership means live.

## 7. How it meets the existing behaviour

### 7.1 Detach

Grid and detached are **mutually exclusive**, maintained in both directions: adding a
detached service to the grid re-attaches it first (`setDetached(id, false)`, which
already hands the live view across without a reload, `index.ts:371-409`); detaching a
gridded service removes its leaf first. `prune` on load is the defensive backstop.

### 7.2 The drag gesture conflict

Dragging a rail icon rightward out of the rail currently means *detach*
(`railDrag.ts:11-17`). Grid gives the same gesture a second possible meaning, resolved by
release region:

| Release region | Outcome |
|----------------|---------|
| Inside the rail | Reorder — unchanged |
| Inside the content rect, **and Grid is the selected entry** | Add to grid (or move, if already a leaf) |
| Inside the content rect, Grid not selected | Detach — unchanged |
| Outside the window | Detach — unchanged |

Detach stays reachable in every case; it just moves further out when the grid is on
screen. This works with the machinery already in place: pointer capture survives leaving
the rail (proven in spec 09c-2b, and relied on today by the detach gesture, which cannot
reach the outside of the window without crossing the content area), and the rail view's
origin is the window origin (`layout.ts:32` — `rail: {x: 0, y: 0}`), so the
`clientX/clientY` main already receives map to window coordinates by subtracting
`RAIL_WIDTH` and `TITLEBAR_HEIGHT`.

`railGestureOutcome` gains a `grid` outcome. Its existing "stay put ⇒ select" rule
(`railDrag.ts:41-49`) is untouched, so click-to-select still works — a zero-distance
press on a rail icon never leaves the rail and so can never be read as a grid drop.

### 7.3 Moving a cell within the grid

The header's `⠿` handle is a pointer-capture drag inside the chrome renderer, feeding the
same `computeGridLayout` + edge-zone hit test, resolving to `move`. Releasing outside any
cell cancels — it does not remove and does not detach. Removal is the `✕`, deliberately
the only way, so a slipped drag cannot silently evict a service.

### 7.4 Focused cell

`webContents.on('focus')` per service view records the focused cell; clicking a header
focuses it too, via IPC from the chrome view. The Electron docs endorse exactly this —
"The `focus` and `blur` events of `WebContents` should only be used to detect focus change
between different `WebContents` and `BrowserView` in the same window" — and the macOS
caveat attached to them does not apply here.

When Grid is selected with nothing focused, focus falls to the first leaf in tree order.
Titlebar zoom acts on the focused cell and persists to that service's existing
`window.zoom` (`config.ts:15-17`) — grid introduces no new zoom storage.

### 7.5 Notifications and DND

Today a notification is suppressed when the service is *focused and visible*. Grid makes
several services visible at once. The faithful extension: a gridded service is **visible**
when Grid is the selected entry and the Loft window is visible, and **focused** when the
Loft window has focus. So with Loft focused on a three-cell grid, all three suppress their
banners — you can see all three. Cell focus does not enter the gate; it governs zoom only.

Per-service and global DND are unchanged.

Hazard, carried from spec 09c-2a: a view moved between hosts fires **no
`did-finish-load`**, so every per-service binding must be explicitly re-seeded on the new
host or the service silently suppresses its own notifications. Mounting into and out of
the grid is such a move. `notifications.registerService(id)` must be re-called on both
transitions, exactly as `setDetached` does at `index.ts:404`.

### 7.6 Badges, D-Bus, deep links

Badges are unchanged at the source; the cell header renders the same value the rail does,
pushed from the same model. `Show()` on a gridded service selects Grid and focuses its
cell. `Hide()` hides the whole Loft window — the same documented wart attached services
already have (spec 09 §6b). A notification click on a gridded service selects Grid,
focuses that cell, and then deep-links as it does today.

### 7.7 Recovery

A crashed or stuck gridded service shows its recovery view in that cell's **body rect**;
the header strip stays, so the cell is still identifiable and still removable. The
same-synchronous-tick mount contract in `serviceView.ts:78-92` applies to grid mounts
unchanged — mount in the tick `createServiceView` returns, or the stuck-watcher misfires.

## 8. Risks and spikes

**S1 — transparent overlay over live sibling views. RESOLVED 2026-07-23: GO.** A
`WebContentsView` with `setBackgroundColor('#00000000')`, stacked above a live
`web.whatsapp.com` view, renders the page through its transparent region with the preview
rectangle drawn over it — verified on Wayland and X11, identical in both. Task 10 uses the
overlay; the hide-the-views fallback is not needed.

Watch the API trap when implementing: alpha hex is `AARRGGBB`, not `RRGGBBAA`, and the
string `"transparent"` is not a valid colour and fails silently. The measured stack was
chrome (bottom) → live page → transparent overlay → rail, which is exactly §4's ordering.

**S2 — capture across a live page. RESOLVED 2026-07-23: GO.** A `setPointerCapture` drag
begun in a rail-stand-in view kept delivering `pointermove` while the cursor was over both
the live page and the transparent overlay, and delivered its final `pointerup` on release
(logged at `381,259`, far outside the originating view). Both backends.

**S3 — simultaneous rendering cost.** All service views are already alive; what is new is
several *painting* at once. Measure with four cells on a mid-range machine before calling
the feature done. If it bites, the lever is throttling background cells, not reducing the
design.

`setVisible()`'s side effects are formally undocumented — whether it suspends rendering or
input is unspecified. The codebase already depends on the answer (inactive attached views
stay visible-false and keep scraping badges), so this is settled empirically here even
though the docs are silent.

## 9. Testing

Unit (Vitest), all against pure functions with no window:

- `gridTree`: insert into empty / into a leaf on each of the four edges; remove a leaf,
  a sibling, the root; collapse correctness after removal; move within the tree; move onto
  itself is a no-op; ratio clamping; `prune` against a valid-id set.
- `gridLayout`: rects tile the content exactly with no overlap and no gap beyond gutters;
  header + body partition each leaf rect; gutter rects fall between children; degenerate
  sizes clamp rather than go negative.
- `gridDrop`: each edge zone from representative points; the diagonal boundary between
  `row` and `col`; points in gutters; points outside all cells; refusal below minimum size.
- `config`: a valid grid round-trips; a malformed node collapses to `null`; unknown keys
  are dropped; absent stays absent.
- `railDrag`: the new `grid` outcome, and that the existing reorder / detach / select
  outcomes are unchanged when Grid is not selected.

Manual checklist:

- A voice call in a cell survives a resize, a move within the grid, and the round trip
  out to single-view and back.
- Notifications from a visible cell suppress; from a non-gridded background service, fire.
- Arrangement survives a restart; a service removed while gridded is pruned cleanly.
- Detach out of a grid and drag back in.
- Wayland and X11, GNOME and KDE.

## 10. Out of scope

Multiple saved grids or named layouts. A grid inside a detached window. Tabs within a
cell. Dragging a cell out to a new window in one gesture. Spanning a grid across monitors.
Each is additive on this tree model rather than blocked by it.
