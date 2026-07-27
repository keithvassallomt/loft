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
  /**
   * Read `avatarUrl` in the PAGE and hand main a data URI, because main cannot fetch it.
   *
   * Element needs this and measurement is the only way anyone would know: its `<img>` renders
   * from a URL that returns `404 application/json` to every other client, main's authenticated
   * `session.fetch` included. Synapse serves authenticated media and Element's service worker
   * supplies the access token — which lives in the page, not in a cookie, so no session
   * arrangement in main can reach it.
   *
   * Off by default: an avatar main CAN fetch should stay a url, or every poll would push
   * base64 across IPC. A `blob:` url is inlined regardless of this flag — it is unreadable
   * outside the page by construction.
   */
  inlineAvatar?: boolean;
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
  /**
   * The keys of every conversation the sidebar currently shows as UNREAD.
   *
   * Returns ALL of them, not just the pinned ones — the page has no idea what is pinned, that
   * lives in main's config. Main intersects.
   *
   * These keys MUST be in the same form `capture()` produces, or a conversation can never be
   * matched: main compares by string equality, so a mismatch fails SILENTLY — the dot simply
   * never appears. Messenger is the one that bites, its capture key being canonicalised to
   * `/messages/t/<id>` rather than the raw href.
   *
   * Optional: a kind without one contributes no keys and its bubbles never show a dot.
   */
  unreadKeys?(doc: Document): string[];
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
  // Per-ROW, unlike the badge parser, which reads one document-wide total. Measured: an
  // unread row carries BOTH an aria-label span and a numeric badge span; the aria-label is
  // keyed on because it is semantic rather than incidental, and cannot be confused with any
  // other number in a row. Case-insensitive so singular and plural both qualify.
  unreadKeys: (doc) => {
    const out = new Set<string>();
    for (const row of waRows(doc)) {
      if (!row.querySelector('[aria-label*="unread" i]')) continue;
      const jid = waRowJid(row);
      if (jid) out.add(jid);
    }
    return [...out];
  },
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

/**
 * The conversation id on or near an unread sidebar row.
 *
 * Measured 2026-07-27: the unread row's OWN id is EMPTY and the conversation id sits on an
 * ANCESTOR, so `row.id` finds nothing. A descendant of the same row carries
 * `id="mask__small-member"`, which is why the format guard is load-bearing rather than
 * defensive: only a real conversation id (C/D/G plus at least six upper-case alphanumerics)
 * is accepted, so neither climbing nor descending can produce a false key.
 */
function slackConversationId(row: Element): string | null {
  for (const el of [row, row.closest('[id]'), row.querySelector('[id]')]) {
    const id = (el as HTMLElement | null)?.id ?? '';
    if (/^[CDG][A-Z0-9]{6,}$/.test(id)) return id;
  }
  return null;
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
  unreadKeys: (doc) => {
    const out = new Set<string>();
    doc.querySelectorAll('.p-channel_sidebar__channel--unread').forEach((row) => {
      // Same exclusion the badge parser applies — an affordance, not a conversation.
      if (row.querySelector('.p-channel_sidebar__link--add-more-items')) return;
      const id = slackConversationId(row);
      if (id) out.add(id);
    });
    return [...out];
  },
};

// --- Telegram ---------------------------------------------------------------
// Measured: the hash IS the conversation (#8623934162 etc., changing per chat), and the
// sidebar renders a real anchor per chat whose href is that exact hash. So reopen finds that
// anchor rather than assigning location.hash, and inherits the retry-and-scroll behaviour
// assignment cannot have. Avatars are blob: urls (no https on the page at all), converted
// downstream by watch.ts.
//
// The anchor is found but NOT `.click()`ed: measured on the real app, `anchor.click()` leaves
// Telegram on the previous chat and a leaf-originated sequence moves it. Its handler is on a
// descendant of <a class="ListItem-button">, and events bubble up but never down — the same
// rule WhatsApp and Slack both needed.

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
  plan: (key) => ({ kind: 'row', find: (doc) => telegramAnchor(doc, key) }),
  scroller: (doc) => doc.querySelector(TELEGRAM_ROW)?.closest('[class*="chat-list" i]')
    ?? doc.querySelector('.chat-list, [class*="ChatList" i]'),
  unreadKeys: (doc) => {
    const out = new Set<string>();
    doc.querySelectorAll('.chat-badge-transition').forEach((badge) => {
      // Numeric only — the badge parser skips action buttons like "Open" the same way.
      if (!/^\d+$/.test((badge.textContent || '').trim())) return;
      const href = badge.closest(TELEGRAM_ROW)?.getAttribute('href');
      if (href) out.add(href);
    });
    return [...out];
  },
};

// --- Element ----------------------------------------------------------------
// Hash-routed (#/room/!id:server). Measured 2026-07-27, against the account that did not
// exist when this first shipped: the room name is `.mx_RoomHeader_truncated` and the room
// avatar is the first `.mx_BaseAvatar img` in the header. The previous selectors were
// guesses, matched nothing, and sent every room to the document.title fallback.

/** Room-name selectors, newest Element first. The older two are kept because they cost
 *  nothing and this is exactly the surface that already drifted once. */
const ELEMENT_NAME = '.mx_RoomHeader_truncated, .mx_RoomHeader_nametext, .mx_RoomHeader_name';

/**
 * "[3] Element | Test User" -> "Test User".
 *
 * Element's document.title is the room name behind a fixed prefix and Element's own unread
 * count, so the fallback is usable once both are stripped — where the raw title was not: its
 * glyph read "ET", from "Element" and "Test".
 */
function elementDocTitle(title: string): string {
  return clean(title).replace(/^\[\d+\]\s*/, '').replace(/^Element\s*\|\s*/, '');
}

const element: ConversationAdapter = {
  capture(doc, win) {
    const hash = win.location.hash;
    if (!hash || hash === '#') return null;
    const header = doc.querySelector('.mx_RoomHeader');
    const title = clean(header?.querySelector(ELEMENT_NAME)?.textContent) || elementDocTitle(doc.title);
    // The FacePile in the same header is a row of MEMBER avatars, and they are .mx_BaseAvatar
    // too — only the per-release hashed layout classes tell them apart, so exclude by name.
    const img = [...(header?.querySelectorAll('.mx_BaseAvatar img') ?? [])]
      .find((im) => !im.closest('.mx_FacePile'));
    return {
      key: hash,
      title,
      avatarUrl: usableAvatarUrl(img?.getAttribute('src'), win),
      // Only this page can fetch it — see CapturedConversation.inlineAvatar.
      inlineAvatar: true,
    };
  },
  plan: (key) => ({ kind: 'hash', hash: key }),
};

// --- Messenger --------------------------------------------------------------
// Rows are real anchors and anchor.click() moves the app — measured on the real page, not
// inferred this time, which is why `via: 'anchor'` stays here and was removed from Telegram.
//
// Two path facts, both measured 2026-07-27, and both of which the string-equality lookup this
// replaced got wrong:
//   - a DM's path is /messages/E2EE/t/<id> (Messenger encrypts one-to-one chats by default)
//     while a group's is /messages/t/<id>, so requiring the latter disabled the pin on every
//     DM;
//   - location.pathname has NO trailing slash and the sidebar anchor's href HAS one, so
//     a[href="<pathname>"] matched nothing — costing the name AND the reopen at once.
// So both are reduced to a thread id and compared as ids.

const MESSENGER_THREAD = /^\/messages\/(?:[^/]+\/)?t\/([^/?#]+)/;
const MESSENGER_TIMESTAMP = /^\d+[smhdw]$/;
const MESSENGER_PRESENCE = /^Active\b/;

/** The thread id in a pathname or an href; null when it is not a conversation at all. */
function messengerThreadId(path: string): string | null {
  return MESSENGER_THREAD.exec(path)?.[1] ?? null;
}

/**
 * The conversation NAME from a sidebar row.
 *
 * The row's textContent is the name run together with presence, preview and timestamp —
 * "Active nowRAOB Currock LodgeMike: Opening at 112h" — so finding the anchor is necessary
 * but not sufficient. This is the rule the shipped notification scraper already uses for
 * `sender` (src/preload/notify/messenger.ts): the first LEAF span carrying real text.
 */
function messengerRowName(anchor: Element): string {
  for (const span of anchor.querySelectorAll('span')) {
    const text = (span.textContent ?? '').trim();
    if (text.length < 2 || text.length > 100) continue;
    if (text === 'Unread message:' || text === '·') continue;
    if (MESSENGER_TIMESTAMP.test(text) || MESSENGER_PRESENCE.test(text)) continue;
    if (span.querySelector('span')) continue;
    return text;
  }
  return '';
}

/** NodeFilter.SHOW_TEXT, inlined: notify/messenger.ts does the same, because that module runs
 *  under a plain 'node' vitest environment where the NodeFilter global is not guaranteed. */
const SHOW_TEXT = 0x4;

/** A row is unread when a text node inside it reads exactly "Unread message:" — the rule the
 *  shipped badge parser and notification scraper both already use. */
function messengerRowUnread(doc: Document, anchor: Element): boolean {
  const walker = doc.createTreeWalker(anchor, SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if ((node.textContent ?? '').trim() === 'Unread message:') return true;
  }
  return false;
}

const messenger: ConversationAdapter = {
  capture(doc, win) {
    const id = messengerThreadId(win.location.pathname);
    if (!id) return null;
    // CANONICAL, not the raw pathname: one chat is reachable at two paths (with and without
    // the e2ee segment, with and without a trailing slash) and each would otherwise mint its
    // own bubble for the same conversation. This form is also what existing group pins
    // already hold, so they keep working untouched.
    const key = `/messages/t/${id}`;
    const anchor = findMessengerAnchor(doc, key);
    const img = anchor?.querySelector('img[src*="fbcdn.net"]') ?? anchor?.querySelector('img');
    return {
      key,
      // Last resort is document.title — always "(2) Messenger | Facebook", i.e. useless, but
      // it is only reached when the row has not rendered, and the watcher replaces it with
      // the real name within a poll.
      title: (anchor && messengerRowName(anchor)) || clean(anchor?.textContent) || clean(doc.title),
      avatarUrl: usableAvatarUrl(img?.getAttribute('src'), win),
    };
  },
  plan: (key) => ({ kind: 'row', via: 'anchor', find: (doc) => findMessengerAnchor(doc, key) }),
  unreadKeys: (doc) => {
    const out = new Set<string>();
    for (const a of doc.querySelectorAll('a[href*="/messages/"]')) {
      // Muted. A muted conversation contributes no service badge, so it contributes no dot —
      // and one of the two unread rows measured on the real page was muted.
      if (a.querySelector('[style*="--disabled-icon"]')) continue;
      if (!messengerRowUnread(doc, a)) continue;
      const id = messengerThreadId(a.getAttribute('href') ?? '');
      // CANONICAL form — the same key capture() stores. Main matches by string equality.
      if (id) out.add(`/messages/t/${id}`);
    }
    return [...out];
  },
};

/**
 * The row for a thread, matched by ID rather than by href string.
 *
 * Comparing ids rather than substrings is what keeps thread 123 from matching thread 1234, and
 * it removes the attribute-selector injection hazard entirely: a malformed key simply reduces
 * to an id that equals nothing.
 */
function findMessengerAnchor(doc: Document, key: string): Element | null {
  const id = messengerThreadId(key);
  if (!id) return null;
  for (const a of doc.querySelectorAll('a[href*="/messages/"]')) {
    if (messengerThreadId(a.getAttribute('href') ?? '') === id) return a;
  }
  return null;
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
  unreadKeys: (doc) => {
    const out = new Set<string>();
    // No numeric filter here, unlike Telegram: the badge parser deliberately counts a
    // non-numeric bubble (a mention marker) as 1, so it is unread too.
    doc.querySelectorAll('.counter-bubble__counter').forEach((counter) => {
      const href = counter.closest('a[href^="/call/"]')?.getAttribute('href');
      if (href) out.add(href);
    });
    return [...out];
  },
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
