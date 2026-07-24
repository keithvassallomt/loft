import { describe, it, expect } from 'vitest';
import { railGestureOutcome } from '../src/main/railDrag';

const base = {
  railWidth: 52, margin: 24, canDetach: true, fromIndex: 1, toIndex: 1,
};

describe('railGestureOutcome with the grid selected', () => {
  it('adds to the grid when released over the content area', () => {
    expect(railGestureOutcome({
      ...base, releaseX: 400, gridSelected: true, insideContent: true,
    })).toBe('grid');
  });

  it('still detaches when released outside the window, even with the grid selected', () => {
    expect(railGestureOutcome({
      ...base, releaseX: 1600, gridSelected: true, insideContent: false,
    })).toBe('detach');
    // Dragged LEFT off the window: negative X is out of band and never inside content.
    expect(railGestureOutcome({
      ...base, releaseX: -140, gridSelected: true, insideContent: false,
    })).toBe('detach');
  });

  it('detaches over the content area when the grid is NOT selected', () => {
    expect(railGestureOutcome({
      ...base, releaseX: 400, gridSelected: false, insideContent: true,
    })).toBe('detach');
  });

  it('adds to the grid even for a service with nothing to detach', () => {
    // A sleeping service cannot be pulled into its own window, but it CAN be gridded —
    // the grid wakes it. canDetach must not gate the grid branch.
    expect(railGestureOutcome({
      ...base, releaseX: 400, canDetach: false, gridSelected: true, insideContent: true,
    })).toBe('grid');
  });

  it('snaps back a non-detachable service dragged off the window, grid or no grid', () => {
    // The grid is up but the release left the window, so the grid does not claim it; with
    // nothing to detach the only answer left is 'none'. This is the one cell of the table
    // where the grid feature changes what an un-detachable service does out of band, so pin
    // it: a regression here would silently select (or reorder) a throw-away gesture.
    expect(railGestureOutcome({
      ...base, releaseX: 1600, canDetach: false, gridSelected: true, insideContent: false,
    })).toBe('none');
  });

  it('leaves in-band gestures alone — a click is still a select', () => {
    expect(railGestureOutcome({
      ...base, releaseX: 26, gridSelected: true, insideContent: false,
    })).toBe('select');
    expect(railGestureOutcome({
      ...base, releaseX: 26, gridSelected: true, insideContent: false, toIndex: 3,
    })).toBe('reorder');
  });

  it('treats the band boundary itself as still in-band, not a grid drop', () => {
    // railDragOutcome leaves at exactly railWidth + margin (`>` , not `>=`), so a release
    // pinned to the boundary is a rail gesture even with the grid selected and the point
    // reported inside the content rect.
    expect(railGestureOutcome({
      ...base, releaseX: base.railWidth + base.margin, gridSelected: true, insideContent: true,
    })).toBe('select');
    expect(railGestureOutcome({
      ...base,
      releaseX: base.railWidth + base.margin,
      gridSelected: true,
      insideContent: true,
      toIndex: 3,
    })).toBe('reorder');
    // One pixel further out and the grid claims it.
    expect(railGestureOutcome({
      ...base, releaseX: base.railWidth + base.margin + 1, gridSelected: true, insideContent: true,
    })).toBe('grid');
  });
});
