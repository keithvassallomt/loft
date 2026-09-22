// Gates a web app's OWN notification/UI sound (e.g. Messenger's incoming-message
// "ding", played by the page itself) so it follows Loft's notification policy
// instead of firing on every message. Runs in the service view's main-world
// preload (contextIsolation: false), wrapping the two ways a page can make a
// sound: HTMLMediaElement.play and the Web Audio API.
//
// BOTH paths are needed, and which one an app uses is not something you can
// guess from the app: Messenger, Telegram and NextCloud Talk all reach for an
// <audio> element (`new Audio(url).play()`), while ELEMENT decodes the sound
// into an AudioBuffer and fires it through an AudioBufferSourceNode
// (`src/audio/BackgroundAudio.ts` upstream). Element's ding therefore never
// touches HTMLMediaElement at all, and for as long as this file only wrapped
// play() its DND setting silenced the banner but not the sound.
//
// Discovered via instrumentation: Messenger plays `…/lvSDckxyoU5.ogg` from its
// own JS on every incoming message, regardless of focus/visibility — untouched
// by our Notification interception or the visibility override. These wrappers
// are the only lever that reaches either path.

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

/** An AudioBufferSourceNode as far as the gate cares — kept minimal so it's unit-testable. */
export interface BufferSourceLike {
  loop: boolean;
  buffer: { duration: number } | null;
  disconnect(): void;
}

/**
 * Longest buffer we will treat as a notification ding. Anything longer is content — a voice
 * message, a video's audio track, a call recording — and is never gated, however it was
 * started. This is the Web Audio path's substitute for the `srcObject` check on the media
 * path: a decoded AudioBuffer carries no hint of what it IS, so length is the only signal
 * left, and the gesture window alone is too tight to lean on (decoding a long voice message
 * can push `start()` well past a second after the click that asked for it).
 */
export const MAX_DING_SECONDS = 10;

/**
 * Should this `AudioBufferSourceNode.start()` be allowed to reach the speakers?
 *
 * Same shape of judgement as `shouldAllowSound`, against what a Web Audio node can tell us:
 * looping nodes are ringtones, long buffers are content, and anything fired right after a
 * user gesture was asked for. What remains — a short one-shot buffer fired with no gesture —
 * is a notification/UI sound, gated by the SAME rule as the desktop banner.
 */
export function shouldAllowBufferSound(node: BufferSourceLike, s: SoundState): boolean {
  if (node.loop) return true;
  // No buffer = nothing to hear; leave the page's own error path alone.
  const duration = node.buffer?.duration;
  if (duration === undefined || duration > MAX_DING_SECONDS) return true;
  if (s.msSinceGesture < GESTURE_WINDOW_MS) return true;
  return !s.dnd && s.hidden;
}

export interface SoundGate {
  setDnd(v: boolean): void;
  setHidden(v: boolean): void;
}

/**
 * Install the notification-sound gate on `win.HTMLMediaElement.prototype.play` and on
 * `win.AudioBufferSourceNode.prototype.start`.
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

  // The Web Audio path. Unlike play(), a gated start() must still HAPPEN: the page's own
  // bookkeeping hangs off the node running to completion — Element's BackgroundAudio
  // decrements a counter in `onended` and only suspends its shared AudioContext when that
  // counter reaches zero, so a start() we simply skipped would leave the context running for
  // the rest of the session and every later sound counted as still playing. Detaching the
  // node from the graph instead costs nothing: the buffer plays out and `ended` fires on
  // schedule, it just reaches no output. Pages connect before they start (they must, or the
  // first frames are lost), so disconnecting here is not a race.
  const BufferSource = win.AudioBufferSourceNode;
  if (BufferSource && BufferSource.prototype && typeof BufferSource.prototype.start === 'function') {
    const origStart = BufferSource.prototype.start;
    BufferSource.prototype.start = function (this: BufferSourceLike, ...args: any[]) {
      const allow = shouldAllowBufferSound(this, { dnd, hidden, msSinceGesture: now() - lastGesture });
      if (!allow) {
        try { this.disconnect(); } catch { /* never connected — nothing to detach */ }
      }
      return origStart.apply(this, args);
    };
  }

  return {
    setDnd: (v: boolean) => { dnd = v; },
    setHidden: (v: boolean) => { hidden = v; },
  };
}
