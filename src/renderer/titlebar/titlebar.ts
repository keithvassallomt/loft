document.getElementById('reload')!.addEventListener('click', () => window.loft.reload());
document.getElementById('zoom-in')!.addEventListener('click', () => window.loft.zoomIn());
document.getElementById('zoom-out')!.addEventListener('click', () => window.loft.zoomOut());
document.getElementById('close')!.addEventListener('click', () => window.loft.close());

// Main sends the service display name once the titlebar has finished loading.
const nameEl = document.getElementById('name')!;
window.loft.onSetService((name: string) => { nameEl.textContent = name; });

// The ⇤ handle attaches this service two ways: click (unchanged), or drag it onto the
// Loft window's rail to choose the slot it lands in. It must be the drag source rather
// than the titlebar itself — the titlebar's drag region belongs to the compositor for
// moving the window, and HTML5 drags cannot start there.
// Named distinctly from rail.ts's own RAIL_MIME: neither file has a top-level
// import/export (see the import()-type-query note atop rail.ts), so tsc treats both as
// global scripts and their top-level declarations collide (TS2451) at compile time —
// same string value, different identifier avoids that.
const TITLEBAR_DRAG_MIME = 'application/x-loft-service';
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
  e.dataTransfer.setData(TITLEBAR_DRAG_MIME, serviceId);
  e.dataTransfer.setData('text/plain', serviceId);
  e.dataTransfer.effectAllowed = 'move';
});

// One signal drives the icon and every context-dependent control, because they all answer
// the same question: what is this titlebar showing? Three answers — a service (its id), the
// manager (null), or the grid (the literal string below). Close stays in every view, and ⇤
// keeps its own set-attachable logic: "is this a detached window" is a different question
// from "is this showing a service".
//
// The grid is announced as a plain 'grid', never as gridTree's reserved grid id: this file
// cannot import that constant (no top-level imports here — see the note on
// TITLEBAR_DRAG_MIME above), and its control-character prefix does not survive editors or
// copy-paste, which would leave a comparison that silently never matches.
// loftWindow.refreshTitlebar sends 'grid' for exactly this reason and keeps the sentinel on
// main's side.
const TITLEBAR_GRID_CONTEXT = 'grid';
const iconEl = document.getElementById('icon') as HTMLImageElement;
const reloadEl = document.getElementById('reload') as HTMLButtonElement;
const zoomEls = ['zoom-out', 'zoom-in']
  .map((el) => document.getElementById(el) as HTMLButtonElement);
const addGridEl = document.getElementById('add-to-grid') as HTMLButtonElement;

iconEl.addEventListener('error', () => { iconEl.hidden = true; });

addGridEl.addEventListener('click', () => window.loft.addToGrid());

window.loft.onSetContext((id, iconEpoch) => {
  const isGrid = id === TITLEBAR_GRID_CONTEXT;
  // A service, as opposed to the manager or the grid — the only context with an icon to
  // load and a web view for reload to act on.
  const isService = id !== null && !isGrid;
  // ?e=<epoch> busts Chromium's cache under the stable loft://icon/<id> URL, so a changed
  // icon re-fetches when the user next opens this service (main bumps the epoch on change).
  if (isService) iconEl.src = `loft://icon/${id}?e=${iconEpoch}`;
  iconEl.hidden = !isService;
  reloadEl.hidden = !isService;
  // Zoom survives into the grid: Task 13 aims it at the focused cell. It is still hidden in
  // the manager, which has nothing to zoom.
  for (const el of zoomEls) el.hidden = !isService && !isGrid;
  addGridEl.hidden = !isGrid;
});
