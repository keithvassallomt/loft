import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, defaultConfig } from '../src/main/config';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loft-cfg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('config', () => {
  it('returns the default config when the file is missing', () => {
    expect(loadConfig(join(dir, 'nope.json'))).toEqual(defaultConfig());
  });
  it('round-trips a saved config', () => {
    const cfg = defaultConfig();
    cfg.services.whatsapp = { window: { width: 900, height: 700, zoom: 1.2 }, openOnStartup: true };
    const p = join(dir, 'config.json');
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
  });
  it('returns the default config when the file is corrupt', () => {
    const p = join(dir, 'bad.json');
    saveConfig(p, defaultConfig());
    require('node:fs').writeFileSync(p, '{ not json');
    expect(loadConfig(p)).toEqual(defaultConfig());
  });
  it('returns the default config when services is a string', () => {
    const p = join(dir, 'string-services.json');
    writeFileSync(p, '{"services":"not-an-object"}', 'utf8');
    expect(loadConfig(p)).toEqual(defaultConfig());
  });
  it('returns the default config when services is an array', () => {
    const p = join(dir, 'array-services.json');
    writeFileSync(p, '{"services":[1,2,3]}', 'utf8');
    expect(loadConfig(p)).toEqual(defaultConfig());
  });
});
