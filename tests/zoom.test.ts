import { describe, it, expect } from 'vitest';
import { clampZoom, ZOOM_MIN, ZOOM_MAX } from '../src/main/zoom';

describe('clampZoom', () => {
  it('leaves an in-range value on a 0.1 step alone', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(1.2)).toBe(1.2);
  });

  it('rounds to 0.1 steps', () => {
    expect(clampZoom(1.04)).toBe(1);
    expect(clampZoom(1.06)).toBe(1.1);
  });

  it('absorbs float drift from repeated addition', () => {
    // 0.1 + 0.2 === 0.30000000000000004; without rounding this drifts forever.
    expect(clampZoom(0.1 + 0.2)).toBe(0.3);
    expect(clampZoom(1.1 + 0.1)).toBe(1.2);
  });

  it('clamps above the maximum', () => {
    expect(clampZoom(5)).toBe(ZOOM_MAX);
    expect(clampZoom(3.1)).toBe(ZOOM_MAX);
  });

  it('clamps below the minimum', () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(-2)).toBe(ZOOM_MIN);
  });

  it('treats a non-finite factor as 1 rather than poisoning the view', () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(ZOOM_MAX);
  });
});
