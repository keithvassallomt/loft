import { findJid, normalizeJid, reactProp } from './whatsappJid';
// Runtime import, but not a cycle: open.ts imports only the TYPES from this file.
import { deepestLeaf, dispatchRealClick } from './open';

/** What is open right now in a service view. */
export interface CapturedConversation {
  key: string;
  title: string;
  /**
   * Absent when the conversation has no image at all (every Slack channel). May be https, an
   * absolute url resolved from a relative one, or a `blob:` — watch.ts converts the last of
   * those to a data URI before it leaves the page, since main cannot read a blob.
   */
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
  | {
    kind: 'row';
    find(doc: Document): Element | null;
    via?: 'leaf' | 'anchor';
    /**
     * Run once, only if `find` misses, to make the row reachable at all — as opposed to
     * merely off-screen, which scrolling handles. Slack needs it: while the DMs tab is
     * showing, a channel row does not exist in the DOM at any scroll position.
     *
     * Deliberately on the first MISS rather than up front, so a reopen that would have
     * worked never disturbs the user's current view.
     */
    prepare?(doc: Document, win: Window): void;
  }
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

/**
 * An avatar reference main can actually turn into a file.
 *
 * Three schemes reach us and each needs different handling, which is why this is not simply
 * an https check (it was, and it silently dropped every Telegram and Talk avatar):
 *   - absolute https — fetched from the service's partition session as-is;
 *   - RELATIVE (`/avatar/user/64`, what NextCloud Talk serves) — resolved against the page
 *     origin here, since main has no idea what host the view is on;
 *   - `blob:` (what Telegram serves — 8 to 37 per page, and no https at all) — passed
 *     through for watch.ts to convert to a data URI, because a blob url exists only inside
 *     this page and main cannot read one.
 * Anything else (data:, javascript:, empty) is refused.
 */
function usableAvatarUrl(src: string | null | undefined, win: Window): string | undefined {
  if (!src) return undefined;
  if (src.startsWith('https://') || src.startsWith('blob:')) return src;
  if (src.startsWith('http://')) return src;
  if (src.startsWith('data:')) return src;
  if (src.startsWith('/') || src.startsWith('./')) {
    try { return new URL(src, win.location.href).href; } catch { return undefined; }
  }
  return undefined;
}

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
  capture(doc, win) {
    const main = doc.querySelector('#main');
    if (!main) return null; // #main exists only while a chat is open
    const fiber = reactProp(main, '__reactFiber') as { memoizedProps?: unknown } | undefined;
    const key = findJid(reactProp(main, '__reactProps')) ?? findJid(fiber?.memoizedProps);
    if (!key) return null;
    const header = main.querySelector('header');
    const title = clean(header?.querySelector('span[title]')?.getAttribute('title'))
      || clean(header?.textContent);
    return { key, title, avatarUrl: usableAvatarUrl(header?.querySelector('img')?.getAttribute('src'), win) };
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
/** The top-level tab rail's Home button, which carries aria-selected. */
const SLACK_HOME_TAB = '[data-qa="tab_rail_home_button"]';

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
    const src = usableAvatarUrl(row?.querySelector('img')?.getAttribute('src'), win);
    return {
      key: id,
      title: isChannel ? `#${name}` : name,
      avatarUrl: isChannel || !src ? undefined : bumpSlackAvatarSize(src),
    };
  },
  plan: (key) => ({
    kind: 'row',
    find: (doc) => doc.getElementById(key),
    // Slack's sidebar shows only the active top-level tab's contents, so from the DMs tab a
    // channel row is absent entirely — not scrolled away. Returning to Home is what makes it
    // exist. Guarded on aria-selected so an already-Home window is left alone.
    prepare: (doc, win) => {
      const home = doc.querySelector(SLACK_HOME_TAB);
      if (home && home.getAttribute('aria-selected') !== 'true') {
        dispatchRealClick(deepestLeaf(home), win);
      }
    },
  }),
  scroller: (doc) => doc.querySelector('[role="tree"]')?.parentElement ?? null,
};

// --- Telegram ---------------------------------------------------------------
// Measured: the hash IS the conversation (#8623934162 etc., changing per chat), and the
// sidebar renders a real anchor per chat whose href is that exact hash. So reopen clicks the
// anchor rather than assigning location.hash — the same mechanism as Messenger, and it
// inherits the retry-and-scroll behaviour that assignment cannot have. Avatars are blob:
// urls (no https on the page at all), converted downstream by watch.ts.

const TELEGRAM_ROW = 'a[href^="#"]';

function telegramAnchor(doc: Document, key: string): Element | null {
  try { return doc.querySelector(`a[href="${key}"]`); } catch { return null; }
}

const telegram: ConversationAdapter = {
  capture(doc, win) {
    const hash = win.location.hash;
    if (!hash || hash === '#') return null;
    // document.title is the open chat's name and nothing else — verified across three chats.
    // The sidebar's own .title divs are per-ROW, so selecting one would name whichever chat
    // happened to render first. A leading unread count is stripped defensively.
    const title = clean(doc.title).replace(/^\(\d+\)\s*/, '');
    const row = telegramAnchor(doc, hash)?.closest('.ListItem') ?? telegramAnchor(doc, hash);
    return { key: hash, title, avatarUrl: usableAvatarUrl(row?.querySelector('img')?.getAttribute('src'), win) };
  },
  plan: (key) => ({ kind: 'row', via: 'anchor', find: (doc) => telegramAnchor(doc, key) }),
  scroller: (doc) => doc.querySelector(TELEGRAM_ROW)?.closest('[class*="chat-list" i]')
    ?? doc.querySelector('.chat-list, [class*="ChatList" i]'),
};

// --- Element ----------------------------------------------------------------
// Hash-routed (#/room/!id:server). INFERRED, not measured — no account was available. The
// title selector is a best guess, which is why it falls back to document.title rather than
// to an empty string.

const element: ConversationAdapter = {
  capture(doc, win) {
    const hash = win.location.hash;
    if (!hash || hash === '#') return null;
    const sel = '.mx_RoomHeader_nametext, .mx_RoomHeader_name';
    const title = clean(doc.querySelector(sel)?.textContent) || clean(doc.title);
    const img = doc.querySelector(`${sel} img`) ?? doc.querySelector('.mx_RoomHeader img');
    return { key: hash, title, avatarUrl: usableAvatarUrl(img?.getAttribute('src'), win) };
  },
  plan: (key) => ({ kind: 'hash', hash: key }),
};

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
      avatarUrl: usableAvatarUrl(anchor?.querySelector('img')?.getAttribute('src'), win),
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
// Measured: the conversation list renders a real anchor per conversation, `a[href="/call/
// <token>"]`, matching the path we store as the key. So reopening clicks that anchor and
// stays in the Vue router, rather than assigning location.href and reloading the whole app.
// A full navigation remains the fallback when the row is not rendered at all.

/** Talk's own app icon, served as the avatar for any conversation with no picture. Using it
 *  would make every such bubble an identical Talk logo — strictly worse than the initials the
 *  rail falls back to, which at least tell two conversations apart. */
const TALK_PLACEHOLDER = /\/img\/app\.svg$/;

function talkAnchor(doc: Document, key: string): Element | null {
  try { return doc.querySelector(`a[href="${key}"]`); } catch { return null; }
}

const talk: ConversationAdapter = {
  capture(doc, win) {
    if (!/^\/call\/[^/]+/.test(win.location.pathname)) return null;
    const key = win.location.pathname;
    // "Test User - Talk - Vassallo.cloud - Nextcloud" -> "Test User". The row's own text is
    // the name concatenated with the last message ("Test UserYou:ssup"), so it is unusable.
    const title = clean(doc.title).replace(/\s+-\s+Talk\s+-\s+.*$/, '');
    const src = talkAnchor(doc, key)?.querySelector('img')?.getAttribute('src') ?? '';
    return {
      key,
      title,
      avatarUrl: TALK_PLACEHOLDER.test(src) ? undefined : usableAvatarUrl(src, win),
    };
  },
  plan: (key) => ({ kind: 'row', via: 'anchor', find: (doc) => talkAnchor(doc, key) }),
  scroller: (doc) => doc.querySelector('.app-navigation__list, .app-navigation ul, .app-navigation'),
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
  telegram,
  element,
};
