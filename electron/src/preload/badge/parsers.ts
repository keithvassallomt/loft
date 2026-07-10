export type BadgeParser = (doc: Document) => number;

const whatsapp: BadgeParser = (doc) => {
  const el = doc.querySelector('[aria-label*="unread message"]');
  const m = el?.getAttribute('aria-label')?.match(/^(\d+) unread message/);
  return m ? parseInt(m[1], 10) : 0;
};

const slack: BadgeParser = (doc) => {
  // Count unread channel rows, excluding the "add more items" affordance.
  // (Filter in JS rather than `:not(:has(...))` — `:has()` works in Chromium but
  // not in jsdom's selector engine, so this keeps the parser unit-testable.)
  let count = 0;
  doc.querySelectorAll('.p-channel_sidebar__channel--unread').forEach((row) => {
    if (!row.querySelector('.p-channel_sidebar__link--add-more-items')) count++;
  });
  return count;
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
  // Port of content.js scanTelegramUnreads' count: sum the numeric sidebar badges.
  // NOTE: verify the selector against extension/content.js and the live sidebar.
  let count = 0;
  doc.querySelectorAll('.ChatBadge, .unread').forEach((el) => {
    const n = parseInt((el.textContent || '').trim(), 10);
    if (Number.isFinite(n)) count += n;
  });
  return count;
};

const messenger: BadgeParser = (doc) => {
  let count = 0;
  for (const a of doc.querySelectorAll('a[href*="/messages/"]')) {
    const walker = doc.createTreeWalker(a, NodeFilter.SHOW_TEXT, null);
    let unread = false;
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if ((n.textContent || '').trim() === 'Unread message:') { unread = true; break; }
    }
    if (unread && !a.querySelector('[style*="--disabled-icon"]')) count++;
  }
  return count;
};

export const BADGE_PARSERS: Record<string, BadgeParser> = {
  whatsapp, slack, element, talk, telegram, messenger,
};
