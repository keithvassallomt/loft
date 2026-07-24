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

export interface InitialLoadDeps {
  /** Clear the service's SW + caches (clearServiceCaches). May reject. */
  clearCaches(): Promise<void>;
  /** Navigate the service view to its start URL and arm stuck detection. */
  load(): void;
  /** Report a clear failure (logged; the load proceeds regardless). */
  onError(err: unknown): void;
}

/**
 * Kick off a service window's very first navigation.
 *
 * Most services just load. A `clearFirst` service (Slack) has its persisted service
 * worker + caches cleared BEFORE the first load: Slack's cached SW reliably wedges
 * the /client navigation on cold start — it never commits, so the view sits on
 * about:blank (see createStuckWatcher) and Chromium won't re-run the SW's install to
 * self-heal. A from-scratch registration each launch is the only reliable cure, and
 * clearServiceCaches leaves cookies untouched so the session stays signed in.
 *
 * The load ALWAYS happens — even if the clear rejects — so a failed clear can never
 * strand the window blank. Non-clearing services load synchronously (unchanged).
 */
export function startInitialLoad(clearFirst: boolean, deps: InitialLoadDeps): Promise<void> {
  if (!clearFirst) {
    deps.load();
    return Promise.resolve();
  }
  return deps.clearCaches().catch(deps.onError).then(() => deps.load());
}
