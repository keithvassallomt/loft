import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isFlatpak, desktopExec, serviceLauncherContent, hubDesktopContent,
  writeServiceLauncher, removeServiceLauncher, deployServiceIcon,
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
