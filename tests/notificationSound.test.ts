import { describe, it, expect, vi } from 'vitest';
import {
  shouldAllowSound, shouldAllowBufferSound, installNotificationSoundGate,
  GESTURE_WINDOW_MS, MAX_DING_SECONDS, type MediaLike, type BufferSourceLike,
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

const bufferSource = (over: Partial<BufferSourceLike> = {}): BufferSourceLike => ({
  loop: false, buffer: { duration: 1 }, disconnect: () => {}, ...over,
});

describe('shouldAllowBufferSound', () => {
  const away = { dnd: false, hidden: true, msSinceGesture: Infinity }; // Loft would notify

  // Element plays its ding through Web Audio, not an <audio> element, so this path is the
  // only thing between its DND setting and a sound on every message.
  it('gates a one-shot buffer by DND + focus, like the media path', () => {
    expect(shouldAllowBufferSound(bufferSource(), away)).toBe(true);
    expect(shouldAllowBufferSound(bufferSource(), { ...away, dnd: true })).toBe(false);
    expect(shouldAllowBufferSound(bufferSource(), { ...away, hidden: false })).toBe(false);
  });

  it('always allows what is not a ding', () => {
    const gated = { dnd: true, hidden: false, msSinceGesture: Infinity };
    expect(shouldAllowBufferSound(bufferSource({ loop: true }), gated)).toBe(true); // ringtone
    expect(shouldAllowBufferSound(bufferSource({ buffer: null }), gated)).toBe(true); // nothing to hear
    // Longer than any ding = content (a voice message), whose decode can outlast the gesture window.
    const long = { duration: MAX_DING_SECONDS + 1 };
    expect(shouldAllowBufferSound(bufferSource({ buffer: long }), gated)).toBe(true);
    expect(shouldAllowBufferSound(bufferSource(), { ...gated, msSinceGesture: GESTURE_WINDOW_MS - 1 })).toBe(true);
  });
});

describe('installNotificationSoundGate — Web Audio path', () => {
  function fakeWin() {
    const listeners: Record<string, Array<(e?: unknown) => void>> = {};
    class AudioBufferSourceNode {
      loop = false;
      buffer: { duration: number } | null = { duration: 1 };
      disconnected = 0;
      started = 0;
      disconnect(): void { this.disconnected++; }
      start(): void { this.started++; }
    }
    const win: any = {
      AudioBufferSourceNode,
      addEventListener: (t: string, cb: (e?: unknown) => void) => { (listeners[t] ||= []).push(cb); },
      _fire: (t: string, e?: unknown) => { for (const cb of listeners[t] || []) cb(e); },
    };
    return { win, AudioBufferSourceNode };
  }

  it('detaches a gated ding from the graph but still starts it', () => {
    let t = 10_000;
    const { win, AudioBufferSourceNode } = fakeWin();
    const gate = installNotificationSoundGate(win, () => t);

    gate.setDnd(false); gate.setHidden(true); // away, not DND → the ding IS the notification
    const heard = new AudioBufferSourceNode();
    heard.start();
    expect(heard.started).toBe(1);
    expect(heard.disconnected).toBe(0);

    gate.setDnd(true); // DND → silent
    const silenced = new AudioBufferSourceNode();
    silenced.start();
    // start() must still happen: the page's own bookkeeping hangs off `ended` firing
    // (Element only suspends its shared AudioContext once its play counter drains).
    expect(silenced.started).toBe(1);
    expect(silenced.disconnected).toBe(1);
  });

  it('leaves a ringtone connected under DND', () => {
    const { win, AudioBufferSourceNode } = fakeWin();
    const gate = installNotificationSoundGate(win, () => 10_000);
    gate.setDnd(true); gate.setHidden(false);

    const ring = new AudioBufferSourceNode();
    ring.loop = true;
    ring.start();
    expect(ring.started).toBe(1);
    expect(ring.disconnected).toBe(0);
  });
});
