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
    expect(onNotify).toHaveBeenCalledWith(
      { title: 'Ann', body: 'hi', icon: 'https://x/a.png', tag: 't1', notifyId: expect.any(Number), epoch: expect.any(String) },
    );
  });

  it('relays showNotification and shows nothing', () => {
    const { win, doc, swProto } = fakeEnv();
    const onNotify = vi.fn();
    installNotificationOverride(win, doc, onNotify);
    win.ServiceWorkerRegistration.prototype.showNotification('Grp', { body: 'yo' });
    expect(onNotify).toHaveBeenCalledWith(
      { title: 'Grp', body: 'yo', icon: '', tag: '', notifyId: expect.any(Number), epoch: expect.any(String) },
    );
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

  // Reaches the notifyId the override minted for the most recent notification.
  const lastNotifyId = (onNotify: { mock: { calls: unknown[][] } }): number =>
    (onNotify.mock.calls[onNotify.mock.calls.length - 1][0] as { notifyId: number }).notifyId;

  const lastEpoch = (onNotify: { mock: { calls: unknown[][] } }): string =>
    (onNotify.mock.calls[onNotify.mock.calls.length - 1][0] as { epoch: string }).epoch;

  it('invokes an onclick the page assigned after construction', () => {
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    n.onclick = clicked;
    h.click(lastNotifyId(onNotify), lastEpoch(onNotify));
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('reads back the onclick the page assigned', () => {
    // The accessor stores into the captured record; reading must return the same function,
    // because apps commonly check or re-wrap their own handler.
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    n.onclick = clicked;
    expect(n.onclick).toBe(clicked);
  });

  it('invokes click listeners added with addEventListener', () => {
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    n.addEventListener('click', clicked);
    n.addEventListener('close', vi.fn()); // a non-click listener must not be invoked
    h.click(lastNotifyId(onNotify), lastEpoch(onNotify));
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('falls back to a non-standard options.onClick when nothing standard was registered', () => {
    // WhatsApp hands its own router in the options object rather than attaching it.
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const optionClick = vi.fn();
    new win.Notification('Ann', { body: 'hi', onClick: optionClick });
    h.click(lastNotifyId(onNotify), lastEpoch(onNotify));
    expect(optionClick).toHaveBeenCalledTimes(1);
  });

  it('prefers standard handlers and does NOT also fire options.onClick', () => {
    // WhatsApp registers BOTH; invoking both would route twice.
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const optionClick = vi.fn();
    const listener = vi.fn();
    const n = new win.Notification('Ann', { body: 'hi', onClick: optionClick });
    n.addEventListener('click', listener);
    h.click(lastNotifyId(onNotify), lastEpoch(onNotify));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(optionClick).not.toHaveBeenCalled();
  });

  it('passes an event whose preventDefault/stopPropagation are safe to call', () => {
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    let seen: { type?: string } = {};
    n.onclick = (e: { type: string; preventDefault(): void; stopPropagation(): void }) => {
      e.preventDefault();
      e.stopPropagation();
      seen = e;
    };
    expect(() => h.click(lastNotifyId(onNotify), lastEpoch(onNotify))).not.toThrow();
    expect(seen.type).toBe('click');
  });

  it('contains a handler that throws, and logs it', () => {
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    n.onclick = () => { throw new Error('boom'); };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => h.click(lastNotifyId(onNotify), lastEpoch(onNotify))).not.toThrow();
      // Swallowing silently would hide a real page bug from anyone debugging it.
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('does nothing for an unknown id, and only fires a handler once', () => {
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    n.onclick = clicked;
    const id = lastNotifyId(onNotify);
    const ep = lastEpoch(onNotify);
    h.click(id, ep);
    h.click(id, ep);       // the entry was taken by the first click
    h.click(123456, ep);   // never issued
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('ignores a click whose epoch is from a previous page life', () => {
    // The registry restarts at 1 on every document load, so a pre-reload id would otherwise
    // collide with a new notification's and open the WRONG conversation.
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    n.onclick = clicked;
    h.click(lastNotifyId(onNotify), 'some-older-page-life');
    expect(clicked).not.toHaveBeenCalled();
  });

  it('still routes a click after the page closed the notification', () => {
    // Our banner outlives the page's object, and apps auto-close theirs routinely.
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    n.onclick = clicked;
    n.close();
    h.click(lastNotifyId(onNotify), lastEpoch(onNotify));
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('accepts onshow/onclose/onerror so they cannot abort the app\'s setup', () => {
    // An app setting onshow BEFORE onclick would otherwise throw and never register a
    // click handler at all.
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    expect(() => {
      n.onshow = () => {};
      n.onclose = () => {};
      n.onerror = () => {};
      n.onclick = clicked;
    }).not.toThrow();
    h.click(lastNotifyId(onNotify), lastEpoch(onNotify));
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('gives handlers an event whose propagation methods are all safe to call', () => {
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    n.onclick = (e: { stopImmediatePropagation(): void; composedPath(): unknown[] }) => {
      e.stopImmediatePropagation();
      e.composedPath();
    };
    expect(() => h.click(lastNotifyId(onNotify), lastEpoch(onNotify))).not.toThrow();
  });
});
