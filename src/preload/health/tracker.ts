import type { HealthSnapshot } from '../../shared/health';

/**
 * Page-side half of the liveness monitor: watch for incoming network data and answer
 * snapshot() with how long ago the last of it arrived.
 *
 * Runs in the service preload, which shares the page's real main world
 * (`contextIsolation: false`) and executes BEFORE any page script — so wrapping WebSocket
 * here catches every socket the web app opens, exactly as the notify bridge already wraps
 * window.Notification.
 *
 * Two sources, because no single one covers all six apps:
 *   - **WebSocket messages** — WhatsApp, Slack, Telegram, Messenger. Sockets are invisible
 *     to resource timing, so without the wrapper those apps look permanently silent.
 *   - **Resource timing** — Element's /sync long-poll and Talk's polling are ordinary HTTP,
 *     which never touches the WebSocket wrapper.
 *
 * Nothing here reads app-specific DOM or knows which service it is in. The obvious
 * alternative — scraping each app's own "Reconnecting…" banner — rots silently: a class
 * name changes, the parser stops matching, and the monitor decides everything is healthy
 * forever.
 */
export interface TrackerWin {
  WebSocket?: unknown;
  PerformanceObserver?: unknown;
  navigator?: { onLine?: boolean };
}

export interface HealthTracker {
  snapshot(): HealthSnapshot;
  /** Note incoming data. Used by the wrappers below, and by tests. */
  touch(): void;
}

/** Is this element one the user could be typing into, with something in it? */
export function isDraftElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    // Buttons, checkboxes and the like carry a `value` that has nothing to do with typing.
    const typed = ['text', 'search', 'email', 'url', 'tel', 'password', ''];
    if (tag === 'input' && !typed.includes(type)) return false;
    return ((el as HTMLInputElement).value ?? '').trim().length > 0;
  }
  // contenteditable — every one of these apps composes in one. isContentEditable already
  // accounts for inheritance; the attribute is the fallback for jsdom, which lacks it.
  const editable = (el as HTMLElement).isContentEditable
    ?? el.getAttribute('contenteditable') === 'true';
  if (!editable) return false;
  return (el.textContent ?? '').trim().length > 0;
}

export function startHealthTracker(
  win: TrackerWin,
  doc: Document,
  now: () => number = () => Date.now(),
): HealthTracker {
  const loadedAt = now();
  let lastActivity: number | null = null;
  let openSockets = 0;
  let everHadSockets = false;

  const touch = (): void => { lastActivity = now(); };

  // --- WebSocket ---------------------------------------------------------------
  // Wrapped rather than observed: no browser API reports "a socket received a message"
  // from the outside. Everything is delegated to the real constructor, so the page cannot
  // tell the difference — the only additions are the listeners below, which never call
  // preventDefault and never touch the event.
  const RealWebSocket = win.WebSocket as (new (...a: unknown[]) => WebSocket) | undefined;
  if (typeof RealWebSocket === 'function') {
    const Wrapped = function (...args: unknown[]): WebSocket {
      const ws = new RealWebSocket(...args);
      everHadSockets = true;
      openSockets += 1;
      touch(); // opening a socket at all means the network answered
      // 'message' is the point of this: it is the keepalive every one of these apps sends.
      ws.addEventListener('message', touch);
      const closed = (): void => { openSockets = Math.max(0, openSockets - 1); };
      ws.addEventListener('close', closed);
      ws.addEventListener('error', closed);
      return ws;
    } as unknown as typeof WebSocket;
    // Keep the shape the page expects: the prototype (so `instanceof` still holds) and the
    // CONNECTING/OPEN/CLOSING/CLOSED constants some libraries read off the constructor.
    Wrapped.prototype = RealWebSocket.prototype;
    Object.setPrototypeOf(Wrapped, RealWebSocket);
    try {
      (win as { WebSocket?: unknown }).WebSocket = Wrapped;
    } catch {
      /* a frozen/readonly global — resource timing alone still covers the polling apps */
    }
  }

  // --- Resource timing ---------------------------------------------------------
  // Covers everything that is not a socket. `buffered: true` picks up entries that landed
  // between the page loading and this observer starting.
  const PO = win.PerformanceObserver as
    (new (cb: (list: { getEntries(): unknown[] }) => void) => { observe(o: unknown): void }) | undefined;
  if (typeof PO === 'function') {
    try {
      new PO((list) => { if (list.getEntries().length) touch(); })
        .observe({ type: 'resource', buffered: true });
    } catch {
      /* unsupported entry type — the socket wrapper still covers the socket apps */
    }
  }

  return {
    touch,
    snapshot: (): HealthSnapshot => ({
      lastActivityMs: lastActivity === null ? null : now() - lastActivity,
      openSockets,
      everHadSockets,
      uptimeMs: now() - loadedAt,
      hasDraft: isDraftElement(doc.activeElement),
      online: win.navigator?.onLine !== false,
    }),
  };
}
