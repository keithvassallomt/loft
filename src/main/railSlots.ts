/** One rail icon's geometry, in coordinates relative to the rail view. */
export interface RailSlot {
  id: string;
  top: number;
  height: number;
}

/**
 * The insertion index for a pointer at `clientY` — 0 means "before the first icon",
 * `slots.length` means "after the last". An icon claims the slot above it until the
 * pointer passes its vertical midpoint, which is what makes the indicator line feel
 * like it snaps to the gap nearest the cursor.
 *
 * The renderer measures (it owns the DOM); this decides (it is testable). Slots must
 * be in visual order.
 */
export function railSlotIndex(clientY: number, slots: readonly RailSlot[]): number {
  for (let i = 0; i < slots.length; i++) {
    if (clientY < slots[i].top + slots[i].height / 2) return i;
  }
  return slots.length;
}
