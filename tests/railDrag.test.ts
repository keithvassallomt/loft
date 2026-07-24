import { describe, it, expect } from 'vitest';
import { railDragOutcome, railGestureOutcome } from '../src/main/railDrag';

describe('railDragOutcome', () => {
  it('selects when released within the rail (a plain click on the icon)', () => {
    expect(railDragOutcome(26, 52)).toBe('select');
    expect(railDragOutcome(52, 52)).toBe('select'); // exactly at the edge
  });
  it('selects when released just past the edge but inside the jitter margin', () => {
    expect(railDragOutcome(62, 52, 24)).toBe('select'); // 62 <= 52+24
    expect(railDragOutcome(76, 52, 24)).toBe('select'); // 76 not > 76
  });
  it('detaches when released comfortably past the rail edge', () => {
    expect(railDragOutcome(77, 52, 24)).toBe('detach'); // 77 > 76
    expect(railDragOutcome(300, 52)).toBe('detach');
  });
  it('detaches when dragged LEFT off the window (clientX goes negative past the rail\'s x=0)', () => {
    // The rail sits on the window's left edge, so dragging an icon out to the left reports a
    // negative clientX — proven on Wayland (a real release landed at -140). This is just as much
    // "off the rail" as dragging right into the content, and must detach too.
    expect(railDragOutcome(-140, 52)).toBe('detach');
    expect(railDragOutcome(-25, 52, 24)).toBe('detach'); // -25 < -24
  });
  it('selects when released just left of the rail but inside the jitter margin', () => {
    expect(railDragOutcome(-24, 52, 24)).toBe('select'); // -24 not < -24
    expect(railDragOutcome(-10, 52, 24)).toBe('select');
    expect(railDragOutcome(0, 52)).toBe('select'); // exactly the rail's / window's left edge
  });
});

describe('railGestureOutcome', () => {
  const base = { railWidth: 52, margin: 24, canDetach: true, fromIndex: 1, toIndex: 1 };

  it('detaches when released outside the rail band', () => {
    expect(railGestureOutcome({ ...base, releaseX: 300 })).toBe('detach');
    expect(railGestureOutcome({ ...base, releaseX: -140 })).toBe('detach');
  });

  it('does NOTHING when an un-detachable icon is dragged out (sleeping/detached snap back)', () => {
    expect(railGestureOutcome({ ...base, releaseX: 300, canDetach: false })).toBe('none');
    expect(railGestureOutcome({ ...base, releaseX: -140, canDetach: false })).toBe('none');
  });

  it('selects when released in the band on its own slot (a plain click)', () => {
    expect(railGestureOutcome({ ...base, releaseX: 26, fromIndex: 1, toIndex: 1 })).toBe('select');
    // toIndex === fromIndex + 1 is the other side of the same gap — still "stay put".
    expect(railGestureOutcome({ ...base, releaseX: 26, fromIndex: 1, toIndex: 2 })).toBe('select');
  });

  it('reorders when released in the band on a different slot', () => {
    expect(railGestureOutcome({ ...base, releaseX: 26, fromIndex: 1, toIndex: 0 })).toBe('reorder');
    expect(railGestureOutcome({ ...base, releaseX: 26, fromIndex: 1, toIndex: 3 })).toBe('reorder');
  });

  it('still reorders an un-detachable icon dragged within the band', () => {
    // A sleeping service has no view to detach, but its rail position is still its own.
    expect(railGestureOutcome({ ...base, releaseX: 26, canDetach: false, fromIndex: 1, toIndex: 3 }))
      .toBe('reorder');
  });

  it('selects when the icon is not in the order at all (fromIndex -1) and did not leave the band', () => {
    // toIndex deliberately far from fromIndex + 1 (which would be 0): this must resolve via the
    // explicit fromIndex < 0 branch, not by coincidentally looking like "stay put".
    expect(railGestureOutcome({ ...base, releaseX: 26, fromIndex: -1, toIndex: 5 })).toBe('select');
  });

  it('prefers the out-of-band decision over the fromIndex -1 check', () => {
    // Guards the branch ORDER: an unknown-index icon dragged clear of the rail must still
    // detach (or snap back), never fall through to select.
    expect(railGestureOutcome({ ...base, releaseX: 300, fromIndex: -1, toIndex: 5 })).toBe('detach');
    expect(railGestureOutcome({ ...base, releaseX: 300, fromIndex: -1, toIndex: 5, canDetach: false }))
      .toBe('none');
  });
});
