import { describe, it, expect, vi } from 'vitest';
import { startContextMenuBridge } from '../src/preload/contextMenu';

function fakeIpc() {
  const sent: Array<[string, unknown]> = [];
  const listeners = new Map<string, (e: unknown, ...a: unknown[]) => void>();
  return {
    sent,
    listeners,
    send: (ch: string, payload: unknown) => { sent.push([ch, payload]); },
    on(ch: string, cb: (e: unknown, ...a: unknown[]) => void) { listeners.set(ch, cb); },
  };
}

/** Captures the one contextmenu listener the bridge registers so tests can fire it. */
function fakeDoc() {
  let handler: ((e: Event) => void) | undefined;
  return {
    fire: (e: Partial<MouseEvent>) => handler?.(e as Event),
    addEventListener(type: string, cb: (e: Event) => void, opts?: unknown) {
      expect(type).toBe('contextmenu');
      expect(opts).toBe(true); // capture phase — must beat the page's own handlers
      handler = cb;
    },
  };
}

function mouseEvent(over: Partial<MouseEvent>) {
  const e = { preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...over };
  return e as unknown as MouseEvent & { preventDefault: ReturnType<typeof vi.fn>; stopImmediatePropagation: ReturnType<typeof vi.fn> };
}

describe('developer context-menu bridge', () => {
  it('does nothing until developer mode is pushed on', () => {
    const ipc = fakeIpc();
    const doc = fakeDoc();
    startContextMenuBridge({ ipc: ipc as never, doc: doc as never });

    const e = mouseEvent({ shiftKey: true, clientX: 4, clientY: 5 });
    doc.fire(e);
    expect(ipc.sent).toEqual([]);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('forwards the click position and suppresses the page menu on Shift+right-click when enabled', () => {
    const ipc = fakeIpc();
    const doc = fakeDoc();
    startContextMenuBridge({ ipc: ipc as never, doc: doc as never });
    ipc.listeners.get('service:debug')!(null, true);

    const e = mouseEvent({ shiftKey: true, clientX: 12.6, clientY: 30.2 });
    doc.fire(e);

    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
    expect(ipc.sent).toEqual([['service:context-menu', { x: 13, y: 30 }]]);
  });

  it('leaves a plain (no-Shift) right-click for the page', () => {
    const ipc = fakeIpc();
    const doc = fakeDoc();
    startContextMenuBridge({ ipc: ipc as never, doc: doc as never });
    ipc.listeners.get('service:debug')!(null, true);

    const e = mouseEvent({ shiftKey: false, clientX: 1, clientY: 2 });
    doc.fire(e);

    expect(ipc.sent).toEqual([]);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('stops intercepting once developer mode is pushed back off', () => {
    const ipc = fakeIpc();
    const doc = fakeDoc();
    startContextMenuBridge({ ipc: ipc as never, doc: doc as never });
    ipc.listeners.get('service:debug')!(null, true);
    ipc.listeners.get('service:debug')!(null, false);

    const e = mouseEvent({ shiftKey: true, clientX: 1, clientY: 2 });
    doc.fire(e);

    expect(ipc.sent).toEqual([]);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
