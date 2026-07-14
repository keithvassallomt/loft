import { describe, it, expect } from 'vitest';
import { buildHubState } from '../src/main/hubState';
import { SERVICES } from '../src/main/registry';
import type { LoftConfig } from '../src/main/config';

const base = {
  services: SERVICES,
  running: () => false,
  visible: () => false,
  badge: () => 0,
  trayBackend: 'auto' as const,
  startAtLogin: false,
};

describe('buildHubState', () => {
  it('marks installed only for services present in config', () => {
    const config: LoftConfig = { services: { whatsapp: {} } };
    const s = buildHubState({ ...base, config });
    expect(s.services.find((x) => x.id === 'whatsapp')!.installed).toBe(true);
    expect(s.services.find((x) => x.id === 'slack')!.installed).toBe(false);
    expect(s.services).toHaveLength(SERVICES.length);
  });

  it('reports the true badge even when the indicator is disabled', () => {
    const config: LoftConfig = { services: { whatsapp: { badgesEnabled: false } } };
    const s = buildHubState({ ...base, config, badge: (id) => (id === 'whatsapp' ? 5 : 0) });
    const wa = s.services.find((x) => x.id === 'whatsapp')!;
    expect(wa.badge).toBe(5);
    expect(wa.badgesEnabled).toBe(false);
  });

  it('derives running/visible/dnd/openOnStartup/customUrl + globals', () => {
    const config: LoftConfig = {
      services: { telegram: { dnd: true, openOnStartup: true, customUrl: 'https://t' } },
    };
    const s = buildHubState({
      ...base, config, trayBackend: 'sni', startAtLogin: true,
      running: (id) => id === 'telegram', visible: (id) => id === 'telegram',
    });
    const tg = s.services.find((x) => x.id === 'telegram')!;
    expect(tg).toMatchObject({ running: true, visible: true, dnd: true, openOnStartup: true, customUrl: 'https://t' });
    expect(s.globals).toEqual({ trayBackend: 'sni', startAtLogin: true });
  });

  it('defaults badgesEnabled to true when unset', () => {
    const config: LoftConfig = { services: { slack: {} } };
    const s = buildHubState({ ...base, config });
    expect(s.services.find((x) => x.id === 'slack')!.badgesEnabled).toBe(true);
  });
});
