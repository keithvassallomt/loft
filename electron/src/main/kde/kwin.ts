// Stage 4.5 (KDE) — window focus/hide via KWin scripting. STUB, NOT YET WIRED.
//
// The GNOME path drives window focus/hide through the Shell-helper D-Bus client
// (../gnome/shellHelper.ts: FocusWindow/HideWindow) to bypass focus-stealing
// prevention. KDE has no such helper; the production Rust Loft uses KWin
// scripting instead. Port that here when there is a KDE (Plasma) test
// environment — do NOT ship it blind.
//
// Port reference: src/daemon/kwin.rs. Approach, RE-KEYED ONTO WINDOW TITLES like
// the GNOME rewrite (all Loft windows share one WM_CLASS under the single Electron
// app identity, so match by title, NOT resourceClass as kwin.rs does):
//   - Connect to org.kde.kwin.Scripting on the session bus.
//   - Write a JS snippet to a temp file that iterates workspace.windowList() and
//     matches by title-prefix: `title === key || title.startsWith(key + ' (')`.
//   - loadScript(path, pluginName) -> run() on /Scripting/Script<id> -> unloadScript.
//     focus: w.skipTaskbar = false; w.minimized = false; workspace.activeWindow = w
//     hide:  w.skipTaskbar = true;  w.minimized = true
//   - Fire-and-forget + never-throw, mirroring the GNOME ShellHelperClient contract.
//
// Wiring: in index.ts, at the "helper" selection seam (currently GNOME-only), add a
// KDE branch — when !gnome && isKde(), build a KwinClient and route the same
// focusWindow/hideWindow calls through it. Until then, non-GNOME show/hide falls
// back to Electron's native window.show()/hide()/focus() (hide/unmap works; raising
// a hidden window may not reliably grab focus under KDE focus-stealing prevention —
// which is exactly what this KWin path fixes).

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

/** STUB (Stage 4.5): no-op KWin client until the port lands and is KDE-verified. */
export function createKwinClient(): KwinClient {
  const notImplemented = (_key: string): Promise<void> => Promise.resolve();
  return { focusWindow: notImplemented, hideWindow: notImplemented };
}
