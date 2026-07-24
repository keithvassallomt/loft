import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceInstance } from './instances';
import { BRAND_ICON, CUSTOM_ICON } from './instances';
import { variantPngPath } from './icons';
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
  // There is no such thing as a dev run inside the Flatpak, and its execPath is
  // /app/main/node_modules/electron/dist/electron — which contains '/node_modules/'
  // AND ends with '/electron', so every heuristic below false-positives on the
  // packaged app. desktopExec() already resolves Flatpak to `flatpak run …`.
  if (isFlatpak(env)) return false;
  return !env.APPIMAGE && (exec.includes('/node_modules/') || exec.endsWith('/electron'));
}

export function serviceLauncherContent(inst: ServiceInstance, exec: string, iconPath: string): string {
  return (
    `[Desktop Entry]\n` +
    `Type=Application\n` +
    `Name=${inst.displayName}\n` +
    `Comment=Open ${inst.displayName} via Loft\n` +
    `Exec=${exec} --service=${inst.id}\n` +
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

/**
 * Put this instance's icon where everything that needs a real file can find it:
 * `~/.local/share/loft/icons/<id>.png`. Returns that path either way.
 *
 * Not just for launchers any more. A second instance has no bundled `<id>.png`, so
 * without this its rail icon, its notification avatar and its `.desktop` all point at
 * nothing — which is why every add and every icon change calls it.
 *
 * A custom icon is left untouched: main wrote that file from the user's own image, and
 * there is no source left to re-copy from.
 */
export function deployInstanceIcon(
  inst: ServiceInstance,
  opts: { env?: Env; iconSourceDir: string },
): string {
  const dir = iconsDir(opts.env);
  const dst = join(dir, `${inst.id}.png`);
  if (inst.icon === CUSTOM_ICON) return dst;
  mkdirSync(dir, { recursive: true });
  const src = inst.icon === BRAND_ICON
    ? join(opts.iconSourceDir, `${inst.kind}.png`)
    : variantPngPath(opts.iconSourceDir, inst.kind, inst.icon);
  if (existsSync(src)) copyFileSync(src, dst);
  return dst;
}

/** Drop a removed instance's deployed icon. Absent is fine — the deploy may never have run. */
export function removeInstanceIcon(id: string, env: Env = process.env): void {
  const p = join(iconsDir(env), `${id}.png`);
  if (existsSync(p)) rmSync(p, { force: true });
}

/** Where a service's launcher lives. Keyed by id: config keys are ids, and may
 *  outlive their registry entry. */
export function serviceLauncherPath(id: string, env?: Env): string {
  return join(applicationsDir(env), `loft-${id}.desktop`);
}

function launcherPath(inst: ServiceInstance, env?: Env): string {
  return serviceLauncherPath(inst.id, env);
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
  inst: ServiceInstance,
  opts: { env?: Env; execPath?: string; iconSourceDir: string },
): void {
  const env = opts.env ?? process.env;
  const exec0 = opts.execPath ?? process.execPath;
  if (isDevExec(exec0, env)) {
    console.debug(`Dev run (${exec0}) — not writing ${inst.id}'s launcher`);
    return;
  }
  const icon = deployInstanceIcon(inst, { env: opts.env, iconSourceDir: opts.iconSourceDir });
  const dir = applicationsDir(opts.env);
  mkdirSync(dir, { recursive: true });
  const exec = desktopExec({ env: opts.env, execPath: opts.execPath });
  writeFileSync(launcherPath(inst, opts.env), serviceLauncherContent(inst, exec, icon), 'utf8');
}

export function removeServiceLauncher(inst: ServiceInstance, env: Env = process.env): void {
  const p = launcherPath(inst, env);
  if (existsSync(p)) rmSync(p, { force: true });
}

/** Enforce each service's opt-in launcher flag: write the .desktop for services that want one,
 *  remove it for those that do not. Per-id try/catch so one unwritable entry can't skip the rest. */
export function reconcileServiceLaunchers(
  ids: string[],
  wants: (id: string) => boolean,
  ops: { write: (id: string) => void; remove: (id: string) => void },
): void {
  for (const id of ids) {
    try { (wants(id) ? ops.write : ops.remove)(id); }
    catch (err) { console.error(`Launcher self-heal failed for ${id}:`, err); }
  }
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
