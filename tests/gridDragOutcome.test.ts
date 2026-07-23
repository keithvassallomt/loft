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

  it('leaves in-band gestures alone — a click is still a select', () => {
    expect(railGestureOutcome({
      ...base, releaseX: 26, gridSelected: true, insideContent: false,
    })).toBe('select');
    expect(railGestureOutcome({
      ...base, releaseX: 26, gridSelected: true, insideContent: false, toIndex: 3,
    })).toBe('reorder');
  });
});
