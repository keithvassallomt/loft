import { describe, it, expect } from 'vitest';
import { migrateConfig, CONFIG_VERSION } from '../src/main/migrate';
import type { LoftConfig } from '../src/main/config';

const cfgWith = (services: LoftConfig['services'], configVersion?: number): LoftConfig => ({
  services,
  ...(configVersion === undefined ? {} : { configVersion }),
});

describe('migrateConfig', () => {
  it('infers launcher from what is actually on disk', () => {
    const cfg = cfgWith({ whatsapp: {}, slack: {} });
    const r = migrateConfig(cfg, (id) => id === 'whatsapp');
    expect(r.changed).toBe(true);
    expect(cfg.services.whatsapp.launcher).toBe(true);
    expect(cfg.services.slack.launcher).toBe(false);
  });

  it('stamps the config version', () => {
    const cfg = cfgWith({});
    migrateConfig(cfg, () => false);
    expect(cfg.configVersion).toBe(CONFIG_VERSION);
  });

  it('is idempotent — a second run changes nothing', () => {
    const cfg = cfgWith({ whatsapp: {} });
    migrateConfig(cfg, () => true);
    // Simulate the user unticking the box after migrating.
    cfg.services.whatsapp.launcher = false;
    const second = migrateConfig(cfg, () => true);
    expect(second.changed).toBe(false);
    expect(cfg.services.whatsapp.launcher).toBe(false);
  });

  it('does not run against an already-migrated config', () => {
    const cfg = cfgWith({ slack: {} }, CONFIG_VERSION);
    expect(migrateConfig(cfg, () => true).changed).toBe(false);
    expect(cfg.services.slack.launcher).toBeUndefined();
  });

  it('does not run against a config from a future version', () => {
    const cfg = cfgWith({ slack: {} }, CONFIG_VERSION + 1);
    expect(migrateConfig(cfg, () => true).changed).toBe(false);
    expect(cfg.services.slack.launcher).toBeUndefined();
  });

  it('never clobbers an explicit flag already present', () => {
    const cfg = cfgWith({ slack: { launcher: false } });
    migrateConfig(cfg, () => true);
    expect(cfg.services.slack.launcher).toBe(false);
  });

  it('migrates an empty install without inventing services', () => {
    const cfg = cfgWith({});
    expect(migrateConfig(cfg, () => true).changed).toBe(true);
    expect(cfg.services).toEqual({});
  });
});
