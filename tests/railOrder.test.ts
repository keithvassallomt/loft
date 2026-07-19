import { describe, it, expect } from 'vitest';
import { moveInOrder } from '../src/main/railOrder';

const IDS = ['whatsapp', 'slack', 'telegram', 'element'];

describe('moveInOrder', () => {
  it('moves an item down to a later slot', () => {
    // insertion index 3 = "before element", i.e. after telegram
    expect(moveInOrder(IDS, 'whatsapp', 3)).toEqual(['slack', 'telegram', 'whatsapp', 'element']);
  });

  it('moves an item up to an earlier slot', () => {
    expect(moveInOrder(IDS, 'element', 1)).toEqual(['whatsapp', 'element', 'slack', 'telegram']);
  });

  it('moves an item to the very end', () => {
    expect(moveInOrder(IDS, 'slack', 4)).toEqual(['whatsapp', 'telegram', 'element', 'slack']);
  });

  it('is a no-op when dropped on its own slot (either side)', () => {
    // slack is at index 1: insertion index 1 (before itself) and 2 (after itself)
    // both mean "stay put".
    expect(moveInOrder(IDS, 'slack', 1)).toEqual(IDS);
    expect(moveInOrder(IDS, 'slack', 2)).toEqual(IDS);
  });

  it('returns the list unchanged for an unknown id', () => {
    expect(moveInOrder(IDS, 'nope', 0)).toEqual(IDS);
  });

  it('clamps an out-of-range index', () => {
    expect(moveInOrder(IDS, 'slack', 99)).toEqual(['whatsapp', 'telegram', 'element', 'slack']);
    expect(moveInOrder(IDS, 'slack', -5)).toEqual(['slack', 'whatsapp', 'telegram', 'element']);
  });

  it('does not mutate its input', () => {
    const src = [...IDS];
    moveInOrder(src, 'slack', 4);
    expect(src).toEqual(IDS);
  });
});
