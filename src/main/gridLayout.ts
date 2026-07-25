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
  /** Cache-buster for the cell headers' loft://icon/<id> URLs — see RailState.iconEpoch. */
  iconEpoch: number;
}

const px = (n: number): number => Math.max(0, Math.round(n));

/**
 * The two child rects of one split — the only place the gutter is subtracted and the halves
 * are rounded. Shared with gridDrop's preview rather than copied there: a previewed half has
 * to be the pixel-exact rect the resulting cell will get, and two roundings of the same
 * division disagree by a pixel on every odd width.
 *
 * `a`/`b` are gridTree's position-agnostic slots in layout order — `a` is left/top.
 */
export function splitRects(rect: Rect, dir: 'row' | 'col', ratio: number): [Rect, Rect] {
  if (dir === 'row') {
    const avail = px(rect.width - GRID_GUTTER);
    const aw = px(avail * ratio);
    return [
      { ...rect, width: aw },
      { ...rect, x: rect.x + aw + GRID_GUTTER, width: px(avail - aw) },
    ];
  }
  const avail = px(rect.height - GRID_GUTTER);
  const ah = px(avail * ratio);
  return [
    { ...rect, height: ah },
    { ...rect, y: rect.y + ah + GRID_GUTTER, height: px(avail - ah) },
  ];
}

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

    const [ra, rb] = splitRects(rect, node.dir, node.ratio);
    walk(node.a, ra, `${path}a`);
    out.gutters.push(node.dir === 'row'
      ? {
        path, dir: 'row',
        rect: { x: ra.x + ra.width, y: rect.y, width: Math.min(GRID_GUTTER, rect.width), height: rect.height },
      }
      : {
        path, dir: 'col',
        rect: { x: rect.x, y: ra.y + ra.height, width: rect.width, height: Math.min(GRID_GUTTER, rect.height) },
      });
    walk(node.b, rb, `${path}b`);
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
 * The rect a given split occupies — the axis length a divider drag is measured against —
 * together with the axis it divides. Undefined when the path names a leaf or does not
 * exist, so a path that went stale under an in-flight drag (a remove collapsed the split)
 * reads as "nothing to resize" rather than throwing, matching gridTree.resize's own
 * tolerance of a stale path.
 *
 * `dir` is returned rather than left to the caller because the caller's own copy of it
 * comes from the renderer, captured when the gesture began. A main-side prune mid-drag can
 * reshape the tree so the path now names a split of the OTHER direction; the rect follows
 * the tree, so the axis has to as well, or the drag resizes along the wrong one.
 *
 * Walks with splitRects rather than re-deriving the halves: a divider has to land on the
 * exact pixel the cell it borders lands on, and two independent roundings of one division
 * disagree on every odd width.
 */
export function splitRectAt(
  tree: GridNode | null,
  content: Rect,
  path: Path,
): { rect: Rect; dir: 'row' | 'col' } | undefined {
  let node = tree;
  let rect = content;
  for (const step of path) {
    if (!node || node.kind !== 'split') return undefined;
    const [ra, rb] = splitRects(rect, node.dir, node.ratio);
    if (step === 'a') { rect = ra; node = node.a; continue; }
    if (step === 'b') { rect = rb; node = node.b; continue; }
    return undefined;
  }
  return node && node.kind === 'split' ? { rect, dir: node.dir } : undefined;
}

/**
 * Hold a divider drag inside the pixel minimum for both children. gridTree.resize
 * applies only structural bounds — it has no idea how big the split is — so this is
 * the layer that enforces the real limit.
 *
 * Null when the axis cannot fit two minimum children at all: there is no legal ratio, and
 * the honest answer is that the divider cannot move. Inventing one — this used to answer a
 * flat 0.5 — re-centres the split on the first pixel of drag, throwing away whatever ratio
 * the user had, and the caller then persists the loss. Resizing a split with no room is
 * meaningless either way; silently rewriting the layout is strictly worse than doing
 * nothing.
 */
export function clampRatio(dir: 'row' | 'col', axisPx: number, ratio: number): number | null {
  const avail = axisPx - GRID_GUTTER;
  const min = dir === 'row' ? MIN_CELL_WIDTH : MIN_CELL_HEIGHT + CELL_HEADER_HEIGHT;
  if (avail < min * 2) return null;
  const lo = min / avail;
  return Math.min(1 - lo, Math.max(lo, ratio));
}
