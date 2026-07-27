// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { CONVERSATION_ADAPTERS, bumpSlackAvatarSize } from '../src/preload/conversation/adapters';
import { executePlan } from '../src/preload/conversation/open';

/** Attach a React-style props object to a node, the way React does. */
function withProps(el: Element, props: unknown): Element {
  Object.defineProperty(el, '__reactProps$test', { value: props, enumerable: true, configurable: true });
  return el;
}
/** A fiber chain whose key sits two levels up, matching what the spike measured. */
function withFiberKey(el: Element, key: string): Element {
  Object.defineProperty(el, '__reactFiber$test', {
    value: { key: null, return: { key: null, return: { key, return: null } } },
    enumerable: true,
    configurable: true,
  });
  return el;
}
const fakeWin = (href: string): Window => ({ location: new URL(href) } as unknown as Window);

describe('whatsapp adapter', () => {
  const wa = CONVERSATION_ADAPTERS.whatsapp;

  it('captures nothing when no chat is open', () => {
    document.body.innerHTML = '<div id="pane-side"></div>';
    expect(wa.capture(document, fakeWin('https://web.whatsapp.com/'))).toBeNull();
  });

  it('captures the open chat jid, title and https avatar', () => {
    document.body.innerHTML = `
      <div id="main"><header><span title="Dan Jackson">Dan Jackson</span>
      <img src="https://cdn.whatsapp.net/a.jpg"></header></div>`;
    withProps(document.querySelector('#main')!, { children: [null, { key: '262135443656788@lid' }] });
    expect(wa.capture(document, fakeWin('https://web.whatsapp.com/'))).toEqual({
      key: '262135443656788@lid',
      title: 'Dan Jackson',
      avatarUrl: 'https://cdn.whatsapp.net/a.jpg',
    });
  });

  // blob: is KEPT now, not dropped: watch.ts inlines it to a data URI before it leaves the
  // page. Dropping it is what left Telegram with no avatars at all.
  it('keeps a blob avatar for downstream inlining', () => {
    document.body.innerHTML = '<div id="main"><header><span title="X">X</span><img src="blob:abc"></header></div>';
    withProps(document.querySelector('#main')!, { children: [null, { key: '1@lid' }] });
    expect(wa.capture(document, fakeWin('https://web.whatsapp.com/'))?.avatarUrl).toBe('blob:abc');
  });

  it('drops an avatar whose scheme main could never resolve', () => {
    document.body.innerHTML = '<div id="main"><header><span title="X">X</span><img src="javascript:x"></header></div>';
    withProps(document.querySelector('#main')!, { children: [null, { key: '1@lid' }] });
    expect(wa.capture(document, fakeWin('https://web.whatsapp.com/'))?.avatarUrl).toBeUndefined();
  });

  it('captures nothing when #main exists but carries no jid', () => {
    document.body.innerHTML = '<div id="main"><header>Loading</header></div>';
    expect(wa.capture(document, fakeWin('https://web.whatsapp.com/'))).toBeNull();
  });

  it('plans a row lookup that matches a row by its fiber key', () => {
    document.body.innerHTML = '<div id="pane-side"><div role="row" id="a"></div><div role="row" id="b"></div></div>';
    withFiberKey(document.querySelector('#a')!, 'chat-111@lid');
    withFiberKey(document.querySelector('#b')!, 'chat-222@lid');
    const plan = wa.plan('222@lid', document, fakeWin('https://web.whatsapp.com/'));
    expect(plan.kind).toBe('row');
    if (plan.kind !== 'row') throw new Error('unreachable');
    expect(plan.find(document)).toBe(document.querySelector('#b'));
    expect(plan.via ?? 'leaf').toBe('leaf');
  });

  it('plans a row lookup that finds nothing when the row is not rendered', () => {
    document.body.innerHTML = '<div id="pane-side"></div>';
    const plan = wa.plan('999@lid', document, fakeWin('https://web.whatsapp.com/'));
    if (plan.kind !== 'row') throw new Error('unreachable');
    expect(plan.find(document)).toBeNull();
  });

  it('offers the chat list as its scroller', () => {
    document.body.innerHTML = '<div id="pane-side"></div>';
    expect(wa.scroller?.(document)).toBe(document.querySelector('#pane-side'));
  });
});

describe('slack adapter', () => {
  const sl = CONVERSATION_ADAPTERS.slack;
  const url = 'https://app.slack.com/client/T01RQ04DP1D/C01S1LHKXUM';

  it('captures the conversation id from the url', () => {
    document.body.innerHTML = '<div id="C01S1LHKXUM">00_team</div>';
    expect(sl.capture(document, fakeWin(url))?.key).toBe('C01S1LHKXUM');
  });

  it('prefixes a channel title with # so the rail falls back to a # glyph', () => {
    document.body.innerHTML = '<div id="C01S1LHKXUM">00_team</div>';
    expect(sl.capture(document, fakeWin(url))?.title).toBe('#00_team');
  });

  it('gives a channel no avatar — channels genuinely have none', () => {
    document.body.innerHTML = '<div id="C01S1LHKXUM">00_team<img src="https://ca.slack-edge.com/x-24"></div>';
    expect(sl.capture(document, fakeWin(url))?.avatarUrl).toBeUndefined();
  });

  it('leaves a DM title unprefixed and bumps its avatar size', () => {
    const dm = 'https://app.slack.com/client/T01RQ04DP1D/D04NCUQ0DCK';
    document.body.innerHTML = '<div id="D04NCUQ0DCK">Sue<img src="https://ca.slack-edge.com/T1-U2-hash-24"></div>';
    const got = sl.capture(document, fakeWin(dm));
    expect(got?.title).toBe('Sue');
    expect(got?.avatarUrl).toBe('https://ca.slack-edge.com/T1-U2-hash-72');
  });

  it('captures nothing outside a conversation route', () => {
    expect(sl.capture(document, fakeWin('https://app.slack.com/client/T01RQ04DP1D'))).toBeNull();
  });

  it('plans a row lookup by element id', () => {
    document.body.innerHTML = '<div id="C0ABCDEFG">general</div>';
    const plan = sl.plan('C0ABCDEFG', document, fakeWin(url));
    if (plan.kind !== 'row') throw new Error('unreachable');
    expect(plan.find(document)).toBe(document.querySelector('#C0ABCDEFG'));
  });
});

describe('bumpSlackAvatarSize', () => {
  it('raises the size suffix for a 34px bubble', () => {
    expect(bumpSlackAvatarSize('https://ca.slack-edge.com/T1-U2-hash-24')).toBe(
      'https://ca.slack-edge.com/T1-U2-hash-72');
  });
  it('leaves a url with no size suffix alone', () => {
    expect(bumpSlackAvatarSize('https://x/y.png')).toBe('https://x/y.png');
  });
});

describe('telegram adapter', () => {
  const tg = CONVERSATION_ADAPTERS.telegram;
  const win = fakeWin('https://web.telegram.org/a/#8623934162');

  it('captures the hash as the key', () => {
    document.body.innerHTML = '';
    document.title = 'Nick Scerri';
    expect(tg.capture(document, win)?.key).toBe('#8623934162');
  });

  // Measured: document.title is the open chat and nothing else. The sidebar's own .title
  // divs are per-ROW, so selecting one names whichever chat rendered first.
  it('takes the title from document.title, not from a sidebar row', () => {
    document.body.innerHTML = '<div class="ListItem"><div class="title">Keith Vassallo</div></div>';
    document.title = 'Nick Scerri';
    expect(tg.capture(document, win)?.title).toBe('Nick Scerri');
  });

  it('strips a leading unread count from the title', () => {
    document.body.innerHTML = '';
    document.title = '(3) Nick Scerri';
    expect(tg.capture(document, win)?.title).toBe('Nick Scerri');
  });

  // Telegram serves blob: avatars and no https at all; watch.ts inlines them downstream.
  it('keeps a blob avatar from the matching sidebar row', () => {
    document.body.innerHTML =
      '<div class="ListItem"><a href="#8623934162"><img src="blob:https://web.telegram.org/x"></a></div>';
    expect(tg.capture(document, win)?.avatarUrl).toBe('blob:https://web.telegram.org/x');
  });

  // The fix for "clicking a bubble shows no chat selected": assigning location.hash cannot
  // retry, so it loses to a still-booting app. The sidebar anchor can.
  it('plans a row click on the sidebar anchor, not a hash assignment', () => {
    document.body.innerHTML = '<div class="ListItem"><a href="#8623934162">Nick</a></div>';
    const plan = tg.plan('#8623934162', document, win);
    expect(plan.kind).toBe('row');
    if (plan.kind !== 'row') throw new Error('unreachable');
    expect(plan.find(document)).toBe(document.querySelector('a'));
  });

  /**
   * Measured on the real app: the anchor IS found, `anchor.click()` does NOT move Telegram,
   * and a leaf-originated sequence does — the same rule WhatsApp and Slack both needed.
   * `via: 'anchor'` was carried over from Messenger on the assumption that it was already
   * proven; it was not, for this app.
   *
   * The DOM below is the asymmetry itself: a click dispatched AT the anchor bubbles up and can
   * never reach a handler on its descendant.
   */
  it('opens a chat whose handler sits on a DESCENDANT of the anchor', async () => {
    document.body.innerHTML =
      '<div class="ListItem"><a href="#8623934162"><div><div class="leaf">Nick</div></div></a></div>';
    let opened = false;
    document.querySelector('.leaf')!.addEventListener('click', () => { opened = true; });

    const plan = tg.plan('#8623934162', document, win);
    const outcome = await executePlan(plan, {
      doc: document, win: window, sleep: async () => {}, scroller: null,
    });

    expect(outcome).toBe('done');
    expect(opened).toBe(true);
  });

  it('finds no row when that chat is not rendered', () => {
    document.body.innerHTML = '<div class="ListItem"><a href="#999">Other</a></div>';
    const plan = tg.plan('#8623934162', document, win);
    if (plan.kind !== 'row') throw new Error('unreachable');
    expect(plan.find(document)).toBeNull();
  });

  it('captures nothing with an empty hash', () => {
    expect(tg.capture(document, fakeWin('https://web.telegram.org/a/'))).toBeNull();
  });
});

describe('element adapter', () => {
  const el = CONVERSATION_ADAPTERS.element;
  const win = fakeWin('https://app.element.io/#/room/!abc:example.org');

  /** The real header, measured 2026-07-27. The room avatar and the FacePile's MEMBER avatars
   *  are both .mx_BaseAvatar images inside it; only the layout-hashed classes distinguish
   *  them, and those change every Element release. */
  const header = `
    <header class="_flex_4dswl_9 mx_RoomHeader light-panel">
      <button class="_avatar_va14e_8 mx_BaseAvatar">
        <img class="_image_va14e_43" src="https://matrix.example.org/_matrix/media/v3/thumbnail/gnome.org/room">
      </button>
      <button class="mx_RoomHeader_infoWrapper">
        <div class="mx_RoomHeader_info">
          <span class="mx_RoomHeader_truncated mx_lineClamp">Extensions</span>
        </div>
      </button>
      <div class="mx_AccessibleButton mx_FacePile">
        <img class="_image_va14e_43" src="https://matrix.example.org/_matrix/media/v3/thumbnail/vassallo.cloud/member">
      </div>
    </header>`;

  it('captures and plans its room hash', () => {
    expect(el.capture(document, win)?.key).toBe('#/room/!abc:example.org');
    expect(el.plan('#/room/!abc:example.org', document, win).kind).toBe('hash');
  });

  // Item 3: the old selectors (.mx_RoomHeader_nametext/.mx_RoomHeader_name) were guessed with
  // no account to check against, and match nothing in current Element -- so every room fell
  // back to document.title, "Element | Test User", which the glyph then read as "ET".
  it('takes the room name from the header', () => {
    document.body.innerHTML = header;
    document.title = 'Element | Extensions';
    expect(el.capture(document, win)?.title).toBe('Extensions');
  });

  it('takes the ROOM avatar, not the first member in the FacePile', () => {
    document.body.innerHTML = header;
    expect(el.capture(document, win)?.avatarUrl)
      .toBe('https://matrix.example.org/_matrix/media/v3/thumbnail/gnome.org/room');
  });

  // The fallback has to be usable in its own right, since the header classes above are the
  // ones that already drifted once.
  it('falls back to document.title with the Element prefix stripped', () => {
    document.body.innerHTML = '';
    document.title = 'Element | #general';
    expect(el.capture(document, win)?.title).toBe('#general');
    document.title = '[3] Element | Test User';
    expect(el.capture(document, win)?.title).toBe('Test User');
  });
});

describe('avatar url handling', () => {
  // This filter was https-only and silently dropped every Telegram and Talk avatar.
  it('resolves a RELATIVE avatar against the page origin (NextCloud Talk)', () => {
    document.body.innerHTML = '<a href="/call/abc123"><img src="/avatar/keith/64"></a>';
    const got = CONVERSATION_ADAPTERS.talk.capture(
      document, fakeWin('https://cloud.example.org/call/abc123'));
    expect(got?.avatarUrl).toBe('https://cloud.example.org/avatar/keith/64');
  });

  it('rejects a scheme main could never resolve', () => {
    document.body.innerHTML = '<a href="/call/abc123"><img src="javascript:alert(1)"></a>';
    expect(CONVERSATION_ADAPTERS.talk.capture(
      document, fakeWin('https://cloud.example.org/call/abc123'))?.avatarUrl).toBeUndefined();
  });
});

describe('messenger adapter', () => {
  const mg = CONVERSATION_ADAPTERS.messenger;
  const win = fakeWin('https://www.facebook.com/messages/t/12345');

  /** A sidebar row as Messenger really renders it: the href carries a TRAILING SLASH that
   *  location.pathname does not, and the row text is the name run together with presence,
   *  preview and timestamp. Measured 2026-07-27. */
  const row = (href: string, name: string, current = false) => `
    <a href="${href}"${current ? ' aria-current="page"' : ''}>
      <img src="https://scontent-lhr11-1.xx.fbcdn.net/v/t39.30808-1/732069033.jpg">
      <span>Active now</span><span>${name}</span><span>Mike: Opening at 11</span><span>2h</span>
    </a>`;

  it('captures the thread path', () => {
    document.body.innerHTML = '<a href="/messages/t/12345">Dan</a>';
    expect(mg.capture(document, win)?.key).toBe('/messages/t/12345');
  });

  it('captures nothing outside the messaging surface', () => {
    expect(mg.capture(document, fakeWin('https://www.facebook.com/somepost'))).toBeNull();
  });

  // Item 4: Messenger's DMs are end-to-end encrypted by default and most groups are not, so
  // "/messages/t/" alone disabled the pin on exactly the one-to-one chats.
  it('captures an e2ee DM, whose path carries an extra segment', () => {
    const dm = fakeWin('https://www.facebook.com/messages/e2ee/t/6382594055138206');
    document.body.innerHTML = row('/messages/e2ee/t/6382594055138206/', 'Pulcina', true);
    // The key is CANONICAL rather than the raw pathname: the same chat is reachable at two
    // paths, and each would otherwise mint its own bubble for the one conversation.
    expect(mg.capture(document, dm)).toMatchObject({
      key: '/messages/t/6382594055138206',
      title: 'Pulcina',
    });
  });

  it('gives one chat one key, whichever path it was pinned from', () => {
    document.body.innerHTML = row('/messages/e2ee/t/777/', 'Josette', true);
    const viaE2ee = mg.capture(document, fakeWin('https://www.facebook.com/messages/e2ee/t/777'));
    const viaPlain = mg.capture(document, fakeWin('https://www.facebook.com/messages/t/777/'));
    expect(viaE2ee?.key).toBe(viaPlain?.key);
  });

  // Items 5 and 6, which are one bug: location.pathname has no trailing slash and the anchor
  // href does, so the exact-match lookup found nothing -- costing both the name (it fell back
  // to document.title, "(2) Messenger | Facebook") and the reopen.
  it('finds the row despite the trailing slash location.pathname omits', () => {
    const group = fakeWin('https://www.facebook.com/messages/t/2746217722122776');
    document.body.innerHTML = row('/messages/t/2746217722122776/', 'RAOB Currock Lodge', true);
    const got = mg.capture(document, group);
    expect(got?.title).toBe('RAOB Currock Lodge');
    expect(got?.avatarUrl).toContain('fbcdn.net');

    const plan = mg.plan('/messages/t/2746217722122776', document, group);
    if (plan.kind !== 'row') throw new Error('unreachable');
    expect(plan.find(document)).toBe(document.querySelector('a'));
  });

  // The row's own textContent is "Active nowRAOB Currock LodgeMike: Opening at 112h" -- so
  // finding the anchor is necessary but not sufficient.
  it('takes the NAME from the row, not the row text run together', () => {
    const group = fakeWin('https://www.facebook.com/messages/t/999');
    document.body.innerHTML = row('/messages/t/999/', 'Familja Vassallo', true);
    expect(mg.capture(document, group)?.title).toBe('Familja Vassallo');
  });

  it('does not confuse a thread id with one that merely starts the same way', () => {
    document.body.innerHTML = row('/messages/t/1234/', 'Wrong chat');
    const plan = mg.plan('/messages/t/123', document, win);
    if (plan.kind !== 'row') throw new Error('unreachable');
    expect(plan.find(document)).toBeNull();
  });

  // Measured: anchor.click() DOES move Messenger, unlike Telegram. Keeping via:'anchor' here
  // is now an observation rather than the assumption it was.
  it('plans an ANCHOR click — measured working on the real app', () => {
    document.body.innerHTML = '<a href="/messages/t/12345/">Dan</a>';
    const plan = mg.plan('/messages/t/12345', document, win);
    if (plan.kind !== 'row') throw new Error('unreachable');
    expect(plan.via).toBe('anchor');
    expect(plan.find(document)).toBe(document.querySelector('a'));
  });

  it('survives a key that would break an attribute selector', () => {
    document.body.innerHTML = '<a href="/messages/t/1">Dan</a>';
    const plan = mg.plan('/messages/t/"broken', document, win);
    if (plan.kind !== 'row') throw new Error('unreachable');
    expect(plan.find(document)).toBeNull();
  });
});

describe('talk adapter', () => {
  const tk = CONVERSATION_ADAPTERS.talk;
  const win = fakeWin('https://nc.example.org/call/37egz8x9');

  it('captures the call token as the key', () => {
    document.body.innerHTML = '';
    document.title = 'Test User - Talk - Example - Nextcloud';
    expect(tk.capture(document, win)?.key).toBe('/call/37egz8x9');
  });

  // Measured: the row's own text is the name concatenated with the last message
  // ("Test UserYou:ssup"), so document.title is the only clean source.
  it('takes the conversation name from document.title, before the " - Talk" suffix', () => {
    document.title = 'Test User - Talk - Vassallo.cloud - Nextcloud';
    expect(tk.capture(document, win)?.title).toBe('Test User');
  });

  // Measured: reopening used to assign location.href and reload the whole Vue app. The
  // sidebar has real anchors, so the router can be used instead.
  it('plans an ANCHOR click rather than a full navigation', () => {
    document.body.innerHTML = '<a href="/call/37egz8x9">Test UserYou:ssup</a>';
    const plan = tk.plan('/call/37egz8x9', document, win);
    expect(plan.kind).toBe('row');
    if (plan.kind !== 'row') throw new Error('unreachable');
    expect(plan.via).toBe('anchor');
    expect(plan.find(document)).toBe(document.querySelector('a'));
  });

  it('ignores the Talk app icon placeholder, so bubbles fall back to distinct initials', () => {
    document.title = 'Test User - Talk - Example - Nextcloud';
    document.body.innerHTML =
      '<a href="/call/37egz8x9"><img src="/custom_apps/spreed/img/app.svg"></a>';
    expect(tk.capture(document, win)?.avatarUrl).toBeUndefined();
  });

  it('keeps a real avatar, resolved against the instance origin', () => {
    document.title = 'Test User - Talk - Example - Nextcloud';
    document.body.innerHTML = '<a href="/call/37egz8x9"><img src="/avatar/testuser/64"></a>';
    expect(tk.capture(document, win)?.avatarUrl).toBe('https://nc.example.org/avatar/testuser/64');
  });

  it('captures nothing outside a call route', () => {
    expect(tk.capture(document, fakeWin('https://nc.example.org/apps/files'))).toBeNull();
  });
});

describe('unknown kind', () => {
  it('has no adapter, which callers must treat as "no bubbles for that service"', () => {
    expect(CONVERSATION_ADAPTERS.nosuchkind).toBeUndefined();
  });
});

// --- unread keys -----------------------------------------------------------
// Every DOM below is taken from probe output measured 2026-07-27, not invented.
// See dev_local/bubbles_spike/FINDINGS-unread.md.

describe('slack unreadKeys', () => {
  const slack = CONVERSATION_ADAPTERS.slack;

  // MEASURED: the unread row's OWN id is empty and the conversation id sits on an ANCESTOR.
  // A row.id implementation would have found nothing at all.
  it('finds the id on the ancestor, which is where Slack actually puts it', () => {
    document.body.innerHTML = `
      <div id="D04K1K54VKQ">
        <div class="p-channel_sidebar__channel p-channel_sidebar__channel--unread">
          <div id="mask__small-member"></div>Dan
        </div>
      </div>`;
    expect(slack.unreadKeys!(document)).toEqual(['D04K1K54VKQ']);
  });

  // The same row carries a descendant id="mask__small-member": without the format guard,
  // querySelector('[id]') would have produced that as a key.
  it('rejects a descendant id that is not a conversation id', () => {
    document.body.innerHTML = `
      <div class="p-channel_sidebar__channel--unread"><div id="mask__small-member"></div></div>`;
    expect(slack.unreadKeys!(document)).toEqual([]);
  });

  it('reports several unread conversations', () => {
    document.body.innerHTML = `
      <div id="C0ABCDEF"><div class="p-channel_sidebar__channel--unread">general</div></div>
      <div id="D0GHIJKL"><div class="p-channel_sidebar__channel--unread">Dan</div></div>
      <div id="C0MNOPQR"><div class="p-channel_sidebar__channel">random</div></div>`;
    expect(slack.unreadKeys!(document).sort()).toEqual(['C0ABCDEF', 'D0GHIJKL']);
  });

  // The badge parser excludes this row from its count; so must this.
  it('ignores the "add more items" affordance', () => {
    document.body.innerHTML = `
      <div id="C0ABCDEF"><div class="p-channel_sidebar__channel--unread">
        <div class="p-channel_sidebar__link--add-more-items">more</div>
      </div></div>`;
    expect(slack.unreadKeys!(document)).toEqual([]);
  });

  it('reports nothing when nothing is unread', () => {
    document.body.innerHTML = '<div id="C0ABCDEF">general</div>';
    expect(slack.unreadKeys!(document)).toEqual([]);
  });
});

describe('messenger unreadKeys', () => {
  const mg = CONVERSATION_ADAPTERS.messenger;
  const unreadRow = (href: string, muted = false) => `
    <a href="${href}">
      <span>Unread message:</span><span>RAOB Currock Lodge</span>
      ${muted ? '<div style="--disabled-icon: 1"></div>' : ''}
    </a>`;

  // MEASURED: an unread e2ee DM's href is /messages/e2ee/t/<id>/, and capture() stores the
  // canonical /messages/t/<id>. Main matches by string equality, so these must agree.
  it('reports the CANONICAL key, not the raw href', () => {
    document.body.innerHTML = unreadRow('/messages/e2ee/t/6382594055138206/');
    expect(mg.unreadKeys!(document)).toEqual(['/messages/t/6382594055138206']);
  });

  // MEASURED: one of the two unread rows was muted. A muted conversation contributes no
  // service badge, so it must contribute no dot.
  it('ignores read rows and muted ones', () => {
    document.body.innerHTML =
      unreadRow('/messages/t/111/') + '<a href="/messages/t/222/"><span>Read</span></a>'
      + unreadRow('/messages/t/5969460249764223/', true);
    expect(mg.unreadKeys!(document)).toEqual(['/messages/t/111']);
  });

  // Messenger renders the same thread as more than one anchor; the badge parser dedupes too.
  it('dedupes a thread rendered as two anchors', () => {
    document.body.innerHTML = unreadRow('/messages/t/111/') + unreadRow('/messages/t/111');
    expect(mg.unreadKeys!(document)).toEqual(['/messages/t/111']);
  });
});

describe('telegram unreadKeys', () => {
  const tg = CONVERSATION_ADAPTERS.telegram;

  it('reports the hash of each chat with a numeric unread badge', () => {
    document.body.innerHTML = `
      <div class="ListItem"><a href="#8623934162"><div class="shown chat-badge-transition open">3</div></a></div>
      <div class="ListItem"><a href="#93372553"><div class="chat-badge-transition">1</div></a></div>
      <div class="ListItem"><a href="#8078674329">read</a></div>`;
    // The read chat (#8078674329) must NOT appear.
    expect(tg.unreadKeys!(document).sort()).toEqual(['#8623934162', '#93372553']);
  });

  // The badge parser skips non-numeric badges (action buttons like "Open"); so must this.
  it('ignores a non-numeric badge', () => {
    document.body.innerHTML =
      '<div class="ListItem"><a href="#111"><div class="chat-badge-transition">Open</div></a></div>';
    expect(tg.unreadKeys!(document)).toEqual([]);
  });

  it('reports nothing when no badge is inside a chat anchor', () => {
    document.body.innerHTML = '<div class="chat-badge-transition">3</div>';
    expect(tg.unreadKeys!(document)).toEqual([]);
  });
});

describe('talk unreadKeys', () => {
  const tk = CONVERSATION_ADAPTERS.talk;

  it('reports the call path of each conversation with a counter', () => {
    document.body.innerHTML = `
      <a href="/call/37egz8x9"><div class="counter-bubble__counter counter-bubble__counter--highlighted">1</div></a>
      <a href="/call/abc12345"><div class="counter-bubble__counter">@</div></a>
      <a href="/call/nounread">read</a>`;
    // No numeric filter, unlike Telegram: the badge parser counts a non-numeric bubble (a
    // mention marker) as 1, so it is unread too.
    expect(tk.unreadKeys!(document).sort()).toEqual(['/call/37egz8x9', '/call/abc12345']);
  });

  it('reports nothing when a counter is not inside a conversation anchor', () => {
    document.body.innerHTML = '<div class="counter-bubble__counter">2</div>';
    expect(tk.unreadKeys!(document)).toEqual([]);
  });
});

describe('whatsapp unreadKeys', () => {
  const wa = CONVERSATION_ADAPTERS.whatsapp;

  /** A rendered row: the jid lives on an ancestor fiber, exactly as the spike measured. */
  const row = (jid: string, unread: boolean): Element => {
    const el = document.createElement('div');
    el.setAttribute('role', 'listitem');
    // MEASURED: an unread row carries BOTH an aria-label span and a numeric badge span. The
    // aria-label is the one keyed on — semantic rather than incidental, and it cannot be
    // confused with any other number in the row.
    el.innerHTML = unread
      ? '<span aria-label="3 unread messages">3</span>'
      : '<span>12:04</span>';
    Object.defineProperty(el, '__reactFiber$test', {
      value: { key: null, return: { key: null, return: { key: `chat-${jid}`, return: null } } },
      enumerable: true, configurable: true,
    });
    return el;
  };

  it('reports the jid of each unread row', () => {
    document.body.innerHTML = '<div id="pane-side"></div>';
    const pane = document.getElementById('pane-side')!;
    pane.append(
      row('447720388804-1549977754@g.us', true),
      row('456@c.us', false),
      row('120363042640138349@g.us', true),
    );
    expect(wa.unreadKeys!(document).sort())
      .toEqual(['120363042640138349@g.us', '447720388804-1549977754@g.us']);
  });

  it('reports nothing when the chat list is not rendered', () => {
    document.body.innerHTML = '';
    expect(wa.unreadKeys!(document)).toEqual([]);
  });

  it('skips an unread row whose jid cannot be read', () => {
    document.body.innerHTML = '<div id="pane-side"></div>';
    const el = document.createElement('div');
    el.setAttribute('role', 'listitem');
    el.innerHTML = '<span aria-label="3 unread messages">3</span>';
    document.getElementById('pane-side')!.append(el);
    expect(wa.unreadKeys!(document)).toEqual([]);
  });
});

describe('element unreadKeys', () => {
  const el = CONVERSATION_ADAPTERS.element;

  /** A room row as Element really renders it. Measured 2026-07-27: the row is a button with
   *  a stable mx_ class, and its aria-label carries BOTH the room name and its unread state.
   *  The room id appears nowhere in the row — not on it, not on any descendant. */
  const row = (label: string, decoration = '') => `
    <button class="mx_RoomListItemView" role="option" aria-label="${label}">
      <div class="_notificationDecoration_vaz9j_63" data-testid="notification-decoration">${decoration}</div>
    </button>`;

  it('reports the room NAME of each unread row, there being no id in the markup', () => {
    document.body.innerHTML =
      row('Open room Extensions')
      + row('Open room keithvassallo with 1 unread message', '1')
      + row('Open room Test User');
    expect(el.unreadKeys!(document)).toEqual(['keithvassallo']);
  });

  it('handles a plural count', () => {
    document.body.innerHTML = row('Open room Dev Team with 12 unread messages', '12');
    expect(el.unreadKeys!(document)).toEqual(['Dev Team']);
  });

  // The decoration carries a count even when the label does not say "unread" — a mention or
  // an activity marker. The empty decoration every row renders must NOT count.
  it('counts a row whose decoration has content but whose label says nothing', () => {
    document.body.innerHTML = row('Open room Quiet Room', '3');
    expect(el.unreadKeys!(document)).toEqual(['Quiet Room']);
  });

  it('ignores the empty decoration that every read row renders', () => {
    document.body.innerHTML = row('Open room Extensions') + row('Open room Test User');
    expect(el.unreadKeys!(document)).toEqual([]);
  });

  it('reports nothing when the room list is not rendered', () => {
    document.body.innerHTML = '';
    expect(el.unreadKeys!(document)).toEqual([]);
  });
});
