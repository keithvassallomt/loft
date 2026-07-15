import type { Session } from 'electron';

/**
 * A view that never committed a document sits on about:blank (or ''). This is the
 * ONLY reliable "it didn't load" signature: `did-fail-load` is unusable because
 * ERR_ABORTED fires on healthy redirects too (Slack's /client -> /client/T…/D…
 * supersedes the first navigation and reports ERR_ABORTED, canceled=true).
 * A network failure is deliberately NOT stuck — Chromium commits its own error
 * page with the real URL, and that page is better than anything we'd show.
 */
export function isStuckUrl(url: string): boolean {
  return !url || url === 'about:blank';
}

export interface StuckWatcherDeps {
  timeoutMs: number;
  getUrl(): string;
  onStuck(): void;
  onRecovered(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface StuckWatcher {
  /** Call whenever a load starts (loadURL / reload) — (re)arms the timer. */
  armed(): void;
  /** Call on did-navigate — a real URL disarms and, if we showed recovery, hides it. */
  navigated(url: string): void;
  dispose(): void;
}

export function createStuckWatcher(deps: StuckWatcherDeps): StuckWatcher {
  let handle: unknown;
  let showing = false;

  const clear = (): void => {
    if (handle === undefined) return;
    deps.clearTimer(handle);
    handle = undefined;
  };

  return {
    armed(): void {
      clear();
      handle = deps.setTimer(() => {
        handle = undefined;
        if (!isStuckUrl(deps.getUrl())) return;
        showing = true;
        deps.onStuck();
      }, deps.timeoutMs);
    },
    navigated(url: string): void {
      // A blank "navigation" is not a commit — leave the timer armed.
      if (isStuckUrl(url)) return;
      clear();
      if (!showing) return;
      showing = false;
      deps.onRecovered();
    },
    dispose(): void {
      clear();
    },
  };
}

/**
 * Clear only what can wedge a load: a corrupt/stale service worker and its caches.
 * NEVER cookies/localstorage/indexdb — that is the user's login and the web app's
 * state. Verified live: clearing exactly these restored a wedged Slack while the
 * session stayed signed in.
 */
export async function clearServiceCaches(ses: Session): Promise<void> {
  await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
  await ses.clearCache();
}
