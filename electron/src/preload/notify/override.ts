export interface OverrideNotice { title: string; body: string; icon: string; tag: string }
export interface OverrideHandle { setHidden(hidden: boolean): void }

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
    return (win.__loft_notify_handle as OverrideHandle) ?? { setHidden };
  }
  win.__loft_notify_installed = true;

  const relay = (title: unknown, options: any): void =>
    onNotify({ title: String(title ?? ''), body: options?.body ?? '', icon: options?.icon ?? '', tag: options?.tag ?? '' });

  const Orig = win.Notification;
  function SilentNotification(this: unknown, title: unknown, options: any = {}) { relay(title, options); }
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
    SWReg.prototype.showNotification = function (title: unknown, options: any = {}) { relay(title, options); return Promise.resolve(); };
  }

  try { Object.defineProperty(doc, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible'), configurable: true }); } catch { /* ignore */ }
  try { Object.defineProperty(doc, 'hidden', { get: () => hidden, configurable: true }); } catch { /* ignore */ }

  const handle: OverrideHandle = { setHidden };
  win.__loft_notify_handle = handle;
  return handle;
}
