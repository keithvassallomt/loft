import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autostartContent, setAutostart, isAutostartEnabled } from '../src/main/autostart';

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
});
