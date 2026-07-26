import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, defaultConfig, reopenDetachedEnabled, effectiveAutoOpen } from '../src/main/config';
import { bubbleId } from '../src/main/bubbles';

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

  it('round-trips autoOpen and preserves a legacy openOnStartup', () => {
    const cfg = defaultConfig();
    cfg.services.slack = { autoOpen: 'launch' };
    cfg.services.whatsapp = { openOnStartup: true };
    const p = join(dir, 'auto-open.json');
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
  });

  it('drops a bogus autoOpen value', () => {
    const p = join(dir, 'bad-auto.json');
    writeFileSync(p, '{"services":{"slack":{"autoOpen":"whenever"}}}', 'utf8');
    expect(loadConfig(p).services.slack.autoOpen).toBeUndefined();
  });

  it('preserves debug:true and, like other "absent means false" flags, drops it when false', () => {
    const on = join(dir, 'debug-on.json');
    writeFileSync(on, '{"services":{},"debug":true}', 'utf8');
    expect(loadConfig(on).debug).toBe(true);

    const off = join(dir, 'debug-off.json');
    writeFileSync(off, '{"services":{},"debug":false}', 'utf8');
    expect(loadConfig(off).debug).toBeUndefined();

    const bogus = join(dir, 'debug-bogus.json');
    writeFileSync(bogus, '{"services":{},"debug":"yes"}', 'utf8');
    expect(loadConfig(bogus).debug).toBeUndefined();
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

  it('round-trips an explicit reopenDetached: true', () => {
    const cfg = defaultConfig();
    cfg.reopenDetached = true;
    const p = join(dir, 'reopen-detached-true.json');
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
    expect(loadConfig(p).reopenDetached).toBe(true);
  });

  it('round-trips an explicit badgesEnabled: true', () => {
    const cfg = defaultConfig();
    cfg.services.slack = { badgesEnabled: true };
    const p = join(dir, 'badges-enabled-true.json');
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
    expect(loadConfig(p).services.slack.badgesEnabled).toBe(true);
  });

  it('does not let a __proto__ key in services corrupt the map', () => {
    const p = join(dir, 'proto-services.json');
    writeFileSync(p, '{"services":{"__proto__":{"dnd":true},"slack":{"dnd":true}}}', 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.services.slack).toEqual({ dnd: true });
    expect(Object.getPrototypeOf(cfg.services)).toBe(Object.prototype);
    // `in`, not hasOwnProperty: the bug leaks `dnd` as an INHERITED property, which
    // hasOwnProperty reports false for either way — so asserting on it can never fail.
    expect('dnd' in cfg.services).toBe(false);
  });

  it('keeps kind, name and icon on a service entry', () => {
    const cfg = defaultConfig();
    cfg.services['whatsapp-2'] = { kind: 'whatsapp', name: 'Work', icon: 'rose' };
    const p = join(dir, 'config.json');
    saveConfig(p, cfg);
    expect(loadConfig(p).services['whatsapp-2']).toEqual({ kind: 'whatsapp', name: 'Work', icon: 'rose' });
  });

  it('drops non-string kind, name and icon rather than passing them through', () => {
    // These reach the D-Bus export, the window title and a file path; a number or an
    // object there is a crash, not a cosmetic problem.
    const p = join(dir, 'config.json');
    writeFileSync(p, JSON.stringify({
      services: { 'whatsapp-2': { kind: 7, name: { a: 1 }, icon: ['rose'], dnd: true } },
    }), 'utf8');
    expect(loadConfig(p).services['whatsapp-2']).toEqual({ dnd: true });
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

describe('effectiveAutoOpen', () => {
  it('is disabled when nothing is set', () => {
    expect(effectiveAutoOpen({})).toBe('disabled');
    expect(effectiveAutoOpen(undefined)).toBe('disabled');
  });
  it('reads a legacy openOnStartup:true as login', () => {
    expect(effectiveAutoOpen({ openOnStartup: true })).toBe('login');
    expect(effectiveAutoOpen({ openOnStartup: false })).toBe('disabled');
  });
  it('returns the explicit autoOpen value', () => {
    expect(effectiveAutoOpen({ autoOpen: 'login' })).toBe('login');
    expect(effectiveAutoOpen({ autoOpen: 'launch' })).toBe('launch');
  });
  it('prefers autoOpen over the legacy boolean', () => {
    expect(effectiveAutoOpen({ autoOpen: 'launch', openOnStartup: true })).toBe('launch');
  });
});

describe('bubbles in config', () => {
  it('round-trips through save and load', () => {
    const p = join(dir, 'bubbles.json');
    const cfg = defaultConfig();
    cfg.bubbles = [{ id: bubbleId('whatsapp', '1@lid'), serviceId: 'whatsapp', key: '1@lid', title: 'Dan' }];
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
  });

  it('omits the key entirely when there are no bubbles, keeping no-op keys out of the file', () => {
    const p = join(dir, 'empty-bubbles.json');
    writeFileSync(p, JSON.stringify({ services: {}, bubbles: [] }), 'utf8');
    expect(loadConfig(p).bubbles).toBeUndefined();
  });

  it('survives a corrupt bubble list rather than failing to start', () => {
    const p = join(dir, 'bad-bubbles.json');
    writeFileSync(p, JSON.stringify({ services: { slack: {} }, bubbles: 'not an array' }), 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.bubbles).toBeUndefined();
    expect(cfg.services.slack).toBeDefined();
  });

  it('drops only the malformed bubbles, keeping the good ones', () => {
    const p = join(dir, 'mixed-bubbles.json');
    writeFileSync(p, JSON.stringify({
      services: {},
      bubbles: [
        { serviceId: 'slack', key: 'C1', title: 'good' },
        { serviceId: 'slack', title: 'no key' },
      ],
    }), 'utf8');
    expect(loadConfig(p).bubbles).toEqual([
      { id: bubbleId('slack', 'C1'), serviceId: 'slack', key: 'C1', title: 'good' },
    ]);
  });
});
