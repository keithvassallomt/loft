import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceDef } from './registry';
import { applicationsDir, iconsDir } from './paths';

type Env = NodeJS.ProcessEnv;

export function isFlatpak(env: Env = process.env): boolean {
  return Boolean(env.FLATPAK_ID) || existsSync('/.flatpak-info');
}

/** The Exec= prefix: AppImage path, else `flatpak run chat.loft.Loft`, else the binary. */
export function desktopExec(opts: { env?: Env; execPath?: string } = {}): string {
  const env = opts.env ?? process.env;
  if (env.APPIMAGE) return env.APPIMAGE;
  if (isFlatpak(env)) return 'flatpak run chat.loft.Loft';
  return opts.execPath ?? process.execPath;
}

/**
 * True when `exec` is a working copy run straight out of the Electron binary
 * in dev (`npm start`), not a packaged AppImage. Shared by every writer that
 * would otherwise bake `.../node_modules/electron/dist/electron` into a
 * `.desktop` file's `Exec=` line — a bare Electron default-app window at the
 * next login, and (for the *autostart* entry specifically) silent clobbering
 * of a real Flatpak-portal-written entry, since both write the same filename.
 */
export function isDevExec(exec: string, env: Env = process.env): boolean {
  return !env.APPIMAGE && (exec.includes('/node_modules/') || exec.endsWith('/electron'));
}

export function serviceLauncherContent(def: ServiceDef, exec: string, iconPath: string): string {
  return (
    `[Desktop Entry]\n` +
    `Type=Application\n` +
    `Name=${def.displayName}\n` +
    `Comment=Open ${def.displayName} via Loft\n` +
    `Exec=${exec} --service=${def.id}\n` +
    `Icon=${iconPath}\n` +
    `Terminal=false\n` +
    `Categories=Network;InstantMessaging;\n`
  );
}

export function hubDesktopContent(exec: string, iconPath: string): string {
  return (
    `[Desktop Entry]\n` +
    `Type=Application\n` +
    `Name=Loft\n` +
    `Comment=Manage Loft web app services\n` +
    `Exec=${exec}\n` +
    `Icon=${iconPath}\n` +
    `Terminal=false\n` +
    `Categories=Network;InstantMessaging;\n`
  );
}

/** Copy the bundled per-service PNG into the user's loft icons dir; return the dest path. */
export function deployServiceIcon(def: ServiceDef, opts: { env?: Env; iconSourceDir: string }): string {
  const dir = iconsDir(opts.env);
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, `${def.id}.png`);
  const srcFile = join(opts.iconSourceDir, `${def.id}.png`);
  if (existsSync(srcFile)) copyFileSync(srcFile, dst);
  return dst;
}

function launcherPath(def: ServiceDef, env?: Env): string {
  return join(applicationsDir(env), `loft-${def.id}.desktop`);
}

/**
 * Write (or repair) a service's launcher + icon. Idempotent — callers re-run it to
 * self-heal a stale or deleted entry, including v1-era ones whose `Icon=` was an XDG
 * theme name rather than a real path.
 *
 * Skipped under a dev run: `desktopExec()` would resolve to the checkout's own
 * `node_modules/.../electron`, producing a launcher that can't work (no app dir, so it
 * opens Electron's default app) at the SAME filename the packaged install uses —
 * silently clobbering the real one. `ensureHubDesktopEntry` has always guarded this;
 * doing it here covers every caller at once.
 */
export function writeServiceLauncher(
  def: ServiceDef,
  opts: { env?: Env; execPath?: string; iconSourceDir: string },
): void {
  const env = opts.env ?? process.env;
  const exec0 = opts.execPath ?? process.execPath;
  if (isDevExec(exec0, env)) {
    console.debug(`Dev run (${exec0}) — not writing ${def.id}'s launcher`);
    return;
  }
  const icon = deployServiceIcon(def, { env: opts.env, iconSourceDir: opts.iconSourceDir });
  const dir = applicationsDir(opts.env);
  mkdirSync(dir, { recursive: true });
  const exec = desktopExec({ env: opts.env, execPath: opts.execPath });
  writeFileSync(launcherPath(def, opts.env), serviceLauncherContent(def, exec, icon), 'utf8');
}

export function removeServiceLauncher(def: ServiceDef, env: Env = process.env): void {
  const p = launcherPath(def, env);
  if (existsSync(p)) rmSync(p, { force: true });
}

/** The hub's own launcher — for dev/AppImage; packaged/Flatpak provide their own. */
export function ensureHubDesktopEntry(opts: { env?: Env; execPath?: string; iconSourceDir: string }): void {
  const env = opts.env ?? process.env;
  if (isFlatpak(env)) return;
  const exec = opts.execPath ?? process.execPath;
  // Skip a working copy run straight out of the Electron binary in dev.
  if (isDevExec(exec, env)) return;
  const dir = applicationsDir(env);
  const p = join(dir, 'chat.loft.Loft.desktop');
  if (existsSync(p)) return;
  mkdirSync(dir, { recursive: true });
  mkdirSync(iconsDir(env), { recursive: true });
  const iconSrc = join(opts.iconSourceDir, 'loft.png');
  const iconDst = join(iconsDir(env), 'loft.png');
  if (existsSync(iconSrc)) copyFileSync(iconSrc, iconDst);
  writeFileSync(p, hubDesktopContent(desktopExec({ env, execPath: exec }), iconDst), 'utf8');
}
