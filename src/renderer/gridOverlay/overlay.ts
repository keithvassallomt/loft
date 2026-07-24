// Inline `import()` type queries only: tsc emits CJS module boilerplate for a real
// top-level import, and that boilerplate throws under `<script type="module">`.
type OverlayRect = import('../../main/layout').Rect;

// Prefixed like grid.ts's names: with no import/export every renderer script is a global
// script to tsc, so a bare `el` would collide with another renderer's at compile time
// (TS2451/TS2393).
const overlayEl = document.getElementById('preview')!;

// Rects arrive in window coordinates; this view's origin is the content rect's origin,
// so main sends the origin with them.
window.loftGrid.onPreview((r: (OverlayRect & { originX: number; originY: number }) | null) => {
  if (!r) { overlayEl.classList.remove('show'); return; }
  overlayEl.style.left = `${r.x - r.originX}px`;
  overlayEl.style.top = `${r.y - r.originY}px`;
  overlayEl.style.width = `${r.width}px`;
  overlayEl.style.height = `${r.height}px`;
  overlayEl.classList.add('show');
});
