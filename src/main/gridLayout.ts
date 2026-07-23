import {
  CELL_HEADER_HEIGHT, GRID_GUTTER, MIN_CELL_WIDTH, MIN_CELL_HEIGHT, type Rect,
} from './layout';
import type { Edge, GridNode, Path } from './gridTree';

/**
 * Tree → rectangles. The single source of truth for grid geometry: main sets each
 * service view's bounds from `body` and pushes `cells` + `gutters` to the chrome
 * renderer, which positions what it is told and computes nothing. Same "main decides,
 * renderer draws" split the rail uses — and the reason all of this is testable with
 * no window.
 */

export interface GridCell {
  service: string;
  /** The header strip. Owned by the chrome view. */
  header: Rect;
  /** Where the service's own WebContentsView goes. */
  body: Rect;
}

export interface GridGutter {
  /** The split this gutter resizes (gridTree Path). */
  path: Path;
  dir: 'row' | 'col';
  rect: Rect;
}

export interface GridLayout {
  cells: GridCell[];
  gutters: GridGutter[];
}

/** Everything the grid chrome renderer needs in one push. `origin` is the content
 *  rect's top-left: the renderer's own coordinate space starts there, but every Rect in
 *  `layout` is in window coordinates, so the renderer subtracts it. */
export interface GridViewState {
  layout: GridLayout;
  origin: { x: number; y: number };
  names: Record<string, string>;
  badges: Record<string, number>;
  focused: string | undefined;
}

const px = (n: number): number => Math.max(0, Math.round(n));

export function computeGridLayout(tree: GridNode | null, content: Rect): GridLayout {
  const out: GridLayout = { cells: [], gutters: [] };
  if (!tree) return out;

  const walk = (node: GridNode, rect: Rect, path: Path): void => {
    if (node.kind === 'leaf') {
      const headerHeight = Math.min(CELL_HEADER_HEIGHT, rect.height);
      out.cells.push({
        service: node.service,
        header: { x: rect.x, y: rect.y, width: rect.width, height: px(headerHeight) },
        body: {
          x: rect.x,
          y: rect.y + headerHeight,
          width: rect.width,
          height: px(rect.height - headerHeight),
        },
      });
      return;
    }

    if (node.dir === 'row') {
      const avail = px(rect.width - GRID_GUTTER);
      const aw = px(avail * node.ratio);
      const bw = px(avail - aw);
      walk(node.a, { ...rect, width: aw }, `${path}a`);
      out.gutters.push({
        path, dir: 'row',
        rect: { x: rect.x + aw, y: rect.y, width: Math.min(GRID_GUTTER, rect.width), height: rect.height },
      });
      walk(node.b, { ...rect, x: rect.x + aw + GRID_GUTTER, width: bw }, `${path}b`);
      return;
    }

    const avail = px(rect.height - GRID_GUTTER);
    const ah = px(avail * node.ratio);
    const bh = px(avail - ah);
    walk(node.a, { ...rect, height: ah }, `${path}a`);
    out.gutters.push({
      path, dir: 'col',
      rect: { x: rect.x, y: rect.y + ah, width: rect.width, height: Math.min(GRID_GUTTER, rect.height) },
    });
    walk(node.b, { ...rect, y: rect.y + ah + GRID_GUTTER, height: bh }, `${path}b`);
  };

  walk(tree, content, '');
  return out;
}

/** Header ∪ body — the region a drop or a click is tested against. */
export function cellRect(cell: GridCell): Rect {
  return {
    x: cell.header.x,
    y: cell.header.y,
    width: cell.header.width,
    height: cell.header.height + cell.body.height,
  };
}

/** Would splitting this cell leave both halves above the minimum? */
export function canSplit(rect: Rect, edge: Edge): boolean {
  if (edge === 'left' || edge === 'right') {
    return (rect.width - GRID_GUTTER) / 2 >= MIN_CELL_WIDTH;
  }
  // MIN_CELL_HEIGHT is the body; each half also has to carry its own header.
  return (rect.height - GRID_GUTTER) / 2 >= MIN_CELL_HEIGHT + CELL_HEADER_HEIGHT;
}

/**
 * The sizes gridTree.autoPlace is allowed to measure: a leaf whose split would break the
 * minimum is reported as unmeasurable, which is autoPlace's own skip signal.
 *
 * The minimum has to be applied on the way IN because autoPlace owns no geometry — it
 * splits whichever leaf it is told is biggest — and withholding a size is the only lever
 * the caller has. With every leaf withheld autoPlace declines and returns the tree by
 * reference, which its callers already treat as a no-op.
 *
 * Without this the two ways of adding a cell disagree: a DRAG refuses a sub-minimum split
 * (the drop preview applies canSplit), while ＋ would silently make one.
 *
 * The edge chosen below must stay in step with autoPlace's own rule ("split the long
 * way") — the question being asked is whether the split autoPlace WOULD make is legal.
 */
export function splittableSizes(
  layout: GridLayout,
): (service: string) => { width: number; height: number } | undefined {
  return (service) => {
    const cell = layout.cells.find((c) => c.service === service);
    if (!cell) return undefined;
    const size = { width: cell.body.width, height: cell.body.height };
    const edge: Edge = size.width >= size.height ? 'right' : 'bottom';
    return canSplit(cellRect(cell), edge) ? size : undefined;
  };
}

/** Is there any cell left that autoPlace could legally split — i.e. would ＋ do anything?
 *  An empty grid always can: its first service becomes the root leaf, splitting nothing. */
export function hasSplittableCell(layout: GridLayout): boolean {
  if (layout.cells.length === 0) return true;
  const sizeOf = splittableSizes(layout);
  return layout.cells.some((c) => sizeOf(c.service) !== undefined);
}

/**
 * Hold a divider drag inside the pixel minimum for both children. gridTree.resize
 * applies only structural bounds — it has no idea how big the split is — so this is
 * the layer that enforces the real limit.
 */
export function clampRatio(dir: 'row' | 'col', axisPx: number, ratio: number): number {
  const avail = axisPx - GRID_GUTTER;
  const min = dir === 'row' ? MIN_CELL_WIDTH : MIN_CELL_HEIGHT + CELL_HEADER_HEIGHT;
  // Two minimum children do not fit at all: refuse to move rather than pick a side.
  if (avail < min * 2) return 0.5;
  const lo = min / avail;
  return Math.min(1 - lo, Math.max(lo, ratio));
}
