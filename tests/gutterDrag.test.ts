import { describe, it, expect } from 'vitest';
import { beginGutterDrag } from '../src/main/gutterDrag';
import type { Rect } from '../src/main/layout';
import type { GridNode } from '../src/main/gridTree';

const leaf = (service: string): GridNode => ({ kind: 'leaf', service });

/** 1006 wide ⇒ 1000px of ratio axis once the 6px gutter is taken out. */
const content: Rect = { x: 0, y: 0, width: 1006, height: 600 };

const rowTree = (ratio: number): GridNode =>
  ({ kind: 'split', dir: 'row', ratio, a: leaf('whatsapp'), b: leaf('slack') });

describe('beginGutterDrag', () => {
  it('resizes the split the path names, from the pointer', () => {
    const drag = beginGutterDrag('');
    const tree = rowTree(0.5);
    const next = drag.move(tree, content, 306, 300);
    expect(next).toEqual({ ...tree, ratio: 0.303 });
    expect(drag.moved()).toBe(true);
  });

  it('takes the axis from the tree, not from the caller', () => {
    // A COLUMN split: only the y of the pointer may move it. The renderer's captured
    // direction is never passed in, so a mid-drag reshape cannot resize the wrong way.
    const tree: GridNode =
      { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('whatsapp'), b: leaf('slack') };
    const drag = beginGutterDrag('');
    // 600 tall ⇒ 594 of axis; y = 300 ⇒ (300 - 3) / 594.
    expect(drag.move(tree, content, 900, 300)).toEqual({ ...tree, ratio: 297 / 594 });
  });

  it('does nothing at all when the path went stale mid-gesture', () => {
    const drag = beginGutterDrag('ab');
    expect(drag.move(rowTree(0.5), content, 306, 300)).toBeUndefined();
    expect(drag.moved()).toBe(false);
  });

  it('leaves the tree untouched when the gesture never moved', () => {
    // The whole point: pointerdown + pointerup on a divider with nothing in between is a
    // CLICK, and a click is not a resize. Undefined tells index.ts to write neither the
    // tree nor config.json.
    const drag = beginGutterDrag('');
    expect(drag.end(rowTree(0.4), content, 306, 300)).toBeUndefined();
    expect(drag.moved()).toBe(false);
  });

  it('applies the release point once the gesture HAS moved', () => {
    const drag = beginGutterDrag('');
    const tree = rowTree(0.5);
    drag.move(tree, content, 200, 300);
    expect(drag.end(tree, content, 306, 300)).toEqual({ ...tree, ratio: 0.303 });
  });

  it('does not re-centre a split too small for two minimum children on a bare click', () => {
    const narrow: Rect = { x: 0, y: 0, width: 300, height: 600 };
    expect(beginGutterDrag('').end(rowTree(0.8), narrow, 150, 300)).toBeUndefined();
  });

  it('leaves a split too small for two minimum children untouched by a real DRAG', () => {
    // Below 2 × MIN_CELL_WIDTH there is no legal ratio at all, so there is nothing a drag
    // here could mean. It used to mean 0.5 — one pixel of movement re-centred the split,
    // discarding whatever ratio the user had, and the release persisted the loss.
    const narrow: Rect = { x: 0, y: 0, width: 300, height: 600 };
    const start = rowTree(0.8);
    let tree: GridNode | null = start;
    const drag = beginGutterDrag('');
    const next = drag.move(tree, narrow, 150, 300);
    expect(next).toBeUndefined();
    if (next !== undefined) tree = next;
    // By identity: not a re-built equal tree either, so nothing downstream can mistake this
    // for a change worth writing.
    expect(tree).toBe(start);
    expect(drag.moved()).toBe(false);
    // …and the release that follows is just as inert.
    expect(drag.end(tree, narrow, 150, 300)).toBeUndefined();
    expect(drag.moved()).toBe(false);
  });

  it('still counts as moved when the release path went stale', () => {
    // index.ts gates its config write on moved(), not on the release step succeeding,
    // because a release whose path went stale still has the earlier moves behind it — and
    // those are what needs writing.
    const drag = beginGutterDrag('');
    let tree: GridNode | null = rowTree(0.5);
    const moved = drag.move(tree, content, 306, 300);
    if (moved !== undefined) tree = moved;
    expect(tree).toEqual(rowTree(0.303));

    // A remove collapsed the split under the gesture: the path now names a leaf.
    expect(drag.end(leaf('whatsapp'), content, 500, 300)).toBeUndefined();
    expect(drag.moved()).toBe(true);
    expect(tree).toEqual(rowTree(0.303));
  });
});
