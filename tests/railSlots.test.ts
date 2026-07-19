import { describe, it, expect } from 'vitest';
import { railSlotIndex, type RailSlot } from '../src/main/railSlots';

// Three 34px icons with a 6px gap, as the rail renders them.
const SLOTS: RailSlot[] = [
  { id: 'whatsapp', top: 50, height: 34 },
  { id: 'slack', top: 90, height: 34 },
  { id: 'telegram', top: 130, height: 34 },
];

describe('railSlotIndex', () => {
  it('returns 0 above the first icon', () => {
    expect(railSlotIndex(0, SLOTS)).toBe(0);
    expect(railSlotIndex(60, SLOTS)).toBe(0); // still in the first icon's top half
  });

  it('returns the following index once past an icon\'s midpoint', () => {
    expect(railSlotIndex(68, SLOTS)).toBe(1); // 50 + 34/2 = 67
    expect(railSlotIndex(108, SLOTS)).toBe(2); // 90 + 17 = 107
  });

  it('returns the last index below the final icon', () => {
    expect(railSlotIndex(200, SLOTS)).toBe(3);
  });

  it('treats a point exactly on a midpoint as belonging to the lower slot', () => {
    // 67 is exactly the first icon's midpoint. The test is `clientY < top + height/2`, so a
    // point ON the midpoint is not "above" it — it belongs to the slot below. 66 still is.
    expect(railSlotIndex(67, SLOTS)).toBe(1);
    expect(railSlotIndex(66, SLOTS)).toBe(0);
  });

  it('returns 0 for an empty rail', () => {
    expect(railSlotIndex(123, [])).toBe(0);
  });

  it('handles a single icon', () => {
    const one: RailSlot[] = [{ id: 'slack', top: 50, height: 34 }];
    expect(railSlotIndex(55, one)).toBe(0);
    expect(railSlotIndex(80, one)).toBe(1);
  });
});
