import { describe, it, expect } from 'vitest';
import {
  insert, remove, move, resize, services, prune, findPath, validGridServices, autoPlace,
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

describe('autoPlace', () => {
  const rects: Record<string, { width: number; height: number }> = {
    whatsapp: { width: 800, height: 600 },
    slack: { width: 200, height: 600 },
  };
  const rectOf = (s: string): { width: number; height: number } | undefined => rects[s];

  it('seeds an empty grid', () => {
    expect(autoPlace(null, 'whatsapp', rectOf)).toEqual({ kind: 'leaf', service: 'whatsapp' });
  });

  it('seeds an empty grid without measuring anything', () => {
    // The ＋ path hands it a layout of a null tree, which has no cells at all.
    expect(autoPlace(null, 'whatsapp', () => undefined)).toEqual(leaf('whatsapp'));
  });

  it('splits the largest leaf, vertically when it is wider than tall', () => {
    const tree = insert(leaf('whatsapp'), 'slack', 'whatsapp', 'right');
    expect(autoPlace(tree, 'telegram', rectOf)).toEqual({
      kind: 'split', dir: 'row', ratio: 0.5,
      a: { kind: 'split', dir: 'row', ratio: 0.5, a: leaf('whatsapp'), b: leaf('telegram') },
      b: leaf('slack'),
    });
  });

  it('splits horizontally when the largest leaf is taller than wide', () => {
    const tall = { whatsapp: { width: 300, height: 900 } };
    expect(autoPlace(leaf('whatsapp'), 'slack', (s) => tall[s as 'whatsapp'])).toEqual({
      kind: 'split', dir: 'col', ratio: 0.5, a: leaf('whatsapp'), b: leaf('slack'),
    });
  });

  it('returns the tree unchanged when nothing can be measured', () => {
    const tree = insert(leaf('whatsapp'), 'slack', 'whatsapp', 'right');
    expect(autoPlace(tree, 'telegram', () => undefined)).toBe(tree);
  });

  it('refuses a service already in the grid, like insert does', () => {
    const tree = insert(leaf('whatsapp'), 'slack', 'whatsapp', 'right');
    expect(autoPlace(tree, 'slack', rectOf)).toBe(tree);
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

  it('returns the tree unchanged, by identity, when the target is absent', () => {
    // Regression for a silent-data-loss bug: move() used to remove() then insert()
    // unconditionally, so an absent target made remove() drop the service and insert()
    // have nowhere to put it back — the leaf vanished with no error. Assert both that the
    // tree comes back unchanged AND that the moved service is still in it.
    const tree = insert(leaf('whatsapp'), 'slack', 'whatsapp', 'right');
    const result = move(tree, 'slack', 'element', 'left');
    expect(result).toBe(tree);
    expect(services(result)).toContain('slack');
  });

  it('treats moving an absent service onto a present target as an insert', () => {
    // Deliberate, not an accident: move doesn't require `service` to already be in the
    // tree, so this falls through to insert's behaviour. Pinned with toEqual so a future
    // change to that behaviour is a conscious decision, not a silent regression.
    const tree = leaf('whatsapp');
    expect(move(tree, 'slack', 'whatsapp', 'right')).toEqual({
      kind: 'split', dir: 'row', ratio: 0.5, a: leaf('whatsapp'), b: leaf('slack'),
    });
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

describe('validGridServices', () => {
  const registry = [{ id: 'whatsapp' }, { id: 'slack' }, { id: 'telegram' }, { id: 'element' }];
  const configured = new Set(['whatsapp', 'slack', 'telegram']);
  const detached = new Set(['telegram']);
  const valid = () =>
    validGridServices(registry, (id) => configured.has(id), (id) => detached.has(id));

  it('keeps only configured, non-detached services', () => {
    expect(valid()).toEqual(new Set(['whatsapp', 'slack']));
  });

  describe('as prune\'s valid set (the startup reconcile)', () => {
    it('drops an uninstalled leaf and collapses its split into the sibling', () => {
      // 'element' is in the registry but was never installed — a hand-edited or
      // stale config.json can still name it.
      const tree: GridNode = {
        kind: 'split', dir: 'row', ratio: 0.6,
        a: leaf('whatsapp'),
        b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('element'), b: leaf('slack') },
      };
      expect(prune(tree, valid())).toEqual({
        kind: 'split', dir: 'row', ratio: 0.6, a: leaf('whatsapp'), b: leaf('slack'),
      });
    });

    it('drops a detached service\'s leaf even though it is configured', () => {
      const tree = insert(leaf('whatsapp'), 'telegram', 'whatsapp', 'right');
      expect(prune(tree, valid())).toEqual(leaf('whatsapp'));
    });

    it('returns an all-valid tree by identity, so startup never rewrites config', () => {
      const tree = insert(leaf('whatsapp'), 'slack', 'whatsapp', 'right');
      expect(prune(tree, valid())).toBe(tree);
    });

    it('empties a tree whose every leaf is invalid', () => {
      const tree = insert(leaf('element'), 'telegram', 'element', 'bottom');
      expect(prune(tree, valid())).toBeNull();
    });
  });
});
