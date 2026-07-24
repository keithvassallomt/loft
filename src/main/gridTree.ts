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

/** Which side of the target leaf the incoming service is dropped on. Drives both the new
 *  split's axis (left/right -> row, top/bottom -> col) and which child slot the newcomer
 *  lands in (see insert). */
export type Edge = 'left' | 'right' | 'top' | 'bottom';

/** A route from the root as `a`/`b` steps. '' is the root; 'ab' is root.a.b. */
export type Path = string;

/** `a` and `b` are position-agnostic slots, not fixed screen sides — which one renders
 *  left/top vs right/bottom follows from `dir` and, at insert time, from `edge` (see
 *  insert). Naming the children that way, instead of after a screen direction, is what lets
 *  resize/remove/prune walk the tree without caring which way it's currently laid out. */
export type GridNode =
  | { kind: 'leaf'; service: string }
  | { kind: 'split'; dir: 'row' | 'col'; ratio: number; a: GridNode; b: GridNode };

/** Structural bounds only. The pixel minimum is applied by gridLayout.clampRatio,
 *  which is the layer that knows how big the split actually is. Exported so config.ts
 *  can clamp a persisted ratio into the same range an interactive resize would produce,
 *  instead of duplicating these numbers there. */
export const RATIO_MIN = 0.05;
export const RATIO_MAX = 0.95;

/** The split a new cell gets: an even one. Exported because gridDrop must draw the preview
 *  on the very half `insert` will produce — this feature's worst bug was the drop rule
 *  written twice and drifting, and this was the last number the two still restated. */
export const INSERT_RATIO = 0.5;

const clampRatioStructural = (r: number): number => {
  if (!Number.isFinite(r)) return 0.5;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
};

/** Leaves in depth-first a-then-b order — not the tree's on-screen layout (that's dir's
 *  job), just the occupied-services set for callers like insert's duplicate check and
 *  prune's valid-set comparison. */
export function services(tree: GridNode | null): string[] {
  if (!tree) return [];
  if (tree.kind === 'leaf') return [tree.service];
  return [...services(tree.a), ...services(tree.b)];
}

/** The route to `service`'s leaf, or undefined if it isn't in the tree — the presence
 *  check an operation should run before it assumes `service` exists (see move's guard
 *  against a target that isn't a leaf). */
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

/** Drops `service` beside `target`, splitting target's leaf into a new two-way split.
 *  Returns the tree unchanged, by reference, when `service` is already in it or `target`
 *  isn't a leaf in it, so callers can use `===` to tell a real edit from a no-op. `left`/
 *  `top` place the newcomer in the `a` slot, `right`/`bottom` in `b` (see Edge for how that
 *  then maps to a screen side). */
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
    ratio: INSERT_RATIO,
    a: incomingFirst ? incoming : existing,
    b: incomingFirst ? existing : incoming,
  }));
}

/**
 * Where ＋ puts a service: split the largest leaf along its own LONG axis — a wide cell
 * halves side-by-side, a tall one stacks — so the result stays roughly square. The direction
 * comes from that leaf's aspect ratio, not from the depth it sits at, which is the rule
 * gridLayout.splittableSizes has to mirror to ask whether the split would be legal. There is
 * no pointer to aim with, so the tree picks — this is the only place auto-placement exists;
 * a drag always aims (grid-view spec §5).
 *
 * Takes `rectOf` rather than a layout because this file owns no geometry (see the header):
 * the caller measures the CURRENT cells and hands the sizes back. A leaf `rectOf` cannot
 * size is skipped, so an empty tree — no cells to measure — still seeds its root leaf
 * without ever asking.
 */
export function autoPlace(
  tree: GridNode | null,
  service: string,
  rectOf: (leafService: string) => { width: number; height: number } | undefined,
): GridNode {
  if (!tree) return { kind: 'leaf', service };
  let best: string | undefined;
  let bestArea = -1;
  for (const s of services(tree)) {
    const r = rectOf(s);
    if (!r) continue;
    const area = r.width * r.height;
    if (area > bestArea) { bestArea = area; best = s; }
  }
  // Nothing measurable to split beside. Returning the tree by reference matches insert's
  // no-op contract, so a caller can still tell nothing happened.
  if (!best) return tree;
  const r = rectOf(best)!;
  // Split the long way: a wide cell halves into two side-by-side, a tall one into two
  // stacked. That is what keeps repeated ＋ from degenerating into slivers.
  return insert(tree, service, best, r.width >= r.height ? 'right' : 'bottom');
}

/** Removes `service`'s leaf, collapsing its parent into the sibling (see the inline
 *  comment below). Returns the tree unchanged, by reference, when `service` isn't in it, so
 *  callers can use `===` to detect a no-op the same way insert does. */
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

/** Relocates `service` to sit beside `target` on the given `edge` (remove, then insert).
 *  Identity (`===`) is preserved only for the literal self-move (`service === target`) and
 *  for an absent `target`; a move that's logically a no-op some other way (e.g. re-dropping
 *  a leaf on the edge it already occupies) still rebuilds the path down to it, so don't rely
 *  on `===` alone to skip a re-layout — diff the result if that distinction matters. */
export function move(
  tree: GridNode | null,
  service: string,
  target: string,
  edge: Edge,
): GridNode | null {
  if (service === target) return tree;
  // Guard the precondition rather than trusting it. Without this an absent target makes
  // remove() drop the service and insert() find nowhere to put it back: the leaf vanishes
  // with no error, and the caller gets a tree that looks deliberately edited.
  if (findPath(tree, target) === undefined) return tree;
  const without = remove(tree, service);
  // A collapse never deletes a leaf other than the removed one, so `target` — checked
  // present just above — is still present here.
  return insert(without, service, target, edge);
}

/** Sets the ratio on the split at `path` (`''` is the root), clamped to the structural
 *  bounds. Identity is preserved (by reference) whenever `path` doesn't resolve to an
 *  existing split — it ran into a leaf, or a step the tree doesn't have — rather than
 *  throwing on a path that went stale after an intervening remove/insert. */
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

/** Drops every leaf whose service isn't in `valid`, collapsing as remove does but in one
 *  pass over the whole tree — the option for reconciling the grid against a changed service
 *  set (e.g. after a config reload) without removing one leaf at a time. */
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

/** The `valid` set prune expects, computed from the registry: a service may hold a cell
 *  only while it is still configured (an uninstalled one has no view to tile) and not
 *  detached (its view lives in its own window — detached and gridded are mutually
 *  exclusive). Takes predicates rather than a config object so the rule stays testable on
 *  its own and LoftConfig stays out of this file. */
export function validGridServices(
  services: readonly { id: string }[],
  isConfigured: (id: string) => boolean,
  isDetached: (id: string) => boolean,
): Set<string> {
  return new Set(
    services.filter((s) => isConfigured(s.id) && !isDetached(s.id)).map((s) => s.id),
  );
}

/**
 * Is `service` one the user is looking at right now, given what the window has selected? —
 * the `active` axis of the notification gate (grid-view spec §7.5).
 *
 * EVERY cell of a selected grid answers true: they are all on screen at once, so all of them
 * suppress their banners. A service that is running but holds no cell answers false while the
 * grid is up, and keeps notifying — it is off screen, whatever the window is doing.
 *
 * The focused cell is deliberately not a parameter. Cell focus is a zoom target (§7.4), not
 * an attention signal; folding it in here would leave two of three cells raising banners for
 * conversations the user is looking straight at.
 *
 * Pure, and here rather than inline in the caller, because this is the rule whose failure is
 * silent — a wrong answer produces no error and no log, only missing or spurious banners, so
 * it is the one that has to be pinned by a test.
 */
export function isActiveSelection(
  activeId: string | undefined,
  tree: GridNode | null,
  service: string,
): boolean {
  if (activeId === GRID_ID) return services(tree).includes(service);
  return activeId === service;
}

/**
 * Which cell the titlebar's zoom buttons should act on, given the current focus and the
 * tree (grid-view spec §7.4).
 *
 * Focus is not persisted and not authoritative: a cell can be removed, detached, moved or
 * pruned out from under it, and every one of those routes ends in refreshGrid. So rather
 * than clearing focus at each of those call sites — and missing one — this is applied on
 * every push, and a focus naming a service that is no longer a leaf falls back to the
 * first leaf in tree order. Undefined only when the grid is genuinely empty, which is the
 * one case where there is nothing to zoom.
 */
export function reseedFocus(
  tree: GridNode | null,
  current: string | undefined,
): string | undefined {
  const leaves = services(tree);
  if (current !== undefined && leaves.includes(current)) return current;
  return leaves[0];
}
