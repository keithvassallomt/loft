// Gates a web app's OWN notification/UI sound (e.g. Messenger's incoming-message
// "ding", played by the page itself via an <audio> element) so it follows Loft's
// notification policy instead of firing on every message. Runs in the service
// view's main-world preload (contextIsolation: false), wrapping the page's
// HTMLMediaElement.play.
//
// Discovered via instrumentation: Messenger plays `…/lvSDckxyoU5.ogg` from its
// own JS on every incoming message, regardless of focus/visibility — untouched
// by our Notification interception or the visibility override. This is the only
// lever that reaches it.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** How recently a real user gesture counts a play() as user-initiated (voice message / video). */
export const GESTURE_WINDOW_MS = 1000;

export interface SoundState {
  /** Effective DND for this service (system || global || per-service). */
  dnd: boolean;
  /** Page is hidden = the window is not focused+visible (mirrors what main pushes). */
  hidden: boolean;
  /** Milliseconds since the last real user gesture (Infinity if none yet). */
  msSinceGesture: number;
}

/** A media element as far as the gate cares — kept minimal so it's unit-testable. */
export interface MediaLike {
  muted: boolean;
  loop: boolean;
  srcObject: unknown;
}

/**
 * Should this media `play()` be allowed to make sound?
 *
 * Everything that isn't an autoplayed notification ding is allowed: already-muted
 * elements (incl. muted autoplay videos), WebRTC streams (calls), looping media
 * (ringtones), and anything played right after a user gesture (voice messages,
 * clicked videos). What remains — a short, non-looping, un-muted sound that
 * autoplays with no user gesture — is a notification/UI sound, so it's gated by
 * the SAME rule as the desktop banner: play only when Loft would notify anyway
 * (not DND and the window isn't focused+visible).
 */
export function shouldAllowSound(el: MediaLike, s: SoundState): boolean {
  if (el.muted) return true;
  if (el.srcObject) return true;
  if (el.loop) return true;
  if (s.msSinceGesture < GESTURE_WINDOW_MS) return true;
  return !s.dnd && s.hidden;
}

export interface SoundGate {
  setDnd(v: boolean): void;
  setHidden(v: boolean): void;
}

/**
 * Install the notification-sound gate on `win.HTMLMediaElement.prototype.play`.
 * Returns handles to push the current DND / hidden state (fed from the bridge's
 * `service:dnd` / `service:visibility` IPC).
 */
export function installNotificationSoundGate(
  win: any,
  now: () => number = () => Date.now(),
): SoundGate {
  let dnd = false;
  let hidden = false;
  let lastGesture = -Infinity;

  const markGesture = (): void => { lastGesture = now(); };
  for (const ev of ['pointerdown', 'mousedown', 'touchstart']) {
    try { win.addEventListener(ev, markGesture, true); } catch { /* ignore */ }
  }
  // Keyboard: only Enter/Space ACTIVATING a control (e.g. a voice-message play
  // button — keyboard a11y) counts as a media gesture. Typing in a compose box
  // (or Enter-to-send) must NOT, or an incoming ding could ride a keystroke and
  // play while you're replying in the focused, active chat.
  const isEditable = (t: any): boolean =>
    !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true);
  try {
    win.addEventListener('keydown', (e: any) => {
      const k = e && e.key;
      if ((k === 'Enter' || k === ' ' || k === 'Spacebar') && !isEditable(e && e.target)) markGesture();
    }, true);
  } catch { /* ignore */ }

  const MediaEl = win.HTMLMediaElement;
  if (MediaEl && MediaEl.prototype && typeof MediaEl.prototype.play === 'function') {
    const origPlay = MediaEl.prototype.play;
    MediaEl.prototype.play = function (this: MediaLike, ...args: any[]) {
      const allow = shouldAllowSound(this, { dnd, hidden, msSinceGesture: now() - lastGesture });
      // Swallow a gated ding: resolve like a successful (no-op) play so page code
      // that awaits play() doesn't error.
      if (!allow) return Promise.resolve();
      return origPlay.apply(this, args);
    };
  }

  return {
    setDnd: (v: boolean) => { dnd = v; },
    setHidden: (v: boolean) => { hidden = v; },
  };
}
