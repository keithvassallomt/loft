import { findJid, normalizeJid, reactProp } from './whatsappJid';

/** What is open right now in a service view. */
export interface CapturedConversation {
  key: string;
  title: string;
  /** Absent when the conversation has no image (every Slack channel) or a non-https one. */
  avatarUrl?: string;
}

/**
 * How to get back to a conversation. A PLAN, not an effect: adapters stay pure and
 * unit-testable, and the one impure executor is written and tested once. This mirrors
 * `navigateAction` (src/preload/notify/navigate.ts), which already returns a union of
 * actions rather than performing them.
 */
export type OpenPlan =
  | { kind: 'hash'; hash: string }
  | { kind: 'row'; find(doc: Document): Element | null; via?: 'leaf' | 'anchor' }
  | { kind: 'url'; url: string }
  | { kind: 'none' };

export interface ConversationAdapter {
  capture(doc: Document, win: Window): CapturedConversation | null;
  plan(key: string, doc: Document, win: Window): OpenPlan;
  /** For `row` plans: the scrollable container to step when the row is not rendered. */
  scroller?(doc: Document): Element | null;
}

/** Titles land in a 34px tooltip and a config file; neither wants an unbounded string. */
const clean = (s: string | null | undefined): string => (s ?? '').trim().slice(0, 120);

/** Main fetches avatars over https from the service's partition session; it cannot read a
 *  `blob:` or `data:` url, which only exist inside the page. */
const httpsOnly = (src: string | null | undefined): string | undefined =>
  src && src.startsWith('https://') ? src : undefined;

// --- WhatsApp ---------------------------------------------------------------
// No per-chat URL exists. The open chat's jid lives in #main's React props, from two
// independent sources; row identity is React's per-child key on an ancestor fiber.

const waRows = (doc: Document): Element[] => [
  ...(doc.querySelector('#pane-side')?.querySelectorAll('[role="listitem"], [role="row"]') ?? []),
];

/**
 * A row's OWN jid. Deliberately NOT a deep search: a row's ancestor fibers hold the entire
 * chat collection, so a deep search finds every chat's jid and returns an arbitrary one.
 * Measured during the spike: the identifying key sits at fiber[2] for 71/71 rendered rows,
 * so eight levels is generous headroom.
 */
function waRowJid(el: Element): string | null {
  let f = reactProp(el, '__reactFiber') as { key?: unknown; return?: unknown } | undefined;
  for (let i = 0; f && i < 8; i++) {
    const jid = normalizeJid(f.key);
    if (jid) return jid;
    f = f.return as typeof f;
  }
  return null;
}

const whatsapp: ConversationAdapter = {
  capture(doc) {
    const main = doc.querySelector('#main');
    if (!main) return null; // #main exists only while a chat is open
    const fiber = reactProp(main, '__reactFiber') as { memoizedProps?: unknown } | undefined;
    const key = findJid(reactProp(main, '__reactProps')) ?? findJid(fiber?.memoizedProps);
    if (!key) return null;
    const header = main.querySelector('header');
    const title = clean(header?.querySelector('span[title]')?.getAttribute('title'))
      || clean(header?.textContent);
    return { key, title, avatarUrl: httpsOnly(header?.querySelector('img')?.getAttribute('src')) };
  },
  plan: (key) => ({
    kind: 'row',
    find: (doc) => waRows(doc).find((el) => waRowJid(el) === key) ?? null,
  }),
  scroller: (doc) => doc.querySelector('#pane-side'),
};

// --- Slack ------------------------------------------------------------------
// URL-routed. Sidebar rows carry the conversation id in their own `id` attribute, so row
// lookup needs no React internals at all.

const SLACK_ROUTE = /\/client\/(T[A-Z0-9]+)\/([CDG][A-Z0-9]+)/;

/** Slack serves a size-suffixed avatar (`…-24`); a 34px bubble wants more pixels than that. */
export function bumpSlackAvatarSize(src: string): string {
  return src.replace(/-\d{2,3}$/, '-72');
}

const slack: ConversationAdapter = {
  capture(doc, win) {
    const m = SLACK_ROUTE.exec(win.location.pathname);
    if (!m) return null;
    const id = m[2];
    const row = doc.getElementById(id);
    const name = clean(row?.textContent)
      || clean(doc.querySelector('[data-qa="channel_header"], .p-view_header')?.textContent);
    // A channel has NO avatar — the spike found only an unrelated onboarding GIF in the
    // header, and no channel emoji. Prefixing '#' costs nothing and makes the rail's existing
    // initials fallback render '#', which is exactly what a channel should look like.
    const isChannel = id.startsWith('C') || id.startsWith('G');
    const src = httpsOnly(row?.querySelector('img')?.getAttribute('src'));
    return {
      key: id,
      title: isChannel ? `#${name}` : name,
      avatarUrl: isChannel || !src ? undefined : bumpSlackAvatarSize(src),
    };
  },
  plan: (key) => ({ kind: 'row', find: (doc) => doc.getElementById(key) }),
  scroller: (doc) => doc.querySelector('[role="tree"]')?.parentElement ?? null,
};

// --- Hash-routed: Telegram, Element -----------------------------------------
// Setting location.hash routes these in place with no reload, which makes them the cheapest
// services in the feature. Both are INFERRED rather than measured (no account was available
// during the spike); the title selectors in particular are best guesses, which is why they
// fall back to document.title rather than to an empty string.

function hashAdapter(titleSelector: string): ConversationAdapter {
  return {
    capture(doc, win) {
      const hash = win.location.hash;
      if (!hash || hash === '#') return null;
      const title = clean(doc.querySelector(titleSelector)?.textContent) || clean(doc.title);
      const img = doc.querySelector(`${titleSelector} img`) ?? doc.querySelector('header img');
      return { key: hash, title, avatarUrl: httpsOnly(img?.getAttribute('src')) };
    },
    plan: (key) => ({ kind: 'hash', hash: key }),
  };
}

// --- Messenger --------------------------------------------------------------
// Rows are real anchors, and anchor.click() is the mechanism already shipped and proven for
// notification clicks. `via: 'anchor'` is explicit so the executor is told rather than
// guessing from a tag name — leaf dispatch would probably work here too, but "probably" is
// not a reason to change a working path.

const messenger: ConversationAdapter = {
  capture(doc, win) {
    if (!win.location.pathname.startsWith('/messages/t/')) return null;
    const key = win.location.pathname;
    const anchor = findMessengerAnchor(doc, key);
    return {
      key,
      title: clean(anchor?.textContent) || clean(doc.title),
      avatarUrl: httpsOnly(anchor?.querySelector('img')?.getAttribute('src')),
    };
  },
  plan: (key) => ({ kind: 'row', via: 'anchor', find: (doc) => findMessengerAnchor(doc, key) }),
};

/** A malformed key (a stray quote) breaks the attribute selector and throws. Treat it as
 *  "no anchor" — the same containment navigate.ts already applies. */
function findMessengerAnchor(doc: Document, key: string): Element | null {
  try { return doc.querySelector(`a[href="${key}"]`); } catch { return null; }
}

// --- NextCloud Talk ---------------------------------------------------------
// Path-routed with no in-page route available, so reopening is a full navigation. Inferred,
// not measured — no Talk account existed during the spike.

const talk: ConversationAdapter = {
  capture(doc, win) {
    if (!/^\/call\/[^/]+/.test(win.location.pathname)) return null;
    return {
      key: win.location.pathname,
      title: clean(doc.querySelector('#app-content h2, .app-navigation .active')?.textContent)
        || clean(doc.title),
      avatarUrl: httpsOnly(doc.querySelector('#app-content img.avatar')?.getAttribute('src')),
    };
  },
  plan: (key) => ({ kind: 'url', url: key }),
};

/**
 * Keyed by KIND, exactly like BADGE_PARSERS, and selected by the `--loft-service=<kind>`
 * preload argument. A kind with no entry simply has no bubbles — never a crash.
 */
export const CONVERSATION_ADAPTERS: Record<string, ConversationAdapter> = {
  whatsapp,
  slack,
  messenger,
  talk,
  telegram: hashAdapter('.chat-info .title, .ChatInfo .title'),
  element: hashAdapter('.mx_RoomHeader_nametext, .mx_RoomHeader_name'),
};
