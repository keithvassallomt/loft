import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, defaultConfig, reopenDetachedEnabled } from '../src/main/config';

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
  it('preserves trayBackend field when valid', () => {
    const p = join(dir, 'with-tray.json');
    writeFileSync(p, '{"services":{},"trayBackend":"sni"}', 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.trayBackend).toBe('sni');
  });
  it('drops bogus trayBackend values', () => {
    const p = join(dir, 'bad-tray.json');
    writeFileSync(p, '{"services":{},"trayBackend":"invalid"}', 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.trayBackend).toBeUndefined();
  });

  it('round-trips the new per-service fields', () => {
    const cfg = defaultConfig();
    cfg.services.slack = { detached: true, launcher: true, openOnStartup: true };
    const p = join(dir, 'new-fields.json');
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
  });

  it('round-trips the new global fields', () => {
    const cfg = defaultConfig();
    cfg.configVersion = 2;
    cfg.window = { x: 10, y: 20, width: 1200, height: 900 };
    cfg.railOrder = ['slack', 'whatsapp'];
    const p = join(dir, 'new-globals.json');
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
  });

  it('drops a service window whose bounds are not numbers', () => {
    const p = join(dir, 'bad-bounds.json');
    writeFileSync(p, '{"services":{"slack":{"window":{"width":"wide","height":null},"dnd":true}}}', 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.services.slack.window).toBeUndefined();
    expect(cfg.services.slack.dnd).toBe(true); // the rest of the entry survives
  });

  it('drops a service window with non-positive dimensions', () => {
    const p = join(dir, 'zero-bounds.json');
    writeFileSync(p, '{"services":{"slack":{"window":{"width":0,"height":800,"zoom":1}}}}', 'utf8');
    expect(loadConfig(p).services.slack.window).toBeUndefined();
  });

  it('clamps a persisted out-of-range zoom instead of trusting it', () => {
    const p = join(dir, 'wild-zoom.json');
    writeFileSync(p, '{"services":{"slack":{"window":{"width":900,"height":700,"zoom":99}}}}', 'utf8');
    expect(loadConfig(p).services.slack.window?.zoom).toBe(3);
  });

  it('defaults a missing zoom to 1 when the bounds are usable', () => {
    const p = join(dir, 'no-zoom.json');
    writeFileSync(p, '{"services":{"slack":{"window":{"width":900,"height":700}}}}', 'utf8');
    expect(loadConfig(p).services.slack.window?.zoom).toBe(1);
  });

  it('drops a service entry that is not an object without losing its siblings', () => {
    const p = join(dir, 'bad-entry.json');
    writeFileSync(p, '{"services":{"slack":"nope","whatsapp":{"dnd":true}}}', 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.services.slack).toEqual({});
    expect(cfg.services.whatsapp.dnd).toBe(true);
  });

  it('ignores non-boolean detached/launcher values', () => {
    const p = join(dir, 'bad-flags.json');
    writeFileSync(p, '{"services":{"slack":{"detached":"yes","launcher":1}}}', 'utf8');
    expect(loadConfig(p).services.slack).toEqual({});
  });

  it('drops the Loft window bounds when malformed', () => {
    const p = join(dir, 'bad-loft-window.json');
    writeFileSync(p, '{"services":{},"window":{"width":"wide"}}', 'utf8');
    expect(loadConfig(p).window).toBeUndefined();
  });

  it('drops non-string entries from railOrder', () => {
    const p = join(dir, 'bad-rail.json');
    writeFileSync(p, '{"services":{},"railOrder":["slack",7,null,"whatsapp"]}', 'utf8');
    expect(loadConfig(p).railOrder).toEqual(['slack', 'whatsapp']);
  });
});

describe('reopenDetachedEnabled', () => {
  it('defaults to true when unset', () => {
    expect(reopenDetachedEnabled(defaultConfig())).toBe(true);
  });
  it('is false only when explicitly false', () => {
    expect(reopenDetachedEnabled({ services: {}, reopenDetached: false })).toBe(false);
    expect(reopenDetachedEnabled({ services: {}, reopenDetached: true })).toBe(true);
  });
});
