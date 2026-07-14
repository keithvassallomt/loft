import { describe, it, expect } from 'vitest';
import { computeLayout, TITLEBAR_HEIGHT } from '../src/main/layout';

describe('computeLayout', () => {
  it('stacks a fixed-height titlebar above a filling service view', () => {
    const { titlebar, service } = computeLayout(1100, 800);
    expect(titlebar).toEqual({ x: 0, y: 0, width: 1100, height: TITLEBAR_HEIGHT });
    expect(service).toEqual({ x: 0, y: TITLEBAR_HEIGHT, width: 1100, height: 800 - TITLEBAR_HEIGHT });
  });
  it('never gives the service view a negative height', () => {
    const { service } = computeLayout(500, 10);
    expect(service.height).toBe(0);
  });
});
