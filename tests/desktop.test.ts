import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isFlatpak, desktopExec, isDevExec, serviceLauncherContent, hubDesktopContent,
  writeServiceLauncher, removeServiceLauncher, deployServiceIcon, ensureHubDesktopEntry,
} from '../src/main/desktop';
import { getService } from '../src/main/registry';

const wa = getService('whatsapp')!;
const tmps: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'loft-')); tmps.push(d); return d; }
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('desktop exec + flatpak', () => {
  it('prefers APPIMAGE, then flatpak, then execPath', () => {
    expect(desktopExec({ env: { APPIMAGE: '/a/Loft.AppImage' }, execPath: '/x' })).toBe('/a/Loft.AppImage');
    expect(desktopExec({ env: { FLATPAK_ID: 'chat.loft.Loft' }, execPath: '/x' })).toBe('flatpak run chat.loft.Loft');
    expect(desktopExec({ env: {}, execPath: '/usr/bin/loft' })).toBe('/usr/bin/loft');
  });
  it('isFlatpak reads FLATPAK_ID', () => {
    expect(isFlatpak({ FLATPAK_ID: 'x' })).toBe(true);
    expect(isFlatpak({})).toBe(false);
  });
});

// I3: the shared predicate behind both ensureHubDesktopEntry's dev-run skip and
// setAutostart's dev-run skip (autostart.ts) — extracted so both stay in lockstep.
describe('isDevExec', () => {
  it('is true for a node_modules/electron path or a bare .../electron path', () => {
    expect(isDevExec('/home/u/proj/node_modules/electron/dist/electron', {})).toBe(true);
    expect(isDevExec('/opt/foo/electron', {})).toBe(true);
  });
  it('is false for a real installed binary', () => {
    expect(isDevExec('/usr/bin/loft', {})).toBe(false);
  });
  it('is false whenever APPIMAGE is set, even for a dev-looking path', () => {
    expect(isDevExec('/home/u/proj/node_modules/electron/dist/electron', { APPIMAGE: '/a/Loft.AppImage' })).toBe(false);
  });
});

describe('desktop content', () => {
  it('service launcher has Exec --service and the icon path', () => {
    const c = serviceLauncherContent(wa, '/usr/bin/loft', '/i/whatsapp.png');
    expect(c).toContain('[Desktop Entry]');
    expect(c).toContain('Name=WhatsApp');
    expect(c).toContain('Exec=/usr/bin/loft --service=whatsapp');
    expect(c).toContain('Icon=/i/whatsapp.png');
    expect(c).toContain('Categories=Network;InstantMessaging;');
    expect(c).not.toContain('StartupWMClass'); // all windows share chat.loft.Loft
  });
  it('hub entry execs the bare binary', () => {
    const c = hubDesktopContent('/usr/bin/loft', '/i/loft.png');
    expect(c).toContain('Name=Loft');
    expect(c).toMatch(/Exec=\/usr\/bin\/loft\n/);
  });
});

describe('desktop writers', () => {
  it('deploys icon, writes then removes the launcher', () => {
    const data = tmp();
    const src = tmp();
    mkdirSync(join(src), { recursive: true });
    writeFileSync(join(src, 'whatsapp.png'), 'PNG');
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;

    const iconDst = deployServiceIcon(wa, { env, iconSourceDir: src });
    expect(existsSync(iconDst)).toBe(true);
    expect(readFileSync(iconDst, 'utf8')).toBe('PNG');

    writeServiceLauncher(wa, { env, execPath: '/usr/bin/loft', iconSourceDir: src });
    const launcher = join(data, 'applications', 'loft-whatsapp.desktop');
    expect(existsSync(launcher)).toBe(true);
    expect(readFileSync(launcher, 'utf8')).toContain('Exec=/usr/bin/loft --service=whatsapp');

    removeServiceLauncher(wa, env);
    expect(existsSync(launcher)).toBe(false);
  });
});

describe('ensureHubDesktopEntry', () => {
  it('skips under Flatpak', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data, FLATPAK_ID: 'chat.loft.Loft' } as NodeJS.ProcessEnv;
    ensureHubDesktopEntry({ env, execPath: '/usr/bin/loft', iconSourceDir: tmp() });
    expect(existsSync(join(data, 'applications', 'chat.loft.Loft.desktop'))).toBe(false);
  });
  it('skips a dev electron binary path (node_modules or /electron), no APPIMAGE', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    ensureHubDesktopEntry({ env, execPath: '/home/u/proj/node_modules/electron/dist/electron', iconSourceDir: tmp() });
    ensureHubDesktopEntry({ env, execPath: '/opt/foo/electron', iconSourceDir: tmp() });
    expect(existsSync(join(data, 'applications', 'chat.loft.Loft.desktop'))).toBe(false);
  });
  it('is idempotent — leaves an existing entry untouched', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const p = join(data, 'applications', 'chat.loft.Loft.desktop');
    mkdirSync(join(data, 'applications'), { recursive: true });
    writeFileSync(p, 'SENTINEL');
    ensureHubDesktopEntry({ env, execPath: '/usr/bin/loft', iconSourceDir: tmp() });
    expect(readFileSync(p, 'utf8')).toBe('SENTINEL');
  });
  it('writes the hub entry for a real (non-dev) exec, deploying the icon', () => {
    const data = tmp();
    const src = tmp();
    writeFileSync(join(src, 'loft.png'), 'PNG');
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    ensureHubDesktopEntry({ env, execPath: '/usr/bin/loft', iconSourceDir: src });
    const p = join(data, 'applications', 'chat.loft.Loft.desktop');
    expect(existsSync(p)).toBe(true);
    const c = readFileSync(p, 'utf8');
    expect(c).toContain('Name=Loft');
    expect(c).toMatch(/Exec=\/usr\/bin\/loft\n/);
    expect(existsSync(join(data, 'loft', 'icons', 'loft.png'))).toBe(true);
  });
});
