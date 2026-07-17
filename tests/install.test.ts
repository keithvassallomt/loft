import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addService, removeService } from '../src/main/install';
import { getService } from '../src/main/registry';
import type { LoftConfig } from '../src/main/config';

const wa = getService('whatsapp')!;
const tmps: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'loft-inst-')); tmps.push(d); return d; }
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function iconSrc(): string { const d = tmp(); writeFileSync(join(d, 'whatsapp.png'), 'PNG'); return d; }

describe('install', () => {
  it('addService marks config, sets customUrl, writes launcher', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: {} };
    addService(wa, cfg, { env, execPath: '/usr/bin/loft', iconSourceDir: iconSrc(), customUrl: 'https://x' });
    expect(cfg.services.whatsapp).toBeDefined();
    expect(cfg.services.whatsapp.customUrl).toBe('https://x');
    expect(existsSync(join(data, 'applications', 'loft-whatsapp.desktop'))).toBe(true);
  });

  it('removeService deletes launcher + config, and partition when asked', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { whatsapp: {} } };
    addService(wa, cfg, { env, execPath: '/usr/bin/loft', iconSourceDir: iconSrc() });
    const part = join(data, 'loft', 'Partitions', 'whatsapp');
    mkdirSync(part, { recursive: true });

    removeService(wa, cfg, true, env);
    expect(cfg.services.whatsapp).toBeUndefined();
    expect(existsSync(join(data, 'applications', 'loft-whatsapp.desktop'))).toBe(false);
    expect(existsSync(part)).toBe(false);
  });

  it('addService preserves existing service-config fields', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { whatsapp: { dnd: true, badgesEnabled: false } } };
    addService(wa, cfg, { env, execPath: '/usr/bin/loft', iconSourceDir: iconSrc(), customUrl: 'https://x' });
    expect(cfg.services.whatsapp.dnd).toBe(true);
    expect(cfg.services.whatsapp.badgesEnabled).toBe(false);
    expect(cfg.services.whatsapp.customUrl).toBe('https://x');
  });

  it('removeService keeps the partition when deleteData is false', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { whatsapp: {} } };
    const part = join(data, 'loft', 'Partitions', 'whatsapp');
    mkdirSync(part, { recursive: true });
    removeService(wa, cfg, false, env);
    expect(existsSync(part)).toBe(true);
  });

  it('addService records that the added service has a launcher', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: {} };
    addService(wa, cfg, { env, execPath: '/usr/bin/loft', iconSourceDir: iconSrc() });
    expect(cfg.services.whatsapp.launcher).toBe(true);
  });

  it('addService sets launcher on an existing entry without dropping its fields', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { whatsapp: { dnd: true } } };
    addService(wa, cfg, { env, execPath: '/usr/bin/loft', iconSourceDir: iconSrc() });
    expect(cfg.services.whatsapp).toEqual({ dnd: true, launcher: true });
  });
});
