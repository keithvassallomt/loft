export type BadgeParser = (doc: Document) => number;

const whatsapp: BadgeParser = (doc) => {
  const el = doc.querySelector('[aria-label*="unread message"]');
  const m = el?.getAttribute('aria-label')?.match(/^(\d+) unread message/);
  return m ? parseInt(m[1], 10) : 0;
};

// Slack's own count of what needs attention, from the tab title:
// "Matthew Sammut (DM) - ICE Campus - 3 new items - Slack". Anchored to the end, so a channel
// or workspace that happens to be called "5 new items" cannot be read as the count.
const SLACK_TITLE_COUNT = /\s-\s(\d+) new items?\s-\sSlack$/;

const slack: BadgeParser = (doc) => {
  // The title comes first because it is the one source that exists on every tab. Slack
  // renders only the sidebar of the tab being shown: on the DMs or Activity tab there are no
  // channel rows at all, so counting rows alone gave 0 with unread DMs sitting right there
  // (measured 2026-11-16: title "3 new items", zero channel rows, two unread DM badges).
  const m = doc.title.match(SLACK_TITLE_COUNT);
  const fromTitle = m ? parseInt(m[1], 10) : 0;
  if (fromTitle > 0) return fromTitle;

  // No count in the title: a format change, a non-English UI, or nothing but plain channel
  // unreads (which the title may not count). Fall back to unread rows in whichever list is
  // rendered: Home's channel sidebar, excluding its "add more items" affordance, or the DMs
  // tab's list. Only one of the two is ever in the DOM, so nothing is counted twice.
  // (Filtered in JS rather than with `:not(:has(...))`: `:has()` works in Chromium but not
  // in jsdom's selector engine, so this keeps the parser unit-testable.)
  let count = 0;
  doc.querySelectorAll('.p-channel_sidebar__channel--unread').forEach((row) => {
    if (!row.querySelector('.p-channel_sidebar__link--add-more-items')) count++;
  });
  return count + doc.querySelectorAll('.p-dms_channel__unread_badge').length;
};

const element: BadgeParser = (doc) => {
  const m = doc.title.match(/\[(\d+)\]/);
  return m ? parseInt(m[1], 10) : 0;
};

const talk: BadgeParser = (doc) => {
  let count = 0;
  doc.querySelectorAll('.counter-bubble__counter').forEach((el) => {
    const n = parseInt((el.textContent || '').trim(), 10);
    count += Number.isFinite(n) ? n : 1;
  });
  return count;
};

const telegram: BadgeParser = (doc) => {
  // Faithful to content.js scanTelegramUnreads: count conversations with a numeric
  // unread badge (`.chat-badge-transition` whose text is all digits — skips action
  // buttons like "Open"). It is a conversation COUNT, not a sum of unread numbers.
  let count = 0;
  doc.querySelectorAll('.chat-badge-transition').forEach((badge) => {
    if (/^\d+$/.test((badge.textContent || '').trim())) count++;
  });
  return count;
};

const messenger: BadgeParser = (doc) => {
  // Faithful to content.js: count UNIQUE unread, non-muted conversations by href
  // (Messenger can render the same thread as more than one anchor).
  const unread = new Set<string>();
  for (const a of doc.querySelectorAll('a[href*="/messages/"]')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    const walker = doc.createTreeWalker(a, NodeFilter.SHOW_TEXT, null);
    let isUnread = false;
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if ((n.textContent || '').trim() === 'Unread message:') { isUnread = true; break; }
    }
    if (isUnread && !a.querySelector('[style*="--disabled-icon"]')) unread.add(href);
  }
  return unread.size;
};

export const BADGE_PARSERS: Record<string, BadgeParser> = {
  whatsapp, slack, element, talk, telegram, messenger,
};
