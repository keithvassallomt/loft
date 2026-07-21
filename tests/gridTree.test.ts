import { describe, it, expect } from 'vitest';
import {
  insert, remove, move, resize, services, prune, findPath,
  type GridNode,
} from '../src/main/gridTree';

const leaf = (service: string): GridNode => ({ kind: 'leaf', service });

describe('insert', () => {
  it('makes the service the root of an empty grid, ignoring target and edge', () => {
    expect(insert(null, 'whatsapp', 'nobody', 'left')).toEqual(leaf('whatsapp'));
  });

  it('splits the target leaf, putting a left/top drop in the a slot', () => {
    expect(insert(leaf('whatsapp'), 'slack', 'whatsapp', 'left')).toEqual({
      kind: 'split', dir: 'row', ratio: 0.5, a: leaf('slack'), b: leaf('whatsapp'),
    });
    expect(insert(leaf('whatsapp'), 'slack', 'whatsapp', 'top')).toEqual({
      kind: 'split', dir: 'col', ratio: 0.5, a: leaf('slack'), b: leaf('whatsapp'),
    });
  });

  it('puts a right/bottom drop in the b slot', () => {
    expect(insert(leaf('whatsapp'), 'slack', 'whatsapp', 'right')).toEqual({
      kind: 'split', dir: 'row', ratio: 0.5, a: leaf('whatsapp'), b: leaf('slack'),
    });
    expect(insert(leaf('whatsapp'), 'slack', 'whatsapp', 'bottom')).toEqual({
      kind: 'split', dir: 'col', ratio: 0.5, a: leaf('whatsapp'), b: leaf('slack'),
    });
  });

  it('splits a nested leaf and leaves its siblings untouched', () => {
    const tree = insert(leaf('whatsapp'), 'slack', 'whatsapp', 'right');
    const out = insert(tree, 'telegram', 'slack', 'bottom');
    expect(out).toEqual({
      kind: 'split', dir: 'row', ratio: 0.5,
      a: leaf('whatsapp'),
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('slack'), b: leaf('telegram') },
    });
  });

  it('refuses a duplicate — one view cannot render in two cells', () => {
    const tree = insert(leaf('whatsapp'), 'slack', 'whatsapp', 'right');
    expect(insert(tree, 'slack', 'whatsapp', 'left')).toBe(tree);
  });

  it('returns the tree unchanged when the target is not a leaf in it', () => {
    const tree = leaf('whatsapp');
    expect(insert(tree, 'slack', 'element', 'left')).toBe(tree);
  });
});

describe('remove', () => {
  it('empties a single-leaf grid', () => {
    expect(remove(leaf('whatsapp'), 'whatsapp')).toBeNull();
  });

  it('collapses the parent split into the surviving sibling', () => {
    const tree = insert(leaf('whatsapp'), 'slack', 'whatsapp', 'right');
    expect(remove(tree, 'slack')).toEqual(leaf('whatsapp'));
    expect(remove(tree, 'whatsapp')).toEqual(leaf('slack'));
  });

  it('collapses a nested split without disturbing the rest', () => {
    const tree: GridNode = {
      kind: 'split', dir: 'row', ratio: 0.6,
      a: leaf('whatsapp'),
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('slack'), b: leaf('telegram') },
    };
    expect(remove(tree, 'telegram')).toEqual({
      kind: 'split', dir: 'row', ratio: 0.6, a: leaf('whatsapp'), b: leaf('slack'),
    });
  });

  it('is identity for an absent service and for an empty tree', () => {
    const tree = leaf('whatsapp');
    expect(remove(tree, 'element')).toBe(tree);
    expect(remove(null, 'element')).toBeNull();
  });
});

describe('move', () => {
  it('relocates a leaf to the other side of the tree', () => {
    const tree: GridNode = {
      kind: 'split', dir: 'row', ratio: 0.5,
      a: leaf('whatsapp'),
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('slack'), b: leaf('telegram') },
    };
    expect(move(tree, 'telegram', 'whatsapp', 'top')).toEqual({
      kind: 'split', dir: 'row', ratio: 0.5,
      a: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('telegram'), b: leaf('whatsapp') },
      b: leaf('slack'),
    });
  });

  it('is a no-op when moved onto itself', () => {
    const tree = insert(leaf('whatsapp'), 'slack', 'whatsapp', 'right');
    expect(move(tree, 'slack', 'slack', 'left')).toBe(tree);
  });
});

describe('resize', () => {
  const tree: GridNode = {
    kind: 'split', dir: 'row', ratio: 0.5,
    a: leaf('whatsapp'),
    b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('slack'), b: leaf('telegram') },
  };

  it('sets the root ratio at the empty path', () => {
    expect(resize(tree, '', 0.7)).toMatchObject({ ratio: 0.7 });
  });

  it('sets a nested ratio without touching the root', () => {
    const out = resize(tree, 'b', 0.25);
    expect(out).toMatchObject({ ratio: 0.5 });
    expect((out as Extract<GridNode, { kind: 'split' }>).b).toMatchObject({ ratio: 0.25 });
  });

  it('clamps structurally out-of-range ratios', () => {
    expect(resize(tree, '', 0)).toMatchObject({ ratio: 0.05 });
    expect(resize(tree, '', 1)).toMatchObject({ ratio: 0.95 });
    expect(resize(tree, '', Number.NaN)).toMatchObject({ ratio: 0.5 });
  });

  it('is identity for a path that names a leaf or does not exist', () => {
    expect(resize(tree, 'a', 0.7)).toBe(tree);
    expect(resize(tree, 'bbb', 0.7)).toBe(tree);
    expect(resize(null, '', 0.7)).toBeNull();
  });
});

describe('services and findPath', () => {
  const tree: GridNode = {
    kind: 'split', dir: 'row', ratio: 0.5,
    a: leaf('whatsapp'),
    b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('slack'), b: leaf('telegram') },
  };

  it('lists leaves in tree order', () => {
    expect(services(tree)).toEqual(['whatsapp', 'slack', 'telegram']);
    expect(services(null)).toEqual([]);
  });

  it('finds the path to a leaf, and undefined for an absent one', () => {
    expect(findPath(tree, 'whatsapp')).toBe('a');
    expect(findPath(tree, 'telegram')).toBe('bb');
    expect(findPath(tree, 'element')).toBeUndefined();
  });
});

describe('prune', () => {
  it('drops leaves outside the valid set, collapsing as it goes', () => {
    const tree: GridNode = {
      kind: 'split', dir: 'row', ratio: 0.5,
      a: leaf('whatsapp'),
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('slack'), b: leaf('telegram') },
    };
    expect(prune(tree, new Set(['whatsapp', 'telegram']))).toEqual({
      kind: 'split', dir: 'row', ratio: 0.5, a: leaf('whatsapp'), b: leaf('telegram'),
    });
    expect(prune(tree, new Set())).toBeNull();
    expect(prune(null, new Set(['whatsapp']))).toBeNull();
  });
});
