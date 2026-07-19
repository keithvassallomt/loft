/**
 * Everything tray, D-Bus and notifications need from *wherever* a service lives.
 *
 * Implemented today only by the per-service window; in plan 09b the Loft window
 * implements it per attached service, so `Show()` on an attached service means
 * "raise Loft and select that tab" while the caller stays none the wiser. That
 * indifference is the whole point — consumers must never branch on where a
 * service lives.
 *
 * Deliberately excludes anything window-shaped (BrowserWindow, titlebar, bounds):
 * the moment one leaks in, the Loft window can't satisfy this and the abstraction
 * is dead. There is no test for that — 09b's loftWindow is the enforcement, by
 * being the second implementer. Keep this interface window-free by hand until then.
 */
import type { ServiceDef } from './registry';

export interface ServiceHost {
  /** Which service this host is showing. A rail entry has an id and a display name
   *  just as a window does — this is not window-shaped. */
  readonly def: ServiceDef;
  /** Is this service actually on screen? For a shared host that means the window is
   *  shown AND this service is the selected tab — an unselected tab is not visible.
   *  Callers must never reach for `.window.isVisible()`: that returns false (it does
   *  not throw) for a service with no window of its own, silently reporting an open
   *  service as hidden. */
  isVisible(): boolean;
  /** Show and focus this service — raising its window, and selecting it if it shares one. */
  show(): void;
  /** Hide this service. For a shared host, hides the whole window (spec 09 §6b). */
  hide(): void;
  /** Adjust zoom by delta (clamped 0.3–3.0), apply, and persist. */
  setZoom(delta: number): void;
  /** Reflect the unread count wherever this service's title is shown. */
  setBadge(count: number): void;
  /** Push Do Not Disturb to the page (gates Notification-API relays). */
  pushDnd(enabled: boolean): void;
  /** Tell the page whether it is hidden (drives document.hidden/visibilityState). */
  pushHidden(hidden: boolean): void;
  /** Ask the page to navigate to a conversation (notification click). */
  navigate(url: string): void;
  /** Replay a notification click into the page's own handler (notification click). */
  notifyClick(notifyId: number, epoch: string): void;
  /** Navigate, hiding any stale recovery overlay and re-arming stuck detection. */
  loadUrl(url: string): void;
  /** Reload and re-arm stuck detection. */
  reload(): void;
  /** Clear the service's caches (never cookies), then reload. */
  clearAndReload(): Promise<void>;
  /** True if the given webContents id belongs to this service's chrome or page. */
  ownsWebContents(id: number): boolean;
}
