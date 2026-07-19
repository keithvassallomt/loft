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
