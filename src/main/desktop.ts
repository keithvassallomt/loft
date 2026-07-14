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

export function writeServiceLauncher(
  def: ServiceDef,
  opts: { env?: Env; execPath?: string; iconSourceDir: string },
): void {
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
  if (!env.APPIMAGE && (exec.includes('/node_modules/') || exec.endsWith('/electron'))) return;
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
