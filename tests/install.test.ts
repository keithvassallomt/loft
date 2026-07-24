import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addInstance, removeInstance, removePartitionData } from '../src/main/install';
import { getKind } from '../src/main/registry';
import { resolveInstance } from '../src/main/instances';
import type { LoftConfig } from '../src/main/config';

const wa = getKind('whatsapp')!;
const tmps: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'loft-inst-')); tmps.push(d); return d; }
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('install', () => {
  it('gives the first account the bare kind id, the brand icon, and no launcher', () => {
    const cfg: LoftConfig = { services: {} };
    const inst = addInstance(wa, cfg, { customUrl: 'https://x', iconSourceDir: tmp() });
    expect(inst.id).toBe('whatsapp');
    expect(cfg.services.whatsapp).toEqual({ kind: 'whatsapp', customUrl: 'https://x' });
    expect(inst.displayName).toBe('WhatsApp');
    expect(inst.icon).toBe('brand');
    expect(cfg.services.whatsapp.launcher).toBeUndefined();
  });

  it('gives the second account -2, a default name and the next unused variant', () => {
    const cfg: LoftConfig = { services: { whatsapp: { kind: 'whatsapp' } } };
    const inst = addInstance(wa, cfg, { variants: ['rose', 'sky'], iconSourceDir: tmp() });
    expect(inst.id).toBe('whatsapp-2');
    expect(inst.displayName).toBe('WhatsApp 2');
    expect(cfg.services['whatsapp-2'].icon).toBe('rose');
    // The name is NOT stored: it is the default, and deriving it keeps a future
    // registry rename propagating. The icon IS, because an auto-pick is not stable
    // as siblings come and go.
    expect(cfg.services['whatsapp-2'].name).toBeUndefined();
  });

  it('skips a variant a sibling already uses', () => {
    const cfg: LoftConfig = {
      services: { whatsapp: { kind: 'whatsapp' }, 'whatsapp-2': { kind: 'whatsapp', icon: 'rose' } },
    };
    const inst = addInstance(wa, cfg, { variants: ['rose', 'sky'], iconSourceDir: tmp() });
    expect(inst.id).toBe('whatsapp-3');
    expect(cfg.services['whatsapp-3'].icon).toBe('sky');
  });

  it('stores a name only when the default is taken', () => {
    const cfg: LoftConfig = { services: { whatsapp: { kind: 'whatsapp', name: 'WhatsApp 2' } } };
    const inst = addInstance(wa, cfg, { iconSourceDir: tmp() });
    expect(inst.displayName).toBe('WhatsApp 3');
    expect(cfg.services['whatsapp-2'].name).toBe('WhatsApp 3');
  });

  it('deploys the instance icon so the rail has something to draw', () => {
    const data = tmp();
    const src = tmp();
    writeFileSync(join(src, 'whatsapp.png'), 'BRAND');
    const cfg: LoftConfig = { services: {} };
    addInstance(wa, cfg, { iconSourceDir: src, env: { XDG_DATA_HOME: data } as NodeJS.ProcessEnv });
    expect(existsSync(join(data, 'loft', 'icons', 'whatsapp.png'))).toBe(true);
  });

  it('removeInstance drops the launcher, the deployed icon and the config entry', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { 'whatsapp-2': { kind: 'whatsapp', launcher: true } } };
    const apps = join(data, 'applications');
    const icons = join(data, 'loft', 'icons');
    mkdirSync(apps, { recursive: true });
    mkdirSync(icons, { recursive: true });
    writeFileSync(join(apps, 'loft-whatsapp-2.desktop'), '[Desktop Entry]');
    writeFileSync(join(icons, 'whatsapp-2.png'), 'x');
    const part = join(data, 'loft', 'Partitions', 'whatsapp-2');
    mkdirSync(part, { recursive: true });

    removeInstance(resolveInstance('whatsapp-2', cfg)!, cfg, true, env);
    expect(cfg.services['whatsapp-2']).toBeUndefined();
    expect(existsSync(join(apps, 'loft-whatsapp-2.desktop'))).toBe(false);
    expect(existsSync(join(icons, 'whatsapp-2.png'))).toBe(false);
    expect(existsSync(part)).toBe(false);
  });

  it('keeps the partition when the user does not ask to delete login data', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const cfg: LoftConfig = { services: { whatsapp: { kind: 'whatsapp' } } };
    const part = join(data, 'loft', 'Partitions', 'whatsapp');
    mkdirSync(part, { recursive: true });
    removeInstance(resolveInstance('whatsapp', cfg)!, cfg, false, env);
    expect(existsSync(part)).toBe(true);
  });
});
