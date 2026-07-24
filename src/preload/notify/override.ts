import { createNotifyRegistry } from './notifyRegistry';

export interface OverrideNotice {
  title: string; body: string; icon: string; tag: string;
  notifyId: number;
  /** Identifies the page life that minted `notifyId` (see `click`). */
  epoch: string;
}
export interface OverrideHandle {
  setHidden(hidden: boolean): void;
  /**
   * Invoke the page's own click handler for a notification we relayed. `epoch` MUST match
   * the page life that minted `notifyId`, or the click is ignored: ids restart at 1 on every
   * document load, while main's pending map is process-lifetime, so a banner posted before a
   * reload would otherwise replay a NEWER notification's handler and open the wrong chat.
   */
  click(notifyId: number, epoch: string): void;
}

/** What we hold on to per notification so its click can be replayed into the page. */
interface Captured {
  instance: unknown;
  /** The `onclick` property, if the app assigned one after construction. */
  onclick?: unknown;
  /** Listeners added via addEventListener('click', …). */
  listeners: unknown[];
  /** WhatsApp's non-standard options.onClick — a fallback, never fired alongside the above. */
  optionsOnClick?: unknown;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function installNotificationOverride(
  win: any, doc: any, onNotify: (n: OverrideNotice) => void,
): OverrideHandle {
  let hidden = false;
  const setHidden = (v: boolean): void => {
    hidden = v;
    try { if (typeof doc.dispatchEvent === 'function' && typeof (globalThis as any).Event === 'function') doc.dispatchEvent(new (globalThis as any).Event('visibilitychange')); } catch { /* ignore */ }
  };

  if (win.__loft_notify_installed) {
    // A no-op click, not the real one: `click` is still in its TDZ here, and with no stored
    // handle there is no registry to replay into anyway. Must satisfy OverrideHandle so a
    // caller in this branch cannot TypeError.
    return (win.__loft_notify_handle as OverrideHandle) ?? { setHidden, click: (): void => {} };
  }
  win.__loft_notify_installed = true;

  const registry = createNotifyRegistry<Captured>();

  // One value per page life. The preload re-runs on every document load, so the registry's
  // ids restart — this is what makes a pre-reload id fail to match instead of colliding.
  const epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const relay = (title: unknown, options: any, notifyId: number): void =>
    onNotify({
      title: String(title ?? ''), body: options?.body ?? '',
      icon: options?.icon ?? '', tag: options?.tag ?? '', notifyId, epoch,
    });

  const Orig = win.Notification;
  function SilentNotification(this: any, title: unknown, options: any = {}) {
    // Keep the object and whatever handler the app attaches to it. Discarding it (as this
    // did before) is why a notification click could never reach the app's own router.
    const self = this ?? {};
    const captured: Captured = { instance: self, listeners: [] };
    if (typeof options?.onClick === 'function') captured.optionsOnClick = options.onClick;
    const notifyId = registry.remember(captured);

    relay(title, options, notifyId);

    // An accessor, so an assignment made AFTER construction still lands in `captured`.
    try {
      Object.defineProperty(self, 'onclick', {
        configurable: true,
        get() { return captured.onclick; },
        set(fn: unknown) { captured.onclick = fn; },
      });
    } catch { /* ignore */ }
    // Same hazard as onclick: these hit Notification.prototype's real setters on a
    // slot-less object and throw "Illegal invocation". An app that sets one BEFORE its
    // onclick would never register a click handler at all. Accept and ignore them.
    for (const prop of ['onshow', 'onclose', 'onerror']) {
      let stored: unknown;
      try {
        Object.defineProperty(self, prop, {
          configurable: true,
          get() { return stored; },
          set(v: unknown) { stored = v; },
        });
      } catch { /* ignore */ }
    }
    self.addEventListener = (type: string, fn: unknown): void => {
      if (type === 'click' && typeof fn === 'function') captured.listeners.push(fn);
    };
    self.removeEventListener = (type: string, fn: unknown): void => {
      if (type !== 'click') return;
      const i = captured.listeners.indexOf(fn);
      if (i >= 0) captured.listeners.splice(i, 1);
    };
    // Deliberately NOT registry.forget(). Our desktop banner outlives the page's object —
    // it is posted with no expiry — and apps routinely close their Notification seconds
    // after showing it, or clear everything on visibilitychange, which our own
    // focus-before-click ordering fires. Evicting here would make the click that follows
    // find nothing. The registry's cap bounds lifetime instead.
    self.close = (): void => { /* no-op: the banner is ours, not the page's */ };
    return self;
  }

  /**
   * Replay a click into the page. NOT dispatchEvent: this object carries
   * Notification.prototype but was never constructed by the real Notification, so it has
   * no internal EventTarget slots and dispatching throws "Illegal invocation" — the same
   * error Slack already provokes against the old dud object.
   */
  const click = (notifyId: number, clickEpoch: string): void => {
    // From a previous page life: its ids have been reused by this one, so acting would
    // misroute. Doing nothing matches what a click on an evicted notification does.
    if (clickEpoch !== epoch) return;
    const c = registry.take(notifyId);
    if (!c) return;
    const event = {
      type: 'click',
      target: c.instance,
      currentTarget: c.instance,
      bubbles: false,
      cancelable: false,
      defaultPrevented: false,
      isTrusted: false,
      composedPath: (): unknown[] => [],
      preventDefault(): void { /* apps call these; they must not throw */ },
      stopPropagation(): void { /* ditto */ },
      stopImmediatePropagation(): void { /* ditto */ },
    };
    const call = (fn: unknown): void => {
      if (typeof fn !== 'function') return;
      try { (fn as (e: unknown) => void).call(c.instance, event); }
      catch (err) { console.error('Loft: notification click handler threw', err); }
    };
    // Standard handlers win. options.onClick is a fallback only — WhatsApp registers both,
    // and firing both would route twice.
    const standard = [c.onclick, ...c.listeners].filter((f) => typeof f === 'function');
    if (standard.length > 0) { for (const fn of standard) call(fn); return; }
    call(c.optionsOnClick);
  };
  if (Orig) {
    (SilentNotification as any).prototype = Orig.prototype; // Slack inspects the prototype
    try { Object.defineProperty(SilentNotification, 'name', { value: 'Notification', configurable: true }); } catch { /* ignore */ }
    (SilentNotification as any).toString = () => 'function Notification() { [native code] }';
    try {
      Object.defineProperty(SilentNotification, 'permission', { get() { return Orig.permission; }, enumerable: true, configurable: true });
    } catch { /* ignore */ }
    (SilentNotification as any).requestPermission = typeof Orig.requestPermission === 'function'
      ? Orig.requestPermission.bind(Orig)
      : async () => 'granted';
    win.Notification = SilentNotification;
  }

  const SWReg = win.ServiceWorkerRegistration;
  if (SWReg && SWReg.prototype) {
    // A service-worker notification has no page object to attach a handler to, so it gets
    // an entry with no handlers: clicking it focuses the window and does nothing more. No
    // service was observed using this path (every one delivers via the page Notification).
    SWReg.prototype.showNotification = function (title: unknown, options: any = {}) {
      relay(title, options, registry.remember({ instance: undefined, listeners: [] }));
      return Promise.resolve();
    };
  }

  try { Object.defineProperty(doc, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible'), configurable: true }); } catch { /* ignore */ }
  try { Object.defineProperty(doc, 'hidden', { get: () => hidden, configurable: true }); } catch { /* ignore */ }

  const handle: OverrideHandle = { setHidden, click };
  win.__loft_notify_handle = handle;
  return handle;
}
