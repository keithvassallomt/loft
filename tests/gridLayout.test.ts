import { describe, it, expect } from 'vitest';
import { computeGridLayout, cellRect, canSplit, clampRatio } from '../src/main/gridLayout';
import { CELL_HEADER_HEIGHT, GRID_GUTTER, type Rect } from '../src/main/layout';
import type { GridNode } from '../src/main/gridTree';

const content: Rect = { x: 52, y: 40, width: 1000, height: 600 };
const leaf = (service: string): GridNode => ({ kind: 'leaf', service });

describe('computeGridLayout', () => {
  it('gives an empty tree no cells and no gutters', () => {
    expect(computeGridLayout(null, content)).toEqual({ cells: [], gutters: [] });
  });

  it('gives a single leaf the whole content rect, split into header and body', () => {
    const { cells, gutters } = computeGridLayout(leaf('whatsapp'), content);
    expect(gutters).toEqual([]);
    expect(cells).toEqual([{
      service: 'whatsapp',
      header: { x: 52, y: 40, width: 1000, height: CELL_HEADER_HEIGHT },
      body: { x: 52, y: 40 + CELL_HEADER_HEIGHT, width: 1000, height: 600 - CELL_HEADER_HEIGHT },
    }]);
  });

  it('divides a row split around a gutter, losing no pixels', () => {
    const tree: GridNode = { kind: 'split', dir: 'row', ratio: 0.5, a: leaf('whatsapp'), b: leaf('slack') };
    const { cells, gutters } = computeGridLayout(tree, content);
    const avail = 1000 - GRID_GUTTER;          // 994
    const aw = Math.round(avail * 0.5);        // 497
    expect(cells[0].header.x).toBe(52);
    expect(cells[0].header.width).toBe(aw);
    expect(gutters).toEqual([
      { path: '', dir: 'row', rect: { x: 52 + aw, y: 40, width: GRID_GUTTER, height: 600 } },
    ]);
    expect(cells[1].header.x).toBe(52 + aw + GRID_GUTTER);
    expect(cells[1].header.width).toBe(avail - aw);
    // Every pixel of the content rect is either a cell or the gutter.
    expect(cells[0].header.width + GRID_GUTTER + cells[1].header.width).toBe(content.width);
  });

  it('divides a col split around a horizontal gutter', () => {
    const tree: GridNode = { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('whatsapp'), b: leaf('slack') };
    const { cells, gutters } = computeGridLayout(tree, content);
    const avail = 600 - GRID_GUTTER;
    const ah = Math.round(avail * 0.5);
    expect(cells[0].header.y).toBe(40);
    expect(gutters[0].rect).toEqual({ x: 52, y: 40 + ah, width: 1000, height: GRID_GUTTER });
    expect(cells[1].header.y).toBe(40 + ah + GRID_GUTTER);
    expect(cells[0].body.height + CELL_HEADER_HEIGHT + GRID_GUTTER
         + cells[1].body.height + CELL_HEADER_HEIGHT).toBe(content.height);
  });

  it('paths its gutters so nested splits are addressable', () => {
    const tree: GridNode = {
      kind: 'split', dir: 'row', ratio: 0.5,
      a: leaf('whatsapp'),
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('slack'), b: leaf('telegram') },
    };
    expect(computeGridLayout(tree, content).gutters.map((g) => g.path)).toEqual(['', 'b']);
  });

  it('never produces a negative dimension in a degenerate rect', () => {
    const tiny: Rect = { x: 0, y: 0, width: 4, height: 8 };
    const tree: GridNode = { kind: 'split', dir: 'row', ratio: 0.5, a: leaf('a'), b: leaf('b') };
    for (const c of computeGridLayout(tree, tiny).cells) {
      expect(c.header.width).toBeGreaterThanOrEqual(0);
      expect(c.header.height).toBeGreaterThanOrEqual(0);
      expect(c.body.width).toBeGreaterThanOrEqual(0);
      expect(c.body.height).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('cellRect', () => {
  it('unions the header and body into the clickable cell rect', () => {
    const [cell] = computeGridLayout(leaf('whatsapp'), content).cells;
    expect(cellRect(cell)).toEqual({ x: 52, y: 40, width: 1000, height: 600 });
  });
});

describe('canSplit', () => {
  const wide: Rect = { x: 0, y: 0, width: 1000, height: 600 };

  it('allows a split when both halves clear the minimum', () => {
    expect(canSplit(wide, 'left')).toBe(true);
    expect(canSplit(wide, 'bottom')).toBe(true);
  });

  it('refuses a vertical split that would go under MIN_CELL_WIDTH', () => {
    expect(canSplit({ x: 0, y: 0, width: 400, height: 600 }, 'right')).toBe(false);
  });

  it('refuses a horizontal split that would go under MIN_CELL_HEIGHT plus the header', () => {
    expect(canSplit({ x: 0, y: 0, width: 1000, height: 300 }, 'top')).toBe(false);
  });
});

describe('clampRatio', () => {
  it('keeps a row ratio inside the pixel minimum for both children', () => {
    // 1000px wide, 6px gutter, 240px minimum ⇒ ratio must stay within [0.241…, 0.758…]
    expect(clampRatio('row', 1000, 0.01)).toBeCloseTo(240 / 994, 3);
    expect(clampRatio('row', 1000, 0.99)).toBeCloseTo(1 - 240 / 994, 3);
    expect(clampRatio('row', 1000, 0.5)).toBe(0.5);
  });

  it('falls back to a half when the axis cannot fit two minimum children', () => {
    expect(clampRatio('row', 300, 0.9)).toBe(0.5);
  });
});
