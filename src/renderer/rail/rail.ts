// See the original note below: an inline `import()` type query keeps tsc from emitting
// module boilerplate that would throw under `<script type="module">`.
type RailItem = import('../../main/railModel').RailItem;
type RailState = import('../../main/railModel').RailState;
type BubbleItem = import('../../main/railModel').BubbleItem;

const root = document.getElementById('rail')!;
const slotLine = document.getElementById('slot')!;
const RAIL_MIME = 'application/x-loft-service';

type Slot = import('../../main/railSlots').RailSlot;
let slots: Slot[] = [];
let dragging = false;
/** A rail:state that arrived mid-drag; applied once the gesture ends (see render). */
let pendingState: RailState | null = null;

/** Below this a gesture is a click, not a drag. Bubbles have no separate handle, so the
 *  press that opens a conversation and the press that starts reordering it are the same
 *  press — only the distance tells them apart. */
const DRAG_THRESHOLD_PX = 4;

/** Measure every icon so main can compute insertion indices from real geometry. */
function measure(sel = '.item'): Slot[] {
  return [...root.querySelectorAll<HTMLElement>(sel)].map((el) => {
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

/** `id` is omitted by the cross-window HTML5 path, which does not learn the service until
 *  'drop' — main treats that as "not currently a grid leaf", which is what it is. */
function beginDrag(id?: string): void {
  slots = measure();
  dragging = true;
  window.loftRail.dragBegin(slots, id);
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

function serviceButton(item: RailItem, iconEpoch: number): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'item';
  b.classList.toggle('active', item.active);
  b.classList.toggle('sleeping', item.sleeping);
  b.title = item.displayName;
  b.setAttribute('aria-label', item.displayName);
  if (item.active) b.setAttribute('aria-current', 'page');

  // The real service logo, served by the loft://icon/<id> protocol registered in main; the
  // rail's CSP already allows `img-src loft:`. If the icon is missing the image errors, and
  // we restore the initials placeholder rather than leaving an empty chip. prepend, not
  // append: the badge and the ⧉/🌙 marks are appended after this and must stay on top.
  const img = document.createElement('img');
  img.className = 'icon';
  // ?e=<epoch> busts Chromium's cache under the stable loft://icon/<id> URL: without it a
  // changed icon keeps the old bytes until the whole rail renderer reloads. Main bumps the
  // epoch on every icon re-deploy.
  img.src = `loft://icon/${item.id}?e=${iconEpoch}`;
  img.alt = '';
  img.addEventListener('error', () => {
    img.remove();
    const g = document.createElement('span');
    g.className = 'glyph';
    g.textContent = initials(item.displayName);
    b.prepend(g);
  });
  b.append(img);

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
    beginDrag(item.id);
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
  // A cancel is an end main never hears about otherwise: no pointerup fires, so dragEnd is
  // never sent and the grid drop preview — an overlay covering the whole content rect —
  // would stay up and swallow every click on the grid, the selected service and the hub.
  // Touch makes this reachable in practice: preventDefault on pointerdown does not stop the
  // gesture being stolen for a pan.
  b.addEventListener('pointercancel', () => {
    b.classList.remove('dragging');
    endDrag();
    window.loftRail.dragCancel();
  });
  // Keyboard activation (Enter/Space) dispatches a synthetic click with detail 0, not
  // pointer events; mouse clicks (detail >= 1) stay owned by the pointer path above.
  b.addEventListener('click', (e) => { if (e.detail === 0) window.loftRail.select(item.id); });
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); window.loftRail.menu(item.id); });
  return b;
}

/** The bubble currently being dragged, and whether it has passed the click threshold. */
let bubbleDragId: string | null = null;
let bubbleDragFromY = 0;
let bubbleMoved = false;

function bubbleButton(item: BubbleItem, iconEpoch: number): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'bubble';
  b.title = item.title;
  b.setAttribute('aria-label', item.unread ? `${item.title} (unread)` : item.title);
  // Same treatment as a sleeping service icon, sharing its CSS rule rather than restating it.
  b.classList.toggle('sleeping', item.sleeping);
  b.dataset.id = item.id;

  // Same mechanism the service icons use: on error the image is replaced by initials. That
  // IS the whole fallback for a conversation with no avatar — every Slack channel, whose
  // title is stored as "#general" and so renders as "#".
  const img = document.createElement('img');
  img.className = 'avatar';
  img.src = `loft://bubble/${item.id}?e=${iconEpoch}`;
  img.alt = '';
  img.addEventListener('error', () => {
    img.remove();
    const g = document.createElement('span');
    g.className = 'glyph';
    // Computed in main (bubbleGlyph): the rail's own initials() splits on whitespace only,
    // which turned every Slack channel into an identical bare '#'. The hue separates two
    // lettered bubbles further, and is keyed on the conversation so a rename cannot
    // recolour it.
    g.textContent = item.glyph;
    // A Slack channel keeps its '#' and so is three characters wide where everything else is
    // two; without this it overflows a 34px circle.
    g.classList.toggle('wide', item.glyph.length > 2);
    b.style.background = `hsl(${item.hue} 45% 45%)`;
    b.style.borderColor = `hsl(${item.hue} 45% 38%)`;
    b.style.color = '#fff';
    b.prepend(g);
  });
  b.append(img);

  // Which service this conversation belongs to, bottom-right.
  const badge = document.createElement('img');
  badge.className = 'service';
  badge.src = `loft://icon/${item.serviceId}?e=${iconEpoch}`;
  badge.alt = '';
  badge.addEventListener('error', () => badge.remove());
  b.append(badge);

  // Top-right, opposite the service badge — the one free corner. Appended last so it sits
  // above the avatar. A sleeping bubble never has one: main gates it (no view, no honest
  // answer), and the greyed treatment is what says so.
  if (item.unread) {
    const dot = document.createElement('span');
    dot.className = 'unread';
    dot.setAttribute('aria-hidden', 'true');
    b.append(dot);
  }

  // Bubbles reorder among THEMSELVES and nothing else — they never detach and never enter
  // the grid, so this is deliberately its own small gesture rather than the service icons'
  // machinery, which exists to resolve reorder-vs-detach-vs-grid from the release point.
  //
  // `dragging` is the shared mid-render guard: replaceChildren during a gesture would destroy
  // the very button holding pointer capture, and its replacement never receives the pointerup.
  b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // primary only — right-click is the context menu
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    bubbleDragId = item.id;
    bubbleDragFromY = e.clientY;
    bubbleMoved = false;
    dragging = true;
    slots = measure('.bubble');
    window.loftRail.bubbleDragBegin(slots, item.id);
  });
  b.addEventListener('pointermove', (e) => {
    if (bubbleDragId !== item.id) return;
    // Until the threshold is passed this is still a click in progress: no indicator, no
    // visual change, so a press that turns out to be a tap looks like nothing happened.
    if (!bubbleMoved && Math.abs(e.clientY - bubbleDragFromY) < DRAG_THRESHOLD_PX) return;
    bubbleMoved = true;
    b.classList.add('dragging');
    window.loftRail.bubbleDragMove(e.clientY);
  });
  b.addEventListener('pointerup', (e) => {
    if (bubbleDragId !== item.id) return;
    bubbleDragId = null;
    b.classList.remove('dragging');
    // null tells main to drop its geometry without reordering — the same thing a cancel
    // does. A click IS a zero-distance drag, so this path always ends the gesture first.
    window.loftRail.bubbleDragEnd(bubbleMoved ? e.clientY : null);
    if (!bubbleMoved) window.loftRail.selectBubble(item.id);
    endDrag();
  });
  // No pointerup fires after a cancel (a touch drag stolen for a pan is the ordinary cause),
  // so without this main keeps stale geometry and the indicator stays up.
  b.addEventListener('pointercancel', () => {
    if (bubbleDragId !== item.id) return;
    bubbleDragId = null;
    b.classList.remove('dragging');
    window.loftRail.bubbleDragEnd(null);
    endDrag();
  });
  // Keyboard activation dispatches a synthetic click with detail 0 and no pointer events.
  b.addEventListener('click', (e) => { if (e.detail === 0) window.loftRail.selectBubble(item.id); });
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.loftRail.bubbleMenu(item.id);
  });
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

function gridButton(active: boolean, count: number): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'grid';
  b.classList.toggle('active', active);
  b.title = 'Grid';
  b.setAttribute('aria-label', 'Grid view');
  if (active) b.setAttribute('aria-current', 'page');
  const g = document.createElement('span');
  g.className = 'glyph';
  g.setAttribute('aria-hidden', 'true');
  g.textContent = '▦';
  b.append(g);
  if (count > 0) {
    const n = document.createElement('span');
    n.className = 'count';
    n.textContent = String(count);
    b.append(n);
  }
  // Pinned: no pointerdown/drag handlers. The Grid entry is not reorderable and not
  // removable, so it takes a plain click — unlike a service icon, whose click IS a
  // zero-distance drag resolved by main.
  b.addEventListener('click', () => window.loftRail.showGrid());
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
  const dividerEl = (): HTMLDivElement => {
    const d = document.createElement('div');
    d.className = 'divider';
    d.setAttribute('aria-hidden', 'true');
    return d;
  };
  root.replaceChildren(
    homeButton(state.managerActive),
    gridButton(state.gridActive, state.gridCount),
    ...(state.items.length
      ? [dividerEl(), ...state.items.map((it) => serviceButton(it, state.iconEpoch))]
      : []),
    // Below the services, behind their own divider, so the service list stays a fixed spine
    // that never shifts as bubbles come and go.
    ...(state.bubbles.length
      ? [dividerEl(), ...state.bubbles.map((bu) => bubbleButton(bu, state.iconEpoch))]
      : []),
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
