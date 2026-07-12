import { describe, it, expect, vi } from 'vitest';
import {
  shouldAllowSound, installNotificationSoundGate, GESTURE_WINDOW_MS, type MediaLike,
} from '../src/preload/notify/notificationSound';

const audio = (over: Partial<MediaLike> = {}): MediaLike => ({ muted: false, loop: false, srcObject: null, ...over });

describe('shouldAllowSound', () => {
  const away = { dnd: false, hidden: true, msSinceGesture: Infinity }; // Loft would notify

  it('gates an autoplayed notification ding by DND + focus (allow only when away & not DND)', () => {
    expect(shouldAllowSound(audio(), away)).toBe(true); // unfocused + not DND → the ding is the notification
    expect(shouldAllowSound(audio(), { ...away, dnd: true })).toBe(false); // DND → silent
    expect(shouldAllowSound(audio(), { ...away, hidden: false })).toBe(false); // focused+visible → silent
  });

  it('always allows non-notification audio', () => {
    const gated = { dnd: true, hidden: false, msSinceGesture: Infinity }; // would otherwise be blocked
    expect(shouldAllowSound(audio({ muted: true }), gated)).toBe(true); // already silent (incl. muted autoplay video)
    expect(shouldAllowSound(audio({ srcObject: {} }), gated)).toBe(true); // WebRTC call stream
    expect(shouldAllowSound(audio({ loop: true }), gated)).toBe(true); // ringtone / looping media
    expect(shouldAllowSound(audio(), { ...gated, msSinceGesture: GESTURE_WINDOW_MS - 1 })).toBe(true); // user-initiated
  });

  it('treats a play just past the gesture window as autoplay', () => {
    const gated = { dnd: true, hidden: false, msSinceGesture: GESTURE_WINDOW_MS + 1 };
    expect(shouldAllowSound(audio(), gated)).toBe(false);
  });
});

describe('installNotificationSoundGate', () => {
  function fakeWin() {
    const listeners: Record<string, Array<(e?: unknown) => void>> = {};
    class HTMLMediaElement {
      muted = false; loop = false; srcObject: unknown = null;
      static _origCalls = 0;
      play(): Promise<void> { HTMLMediaElement._origCalls++; return Promise.resolve(); }
    }
    const win: any = {
      HTMLMediaElement,
      addEventListener: (t: string, cb: (e?: unknown) => void) => { (listeners[t] ||= []).push(cb); },
      _fire: (t: string, e?: unknown) => { for (const cb of listeners[t] || []) cb(e); },
    };
    return { win, HTMLMediaElement };
  }

  it('swallows a gated ding but still plays it when Loft would notify', async () => {
    let t = 10_000;
    const { win, HTMLMediaElement } = fakeWin();
    const gate = installNotificationSoundGate(win, () => t);
    const el = new HTMLMediaElement();
    const before = HTMLMediaElement._origCalls;

    gate.setDnd(false); gate.setHidden(true); // away, not DND → allow
    await el.play();
    expect(HTMLMediaElement._origCalls).toBe(before + 1);

    gate.setDnd(true); // DND → swallow
    await el.play();
    expect(HTMLMediaElement._origCalls).toBe(before + 1); // origPlay NOT called again

    gate.setDnd(false); gate.setHidden(false); // focused+visible → swallow
    await el.play();
    expect(HTMLMediaElement._origCalls).toBe(before + 1);
  });

  it('allows a play right after a click gesture even under DND', async () => {
    let t = 10_000;
    const { win, HTMLMediaElement } = fakeWin();
    const gate = installNotificationSoundGate(win, () => t);
    gate.setDnd(true); gate.setHidden(false); // would otherwise gate
    const el = new HTMLMediaElement();
    const before = HTMLMediaElement._origCalls;

    win._fire('pointerdown'); // gesture at t=10_000
    t = 10_500; // 500ms later → within window
    await el.play();
    expect(HTMLMediaElement._origCalls).toBe(before + 1); // user-initiated → played
  });

  it('allows Enter/Space activating a control (keyboard a11y) but NOT typing', async () => {
    let t = 10_000;
    const { win, HTMLMediaElement } = fakeWin();
    const gate = installNotificationSoundGate(win, () => t);
    gate.setDnd(false); gate.setHidden(false); // focused+visible → dings gated
    const el = new HTMLMediaElement();

    // Typing a reply in the compose box must NOT create a media gesture.
    const beforeType = HTMLMediaElement._origCalls;
    win._fire('keydown', { key: 'a', target: { tagName: 'DIV', isContentEditable: true } });
    win._fire('keydown', { key: 'Enter', target: { tagName: 'DIV', isContentEditable: true } }); // Enter-to-send
    t = 10_050;
    await el.play(); // an incoming ding right after a keystroke
    expect(HTMLMediaElement._origCalls).toBe(beforeType); // still gated — no ride-along ding

    // Enter/Space activating a real control (e.g. a play button) IS a gesture.
    win._fire('keydown', { key: 'Enter', target: { tagName: 'BUTTON' } });
    t = 10_100;
    await el.play();
    expect(HTMLMediaElement._origCalls).toBe(beforeType + 1); // played
  });
});
