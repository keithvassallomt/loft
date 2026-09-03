// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { startHealthTracker, isDraftElement, type TrackerWin } from '../src/preload/health/tracker';

/** A minimal stand-in for the page's WebSocket, driven by hand. */
class FakeSocket {
  listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string): void { for (const fn of this.listeners.get(type) ?? []) fn(); }
}

function trackerWin(): TrackerWin & { WebSocket: unknown } {
  const W = function (this: FakeSocket) { return new FakeSocket(); } as unknown as typeof WebSocket;
  return { WebSocket: W, navigator: { onLine: true } };
}

/** A clock the test moves by hand, so no assertion depends on real elapsed time. */
function clock(start = 1_000) {
  let now = start;
  return { now: () => now, tick: (ms: number) => { now += ms; } };
}

describe('health tracker', () => {
  it('reports nothing received on a page that has had no traffic', () => {
    const c = clock();
    const t = startHealthTracker(trackerWin(), document, c.now);
    c.tick(60_000);
    const s = t.snapshot();
    expect(s.lastActivityMs).toBeNull();
    expect(s.uptimeMs).toBe(60_000);
    expect(s.everHadSockets).toBe(false);
    expect(s.openSockets).toBe(0);
  });

  it('counts opening a socket as activity', () => {
    const c = clock();
    const win = trackerWin();
    const t = startHealthTracker(win, document, c.now);
    new (win.WebSocket as new (u: string) => unknown)('wss://example.test');
    c.tick(5_000);
    const s = t.snapshot();
    expect(s.lastActivityMs).toBe(5_000);
    expect(s.everHadSockets).toBe(true);
    expect(s.openSockets).toBe(1);
  });

  it('treats every socket message as a fresh sign of life', () => {
    // This is the signal the whole monitor rests on: the keepalive traffic every one of
    // these apps exchanges is invisible to resource timing, so without the wrapper a
    // healthy WhatsApp would look permanently silent.
    const c = clock();
    const win = trackerWin();
    const t = startHealthTracker(win, document, c.now);
    const ws = new (win.WebSocket as new (u: string) => FakeSocket)('wss://example.test');
    c.tick(120_000);
    expect(t.snapshot().lastActivityMs).toBe(120_000);
    ws.emit('message');
    expect(t.snapshot().lastActivityMs).toBe(0);
    c.tick(3_000);
    expect(t.snapshot().lastActivityMs).toBe(3_000);
  });

  it('stops counting a socket once it closes or errors', () => {
    const c = clock();
    const win = trackerWin();
    const t = startHealthTracker(win, document, c.now);
    const a = new (win.WebSocket as new (u: string) => FakeSocket)('wss://a.test');
    const b = new (win.WebSocket as new (u: string) => FakeSocket)('wss://b.test');
    expect(t.snapshot().openSockets).toBe(2);
    a.emit('close');
    expect(t.snapshot().openSockets).toBe(1);
    b.emit('error');
    expect(t.snapshot().openSockets).toBe(0);
    // Still remembered as a socket app, which is what makes "0 open" meaningful.
    expect(t.snapshot().everHadSockets).toBe(true);
  });

  it('keeps the page unable to tell the wrapper apart', () => {
    const win = trackerWin();
    const Real = win.WebSocket;
    startHealthTracker(win, document, () => 0);
    expect(win.WebSocket).not.toBe(Real);
    // `instanceof` and the constructor constants are what page code actually reads off it.
    expect((win.WebSocket as { prototype: unknown }).prototype)
      .toBe((Real as { prototype: unknown }).prototype);
    expect(Object.getPrototypeOf(win.WebSocket)).toBe(Real);
  });

  it('survives a window with no WebSocket or PerformanceObserver at all', () => {
    const c = clock();
    const t = startHealthTracker({}, document, c.now);
    c.tick(1_000);
    expect(t.snapshot()).toMatchObject({ lastActivityMs: null, openSockets: 0, uptimeMs: 1_000 });
  });

  it('reads navigator.onLine', () => {
    expect(startHealthTracker({ navigator: { onLine: false } }, document, () => 0).snapshot().online)
      .toBe(false);
    expect(startHealthTracker({ navigator: { onLine: true } }, document, () => 0).snapshot().online)
      .toBe(true);
  });
});

describe('isDraftElement', () => {
  const el = (html: string): Element => {
    document.body.innerHTML = html;
    return document.body.firstElementChild!;
  };

  it('is false with nothing focused', () => {
    expect(isDraftElement(null)).toBe(false);
  });
  it('is false for a non-editable element', () => {
    expect(isDraftElement(el('<div>hello</div>'))).toBe(false);
  });
  it('is false for an empty composer', () => {
    expect(isDraftElement(el('<div contenteditable="true"></div>'))).toBe(false);
    expect(isDraftElement(el('<div contenteditable="true">   </div>'))).toBe(false);
  });
  it('is true for a composer with something in it', () => {
    // The one thing a reload genuinely destroys — every one of these apps composes in a
    // contenteditable.
    expect(isDraftElement(el('<div contenteditable="true">half a message</div>'))).toBe(true);
  });
  it('handles inputs and textareas by value, not by text', () => {
    const input = el('<input type="text">') as HTMLInputElement;
    expect(isDraftElement(input)).toBe(false);
    input.value = 'searching';
    expect(isDraftElement(input)).toBe(true);
    const ta = el('<textarea></textarea>') as HTMLTextAreaElement;
    ta.value = 'typing';
    expect(isDraftElement(ta)).toBe(true);
  });
  it('ignores input types nobody types prose into', () => {
    // A focused checkbox carries value="on"; that is not a draft.
    const cb = el('<input type="checkbox">') as HTMLInputElement;
    cb.checked = true;
    expect(isDraftElement(cb)).toBe(false);
    expect(isDraftElement(el('<input type="submit" value="Send">'))).toBe(false);
  });
});
