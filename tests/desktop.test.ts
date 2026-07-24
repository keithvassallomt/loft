import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isFlatpak, desktopExec, isDevExec, serviceLauncherContent, hubDesktopContent,
  writeServiceLauncher, removeServiceLauncher, deployInstanceIcon, removeInstanceIcon, ensureHubDesktopEntry,
} from '../src/main/desktop';
import { getKind } from '../src/main/registry';

const wa = getKind('whatsapp')!;
// The bare-kind instance (account #1): same id/displayName as the registry entry, brand icon.
const waInst = { ...wa, kind: 'whatsapp', dbusSegment: 'WhatsApp', icon: 'brand' };
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
  // The Flatpak's own execPath is /app/main/node_modules/electron/dist/electron: it
  // CONTAINS '/node_modules/' and ENDS WITH '/electron', so every heuristic above
  // false-positives on the packaged app. desktopExec() resolves Flatpak separately.
  it('is false inside the Flatpak despite the dev-looking execPath', () => {
    const fp = '/app/main/node_modules/electron/dist/electron';
    expect(isDevExec(fp, { FLATPAK_ID: 'chat.loft.Loft' })).toBe(false);
    expect(isDevExec(fp, {})).toBe(true); // same path, no sandbox = genuinely dev
  });
});

describe('desktop content', () => {
  it('service launcher has Exec --service and the icon path', () => {
    const c = serviceLauncherContent(waInst, '/usr/bin/loft', '/i/whatsapp.png');
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

    const iconDst = deployInstanceIcon(waInst, { env, iconSourceDir: src });
    expect(existsSync(iconDst)).toBe(true);
    expect(readFileSync(iconDst, 'utf8')).toBe('PNG');

    writeServiceLauncher(waInst, { env, execPath: '/usr/bin/loft', iconSourceDir: src });
    const launcher = join(data, 'applications', 'loft-whatsapp.desktop');
    expect(existsSync(launcher)).toBe(true);
    expect(readFileSync(launcher, 'utf8')).toContain('Exec=/usr/bin/loft --service=whatsapp');

    removeServiceLauncher(waInst, env);
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

describe('writeServiceLauncher self-heal', () => {
  const iconSrc = (): string => { const d = tmp(); writeFileSync(join(d, 'whatsapp.png'), 'png'); return d; };

  it('repairs a stale v1-era launcher in place (same filename, bad Icon=)', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const apps = join(data, 'applications');
    mkdirSync(apps, { recursive: true });
    // What v1 left behind: our exact filename, but Icon= is an XDG theme name we no
    // longer install — the blank-icon-in-the-launcher symptom.
    const p = join(apps, 'loft-whatsapp.desktop');
    writeFileSync(p, '[Desktop Entry]\nExec=/old/loft --service whatsapp\nIcon=loft-whatsapp\n');

    writeServiceLauncher(waInst, { env, execPath: '/usr/bin/loft', iconSourceDir: iconSrc() });

    const c = readFileSync(p, 'utf8');
    expect(c).toContain('Exec=/usr/bin/loft --service=whatsapp');
    expect(c).toContain(`Icon=${join(data, 'loft', 'icons', 'whatsapp.png')}`);
    expect(c).not.toContain('Icon=loft-whatsapp\n');
  });

  it('recreates a deleted launcher', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const p = join(data, 'applications', 'loft-whatsapp.desktop');
    expect(existsSync(p)).toBe(false);
    writeServiceLauncher(waInst, { env, execPath: '/usr/bin/loft', iconSourceDir: iconSrc() });
    expect(existsSync(p)).toBe(true);
  });

  // Regression lock: the Flatpak's own execPath is
  // /app/main/node_modules/electron/dist/electron — it CONTAINS '/node_modules/' and
  // ENDS WITH '/electron', so the dev heuristic false-positives on the packaged app.
  // Unguarded, that silently disabled launcher writing on the primary shipping target.
  it('still writes inside the Flatpak, whose execPath looks exactly like a dev run', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data, FLATPAK_ID: 'chat.loft.Loft' } as NodeJS.ProcessEnv;
    const p = join(data, 'applications', 'loft-whatsapp.desktop');
    writeServiceLauncher(waInst, {
      env, execPath: '/app/main/node_modules/electron/dist/electron', iconSourceDir: iconSrc(),
    });
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toContain('Exec=flatpak run chat.loft.Loft --service=whatsapp');
    expect(existsSync(join(data, 'loft', 'icons', 'whatsapp.png'))).toBe(true);
  });

  // Without this, `npm start` rewrites every launcher to point at the checkout's
  // electron — at the SAME filename the packaged install uses, silently clobbering it.
  it('refuses to write from a dev checkout', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const p = join(data, 'applications', 'loft-whatsapp.desktop');
    writeServiceLauncher(waInst, {
      env, execPath: '/home/x/loft/node_modules/electron/dist/electron', iconSourceDir: iconSrc(),
    });
    expect(existsSync(p)).toBe(false);
  });

  it('still writes from an AppImage (APPIMAGE set) even though execPath looks dev-ish', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data, APPIMAGE: '/a/Loft.AppImage' } as NodeJS.ProcessEnv;
    const p = join(data, 'applications', 'loft-whatsapp.desktop');
    writeServiceLauncher(waInst, {
      env, execPath: '/tmp/.mount_x/electron', iconSourceDir: iconSrc(),
    });
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toContain('Exec=/a/Loft.AppImage --service=whatsapp');
  });
});

describe('per-instance launchers and icons', () => {
  it('names the launcher after the instance, not the kind', () => {
    const inst = { ...wa, id: 'whatsapp-2', kind: 'whatsapp', displayName: 'Work', dbusSegment: 'WhatsApp2', icon: 'rose' };
    const out = serviceLauncherContent(inst, '/usr/bin/loft', '/icons/whatsapp-2.png');
    expect(out).toContain('Name=Work\n');
    expect(out).toContain('Comment=Open Work via Loft\n');
    expect(out).toContain('Exec=/usr/bin/loft --service=whatsapp-2\n');
    expect(out).toContain('Icon=/icons/whatsapp-2.png\n');
  });

  it('deploys a variant instance icon under the INSTANCE id', () => {
    // The rail asks for loft://icon/whatsapp-2, and no bundled whatsapp-2.png exists —
    // so this copy is what stops a second account rendering a broken image.
    const data = tmp();
    const src = tmp();
    mkdirSync(join(src, 'variants'), { recursive: true });
    writeFileSync(join(src, 'variants', 'whatsapp-rose.png'), 'ROSE');
    const inst = { ...wa, id: 'whatsapp-2', kind: 'whatsapp', displayName: 'Work', dbusSegment: 'WhatsApp2', icon: 'rose' };
    const dst = deployInstanceIcon(inst, { env: { XDG_DATA_HOME: data } as NodeJS.ProcessEnv, iconSourceDir: src });
    expect(dst).toBe(join(data, 'loft', 'icons', 'whatsapp-2.png'));
    expect(readFileSync(dst, 'utf8')).toBe('ROSE');
  });

  it('deploys the brand PNG when the instance uses the brand icon', () => {
    const data = tmp();
    const src = tmp();
    writeFileSync(join(src, 'whatsapp.png'), 'BRAND');
    const inst = { ...wa, id: 'whatsapp', kind: 'whatsapp', displayName: 'WhatsApp', dbusSegment: 'WhatsApp', icon: 'brand' };
    const dst = deployInstanceIcon(inst, { env: { XDG_DATA_HOME: data } as NodeJS.ProcessEnv, iconSourceDir: src });
    expect(readFileSync(dst, 'utf8')).toBe('BRAND');
  });

  it('leaves a custom icon alone — main already wrote it, and there is no source to re-copy', () => {
    const data = tmp();
    const icons = join(data, 'loft', 'icons');
    mkdirSync(icons, { recursive: true });
    writeFileSync(join(icons, 'whatsapp-2.png'), 'MINE');
    const inst = { ...wa, id: 'whatsapp-2', kind: 'whatsapp', displayName: 'Work', dbusSegment: 'WhatsApp2', icon: 'custom' };
    deployInstanceIcon(inst, { env: { XDG_DATA_HOME: data } as NodeJS.ProcessEnv, iconSourceDir: tmp() });
    expect(readFileSync(join(icons, 'whatsapp-2.png'), 'utf8')).toBe('MINE');
  });

  it('removeInstanceIcon deletes the deployed file and tolerates its absence', () => {
    const data = tmp();
    const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
    const icons = join(data, 'loft', 'icons');
    mkdirSync(icons, { recursive: true });
    writeFileSync(join(icons, 'whatsapp-2.png'), 'x');
    removeInstanceIcon('whatsapp-2', env);
    expect(existsSync(join(icons, 'whatsapp-2.png'))).toBe(false);
    expect(() => removeInstanceIcon('whatsapp-2', env)).not.toThrow();
  });
});
