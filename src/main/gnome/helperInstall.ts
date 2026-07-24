import * as dbus from 'dbus-next';
import { dialog } from 'electron';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const HELPER_UUID = 'loft-shell-helper@loft.chat';

const SHELL_NAME = 'org.gnome.Shell';
const SHELL_PATH = '/org/gnome/Shell';
const SHELL_IFACE = 'org.gnome.Shell.Extensions';

export interface HelperInstallDeps {
  /** GNOME Shell's ExtensionInfo dict for uuid; empty object if not installed. Rejects if GNOME Shell is unavailable. */
  getExtensionInfo(uuid: string): Promise<Record<string, unknown>>;
  /** Trigger GNOME's native install dialog for a uuid from extensions.gnome.org. */
  installRemoteExtension(uuid: string): Promise<string>;
  /** Ask the user whether to install the helper. Resolves true if they accept. */
  prompt(): Promise<boolean>;
  /** Install the `loft-symbolic` icon into the user icon theme (needed by the combined panel button). Idempotent. */
  installSymbolicIcon(): void;
}

/**
 * Ensure the GNOME Shell helper is available, installing it from EGO on request.
 * Never throws: a missing/erroring GNOME Shell just leaves Loft on the SNI fallback.
 */
export async function ensureGnomeHelper(deps: HelperInstallDeps): Promise<void> {
  try { deps.installSymbolicIcon(); } catch (e) { console.debug('installSymbolicIcon failed:', e); }

  let info: Record<string, unknown>;
  try {
    info = await deps.getExtensionInfo(HELPER_UUID);
  } catch {
    return; // GNOME Shell not answering → SNI fallback, no prompt
  }
  if (info && Object.keys(info).length > 0) return; // already installed (any state)

  let accepted = false;
  try { accepted = await deps.prompt(); } catch { return; }
  if (!accepted) return;

  try { await deps.installRemoteExtension(HELPER_UUID); }
  catch (e) { console.debug('InstallRemoteExtension failed:', e); }
}

export function defaultHelperInstallDeps(opts: { dataHome: string; resourcesDir: string }): HelperInstallDeps {
  const bus = dbus.sessionBus();
  const iface = async () => {
    const obj = await bus.getProxyObject(SHELL_NAME, SHELL_PATH);
    return obj.getInterface(SHELL_IFACE) as unknown as {
      GetExtensionInfo(uuid: string): Promise<Record<string, dbus.Variant>>;
      InstallRemoteExtension(uuid: string): Promise<string>;
    };
  };
  return {
    getExtensionInfo: async (uuid) => (await iface()).GetExtensionInfo(uuid),
    installRemoteExtension: async (uuid) => (await iface()).InstallRemoteExtension(uuid),
    prompt: async () => {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Install', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        title: 'Enable Loft’s GNOME integration',
        message: 'Install Loft’s GNOME integration?',
        detail:
          'For window management (show/hide, panel icons, badges) on GNOME, Loft uses a small ' +
          'GNOME Shell extension from extensions.gnome.org. Install it now? GNOME will ask you to confirm.',
      });
      return response === 0;
    },
    installSymbolicIcon: () => {
      const dir = join(opts.dataHome, 'icons', 'hicolor', 'scalable', 'apps');
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(opts.resourcesDir, 'loft-symbolic.svg'), join(dir, 'loft-symbolic.svg'));
    },
  };
}
