import { GRID_GUTTER, type Rect } from './layout';
import { splitRectAt, clampRatio } from './gridLayout';
import { resize as resizeGrid, type GridNode, type Path } from './gridTree';

/**
 * One divider-drag gesture, as a pure state machine over the grid tree.
 *
 * Lives here rather than inline in index.ts so the one rule that cannot be read off a
 * single pointer event — "a gesture that never moved changes nothing" — is testable
 * without Electron. index.ts keeps the IPC wiring, the config write and the repaint.
 *
 * Every coordinate is in WINDOW space, the space main's rects are in; the caller adds the
 * content rect's origin to what the renderer reports.
 */
export interface GutterDrag {
  /** Apply a pointer position. Returns the tree to install, or undefined when there is
   *  nothing to resize — because the path went stale (a remove collapsed the split), or
   *  because the split has no legal ratio left (see clampRatio). */
  move(tree: GridNode | null, content: Rect, x: number, y: number): GridNode | null | undefined;
  /** Same, for the release — except that a gesture with no moves behind it returns
   *  undefined. A pointerdown/pointerup on a divider with no motion is a bare CLICK, and a
   *  click must not resize: it would snap the divider's centre to the click point, up to
   *  half a gutter away. */
  end(tree: GridNode | null, content: Rect, x: number, y: number): GridNode | null | undefined;
  /** Has any move actually resized the split? The caller's cue that there is something
   *  worth persisting — including on an aborted gesture, which keeps what it moved. */
  moved(): boolean;
}

export function beginGutterDrag(path: Path): GutterDrag {
  let moved = false;

  const move = (
    tree: GridNode | null, content: Rect, x: number, y: number,
  ): GridNode | null | undefined => {
    const split = splitRectAt(tree, content, path);
    // The path went stale mid-drag — do nothing rather than resize whatever else now sits
    // at that path.
    if (!split) return undefined;
    const { rect, dir } = split;
    const axis = dir === 'row' ? rect.width : rect.height;
    // The inverse of gridLayout.splitRects: the ratio divides the split's axis MINUS the
    // gutter, and the gutter sits between the halves, so aim its CENTRE at the pointer.
    // Measured against the whole axis instead, the divider would trail the cursor by up to
    // a gutter's width — grabbing it would visibly shift it before the first move.
    const along = dir === 'row' ? x - rect.x : y - rect.y;
    const raw = (along - GRID_GUTTER / 2) / Math.max(1, axis - GRID_GUTTER);
    // Two bounds, deliberately composed here: clampRatio holds the PIXEL minimum (it is the
    // only layer that knows how big this split is) and gridTree.resize re-applies the
    // structural one. Whichever is tighter wins, which is what makes the divider stop dead
    // instead of crushing a cell.
    const ratio = clampRatio(dir, axis, raw);
    // The split cannot fit two minimum children, so no position of this divider is legal.
    // Leave the tree alone — and leave `moved` false, so the release writes nothing either:
    // a gesture that resized nothing has nothing to persist.
    if (ratio === null) return undefined;
    moved = true;
    return resizeGrid(tree, path, ratio);
  };

  return {
    move,
    end: (tree, content, x, y) => (moved ? move(tree, content, x, y) : undefined),
    moved: () => moved,
  };
}
