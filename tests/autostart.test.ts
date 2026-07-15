import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autostartContent, setAutostart, isAutostartEnabled, wantsAutostart, syncAutostart, removeLegacyAutostart } from '../src/main/autostart';

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
  // I3: a dev (`npm start`) run's Exec= would be the bare Electron binary out of
  // node_modules; writing it would clobber a real (e.g. Flatpak-portal-written)
  // entry sharing the same filename, silently killing autostart at login.
  it('setAutostart(true) skips writing under a dev Electron run', () => {
    const cfg = tmp();
    const src = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp() } as NodeJS.ProcessEnv;
    const path = join(cfg, 'autostart', 'chat.loft.Loft.desktop');

    setAutostart(true, { env, execPath: '/repo/node_modules/electron/dist/electron', iconSourceDir: src });
    expect(existsSync(path)).toBe(false);

    setAutostart(true, { env, execPath: '/opt/foo/electron', iconSourceDir: src });
    expect(existsSync(path)).toBe(false);
  });

  it('setAutostart(false) still removes a stale entry under a dev Electron run', () => {
    const cfg = tmp();
    const src = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp() } as NodeJS.ProcessEnv;
    const path = join(cfg, 'autostart', 'chat.loft.Loft.desktop');

    // Simulate a real entry already on disk (e.g. written by the portal/a package).
    setAutostart(true, { env, execPath: '/usr/bin/loft', iconSourceDir: src });
    expect(existsSync(path)).toBe(true);

    setAutostart(false, { env, execPath: '/repo/node_modules/electron/dist/electron', iconSourceDir: src });
    expect(existsSync(path)).toBe(false);
  });

  it('setAutostart(true) still writes when APPIMAGE is set, even with a dev-looking execPath', () => {
    const cfg = tmp();
    const src = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp(), APPIMAGE: '/a/Loft.AppImage' } as NodeJS.ProcessEnv;
    const path = join(cfg, 'autostart', 'chat.loft.Loft.desktop');
    setAutostart(true, { env, execPath: '/repo/node_modules/electron/dist/electron', iconSourceDir: src });
    expect(existsSync(path)).toBe(true);
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
  // M1: reconcileAutostart() (src/main/index.ts) gates on
  // `wantsAutostart(services) === isAutostartEnabled()` before doing anything.
  // reconcileAutostart itself isn't unit-testable (it lives in index.ts, which
  // has Electron app-lifecycle side effects at import time and no existing test
  // coverage), so this exercises the exact primitives that gate composes, for
  // the specific scenario M1 was filed over: unticking the LAST flagged service
  // on an install where background permission was never granted. Before the fix,
  // that unconditionally called syncAutostart(false) → RequestBackground(false)
  // with permission UNSET, which can pop a permission dialog at the moment the
  // user turned the feature off. After the fix, wants flips true -> false while
  // isAutostartEnabled() was already false (permission was never granted, so no
  // entry was ever written) — wants === enabled, so the gate is satisfied and
  // reconcileAutostart returns without touching the portal at all.
  it('gate condition: unticking the last service when never-granted is already in sync (no portal call needed)', () => {
    const cfg = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp() } as NodeJS.ProcessEnv;
    const servicesBefore = { slack: { openOnStartup: true } };
    const servicesAfter = { slack: { openOnStartup: false } };

    expect(wantsAutostart(servicesBefore)).toBe(true);
    expect(isAutostartEnabled(env)).toBe(false); // never granted: no entry on disk
    // out of sync before the untick -> the gate would have let a call through
    // (that's the deliberate "denial is retried" behaviour, unrelated to this fix)

    expect(wantsAutostart(servicesAfter)).toBe(false);
    expect(isAutostartEnabled(env)).toBe(false); // still nothing on disk
    // both false -> in sync -> gate short-circuits, no RequestBackground call
    expect(wantsAutostart(servicesAfter)).toBe(isAutostartEnabled(env));
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

  // I3, end-to-end through the function index.ts actually calls: a dev run must
  // not clobber a real entry that's already on disk (e.g. from a prior packaged
  // run or the Flatpak portal).
  it('syncAutostart never overwrites an existing entry with a dev-run Exec=', async () => {
    const cfg = tmp();
    const env = { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: tmp() } as NodeJS.ProcessEnv;
    const path = join(cfg, 'autostart', 'chat.loft.Loft.desktop');
    await syncAutostart(true, { env, execPath: '/usr/bin/loft', iconSourceDir: tmp() });
    const original = readFileSync(path, 'utf8');

    await syncAutostart(true, { env, execPath: '/repo/node_modules/electron/dist/electron', iconSourceDir: tmp() });
    expect(readFileSync(path, 'utf8')).toBe(original);
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

describe('removeLegacyAutostart', () => {
  it('removes v1 per-service entries and leaves everything else alone', () => {
    const cfg = tmp();
    const env = { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv;
    const dir = join(cfg, 'autostart');
    mkdirSync(dir, { recursive: true });
    // v1 wrote one of these PER SERVICE; today's CLI still parses their
    // `--service whatsapp` form, so they'd launch it at login regardless of the flag.
    writeFileSync(join(dir, 'loft-whatsapp.desktop'), 'x');
    writeFileSync(join(dir, 'loft-slack.desktop'), 'x');
    // Must survive: our own derived entry, and an unrelated app's.
    writeFileSync(join(dir, 'chat.loft.Loft.desktop'), 'ours');
    writeFileSync(join(dir, 'com.bitwarden.desktop.desktop'), 'theirs');

    const removed = removeLegacyAutostart(['whatsapp', 'slack', 'telegram']);
    expect(removed).toEqual([]); // default env, not our tmp dir

    const removed2 = removeLegacyAutostart(['whatsapp', 'slack', 'telegram'], env);
    expect(removed2).toHaveLength(2);
    expect(existsSync(join(dir, 'loft-whatsapp.desktop'))).toBe(false);
    expect(existsSync(join(dir, 'loft-slack.desktop'))).toBe(false);
    expect(existsSync(join(dir, 'chat.loft.Loft.desktop'))).toBe(true);
    expect(existsSync(join(dir, 'com.bitwarden.desktop.desktop'))).toBe(true);
  });

  it('is idempotent and never throws on a missing dir', () => {
    const env = { XDG_CONFIG_HOME: join(tmp(), 'nope') } as NodeJS.ProcessEnv;
    expect(() => removeLegacyAutostart(['whatsapp'], env)).not.toThrow();
    expect(removeLegacyAutostart(['whatsapp'], env)).toEqual([]);
  });
});
