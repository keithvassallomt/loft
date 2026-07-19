import { describe, it, expect, vi } from 'vitest';
import { startNotifyBridge } from '../src/preload/notify/bridge';
import { MessengerNotifier } from '../src/preload/notify/messenger';
import { TelegramNotifier } from '../src/preload/notify/telegram';

(globalThis as any).Event = (globalThis as any).Event || class { constructor(public type: string) {} };

function fakeEnv() {
  class Orig {
    static permission = 'granted';
    static requestPermission = vi.fn(async () => 'granted');
  }
  const win: any = {
    Notification: Orig,
    ServiceWorkerRegistration: function () {},
    location: { href: 'https://example.test/', },
    // HTMLMediaElement gate + timers touch these; provide inert stand-ins.
    HTMLMediaElement: function () {},
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
  };
  win.ServiceWorkerRegistration.prototype = { showNotification: vi.fn() };
  win.HTMLMediaElement.prototype = { play: function () { return Promise.resolve(); } };
  const handlers: Record<string, (e: unknown, ...a: unknown[]) => void> = {};
  const ipc = {
    send: vi.fn(),
    on: (ch: string, cb: (e: unknown, ...a: unknown[]) => void) => { handlers[ch] = cb; },
  };
  // Minimal DOM: no body yet so the scanners' waitForBody loop parks (we assert
  // the Notification-override routing, which does not depend on the scanner).
  const doc: any = {
    body: null,
    visibilityState: 'visible',
    hidden: false,
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
  };
  return { Orig, win, doc, ipc, handlers };
}

describe('startNotifyBridge routing', () => {
  it('relays a page Notification for slack/whatsapp/element/talk', () => {
    for (const id of ['whatsapp', 'slack', 'element', 'talk']) {
      const { win, doc, ipc } = fakeEnv();
      startNotifyBridge(id, { ipc, win, doc });
      new win.Notification('Ann', { body: 'hi', icon: 'https://x/a.png' });
      const notifyCalls = ipc.send.mock.calls.filter((c) => c[0] === 'service:notify');
      expect(notifyCalls.length, `${id} should relay`).toBe(1);
      expect(notifyCalls[0][1]).toMatchObject({ title: 'Ann', body: 'hi' });
    }
  });

  it('suppresses (does NOT relay) a page Notification for messenger/telegram', () => {
    for (const id of ['messenger', 'telegram']) {
      const { win, doc, ipc } = fakeEnv();
      startNotifyBridge(id, { ipc, win, doc });
      new win.Notification('Ann', { body: 'hi', icon: 'https://x/a.png' });
      const notifyCalls = ipc.send.mock.calls.filter((c) => c[0] === 'service:notify');
      expect(notifyCalls.length, `${id} should be suppression-only`).toBe(0);
    }
  });

  it('routes service:navigate (messenger) to a full-URL fallback when no anchor matches', () => {
    const { win, doc, ipc, handlers } = fakeEnv();
    startNotifyBridge('messenger', { ipc, win, doc });
    doc.querySelector = vi.fn(() => null);
    handlers['service:navigate']({}, '/t/abc');
    expect(win.location.href).toBe('https://www.facebook.com/t/abc');
  });

  it('ignores service:navigate for non-messenger services', () => {
    const { win, doc, ipc, handlers } = fakeEnv();
    const before = win.location.href;
    startNotifyBridge('slack', { ipc, win, doc });
    handlers['service:navigate']?.({}, '/x');
    expect(win.location.href).toBe(before);
  });

  it('routes service:dnd to messenger/telegram/soundGate', () => {
    // Spy on the real prototypes before creating instances
    const messengerSetDndSpy = vi.spyOn(MessengerNotifier.prototype, 'setDnd');
    const telegramSetDndSpy = vi.spyOn(TelegramNotifier.prototype, 'setDnd');

    // Test messenger service: messenger exists, telegram does not
    const { win: win1, doc: doc1, ipc: ipc1, handlers: handlers1 } = fakeEnv();
    startNotifyBridge('messenger', { ipc: ipc1, win: win1, doc: doc1 });
    handlers1['service:dnd']({}, true);
    expect(messengerSetDndSpy).toHaveBeenCalledWith(true);
    expect(telegramSetDndSpy).not.toHaveBeenCalled();

    messengerSetDndSpy.mockClear();
    telegramSetDndSpy.mockClear();

    // Test telegram service: telegram exists, messenger does not
    const { win: win2, doc: doc2, ipc: ipc2, handlers: handlers2 } = fakeEnv();
    startNotifyBridge('telegram', { ipc: ipc2, win: win2, doc: doc2 });
    handlers2['service:dnd']({}, false);
    expect(telegramSetDndSpy).toHaveBeenCalledWith(false);
    expect(messengerSetDndSpy).not.toHaveBeenCalled();

    messengerSetDndSpy.mockRestore();
    telegramSetDndSpy.mockRestore();
  });

  it('routes service:visibility to override and soundGate', () => {
    const { win, doc, ipc, handlers } = fakeEnv();
    startNotifyBridge('slack', { ipc, win, doc });

    // Initially visible
    expect(doc.hidden).toBe(false);
    expect(doc.visibilityState).toBe('visible');

    // Hide via service:visibility handler
    handlers['service:visibility']({}, true);
    expect(doc.hidden).toBe(true);
    expect(doc.visibilityState).toBe('hidden');

    // Show again
    handlers['service:visibility']({}, false);
    expect(doc.hidden).toBe(false);
    expect(doc.visibilityState).toBe('visible');
  });

  it('sends the notifyId out with a relayed notification', () => {
    const { win, doc, ipc } = fakeEnv();
    startNotifyBridge('slack', { ipc, win, doc });
    new win.Notification('Ann', { body: 'hi' });
    const sent = ipc.send.mock.calls.find((c) => c[0] === 'service:notify');
    expect(sent).toBeTruthy();
    expect((sent![1] as { notifyId: number }).notifyId).toEqual(expect.any(Number));
  });

  it('routes service:notify-click into the page handler', () => {
    const { win, doc, ipc, handlers } = fakeEnv();
    startNotifyBridge('slack', { ipc, win, doc });
    const n = new win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    n.onclick = clicked;
    const sent = ipc.send.mock.calls.find((c) => c[0] === 'service:notify')!;
    const { notifyId } = sent[1] as { notifyId: number };
    handlers['service:notify-click']({}, notifyId);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed service:notify-click as inert — no throw, no handler fired', () => {
    // What this actually pins down: a bad payload from main is harmless. It does NOT prove
    // the `typeof notifyId === 'number'` guard does runtime work — without it the id would
    // just miss in the registry's Map and still fire nothing. The guard earns its place by
    // narrowing `unknown` to `number` for the call site, which no runtime test can observe.
    const { win, doc, ipc, handlers } = fakeEnv();
    startNotifyBridge('slack', { ipc, win, doc });
    const n = new win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    n.onclick = clicked;
    expect(() => handlers['service:notify-click']({}, 'nope')).not.toThrow();
    expect(() => handlers['service:notify-click']({}, undefined)).not.toThrow();
    expect(clicked).not.toHaveBeenCalled();
  });
});
