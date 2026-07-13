import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startNotifyBridge } from '../src/preload/notify/bridge';

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
});
