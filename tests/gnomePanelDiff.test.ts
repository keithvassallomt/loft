import { describe, it, expect } from 'vitest';
import { diffPanelServices, type PanelSnapshot } from '../src/main/tray/gnomePanel';

const snap = (o: Partial<PanelSnapshot> & { id: string }): PanelSnapshot =>
  ({ displayName: o.id, visible: false, badge: 0, dnd: false, ...o });

describe('diffPanelServices', () => {
  it('emits updates for new + changed services and removes dropped ones', () => {
    const prev = new Map<string, PanelSnapshot>([
      ['a', snap({ id: 'a', badge: 1 })],
      ['b', snap({ id: 'b' })],
    ]);
    const cur = new Map<string, PanelSnapshot>([
      ['a', snap({ id: 'a', badge: 2 })], // changed
      ['c', snap({ id: 'c' })],           // new
    ]);
    const { updates, removals } = diffPanelServices(prev, cur);
    expect(updates.map((u) => u.id).sort()).toEqual(['a', 'c']);
    expect(removals.sort()).toEqual(['b']);
  });
  it('emits nothing when unchanged', () => {
    const m = new Map<string, PanelSnapshot>([['a', snap({ id: 'a', badge: 3, dnd: true })]]);
    const { updates, removals } = diffPanelServices(m, new Map(m));
    expect(updates).toEqual([]);
    expect(removals).toEqual([]);
  });
});
