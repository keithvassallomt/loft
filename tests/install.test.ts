import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addService, removeService } from '../src/main/install';
import { getKind } from '../src/main/registry';
import type { LoftConfig } from '../src/main/config';

const wa = getKind('whatsapp')!;
const tmps: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'loft-inst-')); tmps.push(d); return d; }
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('install', () => {
  it('addService marks config + customUrl and writes no launcher (opt-in off)', () => {
    const cfg: LoftConfig = { services: {} };
    addService(wa, cfg, { customUrl: 'https://x' });
    expect(cfg.services.whatsapp).toBeDefined();
    expect(cfg.services.whatsapp.customUrl).toBe('https://x');
    expect(cfg.services.whatsapp.launcher).toBeUndefined();
  });

  it('removeService deletes an existing launcher + config, and partition when asked', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { whatsapp: { launcher: true } } };
    const apps = join(data, 'applications');
    mkdirSync(apps, { recursive: true });
    writeFileSync(join(apps, 'loft-whatsapp.desktop'), '[Desktop Entry]');
    const part = join(data, 'loft', 'Partitions', 'whatsapp');
    mkdirSync(part, { recursive: true });

    removeService(wa, cfg, true, env);
    expect(cfg.services.whatsapp).toBeUndefined();
    expect(existsSync(join(apps, 'loft-whatsapp.desktop'))).toBe(false);
    expect(existsSync(part)).toBe(false);
  });

  it('addService preserves existing service-config fields', () => {
    const cfg: LoftConfig = { services: { whatsapp: { dnd: true, badgesEnabled: false } } };
    addService(wa, cfg, { customUrl: 'https://x' });
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

  it('addService does not set launcher (opt-in off)', () => {
    const cfg: LoftConfig = { services: {} };
    addService(wa, cfg, {});
    expect(cfg.services.whatsapp.launcher).toBeUndefined();
  });

  it('addService does not add a launcher flag to an existing entry', () => {
    const cfg: LoftConfig = { services: { whatsapp: { dnd: true } } };
    addService(wa, cfg, {});
    expect(cfg.services.whatsapp).toEqual({ dnd: true });
  });
});
