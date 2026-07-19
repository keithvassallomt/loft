import { describe, it, expect } from 'vitest';
import { railDragOutcome } from '../src/main/railDrag';

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
