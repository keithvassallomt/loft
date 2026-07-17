import { describe, it, expect } from 'vitest';
import { computeLayout, TITLEBAR_HEIGHT, RAIL_WIDTH } from '../src/main/layout';

describe('computeLayout', () => {
  it('with no rail, reproduces the detached window layout', () => {
    const { rail, titlebar, content } = computeLayout(1100, 800);
    expect(rail).toEqual({ x: 0, y: 0, width: 0, height: 800 });
    expect(titlebar).toEqual({ x: 0, y: 0, width: 1100, height: TITLEBAR_HEIGHT });
    expect(content).toEqual({ x: 0, y: TITLEBAR_HEIGHT, width: 1100, height: 800 - TITLEBAR_HEIGHT });
  });

  it('insets the titlebar and content by the rail width', () => {
    const { rail, titlebar, content } = computeLayout(1100, 800, { railWidth: RAIL_WIDTH });
    expect(rail).toEqual({ x: 0, y: 0, width: RAIL_WIDTH, height: 800 });
    expect(titlebar).toEqual({ x: RAIL_WIDTH, y: 0, width: 1100 - RAIL_WIDTH, height: TITLEBAR_HEIGHT });
    expect(content).toEqual({
      x: RAIL_WIDTH,
      y: TITLEBAR_HEIGHT,
      width: 1100 - RAIL_WIDTH,
      height: 800 - TITLEBAR_HEIGHT,
    });
  });

  it('never gives the content view a negative height', () => {
    expect(computeLayout(500, 10).content.height).toBe(0);
  });

  it('never gives the content view a negative width when the rail exceeds the window', () => {
    expect(computeLayout(20, 800, { railWidth: RAIL_WIDTH }).content.width).toBe(0);
  });

  it('honours a custom titlebar height', () => {
    expect(computeLayout(1100, 800, { titlebarHeight: 10 }).titlebar.height).toBe(10);
  });
});
