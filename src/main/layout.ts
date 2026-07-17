export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TITLEBAR_HEIGHT = 40;
/** The Loft window's service rail (spec 09 §5b). Detached windows pass railWidth: 0. */
export const RAIL_WIDTH = 52;

export interface Layout {
  rail: Rect;
  titlebar: Rect;
  content: Rect;
}

/**
 * One layout for both hosts. A detached service window omits `railWidth` and gets
 * the two-region result it has always had; the Loft window passes RAIL_WIDTH and
 * the titlebar/content inset to make room.
 */
export function computeLayout(
  width: number,
  height: number,
  opts: { railWidth?: number; titlebarHeight?: number } = {},
): Layout {
  const railWidth = opts.railWidth ?? 0;
  const titlebarHeight = opts.titlebarHeight ?? TITLEBAR_HEIGHT;
  const contentWidth = Math.max(0, width - railWidth);
  return {
    rail: { x: 0, y: 0, width: railWidth, height },
    titlebar: { x: railWidth, y: 0, width: contentWidth, height: titlebarHeight },
    content: {
      x: railWidth,
      y: titlebarHeight,
      width: contentWidth,
      height: Math.max(0, height - titlebarHeight),
    },
  };
}
