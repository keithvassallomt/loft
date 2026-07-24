/**
 * Developer context menu (Settings → Developer mode). Electron shows no context menu of
 * its own — the web app's own JS owns right-clicks — so a plain right-click is left
 * untouched and only Shift+right-click (Chrome's own "force the browser menu" gesture) is
 * intercepted and relayed to main, which pops the menu (inspect element / DevTools).
 *
 * The modifier is not carried on Electron's main-process `context-menu` event, but it IS on
 * the DOM event, and this runs in the service view's main-world preload — so reading
 * `e.shiftKey` here is exact, and the capture-phase listener fires before (and suppresses)
 * the page's own handler. Gated on `enabled`, pushed from main over `service:debug`, so with
 * developer mode off this is inert and every right-click reaches the page normally.
 */
export interface ContextMenuBridgeDeps {
  ipc: {
    send(ch: string, ...a: unknown[]): void;
    on(ch: string, cb: (e: unknown, ...a: unknown[]) => void): void;
  };
  doc: Pick<Document, 'addEventListener'>;
}

export function startContextMenuBridge(deps: ContextMenuBridgeDeps): void {
  const { ipc, doc } = deps;
  let enabled = false;

  ipc.on('service:debug', (_e: unknown, v?: unknown) => { enabled = !!v; });

  doc.addEventListener(
    'contextmenu',
    (e: Event) => {
      const me = e as MouseEvent;
      if (!enabled || !me.shiftKey) return;
      // Suppress the page's own context menu and hand main the click position, in the
      // page's CSS-pixel space, for inspectElement(x, y). stopImmediatePropagation (not just
      // stopPropagation): a page that also listens on document in capture phase would still
      // render its own menu otherwise — we run at document_start, so we are the first listener
      // and can block the rest.
      e.preventDefault();
      e.stopImmediatePropagation();
      ipc.send('service:context-menu', { x: Math.round(me.clientX), y: Math.round(me.clientY) });
    },
    true, // capture: run before the page's listeners so stopPropagation actually suppresses them
  );
}
