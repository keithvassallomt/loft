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
// Named distinctly from rail.ts's own RAIL_MIME: both files are loaded as non-module
// <script> tags (see the import()-type-query note atop rail.ts), so their top-level
// declarations share one global scope — same string value, different identifier.
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
