import { canSplit, cellRect, computeGridLayout, splitRects, type GridCell } from './gridLayout';
import { findPath, insert, INSERT_RATIO, remove, type Edge, type GridNode } from './gridTree';
import type { Rect } from './layout';

/** `'root'` = drop into an empty grid; `null` = no legal target, hide the preview. */
export type GridDropTarget = { target: string; edge: Edge } | 'root' | null;

const inside = (r: Rect, p: { x: number; y: number }): boolean =>
  p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

/**
 * Which cell and which half a point drops into (grid-view spec §5).
 *
 * Closest edge wins, measured on NORMALISED distance so a wide-but-short cell does not
 * bias every drop to its top or bottom. There is deliberately no centre dead zone: every
 * point inside a cell yields exactly one answer, so the preview is never ambiguous.
 */
export function gridDropTarget(
  point: { x: number; y: number },
  cells: readonly GridCell[],
  content: Rect,
): GridDropTarget {
  if (cells.length === 0) return inside(content, point) ? 'root' : null;

  const hit = cells.find((c) => inside(cellRect(c), point));
  if (!hit) return null; // a gutter, or outside the grid entirely

  const r = cellRect(hit);
  const rx = (point.x - r.x) / r.width;
  const ry = (point.y - r.y) / r.height;
  const dx = Math.min(rx, 1 - rx);
  const dy = Math.min(ry, 1 - ry);
  const edge: Edge = dx < dy ? (rx < 0.5 ? 'left' : 'right') : (ry < 0.5 ? 'top' : 'bottom');
  return { target: hit.service, edge };
}

export interface GridDropPlan {
  /** Where the dropped cell will land — the preview rectangle. */
  rect: Rect;
  /** The tree the release will produce. */
  next: GridNode;
}

/** The half `insert` would give the newcomer: `left`/`top` take the `a` slot, `right`/
 *  `bottom` the `b` slot, at INSERT_RATIO — insert's own number, imported rather than
 *  restated, so the preview cannot promise a half the release will not produce. splitRects,
 *  not local arithmetic, so the rect is the one computeGridLayout will hand the new cell
 *  down to the pixel. */
function droppedHalf(rect: Rect, edge: Edge): Rect {
  const dir = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const [a, b] = splitRects(rect, dir, INSERT_RATIO);
  return edge === 'left' || edge === 'top' ? a : b;
}

/**
 * What a drop at `point` would do: the rectangle to preview AND the tree to commit, from one
 * computation. `null` = no legal drop, so the preview hides and the release does nothing.
 *
 * The preview and the release used to be two copies of this rule, and they had already
 * drifted: only the release knew that a service already in the grid MOVES rather than
 * inserts. A move is remove-then-insert, and the remove collapses the dragged leaf's parent
 * into its sibling — so the target cell has already GROWN by the time the insert runs, and a
 * preview drawn on current geometry promised a rect that was off by up to a factor of two.
 * Hence `next` is returned alongside `rect` rather than recomputed by the caller.
 *
 * The hit test still runs against the CURRENT on-screen layout — that is what the user is
 * aiming at — while the resulting geometry is measured on the post-removal tree.
 *
 * `draggedId` may be a service that is not in the grid (including `''` for the cross-window
 * HTML5 drag, whose id is unknown until `drop`); that is simply the insert case, which is
 * correct — a service being attached by drag is never already a leaf.
 */
export function gridDropPlan(
  point: { x: number; y: number },
  tree: GridNode | null,
  content: Rect,
  draggedId: string,
): GridDropPlan | null {
  const { cells } = computeGridLayout(tree, content);
  const at = gridDropTarget(point, cells, content);
  if (at === null) return null;
  // An empty grid takes the whole content rect: the first service is the root leaf.
  // Except for an empty id — the cross-window drag's preview path passes '' because the
  // browser withholds the dragged id until 'drop'. Everywhere else that is harmlessly "not
  // in the grid", but here it would build a leaf NAMED '', which names no service and
  // renders as a cell nothing can fill. Unreachable today (the preview only asks for a rect,
  // never commits `next`); refused at the source so it stays that way.
  if (at === 'root') {
    return draggedId ? { rect: content, next: { kind: 'leaf', service: draggedId } } : null;
  }

  const relocating = findPath(tree, draggedId) !== undefined;
  // A self-drop is a no-op (move() returns the tree by identity), so it must not promise a
  // split the release will not make.
  if (relocating && at.target === draggedId) return null;
  // Measure the tree the insert will actually run against, not the one on screen.
  const base = relocating ? remove(tree, draggedId) : tree;
  const cell = (relocating ? computeGridLayout(base, content).cells : cells)
    .find((c) => c.service === at.target);
  if (!cell) return null;
  const r = cellRect(cell);
  if (!canSplit(r, at.edge)) return null;
  return {
    rect: droppedHalf(r, at.edge),
    next: insert(base, draggedId, at.target, at.edge),
  };
}
