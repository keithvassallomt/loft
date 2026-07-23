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

  const badge = state.badges[cell.service] ?? 0;
  if (badge > 0) {
    const n = document.createElement('span');
    n.className = 'badge';
    n.textContent = badge > 99 ? '99+' : String(badge);
    el.append(n);
  }

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  el.append(spacer);

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
    window.loftGrid.gutterDragBegin(g.path, g.dir);
  });
  el.addEventListener('pointermove', (e) => {
    if (!el.classList.contains('dragging')) return;
    window.loftGrid.dragMove(e.clientX, e.clientY);
  });
  el.addEventListener('pointerup', (e) => {
    if (!el.classList.contains('dragging')) return;
    el.classList.remove('dragging');
    endGridDrag();
    window.loftGrid.dragEnd(e.clientX, e.clientY);
  });
  // A cancel is an end main never hears about otherwise: no pointerup fires, so dragEnd is
  // never sent, main keeps the drag tracked, and every later pointermove over this gutter —
  // a plain hover — would go on resizing the split. Touch makes this reachable in practice:
  // preventDefault on pointerdown does not stop the gesture being stolen for a pan.
  el.addEventListener('pointercancel', () => {
    if (!el.classList.contains('dragging')) return;
    el.classList.remove('dragging');
    endGridDrag();
    window.loftGrid.dragCancel();
  });
  return el;
}

function renderGrid(state: GridViewState): void {
  // Never re-render mid-drag. replaceChildren would destroy the very gutter holding pointer
  // capture, and the replacement node never receives the pointerup — orphaning the gesture:
  // dragging stuck true, dragEnd never sent, main still resizing on every later hover. A
  // badge landing a second late is invisible next to that. Live during a resize this is the
  // rule, not the exception: main refreshes the grid on every move. endGridDrag() flushes.
  if (gridDragging) { gridPendingState = state; return; }
  gridEmptyEl.classList.toggle('show', state.layout.cells.length === 0);
  gridRoot.replaceChildren(
    ...state.layout.gutters.map((g) => gridGutter(g, state)),
    ...state.layout.cells.map((c) => gridCellHeader(c, state)),
  );
}

window.loftGrid.onState(renderGrid);
