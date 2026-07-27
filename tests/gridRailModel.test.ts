import { describe, it, expect } from 'vitest';
import { buildRailState } from '../src/main/railModel';
import { GRID_ID } from '../src/main/gridTree';
import type { LoftConfig } from '../src/main/config';
import type { ServiceKind } from '../src/main/registry';

const defs: ServiceKind[] = [
  { id: 'whatsapp', displayName: 'WhatsApp' } as ServiceKind,
  { id: 'slack', displayName: 'Slack' } as ServiceKind,
];

const base = {
  services: defs,
  config: { services: { whatsapp: {}, slack: {} } } as LoftConfig,
  loaded: () => true,
  detached: () => false,
  badge: () => 0,
  activeId: undefined as string | undefined,
  iconEpoch: 0,
  bubbles: [],
  kindOf: (id: string) => id,
};

describe('buildRailState', () => {
  it('reports the grid inactive and empty by default', () => {
    const s = buildRailState({ ...base, grid: null });
    expect(s.gridActive).toBe(false);
    expect(s.gridCount).toBe(0);
    expect(s.managerActive).toBe(true);
    expect(s.items.every((i) => !i.active)).toBe(true);
  });

  it('counts the services in the grid', () => {
    const grid = {
      kind: 'split' as const, dir: 'row' as const, ratio: 0.5,
      a: { kind: 'leaf' as const, service: 'whatsapp' },
      b: { kind: 'leaf' as const, service: 'slack' },
    };
    expect(buildRailState({ ...base, grid }).gridCount).toBe(2);
  });

  it('marks the grid active when GRID_ID is selected, and no service item active', () => {
    const s = buildRailState({ ...base, activeId: GRID_ID, grid: null });
    expect(s.gridActive).toBe(true);
    expect(s.managerActive).toBe(false);
    expect(s.items.every((i) => !i.active)).toBe(true);
  });

  it('still marks a selected service active, with the grid and manager inactive', () => {
    const s = buildRailState({ ...base, activeId: 'slack', grid: null });
    expect(s.gridActive).toBe(false);
    expect(s.managerActive).toBe(false);
    expect(s.items.find((i) => i.id === 'slack')!.active).toBe(true);
  });

  it('passes the icon cache-buster through so the rail can bust a changed icon URL', () => {
    expect(buildRailState({ ...base, grid: null, iconEpoch: 7 }).iconEpoch).toBe(7);
  });
});
