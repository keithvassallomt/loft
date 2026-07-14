// Stage 4.5 (KDE) — window focus/hide via KWin scripting.
//
// The GNOME path drives window focus/hide through the Shell-helper D-Bus client
// (../gnome/shellHelper.ts: FocusWindow/HideWindow) to bypass focus-stealing
// prevention. KDE has no such helper; this ports the production Rust Loft's
// KWin-scripting approach (src/daemon/kwin.rs), RE-KEYED ONTO WINDOW TITLES like
// the GNOME rewrite (all Loft windows share one WM_CLASS under the single Electron
// app identity, so match by title/caption, NOT resourceClass as kwin.rs does).
//
// dbus-next API used here is verified against node_modules/dbus-next@0.10.2:
// `new dbus.Message({destination,path,interface,member,signature?,body?})`,
// `bus.call(msg): Promise<Message>` (../gnome/shellHelper.ts).
import * as dbus from 'dbus-next';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const KWIN = 'org.kde.KWin';

/**
 * KWin scripting JS that finds the Loft window whose caption matches `key`
 * (exact, or "<key> (N)") and shows or hides it. Plasma 6 primary
 * (workspace.windowList / activeWindow); Plasma 5 fallback (clientList /
 * activeClient). `key` is JSON-escaped so titles with quotes/spaces are safe.
 */
export function buildKwinScript(action: 'show' | 'hide', key: string): string {
  const k = JSON.stringify(key); // yields a safely-quoted JS string literal
  const body =
    action === 'show'
      ? `w.skipTaskbar = false; w.minimized = false;
      if ("activeWindow" in workspace) workspace.activeWindow = w; else workspace.activeClient = w;`
      : `w.skipTaskbar = true; w.minimized = true;`;
  return `var list = (typeof workspace.windowList === 'function')
  ? workspace.windowList()
  : workspace.clientList();
for (var i = 0; i < list.length; i++) {
  var w = list[i];
  if (w.caption === ${k} || w.caption.indexOf(${k} + " (") === 0) {
    ${body}
    break;
  }
}
`;
}

export interface KwinClient {
  focusWindow(key: string): Promise<void>;
  hideWindow(key: string): Promise<void>;
}

/** Real KWin client: focus/hide the Loft window whose caption matches `key`. Never throws. */
export function createKwinClient(): KwinClient {
  let bus: ReturnType<typeof dbus.sessionBus> | null = null;
  const getBus = () => (bus ??= dbus.sessionBus());

  const call = (path: string, iface: string, member: string, signature: string | undefined, body: unknown[]) =>
    getBus().call(new dbus.Message({
      destination: KWIN, path, interface: iface, member,
      ...(signature ? { signature } : {}),
      ...(body.length ? { body } : {}),
    }));

  const runScript = async (action: 'show' | 'hide', key: string): Promise<void> => {
    const plugin = action === 'show' ? 'loft-show' : 'loft-hide';
    const path = join(tmpdir(), `${plugin}.js`);
    try {
      writeFileSync(path, buildKwinScript(action, key), 'utf8');
      // Clear any stale instance first (ignore errors).
      await call('/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', [plugin]).catch(() => {});
      const reply = await call('/Scripting', 'org.kde.kwin.Scripting', 'loadScript', 'ss', [path, plugin]);
      const id = (reply?.body?.[0] as number) ?? 0;
      await call(`/Scripting/Script${id}`, 'org.kde.kwin.Script', 'run', undefined, []);
      await new Promise((r) => setTimeout(r, 120)); // let the script execute before unload
      await call('/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', [plugin]).catch(() => {});
    } catch (e) {
      console.debug(`KWin ${action} failed:`, (e as Error)?.message ?? e);
    }
  };

  return {
    focusWindow: (key) => runScript('show', key),
    hideWindow: (key) => runScript('hide', key),
  };
}
