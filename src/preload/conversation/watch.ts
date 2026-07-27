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

/**
 * Read a blob url into a data URI, in the page that owns it.
 *
 * Mirrors notify/avatar.ts's own blobToDataUri — same problem, same shape. Kept local rather
 * than shared because that one is wired into the notification bridge's deps; duplicating six
 * lines beats threading a dependency through for it.
 */
async function blobToDataUri(url: string, win: Window): Promise<string | undefined> {
  try {
    const res = await (win as unknown as { fetch: typeof fetch }).fetch(url);
    const blob = await res.blob();
    return await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

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
    if (next?.avatarUrl?.startsWith('blob:')) {
      // A blob url is readable only inside this page, so it must be inlined before crossing
      // to main. Telegram serves nothing else — the whole page had 8-37 blobs and no https.
      // The conversation is sent immediately either way: a bubble showing initials now beats
      // one that waits on a fetch, and the avatar follows a beat later.
      const pending = next;
      deps.send({ ...pending, avatarUrl: undefined });
      void blobToDataUri(pending.avatarUrl!, deps.win).then((dataUri) => {
        // Only if that conversation is still the current one — the user may have moved on.
        if (dataUri && last === pending) deps.send({ ...pending, avatarUrl: dataUri });
      });
      return;
    }
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
