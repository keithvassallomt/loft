import { describe, it, expect } from 'vitest';
import { managerNav, resolveSelection } from '../src/renderer/hub/managerModel';
import type { HubState } from '../src/shared/hubTypes';

const svc = (id: string) => ({
  id, kind: id, displayName: id[0].toUpperCase() + id.slice(1), selfHosted: false,
  serverRequired: false, defaultUrl: '',
  running: false, visible: false, badge: 0, badgesEnabled: true,
  dnd: false, openOnStartup: false, customUrl: '', launcher: false,
  icon: 'brand', variants: [],
});
const kind = (id: string, instanceCount: number) => ({
  id, displayName: id[0].toUpperCase() + id.slice(1), selfHosted: false,
  serverRequired: false, defaultUrl: '', instanceCount,
});
const state = (over: Partial<HubState> = {}): HubState => ({
  services: [svc('whatsapp'), svc('slack')],
  kinds: [kind('whatsapp', 1), kind('slack', 1), kind('telegram', 0)],
  globals: { trayBackend: 'auto', autostartBlocked: false }, ...over,
});

describe('managerNav', () => {
  it('lists every installed account as the Configure list, in order', () => {
    expect(managerNav(state()).configure.map((c) => c.id)).toEqual(['whatsapp', 'slack']);
  });
  it('is empty when nothing is installed', () => {
    expect(managerNav(state({ services: [] })).configure).toEqual([]);
  });
});

describe('resolveSelection', () => {
  it('passes the string panes through unchanged', () => {
    for (const s of ['add', 'settings', 'about'] as const)
      expect(resolveSelection(s, state())).toBe(s);
  });
  it('keeps a service selection that is still installed', () => {
    expect(resolveSelection({ service: 'slack' }, state())).toEqual({ service: 'slack' });
  });
  it('folds a removed service back to add', () => {
    expect(resolveSelection({ service: 'slack' }, state({ services: [svc('whatsapp')] }))).toBe('add');
  });
  it('folds a not-installed (available) service back to add', () => {
    expect(resolveSelection({ service: 'telegram' }, state())).toBe('add');
  });
});
