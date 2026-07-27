// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { CONVERSATION_ADAPTERS, bumpSlackAvatarSize } from '../src/preload/conversation/adapters';

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
  it('plans an ANCHOR click on the sidebar row, not a hash assignment', () => {
    document.body.innerHTML = '<div class="ListItem"><a href="#8623934162">Nick</a></div>';
    const plan = tg.plan('#8623934162', document, win);
    expect(plan.kind).toBe('row');
    if (plan.kind !== 'row') throw new Error('unreachable');
    expect(plan.via).toBe('anchor');
    expect(plan.find(document)).toBe(document.querySelector('a'));
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

  it('captures and plans its room hash', () => {
    expect(el.capture(document, win)?.key).toBe('#/room/!abc:example.org');
    expect(el.plan('#/room/!abc:example.org', document, win).kind).toBe('hash');
  });

  it('falls back to document.title when the title selector misses', () => {
    document.body.innerHTML = '';
    document.title = 'Element | #general';
    expect(el.capture(document, win)?.title).toBe('Element | #general');
  });
});

describe('avatar url handling', () => {
  // This filter was https-only and silently dropped every Telegram and Talk avatar.
  it('resolves a RELATIVE avatar against the page origin (NextCloud Talk)', () => {
    document.body.innerHTML = '<div id="app-content"><img class="avatar" src="/avatar/keith/64"></div>';
    const got = CONVERSATION_ADAPTERS.talk.capture(
      document, fakeWin('https://cloud.example.org/call/abc123'));
    expect(got?.avatarUrl).toBe('https://cloud.example.org/avatar/keith/64');
  });

  it('rejects a scheme main could never resolve', () => {
    document.body.innerHTML = '<div id="app-content"><img class="avatar" src="javascript:alert(1)"></div>';
    expect(CONVERSATION_ADAPTERS.talk.capture(
      document, fakeWin('https://cloud.example.org/call/abc123'))?.avatarUrl).toBeUndefined();
  });
});

describe('messenger adapter', () => {
  const mg = CONVERSATION_ADAPTERS.messenger;
  const win = fakeWin('https://www.facebook.com/messages/t/12345');

  it('captures the thread path', () => {
    document.body.innerHTML = '<a href="/messages/t/12345">Dan</a>';
    expect(mg.capture(document, win)?.key).toBe('/messages/t/12345');
  });

  it('captures nothing outside the messaging surface', () => {
    expect(mg.capture(document, fakeWin('https://www.facebook.com/somepost'))).toBeNull();
  });

  it('plans an ANCHOR click — the mechanism already shipped for notification clicks', () => {
    document.body.innerHTML = '<a href="/messages/t/12345">Dan</a>';
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
  it('captures the call token and plans a full navigation', () => {
    const win = fakeWin('https://cloud.example.org/call/abc123');
    expect(tk.capture(document, win)?.key).toBe('/call/abc123');
    expect(tk.plan('/call/abc123', document, win)).toEqual({ kind: 'url', url: '/call/abc123' });
  });
  it('captures nothing outside a call route', () => {
    expect(tk.capture(document, fakeWin('https://cloud.example.org/apps/files'))).toBeNull();
  });
});

describe('unknown kind', () => {
  it('has no adapter, which callers must treat as "no bubbles for that service"', () => {
    expect(CONVERSATION_ADAPTERS.nosuchkind).toBeUndefined();
  });
});
