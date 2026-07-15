import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autostartContent, setAutostart, isAutostartEnabled, wantsAutostart, syncAutostart } from '../src/main/autostart';

const tmps: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'loft-as-')); tmps.push(d); return d; }
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('autostart', () => {
  it('content execs --minimized and enables gnome autostart', () => {
    const c = autostartContent('/usr/bin/loft', '/i/loft.png');
    expect(c).toContain('Exec=/usr/bin/loft --minimized');
    expect(c).toContain('X-GNOME-Autostart-enabled=true');
    expect(c).toContain('Name=Loft');
  });
  it('enable writes, query reports true, disable removes', () => {
    const cfg = tmp();
    const src = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp() } as NodeJS.ProcessEnv;
    const path = join(cfg, 'autostart', 'chat.loft.Loft.desktop');

    expect(isAutostartEnabled(env)).toBe(false);
    setAutostart(true, { env, execPath: '/usr/bin/loft', iconSourceDir: src });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('--minimized');
    expect(isAutostartEnabled(env)).toBe(true);

    setAutostart(false, { env, execPath: '/usr/bin/loft', iconSourceDir: src });
    expect(existsSync(path)).toBe(false);
    expect(isAutostartEnabled(env)).toBe(false);
  });
  it('deploys loft.png into the icons dir when present in the source', () => {
    const cfg = tmp();
    const src = tmp();
    const dataH = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: dataH } as NodeJS.ProcessEnv;
    writeFileSync(join(src, 'loft.png'), 'PNG');
    setAutostart(true, { env, execPath: '/usr/bin/loft', iconSourceDir: src });
    expect(existsSync(join(dataH, 'loft', 'icons', 'loft.png'))).toBe(true);
  });
  it('wantsAutostart is false with no services and no flags', () => {
    expect(wantsAutostart({})).toBe(false);
    expect(wantsAutostart({ slack: {} })).toBe(false);
    expect(wantsAutostart({ slack: { openOnStartup: false } })).toBe(false);
  });
  it('wantsAutostart is true when any service opts in', () => {
    expect(wantsAutostart({ slack: { openOnStartup: true } })).toBe(true);
    expect(wantsAutostart({ slack: { openOnStartup: false }, whatsapp: { openOnStartup: true } })).toBe(true);
    expect(wantsAutostart({ a: { openOnStartup: true }, b: { openOnStartup: true } })).toBe(true);
  });
  it('wantsAutostart tolerates undefined entries', () => {
    expect(wantsAutostart({ slack: undefined })).toBe(false);
  });

  it('syncAutostart uses the portal under Flatpak and never touches the file', async () => {
    const cfg = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp(), FLATPAK_ID: 'chat.loft.Loft' } as NodeJS.ProcessEnv;
    const seen: boolean[] = [];
    await syncAutostart(true, {
      env, execPath: '/usr/bin/loft', iconSourceDir: tmp(),
      portal: async (e) => { seen.push(e); return true; },
    });
    expect(seen).toEqual([true]);
    expect(existsSync(join(cfg, 'autostart', 'chat.loft.Loft.desktop'))).toBe(false);
  });

  it('syncAutostart writes the file natively and never calls the portal', async () => {
    const cfg = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp() } as NodeJS.ProcessEnv;
    let portalCalls = 0;
    await syncAutostart(true, {
      env, execPath: '/usr/bin/loft', iconSourceDir: tmp(),
      portal: async () => { portalCalls++; return true; },
    });
    expect(portalCalls).toBe(0);
    expect(existsSync(join(cfg, 'autostart', 'chat.loft.Loft.desktop'))).toBe(true);
  });

  it('syncAutostart(false) removes the file natively', async () => {
    const cfg = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp() } as NodeJS.ProcessEnv;
    const opts = { env, execPath: '/usr/bin/loft', iconSourceDir: tmp() };
    await syncAutostart(true, opts);
    expect(isAutostartEnabled(env)).toBe(true);
    await syncAutostart(false, opts);
    expect(isAutostartEnabled(env)).toBe(false);
  });

  it('syncAutostart never rejects when the native write fails', async () => {
    // Point XDG_CONFIG_HOME at a path *under an existing regular file* — the
    // parent segment can't be a directory, so mkdirSync throws ENOTDIR deep
    // inside setAutostart. This proves the failure is a genuine fs error, not
    // a mock, and that syncAutostart still resolves rather than rejecting.
    const parent = tmp();
    const blocker = join(parent, 'blocker-file');
    writeFileSync(blocker, 'not a directory', 'utf8');
    const cfg = join(blocker, 'config-home');
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp() } as NodeJS.ProcessEnv;
    const opts: { env: NodeJS.ProcessEnv; execPath: string; iconSourceDir: string } = {
      env, execPath: '/usr/bin/loft', iconSourceDir: tmp(),
    };

    await expect(syncAutostart(true, opts)).resolves.toBeUndefined();
    expect(isAutostartEnabled(env)).toBe(false);
    expect(existsSync(join(cfg, 'autostart', 'chat.loft.Loft.desktop'))).toBe(false);
  });
});
