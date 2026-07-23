// Inline `import()` type queries only: tsc emits CJS module boilerplate for a real
// top-level import, and that boilerplate throws under `<script type="module">`.
type GridLayout = import('../../main/gridLayout').GridLayout;
type GridViewState = import('../../main/gridLayout').GridViewState;

// Every top-level name here is grid-prefixed for the same reason titlebar.ts renamed its
// drag MIME: with no import/export, tsc treats each renderer script as a global script,
// so a bare `root`/`render` collides with rail.ts's at compile time (TS2451/TS2393).
const gridRoot = document.getElementById('grid')!;
const gridEmptyEl = document.getElementById('empty')!;

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
  return el;
}

function renderGrid(state: GridViewState): void {
  gridEmptyEl.classList.toggle('show', state.layout.cells.length === 0);
  gridRoot.replaceChildren(
    ...state.layout.gutters.map((g) => gridGutter(g, state)),
    ...state.layout.cells.map((c) => gridCellHeader(c, state)),
  );
}

window.loftGrid.onState(renderGrid);
