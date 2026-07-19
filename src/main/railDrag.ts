/**
 * Decide a rail drag's outcome from where the pointer was released, in coordinates relative to
 * the rail view (so a value past the rail's own width means "released to the right of the rail").
 * A release comfortably past the rail edge detaches; anything within the rail — including a plain
 * click, whose release sits on the icon — is a normal select. The margin absorbs click jitter so
 * an ordinary click can never cross the threshold.
 */
export function railDragOutcome(
  releaseClientX: number,
  railWidth: number,
  margin = 24,
): 'detach' | 'select' {
  return releaseClientX > railWidth + margin ? 'detach' : 'select';
}
