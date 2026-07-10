import { describe, it, expect } from 'vitest';
import { overlayFor } from '../src/main/tray/icon';

describe('overlayFor', () => {
  it('shows DND dash over everything, else unread dot, else none', () => {
    expect(overlayFor(5, true)).toBe('dnd');
    expect(overlayFor(0, true)).toBe('dnd');
    expect(overlayFor(3, false)).toBe('unread');
    expect(overlayFor(0, false)).toBe('none');
  });
});
