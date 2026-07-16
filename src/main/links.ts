/**
 * Where a link should open: inside the service view (calls, SSO/auth popups, the
 * app's own navigation) or handed to the user's default browser (everything else).
 *
 * Pure decisions only — no electron import — so the whole policy is unit-testable;
 * serviceWindow.ts wires these to setWindowOpenHandler / will-navigate and does the
 * actual shell.openExternal.
 */
export type LinkAction = 'in-app' | 'external';

function originOf(url: string): string | undefined {
  try {
    // Opaque origins (javascript:/data:/blob:) serialize to "null" and must not be
    // classified as cross-origin — they're page-generated, never something to fling
    // to the browser. Treat as unclassifiable (undefined) so callers don't hijack.
    const o = new URL(url).origin;
    return o === 'null' ? undefined : o;
  } catch { return undefined; }
}

/**
 * Same top-level origin? An unparseable TARGET returns true (we never hijack a URL
 * we can't classify — leave it to the page); an unparseable current URL with a real
 * target is not same-origin.
 */
export function isSameOrigin(currentUrl: string, targetUrl: string): boolean {
  const target = originOf(targetUrl);
  if (target === undefined) return true;
  return originOf(currentUrl) === target;
}

/** Schemes we're willing to hand to the OS: pages, plus the obvious mailto/tel. */
export function isExternallyOpenable(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme === 'https:' || scheme === 'http:' || scheme === 'mailto:' || scheme === 'tel:';
  } catch { return false; }
}

/**
 * Messenger shares facebook.com with all of Facebook, so same-origin isn't enough
 * to mean "the app". Keep the messaging surface and the auth flows in-window; a nav
 * to a post / profile / photo / group / etc. is the user leaving Messenger and
 * belongs in the browser. Lenient toward in-app (an unparseable URL, and anything
 * under an auth prefix, stays) so a login can never be flung out to the browser.
 */
export function messengerKeepsInApp(targetUrl: string): boolean {
  let u: URL;
  try { u = new URL(targetUrl); } catch { return true; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return true; // non-web — don't hijack
  const path = u.pathname;
  if (path === '/') return true; // logged-out redirect target — never hijack
  const KEEP = ['/messages', '/e2ee', '/login', '/checkpoint', '/recover', '/two_factor'];
  return KEEP.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '.'));
}

/**
 * A top-level navigation of the service view (will-navigate). Cross-origin leaves;
 * same-origin stays — except Messenger, which additionally must leave when it exits
 * the messaging app (that's Bug 1: a Facebook link replacing the Messenger view).
 */
export function classifyNavigation(serviceId: string, currentUrl: string, targetUrl: string): LinkAction {
  if (!isSameOrigin(currentUrl, targetUrl)) return 'external';
  if (serviceId === 'messenger') return messengerKeepsInApp(targetUrl) ? 'in-app' : 'external';
  return 'in-app';
}

/**
 * A window.open / target=_blank request (setWindowOpenHandler). Send it to the
 * browser only when it's a user-clicked link (a foreground/background tab) AND
 * cross-origin. Everything else stays in-app:
 *   - same-origin popups  -> Messenger opens calls same-origin, so this is what
 *     guarantees a call popup is NEVER flung to the browser, whatever its disposition;
 *   - cross-origin 'new-window'/'other' -> popups opened WITH window features (calls,
 *     most SSO/OAuth), which must stay in Electron to complete.
 *
 * Known gap: a FEATURELESS cross-origin window.open (disposition 'foreground-tab') is
 * indistinguishable from a user clicking a cross-origin link, so it goes to the
 * browser. That's correct for the common case (external links — the whole point) and
 * only wrong for the rare OAuth flow that opens its popup without dimensions.
 */
export function classifyWindowOpen(currentUrl: string, targetUrl: string, disposition: string): LinkAction {
  const tabLike = disposition === 'foreground-tab' || disposition === 'background-tab';
  if (tabLike && !isSameOrigin(currentUrl, targetUrl)) return 'external';
  return 'in-app';
}
