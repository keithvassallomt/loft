// See the original note below: an inline `import()` type query keeps tsc from emitting
// module boilerplate that would throw under `<script type="module">`.
type RailItem = import('../../main/railModel').RailItem;
type RailState = import('../../main/railModel').RailState;

const root = document.getElementById('rail')!;
const slotLine = document.getElementById('slot')!;
const RAIL_MIME = 'application/x-loft-service';

type Slot = import('../../main/railSlots').RailSlot;
let slots: Slot[] = [];
let dragging = false;
/** A rail:state that arrived mid-drag; applied once the gesture ends (see render). */
let pendingState: RailState | null = null;

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

const initials = (name: string): string =>
  name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

function serviceButton(item: RailItem): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'item';
  b.classList.toggle('active', item.active);
  b.classList.toggle('sleeping', item.sleeping);
  b.title = item.displayName;
  b.setAttribute('aria-label', item.displayName);
  if (item.active) b.setAttribute('aria-current', 'page');

  const g = document.createElement('span');
  g.className = 'glyph';
  g.textContent = initials(item.displayName);
  b.append(g);

  if (item.badge > 0) {
    const n = document.createElement('span');
    n.className = 'badge';
    n.textContent = item.badge > 99 ? '99+' : String(item.badge);
    b.append(n);
  }
  for (const [on, cls, glyph] of [[item.detached, 'detached', '⧉'], [item.dnd, 'dnd', '🌙']] as const) {
    if (!on) continue;
    const m = document.createElement('span');
    m.className = `mark ${cls}`;
    m.setAttribute('aria-hidden', 'true');
    m.textContent = glyph;
    b.append(m);
  }

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
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); window.loftRail.menu(item.id); });
  return b;
}

function homeButton(active: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'home';
  b.classList.toggle('active', active);
  b.title = 'Loft';
  b.setAttribute('aria-label', 'Loft manager');
  if (active) b.setAttribute('aria-current', 'page');
  const img = document.createElement('img');
  img.src = 'loft://icon/loft';
  img.alt = '';
  b.append(img);
  b.addEventListener('click', () => window.loftRail.showManager());
  return b;
}

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

window.loftRail.onState(render);

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
  // Only on true entry — dragenter re-fires on every child boundary crossing, and each
  // beginDrag() is a full re-measure plus an IPC send.
  if (!dragging) beginDrag();
});
root.addEventListener('dragover', (e) => {
  if (!ours(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';
  window.loftRail.dragMove(e.clientX, e.clientY);
});
root.addEventListener('dragleave', (e) => {
  if (!ours(e)) return;
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
