import { describe, it, expect } from 'vitest';
import { buildRailState } from '../src/main/railModel';
import { GRID_ID } from '../src/main/gridTree';
import type { LoftConfig } from '../src/main/config';
import type { ServiceDef } from '../src/main/registry';

const defs: ServiceDef[] = [
  { id: 'whatsapp', displayName: 'WhatsApp' } as ServiceDef,
  { id: 'slack', displayName: 'Slack' } as ServiceDef,
];

const base = {
  services: defs,
  config: { services: { whatsapp: {}, slack: {} } } as LoftConfig,
  loaded: () => true,
  detached: () => false,
  badge: () => 0,
  activeId: undefined as string | undefined,
};

describe('buildRailState', () => {
  it('reports the grid inactive and empty by default', () => {
    const s = buildRailState({ ...base, grid: null });
    expect(s.gridActive).toBe(false);
    expect(s.gridCount).toBe(0);
    expect(s.managerActive).toBe(true);
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

  it('does not mark the manager active when the grid is selected', () => {
    expect(buildRailState({ ...base, activeId: GRID_ID, grid: null }).managerActive).toBe(false);
  });

  it('still marks a selected service active, with the grid inactive', () => {
    const s = buildRailState({ ...base, activeId: 'slack', grid: null });
    expect(s.gridActive).toBe(false);
    expect(s.items.find((i) => i.id === 'slack')!.active).toBe(true);
  });
});
