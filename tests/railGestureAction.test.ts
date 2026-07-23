import { describe, it, expect } from 'vitest';
import { railGestureAction } from '../src/main/railGesture';
import { services as gridServicesOf, type GridNode } from '../src/main/gridTree';

/**
 * railGestureOutcome was well covered; the switch that CONSUMED it was not, and that is
 * exactly where spec D2 broke — the select branch let showService's `preferCell` default to
 * true, so a mouse click on a gridded rail icon focused its cell instead of opening the
 * service full-size. Only keyboard activation was right, because it never reaches this code.
 *
 * These tests are on the decision, not on the outcome: what the release DOES to the service.
 */
const base = {
  railWidth: 52, margin: 24, canDetach: true, fromIndex: 1, toIndex: 1,
};

/** A plain mouse click: pointerdown → pointerup on the icon, i.e. a zero-distance drag whose
 *  release sits in the rail band, on its own slot. This is the gesture the bug was in. */
const click = { ...base, releaseX: 26 };

const grid: GridNode = {
  kind: 'split', dir: 'row', ratio: 0.5,
  a: { kind: 'leaf', service: 'whatsapp' },
  b: { kind: 'leaf', service: 'slack' },
};

/**
 * showService's cell branch, as the test can see it: it routes to the cell only when the
 * caller asked to prefer it AND the service really is a leaf. Written here against the REAL
 * tree helper and the REAL action, so "would this click land in a cell?" is answered by the
 * shipped rule rather than restated.
 */
function wouldLandInCell(show: { preferCell: boolean }, tree: GridNode, id: string): boolean {
  return show.preferCell && gridServicesOf(tree).includes(id);
}

describe('what a released rail gesture does', () => {
  it('shows a GRIDDED service full-size on a plain click, not in its cell (spec D2)', () => {
    const action = railGestureAction({ ...click, gridSelected: true, insideContent: false });

    expect(action.kind).toBe('select');
    if (action.kind !== 'select') return;
    // The regression guard: with preferCell left to default, this is true and the click only
    // moves the zoom target inside the grid the user was trying to leave.
    expect(wouldLandInCell(action.show, grid, 'whatsapp')).toBe(false);
    expect(action.show.preferCell).toBe(false);
  });

  it('shows a non-gridded service the same way — one rule, no service-dependent branch', () => {
    const action = railGestureAction({ ...click, gridSelected: false, insideContent: false });

    expect(action).toEqual({ kind: 'select', show: { preferCell: false } });
  });

  it('detaches, and shows the new window full-size', () => {
    // Post-detach the service is in its own window, so the cell branch could not fire anyway;
    // the point is that no branch here relies on that — the intent is stated, not inferred.
    const action = railGestureAction({
      ...base, releaseX: 1600, gridSelected: false, insideContent: false,
    });

    expect(action).toEqual({ kind: 'detach', show: { preferCell: false } });
  });

  it('carries the drop index through on a reorder', () => {
    const action = railGestureAction({
      ...base, releaseX: 26, toIndex: 3, gridSelected: false, insideContent: false,
    });

    expect(action).toEqual({ kind: 'reorder', toIndex: 3 });
  });

  it('asks for a grid drop when the release lands on the grid', () => {
    const action = railGestureAction({
      ...base, releaseX: 400, gridSelected: true, insideContent: true,
    });

    // No show intent: the drop leaves the user on the grid, so nothing is shown full-size.
    expect(action).toEqual({ kind: 'grid' });
  });

  it('snaps back — and shows nothing — when there is nothing to detach', () => {
    const action = railGestureAction({
      ...base, releaseX: 1600, canDetach: false, gridSelected: true, insideContent: false,
    });

    expect(action).toEqual({ kind: 'none' });
  });
});
