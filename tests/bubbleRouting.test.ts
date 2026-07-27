import { describe, it, expect } from 'vitest';
import { bubbleClickAction } from '../src/main/bubbles';

describe('bubbleClickAction', () => {
  it('focuses a detached service window without touching the rail selection', () => {
    expect(bubbleClickAction({ serviceId: 'slack', detached: true, visibleIds: [] }))
      .toEqual({ kind: 'focus-detached', serviceId: 'slack' });
  });

  it('navigates in place when the service is already the visible tab', () => {
    expect(bubbleClickAction({ serviceId: 'slack', detached: false, visibleIds: ['slack'] }))
      .toEqual({ kind: 'navigate-only', serviceId: 'slack' });
  });

  // The grid is why this is stated as "already visible" rather than "is the active tab": in
  // grid mode several services are visible at once, and switching away from the grid to reach
  // one of them would be gratuitous.
  it('navigates in place when the service is a visible grid cell', () => {
    expect(bubbleClickAction({
      serviceId: 'whatsapp', detached: false, visibleIds: ['slack', 'whatsapp'],
    })).toEqual({ kind: 'navigate-only', serviceId: 'whatsapp' });
  });

  it('selects the service when it is not visible', () => {
    expect(bubbleClickAction({ serviceId: 'element', detached: false, visibleIds: ['slack'] }))
      .toEqual({ kind: 'select', serviceId: 'element' });
  });

  it('selects the service when nothing is visible at all (the manager is showing)', () => {
    expect(bubbleClickAction({ serviceId: 'element', detached: false, visibleIds: [] }).kind)
      .toBe('select');
  });

  it('prefers detached over visible — a detached service lives in its own window', () => {
    expect(bubbleClickAction({ serviceId: 'slack', detached: true, visibleIds: ['slack'] }).kind)
      .toBe('focus-detached');
  });
});
