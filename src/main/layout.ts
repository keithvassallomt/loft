export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TITLEBAR_HEIGHT = 40;

export function computeLayout(
  width: number,
  height: number,
  titlebarHeight: number = TITLEBAR_HEIGHT,
): { titlebar: Rect; service: Rect } {
  return {
    titlebar: { x: 0, y: 0, width, height: titlebarHeight },
    service: { x: 0, y: titlebarHeight, width, height: Math.max(0, height - titlebarHeight) },
  };
}
