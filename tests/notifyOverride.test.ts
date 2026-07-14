import { describe, it, expect, vi } from 'vitest';
import { installNotificationOverride } from '../src/preload/notify/override';

function fakeEnv() {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  class Orig {
    static permission = 'granted';
    static requestPermission = vi.fn(async () => 'granted');
  }
  const swProto: any = { showNotification: vi.fn() };
  const win: any = {
    Notification: Orig,
    ServiceWorkerRegistration: function () {},
  };
  win.ServiceWorkerRegistration.prototype = swProto;
  const doc: any = {
    _props: {} as Record<string, unknown>,
    dispatchEvent: vi.fn(),
    addEventListener: (t: string, cb: (e: unknown) => void) => { (listeners[t] ||= []).push(cb); },
  };
  return { Orig, win, doc, swProto };
}

// Provide a minimal global Event for the visibilitychange dispatch.
(globalThis as any).Event = (globalThis as any).Event || class { constructor(public type: string) {} };

describe('installNotificationOverride', () => {
  it('relays new Notification() and preserves the Slack prototype invariant', () => {
    const { Orig, win, doc } = fakeEnv();
    const onNotify = vi.fn();
    installNotificationOverride(win, doc, onNotify);

    expect(win.Notification).not.toBe(Orig);
    expect(win.Notification.prototype).toBe(Orig.prototype); // Slack checks this
    expect(win.Notification.name).toBe('Notification');
    expect(String(win.Notification)).toContain('[native code]');
    expect(win.Notification.permission).toBe('granted');

    new win.Notification('Ann', { body: 'hi', icon: 'https://x/a.png', tag: 't1' });
    expect(onNotify).toHaveBeenCalledWith({ title: 'Ann', body: 'hi', icon: 'https://x/a.png', tag: 't1' });
  });

  it('relays showNotification and shows nothing', () => {
    const { win, doc, swProto } = fakeEnv();
    const onNotify = vi.fn();
    installNotificationOverride(win, doc, onNotify);
    win.ServiceWorkerRegistration.prototype.showNotification('Grp', { body: 'yo' });
    expect(onNotify).toHaveBeenCalledWith({ title: 'Grp', body: 'yo', icon: '', tag: '' });
  });

  it('setHidden flips the page visibility and fires visibilitychange', () => {
    const { win, doc } = fakeEnv();
    const h = installNotificationOverride(win, doc, vi.fn());
    expect(doc.visibilityState).toBe('visible');
    expect(doc.hidden).toBe(false);
    h.setHidden(true);
    expect(doc.visibilityState).toBe('hidden');
    expect(doc.hidden).toBe(true);
    expect(doc.dispatchEvent).toHaveBeenCalled();
  });
});
