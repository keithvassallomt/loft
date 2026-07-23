// Inline `import()` type queries only: tsc emits CJS module boilerplate for a real
// top-level import, and that boilerplate throws under `<script type="module">`.
type GridLayout = import('../../main/gridLayout').GridLayout;
type GridViewState = import('../../main/gridLayout').GridViewState;

// Every top-level name here is grid-prefixed for the same reason titlebar.ts renamed its
// drag MIME: with no import/export, tsc treats each renderer script as a global script,
// so a bare `root`/`render` collides with rail.ts's at compile time (TS2451/TS2393).
const gridRoot = document.getElementById('grid')!;
const gridEmptyEl = document.getElementById('empty')!;

let gridDragging = false;
/** A grid:state that arrived mid-drag; applied once the gesture ends (see renderGrid). */
let gridPendingState: GridViewState | null = null;
/** Where the pointer was released, recorded by pointerup and consumed by
 *  lostpointercapture — the one place a gesture ends. Null means "no release seen", i.e.
 *  the gesture was cancelled rather than finished. */
let gridDragRelease: { x: number; y: number } | null = null;

/** One owner of "the gesture is over" on this side: drop the guard and apply whatever we
 *  refused to render while it was up. */
function endGridDrag(): void {
  gridDragging = false;
  if (gridPendingState) {
    const s = gridPendingState;
    gridPendingState = null;
    renderGrid(s);
  }
}

/** Position an absolutely-placed element from a main-computed Rect. Every rect arrives
 *  in window coordinates; the grid view's own origin is the content rect's origin, so
 *  each one is offset by the layout's origin before use. */
function placeGridEl(el: HTMLElement, r: { x: number; y: number; width: number; height: number },
                     origin: { x: number; y: number }): void {
  el.style.left = `${r.x - origin.x}px`;
  el.style.top = `${r.y - origin.y}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
}

/** Add, update or drop a header's unread pill. One owner, so a header built from scratch
 *  and one refreshed in place cannot disagree about where the pill sits or when it shows. */
function setGridBadge(el: HTMLElement, count: number): void {
  const existing = el.querySelector('.badge');
  if (count <= 0) { existing?.remove(); return; }
  const text = count > 99 ? '99+' : String(count);
  if (existing) { existing.textContent = text; return; }
  const n = document.createElement('span');
  n.className = 'badge';
  n.textContent = text;
  el.insertBefore(n, el.querySelector('.spacer'));
}

function gridCellHeader(cell: GridLayout['cells'][number], state: GridViewState): HTMLElement {
  const el = document.createElement('div');
  el.className = 'chead';
  el.classList.toggle('focused', state.focused === cell.service);
  el.dataset.service = cell.service;
  placeGridEl(el, cell.header, state.origin);

  const img = document.createElement('img');
  img.className = 'icon';
  img.src = `loft://icon/${cell.service}`;
  img.alt = '';
  el.append(img);

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = state.names[cell.service] ?? cell.service;
  el.append(name);

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  el.append(spacer);
  setGridBadge(el, state.badges[cell.service] ?? 0); // lands before the spacer

  const handle = document.createElement('button');
  handle.className = 'handle';
  handle.title = 'Move this cell';
  handle.setAttribute('aria-label', `Move ${name.textContent}`);
  handle.textContent = '⠿';
  el.append(handle);

  const close = document.createElement('button');
  close.className = 'close';
  close.title = 'Remove from grid';
  close.setAttribute('aria-label', `Remove ${name.textContent} from the grid`);
  close.textContent = '✕';
  close.addEventListener('click', () => window.loftGrid.removeCell(cell.service));
  el.append(close);

  // Clicking anywhere in the header focuses the cell — the target the titlebar's zoom
  // buttons act on. Handled on the header, not the buttons, so ✕ and ⠿ still work.
  el.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button') === close) return;
    window.loftGrid.focusCell(cell.service);
  });

  return el;
}

function gridGutter(g: GridLayout['gutters'][number], state: GridViewState): HTMLElement {
  const el = document.createElement('div');
  el.className = `gutter ${g.dir}`;
  el.dataset.path = g.path;
  el.dataset.dir = g.dir;
  placeGridEl(el, g.rect, state.origin);

  // Drag the divider to resize the split it belongs to. The renderer reports the pointer
  // and nothing else — main owns the tree, so it owns the ratio (see grid:gutterDragBegin).
  // setPointerCapture keeps the whole gesture on this element even once the cursor leaves
  // the gutter, which it does immediately: the divider is 6px wide.
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // primary button only — middle/right fall through
    // One gesture at a time. Main tracks a single drag, so a second pointer grabbing another
    // gutter would silently retarget the first one's moves at the second one's split; refuse
    // it here instead, where the second gutter simply never enters .dragging and its own
    // moves and release are ignored.
    if (gridDragging) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    gridDragging = true;
    gridDragRelease = null;
    window.loftGrid.gutterDragBegin(g.path, g.dir);
  });
  el.addEventListener('pointermove', (e) => {
    if (!el.classList.contains('dragging')) return;
    window.loftGrid.dragMove(e.clientX, e.clientY);
  });
  // Records the release point and nothing else. Ending the gesture here too would send main
  // both an end and (later) a cancel for one gesture.
  el.addEventListener('pointerup', (e) => {
    if (!el.classList.contains('dragging')) return;
    gridDragRelease = { x: e.clientX, y: e.clientY };
  });
  // The single "gesture is over" signal: it fires for a release, for a cancel, and for this
  // node being removed from the DOM alike. Ending only on pointerup/pointercancel would let
  // a lost capture latch gridDragging true for the rest of the session — no further gutter
  // drag would start, and the chrome would never fully re-render again.
  //
  // No release recorded ⇒ the gesture was cancelled, which is an end main never hears about
  // otherwise: it keeps the drag tracked, and every later pointermove over this gutter — a
  // plain hover — goes on resizing the split. Touch makes that reachable in practice:
  // preventDefault on pointerdown does not stop the gesture being stolen for a pan.
  el.addEventListener('lostpointercapture', () => {
    if (!el.classList.contains('dragging')) return;
    el.classList.remove('dragging');
    const release = gridDragRelease;
    gridDragRelease = null;
    endGridDrag();
    if (release) window.loftGrid.dragEnd(release.x, release.y);
    else window.loftGrid.dragCancel();
  });
  return el;
}

/**
 * Does the mounted DOM already have exactly this state's shape — the same gutters at the
 * same paths on the same axes, and the same cells for the same services, in the same order?
 * True for every push during a resize, which moves rects and changes nothing else.
 *
 * Both lists are emitted in the tree's own walk order by computeGridLayout, and this
 * renderer mounts them in that order, so comparing by index is exact.
 */
function gridStructureMatches(state: GridViewState): boolean {
  const gutters = gridRoot.querySelectorAll<HTMLElement>('.gutter');
  const heads = gridRoot.querySelectorAll<HTMLElement>('.chead');
  if (gutters.length !== state.layout.gutters.length) return false;
  if (heads.length !== state.layout.cells.length) return false;
  for (let i = 0; i < gutters.length; i += 1) {
    const g = state.layout.gutters[i];
    if (gutters[i].dataset.path !== g.path || gutters[i].dataset.dir !== g.dir) return false;
  }
  for (let i = 0; i < heads.length; i += 1) {
    if (heads[i].dataset.service !== state.layout.cells[i].service) return false;
  }
  return true;
}

/** Re-place and re-label the nodes that are already mounted. Creates and removes nothing, so
 *  the element holding pointer capture is untouched — which is the whole point.
 *  Display names are not refreshed: they come from the static service registry and cannot
 *  change without a restart, whereas rects, focus and badges all change under a live drag. */
function updateGridInPlace(state: GridViewState): void {
  const gutters = gridRoot.querySelectorAll<HTMLElement>('.gutter');
  state.layout.gutters.forEach((g, i) => placeGridEl(gutters[i], g.rect, state.origin));
  const heads = gridRoot.querySelectorAll<HTMLElement>('.chead');
  state.layout.cells.forEach((c, i) => {
    placeGridEl(heads[i], c.header, state.origin);
    heads[i].classList.toggle('focused', state.focused === c.service);
    setGridBadge(heads[i], state.badges[c.service] ?? 0);
  });
}

function renderGrid(state: GridViewState): void {
  // Mid-drag, replaceChildren would destroy the very gutter holding pointer capture, and the
  // replacement node never receives the pointerup — orphaning the gesture. But that hazard
  // is about REMOVAL, not about rendering: when the incoming state has the shape already on
  // screen (always, during a resize — it moves rects and nothing else) every node it
  // describes is mounted, so re-placing them in place is both safe and what makes the
  // dragged divider actually follow the pointer instead of freezing until release.
  // Only a genuine structural change has to wait; endGridDrag() flushes it.
  if (gridDragging) {
    if (!gridStructureMatches(state)) { gridPendingState = state; return; }
    updateGridInPlace(state);
    // The DOM is now this state, which is newer than anything held back — so whatever was
    // deferred is stale and must not be replayed over it at the end of the gesture.
    gridPendingState = null;
    return;
  }
  gridEmptyEl.classList.toggle('show', state.layout.cells.length === 0);
  gridRoot.replaceChildren(
    ...state.layout.gutters.map((g) => gridGutter(g, state)),
    ...state.layout.cells.map((c) => gridCellHeader(c, state)),
  );
}

window.loftGrid.onState(renderGrid);
