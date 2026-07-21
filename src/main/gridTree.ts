/**
 * The grid's arrangement: a binary tree of splits with services at the leaves
 * (grid-view spec §5). Chosen over row/column tracks because holes and overlaps are
 * unrepresentable — a split always has exactly two children, so removing a leaf
 * collapses its parent into the sibling and the space is never orphaned.
 *
 * Pure: no geometry, no Electron, no I/O. Geometry lives in gridLayout.ts.
 */

/** The rail's Grid entry, and the value LoftWindow.select() takes to show the grid.
 *  The U+0000 prefix cannot collide with a service id from the registry. Write it as the
 *  `\u0000` escape, never as a literal control character — editors and copy-paste eat it
 *  silently, leaving a sentinel that compares equal to nothing. */
export const GRID_ID = '\u0000grid';

export type Edge = 'left' | 'right' | 'top' | 'bottom';

/** A route from the root as `a`/`b` steps. '' is the root; 'ab' is root.a.b. */
export type Path = string;

export type GridNode =
  | { kind: 'leaf'; service: string }
  | { kind: 'split'; dir: 'row' | 'col'; ratio: number; a: GridNode; b: GridNode };

/** Structural bounds only. The pixel minimum is applied by gridLayout.clampRatio,
 *  which is the layer that knows how big the split actually is. */
const RATIO_MIN = 0.05;
const RATIO_MAX = 0.95;

const clampRatioStructural = (r: number): number => {
  if (!Number.isFinite(r)) return 0.5;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
};

export function services(tree: GridNode | null): string[] {
  if (!tree) return [];
  if (tree.kind === 'leaf') return [tree.service];
  return [...services(tree.a), ...services(tree.b)];
}

export function findPath(tree: GridNode | null, service: string, at: Path = ''): Path | undefined {
  if (!tree) return undefined;
  if (tree.kind === 'leaf') return tree.service === service ? at : undefined;
  return findPath(tree.a, service, `${at}a`) ?? findPath(tree.b, service, `${at}b`);
}

/** Replace the leaf holding `target`. Returns the original tree when target is absent,
 *  so callers can compare by identity to detect a no-op. */
function mapLeaf(tree: GridNode, target: string, f: (leaf: GridNode) => GridNode): GridNode {
  if (tree.kind === 'leaf') return tree.service === target ? f(tree) : tree;
  const a = mapLeaf(tree.a, target, f);
  const b = mapLeaf(tree.b, target, f);
  if (a === tree.a && b === tree.b) return tree;
  return { ...tree, a, b };
}

export function insert(
  tree: GridNode | null,
  service: string,
  target: string,
  edge: Edge,
): GridNode {
  if (!tree) return { kind: 'leaf', service };
  // One ServiceView cannot render in two cells. Refuse rather than duplicate.
  if (services(tree).includes(service)) return tree;
  const dir = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const incomingFirst = edge === 'left' || edge === 'top';
  const incoming: GridNode = { kind: 'leaf', service };
  return mapLeaf(tree, target, (existing) => ({
    kind: 'split',
    dir,
    ratio: 0.5,
    a: incomingFirst ? incoming : existing,
    b: incomingFirst ? existing : incoming,
  }));
}

export function remove(tree: GridNode | null, service: string): GridNode | null {
  if (!tree) return null;
  if (tree.kind === 'leaf') return tree.service === service ? null : tree;
  const a = remove(tree.a, service);
  const b = remove(tree.b, service);
  // A split with a removed child becomes its surviving sibling — that is the collapse
  // that keeps every split binary and the space reclaimed.
  if (a === null) return b;
  if (b === null) return a;
  if (a === tree.a && b === tree.b) return tree;
  return { ...tree, a, b };
}

export function move(
  tree: GridNode | null,
  service: string,
  target: string,
  edge: Edge,
): GridNode | null {
  if (service === target) return tree;
  const without = remove(tree, service);
  // A collapse never deletes a leaf other than the removed one, so `target` is still
  // present here whenever it was present before.
  return insert(without, service, target, edge);
}

export function resize(tree: GridNode | null, path: Path, ratio: number): GridNode | null {
  if (!tree) return null;
  if (tree.kind !== 'split') return tree;
  if (path === '') return { ...tree, ratio: clampRatioStructural(ratio) };
  const step = path[0];
  const rest = path.slice(1);
  if (step === 'a') {
    const a = resize(tree.a, rest, ratio);
    return a === tree.a || a === null ? tree : { ...tree, a };
  }
  if (step === 'b') {
    const b = resize(tree.b, rest, ratio);
    return b === tree.b || b === null ? tree : { ...tree, b };
  }
  return tree;
}

export function prune(tree: GridNode | null, valid: ReadonlySet<string>): GridNode | null {
  if (!tree) return null;
  if (tree.kind === 'leaf') return valid.has(tree.service) ? tree : null;
  const a = prune(tree.a, valid);
  const b = prune(tree.b, valid);
  if (a === null) return b;
  if (b === null) return a;
  if (a === tree.a && b === tree.b) return tree;
  return { ...tree, a, b };
}
