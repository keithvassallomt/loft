import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceConfig } from './config';
import { autostartDir, iconsDir } from './paths';
import { desktopExec } from './desktop';

type Env = NodeJS.ProcessEnv;

const FILE = 'chat.loft.Loft.desktop';

export function autostartContent(exec: string, iconPath: string): string {
  return (
    `[Desktop Entry]\n` +
    `Type=Application\n` +
    `Name=Loft\n` +
    `Comment=Loft\n` +
    `Exec=${exec} --minimized\n` +
    `Icon=${iconPath}\n` +
    `Terminal=false\n` +
    `X-GNOME-Autostart-enabled=true\n`
  );
}

function entryPath(env?: Env): string {
  return join(autostartDir(env), FILE);
}

export function isAutostartEnabled(env: Env = process.env): boolean {
  return existsSync(entryPath(env));
}

export function setAutostart(
  enabled: boolean,
  opts: { env?: Env; execPath?: string; iconSourceDir: string },
): void {
  const env = opts.env ?? process.env;
  const path = entryPath(env);
  if (enabled) {
    mkdirSync(autostartDir(env), { recursive: true });
    mkdirSync(iconsDir(env), { recursive: true });
    const iconSrc = join(opts.iconSourceDir, 'loft.png');
    const iconDst = join(iconsDir(env), 'loft.png');
    if (existsSync(iconSrc)) copyFileSync(iconSrc, iconDst);
    writeFileSync(path, autostartContent(desktopExec({ env, execPath: opts.execPath }), iconDst), 'utf8');
  } else if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

/**
 * The desired autostart state, derived from config — there is no separate
 * "start at login" setting. Loft autostarts iff at least one service asked to
 * open at login; the per-service flags are the single source of truth.
 */
export function wantsAutostart(services: Record<string, ServiceConfig | undefined>): boolean {
  return Object.values(services).some((s) => s?.openOnStartup === true);
}
