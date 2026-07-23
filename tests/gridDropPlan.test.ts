import { describe, it, expect } from 'vitest';
import { gridDropPlan } from '../src/main/gridDrop';
import { cellRect, computeGridLayout } from '../src/main/gridLayout';
import type { Rect } from '../src/main/layout';
import type { GridNode } from '../src/main/gridTree';

const content: Rect = { x: 0, y: 0, width: 1000, height: 600 };
const leaf = (service: string): GridNode => ({ kind: 'leaf', service });
const row = (a: GridNode, b: GridNode): GridNode => ({ kind: 'split', dir: 'row', ratio: 0.5, a, b });

/** Where `service` actually ends up, measured the way the window measures it. */
function cellOf(tree: GridNode | null, service: string, area: Rect = content): Rect | undefined {
  const cell = computeGridLayout(tree, area).cells.find((c) => c.service === service);
  return cell ? cellRect(cell) : undefined;
}

describe('gridDropPlan — the preview IS the release', () => {
  // The whole point of the function: whatever rectangle the drag promised, the tree it
  // commits puts the dropped service in exactly that rectangle. Two copies of this rule
  // drifted once already, which is what these two assertions exist to catch.
  it('previews the rect a fresh insert really produces', () => {
    const tree = leaf('whatsapp');
    const plan = gridDropPlan({ x: 980, y: 300 }, tree, content, 'slack');
    expect(plan).not.toBeNull();
    expect(plan!.rect).toEqual(cellOf(plan!.next, 'slack'));
  });

  it('previews the rect a cross-cell MOVE really produces', () => {
    // row(A, row(B, C)), dragging A onto C: removing A collapses the outer split, so C is
    // twice as wide by the time the insert runs.
    const tree = row(leaf('a'), row(leaf('b'), leaf('c')));
    const plan = gridDropPlan({ x: 877, y: 590 }, tree, content, 'a');
    expect(plan).not.toBeNull();
    expect(plan!.rect).toEqual(cellOf(plan!.next, 'a'));
  });

  it('measures a move against the POST-removal geometry, not what is on screen', () => {
    const tree = row(leaf('a'), row(leaf('b'), leaf('c')));
    const before = cellOf(tree, 'c')!;
    // On screen C is a quarter of the width: the outer split halves 1000 (less the 6px
    // gutter) and the inner one halves that again.
    expect(before.width).toBe(245);
    const plan = gridDropPlan({ x: 877, y: 590 }, tree, content, 'a')!;
    expect(plan).not.toBeNull();
    // Removing A collapses the outer split into row(B, C), so by the time the insert runs C
    // is half the content — the naive preview would have promised a rect half this wide.
    expect(plan.rect.width).not.toBe(before.width);
    expect(plan.rect.width).toBe(497);
  });

  it('refuses a self-drop rather than promising a split that never happens', () => {
    const tree = row(leaf('whatsapp'), leaf('slack'));
    expect(gridDropPlan({ x: 20, y: 300 }, tree, content, 'whatsapp')).toBeNull();
  });
});

describe('gridDropPlan — refusals and the empty grid', () => {
  it('takes the whole content rect for the first service', () => {
    const plan = gridDropPlan({ x: 500, y: 300 }, null, content, 'slack');
    expect(plan).toEqual({ rect: content, next: leaf('slack') });
  });

  it('returns null in a gutter and outside the content rect', () => {
    const tree = row(leaf('whatsapp'), leaf('slack'));
    expect(gridDropPlan({ x: 499, y: 300 }, tree, content, 'element')).toBeNull();
    expect(gridDropPlan({ x: 1200, y: 300 }, tree, content, 'element')).toBeNull();
    expect(gridDropPlan({ x: 1200, y: 300 }, null, content, 'element')).toBeNull();
  });

  it('returns null when the split would leave a half under the minimum', () => {
    // 400 wide: each half would be 197px, below MIN_CELL_WIDTH.
    const narrow: Rect = { x: 0, y: 0, width: 400, height: 600 };
    expect(gridDropPlan({ x: 10, y: 300 }, leaf('whatsapp'), narrow, 'slack')).toBeNull();
    // 300 tall: each half would be 147px of body+header, below MIN_CELL_HEIGHT + header.
    const short: Rect = { x: 0, y: 0, width: 1000, height: 300 };
    expect(gridDropPlan({ x: 500, y: 295 }, leaf('whatsapp'), short, 'slack')).toBeNull();
  });

  // The ⠿ handle drag (grid:cellDragBegin) resolves through this same call, so these two are
  // what make a slipped cell move a no-op: a release that is not over another cell must leave
  // the tree alone. Removal is the ✕ and only the ✕ — a drag can never evict a service.
  it('returns null for a cell released over a gutter or outside the grid', () => {
    const tree = row(leaf('whatsapp'), leaf('slack'));
    expect(gridDropPlan({ x: 499, y: 300 }, tree, content, 'whatsapp')).toBeNull();
    expect(gridDropPlan({ x: 1200, y: 300 }, tree, content, 'whatsapp')).toBeNull();
    expect(gridDropPlan({ x: 500, y: -20 }, tree, content, 'whatsapp')).toBeNull();
  });

  it('refuses a move whose target is too small to split even after the removal', () => {
    // 300 wide: whatever a leaves behind, halving it gives 147px — under MIN_CELL_WIDTH.
    const tiny: Rect = { x: 0, y: 0, width: 300, height: 600 };
    const tree = row(leaf('a'), leaf('b'));
    expect(gridDropPlan({ x: 160, y: 300 }, tree, tiny, 'a')).toBeNull();
  });

  it('applies the minimum to the POST-removal cell a move would split', () => {
    // b is only 297px wide on screen — too narrow to halve — but removing a leaves it the
    // full 600, so this move is legal even though the same drop by a not-yet-gridded
    // service is not.
    const narrow: Rect = { x: 0, y: 0, width: 600, height: 600 };
    const tree = row(leaf('a'), leaf('b'));
    const point = { x: 310, y: 300 };
    expect(gridDropPlan(point, tree, narrow, 'c')).toBeNull();
    const plan = gridDropPlan(point, tree, narrow, 'a');
    expect(plan).not.toBeNull();
    expect(plan!.rect).toEqual(cellOf(plan!.next, 'a', narrow));
  });
});
