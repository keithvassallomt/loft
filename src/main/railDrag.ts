/**
 * Decide a rail drag's outcome from where the pointer was released, in coordinates relative to
 * the rail view (whose left edge is the window's left edge, x=0). A release comfortably OUTSIDE
 * the rail strip detaches — either to the RIGHT, past the rail's own width (into the content or
 * beyond the window), OR to the LEFT off the window's left edge, where clientX goes negative once
 * the cursor passes x=0 (proven on Wayland: a real left-drag release landed at -140). Anything
 * within the rail — including a plain click, whose release sits on the icon — is a normal select.
 * The margin absorbs click jitter at either edge, so an ordinary click can never cross either
 * threshold.
 */
export function railDragOutcome(
  releaseClientX: number,
  railWidth: number,
  margin = 24,
): 'detach' | 'select' {
  return releaseClientX > railWidth + margin || releaseClientX < -margin ? 'detach' : 'select';
}

export interface RailGesture {
  /** Release X, relative to the rail view. */
  releaseX: number;
  railWidth: number;
  margin?: number;
  /** Only a loaded, attached service has a view to pull out into its own window. */
  canDetach: boolean;
  /** The dragged icon's current index in the rail order, or -1 if unknown. */
  fromIndex: number;
  /** The insertion index the release landed on (railSlotIndex). */
  toIndex: number;
  /** The Grid entry is the current selection, so a release over the content area means
   *  "add to the grid" rather than "detach" (grid-view spec §7.2). */
  gridSelected?: boolean;
  /** The release landed inside the window's content rect. False for a release beyond the
   *  window on either side, which is what keeps detach reachable while the grid is up. */
  insideContent?: boolean;
}

/**
 * Resolve one rail-icon gesture. The horizontal axis decides whether the user left the
 * rail at all (railDragOutcome, unchanged from 09c-2b); only if they stayed does the
 * vertical axis matter.
 *
 * Dropping on either side of an icon's own gap — toIndex === fromIndex or fromIndex + 1 —
 * means "stay put", which is what keeps an ordinary click a select: its release sits on
 * the icon it started from.
 *
 * Leaving the rail used to mean exactly one thing. With the grid selected it means two,
 * split by where the release landed: over the content rect the grid takes it, beyond the
 * window detach still does — so both stay reachable in the same gesture, and the in-band
 * rules above are untouched either way.
 */
export function railGestureOutcome(
  i: RailGesture,
): 'detach' | 'reorder' | 'select' | 'grid' | 'none' {
  const left = railDragOutcome(i.releaseX, i.railWidth, i.margin) === 'detach';
  if (left) {
    // The grid claims releases over the content rect; detach keeps everything beyond the
    // window, so it stays reachable — it just moves further out while the grid is up.
    // Deliberately not gated on canDetach: a sleeping service has no view to pull out but
    // can still be gridded, because the grid wakes it.
    if (i.gridSelected && i.insideContent) return 'grid';
    // Out of the band: pull it into its own window, or — with nothing to pull — snap back
    // rather than quietly selecting something the user was trying to throw away.
    return i.canDetach ? 'detach' : 'none';
  }
  if (i.fromIndex < 0) return 'select';
  const samePlace = i.toIndex === i.fromIndex || i.toIndex === i.fromIndex + 1;
  return samePlace ? 'select' : 'reorder';
}
