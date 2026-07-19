/**
 * Move `id` to `toIndex` and return the FULL new order.
 *
 * `toIndex` is an insertion index measured against the list as it looks WITH `id` still
 * in it (that is what railSlotIndex reports), so dropping on either side of an item's own
 * slot must mean "stay put" — hence the -1 adjustment when moving down. Writing the whole
 * list rather than a delta keeps the persisted railOrder predictable; buildRailModel
 * already tolerates partial lists via its rank fallback, but there is no reason to rely
 * on that here.
 */
export function moveInOrder(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from === -1) return [...ids];
  const without = ids.filter((x) => x !== id);
  // Removing the item shifts every later position down by one.
  const adjusted = toIndex > from ? toIndex - 1 : toIndex;
  const clamped = Math.max(0, Math.min(adjusted, without.length));
  without.splice(clamped, 0, id);
  return without;
}
