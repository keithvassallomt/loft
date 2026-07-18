export type NavigateAction =
  | { kind: 'click' }
  | { kind: 'href'; url: string }
  | { kind: 'hash'; url: string }
  | { kind: 'none' };

/** How to act on a notification-click navigation. The chat row is a live `<a href>` for both
 *  Messenger and Telegram, so an anchor match is the shared path; otherwise a per-service
 *  fallback (Messenger → full facebook nav, Telegram → hash route, anything else → nothing). */
export function navigateAction(serviceId: string, url: string, hasAnchor: boolean): NavigateAction {
  if (hasAnchor) return { kind: 'click' };
  if (serviceId === 'messenger') return { kind: 'href', url: `https://www.facebook.com${url}` };
  if (serviceId === 'telegram') return url.startsWith('#') ? { kind: 'hash', url } : { kind: 'none' };
  return { kind: 'none' };
}
