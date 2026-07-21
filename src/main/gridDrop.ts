import { cellRect, type GridCell } from './gridLayout';
import type { Edge } from './gridTree';
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
