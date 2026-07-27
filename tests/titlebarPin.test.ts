import { describe, it, expect } from 'vitest';
import { pinTarget } from '../src/main/bubbles';

describe('pinTarget', () => {
  const open = () => true;
  const none = () => false;

  it('is the active service when one is selected', () => {
    expect(pinTarget({ activeId: 'slack', gridFocusId: undefined, hasConversation: open }))
      .toBe('slack');
  });

  // In grid mode several services are visible at once, so "which service does a whole-window
  // control act on" needs an answer. The grid already maintains a focused cell for zoom;
  // reusing it beats inventing a second notion of "current service".
  it('is the focused grid cell when the grid is selected', () => {
    expect(pinTarget({ activeId: undefined, gridFocusId: 'whatsapp', hasConversation: open }))
      .toBe('whatsapp');
  });

  it('prefers the active service over a stale focused cell', () => {
    expect(pinTarget({ activeId: 'slack', gridFocusId: 'whatsapp', hasConversation: open }))
      .toBe('slack');
  });

  it('is null with no focused cell in grid mode', () => {
    expect(pinTarget({ activeId: undefined, gridFocusId: undefined, hasConversation: open }))
      .toBeNull();
  });

  it('is null when the service has no conversation open, so the button greys out', () => {
    expect(pinTarget({ activeId: 'slack', gridFocusId: undefined, hasConversation: none }))
      .toBeNull();
  });

  it('asks about the service it actually chose', () => {
    const asked: string[] = [];
    pinTarget({
      activeId: undefined,
      gridFocusId: 'whatsapp',
      hasConversation: (id) => { asked.push(id); return true; },
    });
    expect(asked).toEqual(['whatsapp']);
  });
});
