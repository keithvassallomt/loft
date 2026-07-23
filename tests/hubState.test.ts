import { describe, it, expect } from 'vitest';
import { buildHubState } from '../src/main/hubState';
import { KINDS } from '../src/main/registry';
import type { LoftConfig } from '../src/main/config';

const base = {
  services: KINDS,
  running: () => false,
  visible: () => false,
  badge: () => 0,
  trayBackend: 'auto' as const,
  autostartBlocked: false,
};

describe('buildHubState', () => {
  it('marks installed only for services present in config', () => {
    const config: LoftConfig = { services: { whatsapp: {} } };
    const s = buildHubState({ ...base, config });
    expect(s.services.find((x) => x.id === 'whatsapp')!.installed).toBe(true);
    expect(s.services.find((x) => x.id === 'slack')!.installed).toBe(false);
    expect(s.services).toHaveLength(KINDS.length);
  });

  it('tells the hub whether a server is required and what the default is', () => {
    // The Add tile needs both: whether to block the Add button on an empty field, and the
    // real default URL to name in its hint rather than hardcoding one in the renderer.
    const s = buildHubState({ ...base, config: { services: {} } });
    const el = s.services.find((x) => x.id === 'element')!;
    const talk = s.services.find((x) => x.id === 'talk')!;
    expect(el.serverRequired).toBe(false);
    expect(el.defaultUrl).toBe('https://app.element.io/');
    expect(talk.serverRequired).toBe(true);
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
      ...base, config, trayBackend: 'sni', autostartBlocked: true,
      running: (id) => id === 'telegram', visible: (id) => id === 'telegram',
    });
    const tg = s.services.find((x) => x.id === 'telegram')!;
    expect(tg).toMatchObject({ running: true, visible: true, dnd: true, openOnStartup: true, customUrl: 'https://t' });
    expect(s.globals).toEqual({ trayBackend: 'sni', autostartBlocked: true });
  });

  it('reports launcher as configured (absent means off)', () => {
    const config: LoftConfig = {
      services: { telegram: { launcher: true }, slack: {} },
    };
    const s = buildHubState({ ...base, config });
    expect(s.services.find((x) => x.id === 'telegram')!.launcher).toBe(true);
    expect(s.services.find((x) => x.id === 'slack')!.launcher).toBe(false);
  });

  it('defaults badgesEnabled to true when unset', () => {
    const config: LoftConfig = { services: { slack: {} } };
    const s = buildHubState({ ...base, config });
    expect(s.services.find((x) => x.id === 'slack')!.badgesEnabled).toBe(true);
  });

  it('surfaces autostartBlocked in globals', () => {
    const deps = {
      services: [], config: { services: {} } as never,
      running: () => false, visible: () => false, badge: () => 0,
      trayBackend: 'auto' as const,
    };
    expect(buildHubState({ ...deps, autostartBlocked: true }).globals.autostartBlocked).toBe(true);
    expect(buildHubState({ ...deps, autostartBlocked: false }).globals.autostartBlocked).toBe(false);
  });
});
