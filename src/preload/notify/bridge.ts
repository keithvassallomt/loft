import { installNotificationOverride, type OverrideNotice } from './override';
import {
  resolveIconUrl, pickTalkAvatarSrc, findSlackAvatar, scanSlackAvatars, blobToDataUri,
} from './avatar';
import { MessengerNotifier, type NotifyPayload } from './messenger';
import { TelegramNotifier } from './telegram';
import { installNotificationSoundGate } from './notificationSound';
import { navigateAction } from './navigate';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface BridgeDeps {
  ipc: { send(ch: string, ...a: unknown[]): void; on(ch: string, cb: (e: unknown, ...a: unknown[]) => void): void };
  win: any;
  doc: Document;
}

// Mirrors extension/content.js's conversation-scraper timing: an initial
// debounced MutationObserver pass, three retries to catch slow page loads,
// then a periodic fallback in case a mutation is ever missed.
const CONVERSATION_DEBOUNCE_MS = 500;
const CONVERSATION_RETRY_DELAYS_MS = [3000, 8000, 15000];
const CONVERSATION_INTERVAL_MS = 10_000;
const SLACK_AVATAR_SCAN_DELAY_MS = 3000;
const BODY_POLL_MS = 500;

// Populated by the Slack avatar MutationObserver below and consulted from
// handleNotice() so a notification whose own icon is empty can still be
// matched to a sender's avatar scraped from the sidebar/message list.
const slackCache = new Map<string, string>();

/**
 * Wires the notification override + avatar resolution + Messenger/Telegram
 * DOM scrapers together in the page, and relays daemon -> page IPC (DND,
 * visibility, notification-click navigation). Runs in the service
 * WebContentsView's main-world preload (contextIsolation: false), so it can
 * see and wrap the page's real `window.Notification`.
 */
export function startNotifyBridge(serviceId: string, deps: BridgeDeps): void {
  const { ipc, win, doc } = deps;

  const overrideHandle = installNotificationOverride(win, doc, (n) => { void handleNotice(n); });

  // Gate the web app's OWN notification ding (played in-page, e.g. Messenger's
  // <audio>) by the same DND + focus rule as the banner. Calls, ringtones, and
  // user-initiated media are left alone (see notificationSound.ts).
  const soundGate = installNotificationSoundGate(win);

  async function handleNotice(n: OverrideNotice): Promise<void> {
    // Messenger/Telegram: the DOM-scrape scanner (startConversationScanner
    // below) is the sole authoritative `service:notify` source for these two
    // services, matching the old extension (which suppressed their native
    // notifications via chrome.contentSettings — a mechanism Electron lacks).
    // The override is still installed for both (see installNotificationOverride
    // call above) purely for its suppression side effect (SilentNotification
    // keeps the page from showing its own native notification) and so
    // DND/visibility overrides keep working; it must not also relay to IPC or
    // every Messenger/Telegram message would notify twice.
    if (serviceId === 'messenger' || serviceId === 'telegram') return;

    let icon: string;
    if (serviceId === 'slack') {
      icon = n.icon || findSlackAvatar(doc, slackCache, n.title, n.tag);
    } else if (serviceId === 'talk') {
      icon = resolveIconUrl(pickTalkAvatarSrc(doc, n.title) || n.icon, win.location.href);
    } else {
      icon = n.icon.startsWith('blob:') ? await blobToDataUri(n.icon) : resolveIconUrl(n.icon, win.location.href);
    }
    ipc.send('service:notify', { title: n.title, body: n.body, icon, href: '' });
  }

  if (serviceId === 'slack') startSlackAvatarScanner(doc);

  const messenger = serviceId === 'messenger' ? new MessengerNotifier() : null;
  const telegram = serviceId === 'telegram' ? new TelegramNotifier() : null;
  const conversationNotifier = messenger ?? telegram;
  if (conversationNotifier) startConversationScanner(serviceId, doc, conversationNotifier, ipc);

  ipc.on('service:dnd', (_e: unknown, enabled?: unknown) => {
    const v = !!enabled;
    messenger?.setDnd(v);
    telegram?.setDnd(v);
    soundGate.setDnd(v);
  });

  ipc.on('service:visibility', (_e: unknown, hidden?: unknown) => {
    overrideHandle.setHidden(!!hidden);
    soundGate.setHidden(!!hidden);
  });

  // Notification click routes here from main. The chat row is a live <a href> for both
  // Messenger and Telegram, so try an anchor-click first; otherwise a per-service fallback.
  ipc.on('service:navigate', (_e: unknown, url?: unknown) => {
    if (typeof url !== 'string') return;
    let anchor: Element | null = null;
    try {
      anchor = doc.querySelector(`a[href="${url}"]`);
    } catch {
      // Malformed url (e.g. a stray `"`) breaks the attribute selector; treat as no anchor.
      anchor = null;
    }
    const action = navigateAction(serviceId, url, anchor !== null);
    switch (action.kind) {
      case 'click': (anchor as HTMLElement).click(); break;
      case 'href': win.location.href = action.url; break;
      case 'hash': win.location.hash = action.url; break;
      case 'none': break;
      default: { const _exhaustive: never = action; void _exhaustive; break; }
    }
  });
}

function startSlackAvatarScanner(doc: Document): void {
  const scan = (): void => scanSlackAvatars(doc, slackCache);
  const start = (): void => {
    if (!doc.body) { setTimeout(start, BODY_POLL_MS); return; }
    new MutationObserver(scan).observe(doc.body, { childList: true, subtree: true });
    setTimeout(scan, SLACK_AVATAR_SCAN_DELAY_MS);
  };
  start();
}

function startConversationScanner(
  serviceId: string,
  doc: Document,
  notifier: { scan(doc: Document): NotifyPayload[] },
  ipc: BridgeDeps['ipc'],
): void {
  const emit = async (p: NotifyPayload): Promise<void> => {
    const icon = serviceId === 'telegram' && p.icon.startsWith('blob:') ? await blobToDataUri(p.icon) : p.icon;
    ipc.send('service:notify', { title: p.sender, body: p.body, icon, href: p.href });
  };

  const runScan = (): void => { for (const p of notifier.scan(doc)) void emit(p); };

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const onMutation = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(runScan, CONVERSATION_DEBOUNCE_MS);
  };

  const start = (): void => {
    if (!doc.body) { setTimeout(start, BODY_POLL_MS); return; }
    new MutationObserver(onMutation).observe(doc.body, { childList: true, subtree: true });
    for (const delay of CONVERSATION_RETRY_DELAYS_MS) setTimeout(runScan, delay);
    setInterval(runScan, CONVERSATION_INTERVAL_MS);
  };
  start();
}
