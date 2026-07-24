import { describe, it, expect } from 'vitest';
import { gridDropTarget } from '../src/main/gridDrop';
import { computeGridLayout } from '../src/main/gridLayout';
import type { Rect } from '../src/main/layout';
import type { GridNode } from '../src/main/gridTree';

const content: Rect = { x: 0, y: 0, width: 1000, height: 600 };
const leaf = (service: string): GridNode => ({ kind: 'leaf', service });

const cellsOf = (tree: GridNode | null) => computeGridLayout(tree, content).cells;

describe('gridDropTarget', () => {
  it('targets the root anywhere inside an empty grid', () => {
    expect(gridDropTarget({ x: 500, y: 300 }, [], content)).toBe('root');
    expect(gridDropTarget({ x: 0, y: 0 }, [], content)).toBe('root');
  });

  it('returns null outside the content rect of an empty grid', () => {
    expect(gridDropTarget({ x: -10, y: 300 }, [], content)).toBeNull();
    expect(gridDropTarget({ x: 500, y: 700 }, [], content)).toBeNull();
  });

  it('picks the nearest edge of the cell under the pointer', () => {
    const cells = cellsOf(leaf('whatsapp'));
    expect(gridDropTarget({ x: 20, y: 300 }, cells, content)).toEqual({ target: 'whatsapp', edge: 'left' });
    expect(gridDropTarget({ x: 980, y: 300 }, cells, content)).toEqual({ target: 'whatsapp', edge: 'right' });
    expect(gridDropTarget({ x: 500, y: 10 }, cells, content)).toEqual({ target: 'whatsapp', edge: 'top' });
    expect(gridDropTarget({ x: 500, y: 590 }, cells, content)).toEqual({ target: 'whatsapp', edge: 'bottom' });
  });

  it('resolves the diagonal by normalised distance, not raw pixels', () => {
    // The cell is 1000x600. At (100, 100): rx = 0.1, ry = 0.167 — so the LEFT edge is
    // nearer in normalised terms even though both are 100px away in raw pixels.
    const cells = cellsOf(leaf('whatsapp'));
    expect(gridDropTarget({ x: 100, y: 100 }, cells, content)).toEqual({ target: 'whatsapp', edge: 'left' });
    // At (100, 50): ry = 0.083 < rx = 0.1 — now the top wins.
    expect(gridDropTarget({ x: 100, y: 50 }, cells, content)).toEqual({ target: 'whatsapp', edge: 'top' });
  });

  it('has no dead zone — the exact centre still yields an edge', () => {
    const cells = cellsOf(leaf('whatsapp'));
    const at = gridDropTarget({ x: 500, y: 300 }, cells, content);
    expect(at).not.toBeNull();
    expect(at).toMatchObject({ target: 'whatsapp' });
  });

  it('targets the correct cell in a populated grid, header included', () => {
    const tree: GridNode = { kind: 'split', dir: 'row', ratio: 0.5, a: leaf('whatsapp'), b: leaf('slack') };
    const cells = cellsOf(tree);
    expect(gridDropTarget({ x: 480, y: 300 }, cells, content)).toMatchObject({ target: 'whatsapp' });
    expect(gridDropTarget({ x: 520, y: 300 }, cells, content)).toMatchObject({ target: 'slack' });
    // A point in the header strip belongs to that cell too.
    expect(gridDropTarget({ x: 520, y: 5 }, cells, content)).toMatchObject({ target: 'slack' });
  });

  it('returns null in a gutter and outside the content rect of a populated grid', () => {
    const tree: GridNode = { kind: 'split', dir: 'row', ratio: 0.5, a: leaf('whatsapp'), b: leaf('slack') };
    const cells = cellsOf(tree);
    expect(gridDropTarget({ x: 499, y: 300 }, cells, content)).toBeNull();
    expect(gridDropTarget({ x: 1200, y: 300 }, cells, content)).toBeNull();
  });
});
