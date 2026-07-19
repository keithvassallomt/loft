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
});
