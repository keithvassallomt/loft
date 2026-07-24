import { describe, it, expect } from 'vitest';
import { shouldNotify } from '../src/main/notifications/gate';
import { GRID_ID, isActiveSelection, type GridNode } from '../src/main/gridTree';

/**
 * Grid makes several services visible at once. The faithful extension of the existing
 * "focused and visible and active" rule (spec §7.5): a gridded service is visible when
 * the grid is selected and the window is visible, and ACTIVE for every cell — they are
 * all being looked at. Cell focus governs zoom only; it must not enter this gate.
 *
 * CHARACTERISATION, not red-to-green: shouldNotify is already right. What this pins is the
 * INTERPRETATION main feeds it, so a later change to the gate cannot silently mute a grid —
 * the failure mode has no error and no log, just missing banners.
 */
/** A three-cell grid, shared by both halves of this file: the gate below is fed the `active`
 *  this tree implies, so neither half can be right about a grid the other is wrong about. */
const three: GridNode = {
  kind: 'split', dir: 'row', ratio: 0.5,
  a: { kind: 'leaf', service: 'whatsapp' },
  b: {
    kind: 'split', dir: 'col', ratio: 0.5,
    a: { kind: 'leaf', service: 'slack' },
    b: { kind: 'leaf', service: 'telegram' },
  },
};

describe('the notification gate over a grid', () => {
  const quiet = { systemDnd: false, globalDnd: false, serviceDnd: false };

  it('suppresses every visible cell when the window is focused', () => {
    for (const cell of ['whatsapp', 'slack', 'telegram']) {
      // `active` comes from the tree, not a literal: the loop asserted one constant
      // expression three times and pinned nothing about the cells it named.
      const active = isActiveSelection(GRID_ID, three, cell);
      expect(shouldNotify({ ...quiet, focused: true, visible: true, active })).toBe(false);
    }
  });

  it('notifies from a gridded service when the window is not focused', () => {
    expect(shouldNotify({ ...quiet, focused: false, visible: true, active: true })).toBe(true);
  });

  it('notifies from a gridded service when the window is hidden', () => {
    expect(shouldNotify({ ...quiet, focused: true, visible: false, active: true })).toBe(true);
  });

  it('notifies from a service that is NOT in the grid while the grid is selected', () => {
    // Not a cell ⇒ not active, whatever the window is doing.
    expect(shouldNotify({ ...quiet, focused: true, visible: true, active: false })).toBe(true);
  });

  it('still honours every DND flag over a visible cell', () => {
    const looking = { focused: false, visible: true, active: true };
    expect(shouldNotify({ ...quiet, ...looking, systemDnd: true })).toBe(false);
    expect(shouldNotify({ ...quiet, ...looking, globalDnd: true })).toBe(false);
    expect(shouldNotify({ ...quiet, ...looking, serviceDnd: true })).toBe(false);
  });
});

/**
 * The other half of the same rule: what main FEEDS the gate as `active`. shouldNotify can be
 * perfectly right and a grid still go silent (or shout) if this answer is wrong, and that
 * failure has no error and no log either — so it is pinned here beside it.
 */
describe('which services are active', () => {
  it('makes every cell active when the grid is selected', () => {
    for (const id of ['whatsapp', 'slack', 'telegram']) {
      expect(isActiveSelection(GRID_ID, three, id)).toBe(true);
    }
  });

  it('leaves a running non-gridded service inactive while the grid is selected', () => {
    expect(isActiveSelection(GRID_ID, three, 'element')).toBe(false);
  });

  it('activates only the selected tab when the grid is not the selection', () => {
    expect(isActiveSelection('slack', three, 'slack')).toBe(true);
    // A cell of a grid that is not on screen is not being looked at.
    expect(isActiveSelection('slack', three, 'whatsapp')).toBe(false);
  });

  it('activates nothing while the manager is selected', () => {
    for (const id of ['whatsapp', 'slack', 'telegram']) {
      expect(isActiveSelection(undefined, three, id)).toBe(false);
    }
  });

  it('activates nothing for an empty grid', () => {
    expect(isActiveSelection(GRID_ID, null, 'whatsapp')).toBe(false);
  });
});
