export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3;

/**
 * Round to 0.1 steps and clamp to the supported range.
 *
 * The rounding is not cosmetic: zoom is applied by repeated `+= delta`, and
 * without it the factor accumulates float drift (0.1 + 0.2 = 0.30000000000000004)
 * which then gets persisted to config and reloaded forever.
 *
 * NaN cannot be clamped into range by Math.min/Math.max — both propagate it —
 * so it is mapped to 1 explicitly. A NaN zoom factor blanks the view.
 */
export function clampZoom(factor: number): number {
  if (Number.isNaN(factor)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(factor * 10) / 10));
}
