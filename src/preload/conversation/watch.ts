import { CONVERSATION_ADAPTERS, type CapturedConversation } from './adapters';

export interface WatchDeps {
  doc: Document;
  win: Window;
  send(conversation: CapturedConversation | null): void;
}

/** Same cadence the badge scanner uses — see src/preload/badge/scanner.ts. */
const DEBOUNCE_MS = 500;
const POLL_MS = 2000;
const FIRST_SCAN_MS = 3000;
const BODY_POLL_MS = 500;

export function sameConversation(
  a: CapturedConversation | null, b: CapturedConversation | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.key === b.key && a.title === b.title && a.avatarUrl === b.avatarUrl;
}

/**
 * Report the open conversation whenever it changes.
 *
 * Pushed continuously rather than fetched on demand at pin time, which buys three things
 * from one mechanism: pinning needs no request/response round trip, the titlebar pin button
 * knows whether to be enabled, and an already-pinned conversation observed open gets its
 * title refreshed — so a renamed group stops showing a stale label with no extra code.
 */
export function startConversationWatch(kind: string, deps: WatchDeps): void {
  const adapter = CONVERSATION_ADAPTERS[kind];
  if (!adapter) return; // a kind with no adapter simply has no bubbles

  let last: CapturedConversation | null = null;
  let reported = false;

  const scan = (): void => {
    let next: CapturedConversation | null = null;
    // A page mid-navigation can make any adapter throw. That is an ordinary transient, not
    // an error: report "nothing open" and let the next tick correct it.
    try { next = adapter.capture(deps.doc, deps.win); } catch { next = null; }
    if (reported && sameConversation(last, next)) return;
    reported = true;
    last = next;
    deps.send(next);
  };

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const onMutation = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(scan, DEBOUNCE_MS);
  };

  const start = (): void => {
    if (!deps.doc.body) { setTimeout(start, BODY_POLL_MS); return; }
    new MutationObserver(onMutation).observe(deps.doc.body, { childList: true, subtree: true });
  };
  start();

  // For a URL-routed service the conversation can change with no DOM mutation the observer
  // would see, so this interval is not merely a safety net — it is the PRIMARY trigger for
  // Slack, Telegram, Element and Talk.
  setInterval(scan, POLL_MS);
  setTimeout(scan, FIRST_SCAN_MS);
}
