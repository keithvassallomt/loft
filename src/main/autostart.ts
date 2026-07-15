import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceConfig } from './config';
import { autostartDir, iconsDir } from './paths';
import { desktopExec, isFlatpak } from './desktop';
import { requestAutostart, defaultPortalDeps, type PortalDeps } from './portal/background';

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

/**
 * defaultPortalDeps() opens a brand-new D-Bus session-bus connection (and
 * socket) on every call and exposes no teardown — calling it once per
 * syncAutostart invocation would leak a file descriptor for the process
 * lifetime every time a service's "open on startup" flag is toggled. Created
 * lazily on first real (non-test) use and reused for the rest of the process,
 * exactly like the singleton bus connections the tray/notifications backends
 * already keep. Not used at all when opts.portal is supplied (the test seam).
 */
let cachedPortalDeps: PortalDeps | undefined;
function sharedPortalDeps(): PortalDeps {
  if (!cachedPortalDeps) cachedPortalDeps = defaultPortalDeps();
  return cachedPortalDeps;
}

/**
 * Apply the desired autostart state.
 *
 * Under Flatpak this goes through the XDG Background portal — the sanctioned
 * route, which writes a proper X-XDP-Autostart entry using the app's own
 * Name/Icon and lets the manifest keep only :ro on the autostart dir. Natively
 * there is no sandbox app-id for the portal to key on, so we write the file
 * ourselves (unchanged behaviour).
 *
 * Returns nothing on purpose: what was actually granted is read back from disk
 * with isAutostartEnabled(), so both backends are judged by the same evidence
 * rather than by what each claims it did. That's also why a failure here is
 * swallowed rather than propagated: unlike the portal path (documented to
 * never reject), the native branch below does synchronous fs I/O
 * (mkdirSync/copyFileSync/writeFileSync/rmSync) that throws on EACCES/EROFS/
 * ENOSPC/etc. Callers invoke this fire-and-forget (`void syncAutostart(...)`,
 * see hub IPC), and there is no process-wide unhandledRejection handler, so a
 * rejection here would crash the whole app over a routine settings toggle. A
 * failed write simply leaves no entry on disk, which isAutostartEnabled()
 * already reports as "autostart blocked" for the hub to surface — never
 * throwing is what makes that the uniform, safe contract.
 */
export async function syncAutostart(
  enabled: boolean,
  opts: { env?: Env; execPath?: string; iconSourceDir: string; portal?: (enabled: boolean) => Promise<boolean> },
): Promise<void> {
  try {
    const env = opts.env ?? process.env;
    if (isFlatpak(env)) {
      const portal = opts.portal ?? ((e: boolean) => requestAutostart(e, sharedPortalDeps()));
      await portal(enabled);
      return;
    }
    setAutostart(enabled, { env, execPath: opts.execPath, iconSourceDir: opts.iconSourceDir });
  } catch (e) {
    console.debug('syncAutostart failed:', (e as Error)?.message ?? e);
  }
}
