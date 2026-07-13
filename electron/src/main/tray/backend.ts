import { startTray } from './index';
import { startGnomePanelTray } from './gnomePanel';
import type { Tray, TrayDeps } from './index';
import type { ShellHelperClient } from '../gnome/shellHelper';

export async function startTrayBackend(
  deps: TrayDeps,
  opts: { backend: 'gnome-panel' | 'sni'; helper: ShellHelperClient },
): Promise<Tray> {
  return opts.backend === 'gnome-panel'
    ? startGnomePanelTray(deps, opts.helper)
    : startTray(deps);
}
