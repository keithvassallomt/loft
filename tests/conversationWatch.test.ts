// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sameConversation, startConversationWatch } from '../src/preload/conversation/watch';
import { CONVERSATION_ADAPTERS, type ConversationAdapter } from '../src/preload/conversation/adapters';

describe('sameConversation', () => {
  const a = { key: '1@lid', title: 'Dan', avatarUrl: 'https://x/a.jpg' };
  it('is true for identical captures', () => {
    expect(sameConversation(a, { ...a })).toBe(true);
  });
  it('is true for two nulls, false when only one is null', () => {
    expect(sameConversation(null, null)).toBe(true);
    expect(sameConversation(a, null)).toBe(false);
    expect(sameConversation(null, a)).toBe(false);
  });
  it('is false when the title changes, so a rename is picked up', () => {
    expect(sameConversation(a, { ...a, title: 'Daniel' })).toBe(false);
  });
  it('is false when the key or avatar changes', () => {
    expect(sameConversation(a, { ...a, key: '2@lid' })).toBe(false);
    expect(sameConversation(a, { ...a, avatarUrl: 'https://x/b.jpg' })).toBe(false);
  });
});

describe('startConversationWatch', () => {
  beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ''; });
  afterEach(() => { vi.useRealTimers(); });

  const slackWin = (pathname: string): Window =>
    ({ location: { pathname, hash: '' } } as unknown as Window);

  it('does nothing for a kind with no adapter', () => {
    const send = vi.fn();
    startConversationWatch('nosuchkind', { doc: document, win: slackWin('/'), send, sendUnread: vi.fn() });
    vi.advanceTimersByTime(10_000);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the open conversation once it settles', () => {
    document.body.innerHTML = '<div id="C0ABC">general</div>';
    const send = vi.fn();
    startConversationWatch('slack', { doc: document, win: slackWin('/client/T1/C0ABC'), send, sendUnread: vi.fn() });
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ key: 'C0ABC' }));
  });

  it('does not re-send an unchanged conversation', () => {
    document.body.innerHTML = '<div id="C0ABC">general</div>';
    const send = vi.fn();
    startConversationWatch('slack', { doc: document, win: slackWin('/client/T1/C0ABC'), send, sendUnread: vi.fn() });
    vi.advanceTimersByTime(15_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends null when the conversation goes away, so the pin control can grey out', () => {
    document.body.innerHTML = '<div id="C0ABC">general</div>';
    const loc = { pathname: '/client/T1/C0ABC', hash: '' };
    const send = vi.fn();
    startConversationWatch('slack', { doc: document, win: { location: loc } as unknown as Window, send, sendUnread: vi.fn() });
    vi.advanceTimersByTime(5_000);
    send.mockClear();
    loc.pathname = '/client/T1';
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledWith(null);
  });

  it('reports the very first observation even when it is null', () => {
    const send = vi.fn();
    startConversationWatch('slack', { doc: document, win: slackWin('/client/T1'), send, sendUnread: vi.fn() });
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledWith(null);
  });

  it('sends the new conversation when the user switches', () => {
    document.body.innerHTML = '<div id="C0ABC">general</div><div id="C0DEF">random</div>';
    const loc = { pathname: '/client/T1/C0ABC', hash: '' };
    const send = vi.fn();
    startConversationWatch('slack', { doc: document, win: { location: loc } as unknown as Window, send, sendUnread: vi.fn() });
    vi.advanceTimersByTime(5_000);
    loc.pathname = '/client/T1/C0DEF';
    vi.advanceTimersByTime(3_000);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'C0DEF' }));
  });

  it('survives an adapter that throws, reporting null rather than dying', () => {
    const send = vi.fn();
    // A window with no location at all makes the slack adapter throw on read.
    startConversationWatch('slack', { doc: document, win: {} as unknown as Window, send, sendUnread: vi.fn() });
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    expect(send).toHaveBeenCalledWith(null);
  });
});

/**
 * Element's avatar URL 404s for anyone but the page.
 *
 * Measured on Keith's homeserver 2026-07-27: the `<img>` renders, and the very same URL
 * returns `404 application/json` to curl and to main's session.fetch. Synapse serves
 * authenticated media, and Element's service worker rewrites the legacy media path and
 * attaches the access token — which main has no way to supply, cookies or not.
 *
 * The fix does not depend on which errcode it is: the bytes are reachable from the PAGE and
 * not from main, so they are read in the page, exactly as Telegram's blobs already are.
 */
describe('avatars that only the page can fetch', () => {
  beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ''; });
  afterEach(() => { vi.useRealTimers(); });

  const AVATAR = 'https://matrix.example.org/_matrix/media/v3/thumbnail/vassallo.cloud/tYsJ';
  const elementWin = (fetchImpl: unknown): Window =>
    ({ location: { pathname: '/', hash: '#/room/!a:b', href: 'https://app.element.io/' }, fetch: fetchImpl } as unknown as Window);

  const header = `<header class="mx_RoomHeader">
      <button class="mx_BaseAvatar"><img src="${AVATAR}"></button>
      <span class="mx_RoomHeader_truncated">Test User</span>
    </header>`;

  it('inlines an https Element avatar rather than handing main a url it cannot fetch', async () => {
    document.body.innerHTML = header;
    const send = vi.fn();
    const pageFetch = vi.fn(async () => ({ blob: async () => new Blob(['pretend png'], { type: 'image/png' }) }));
    startConversationWatch('element', { doc: document, win: elementWin(pageFetch), send, sendUnread: vi.fn() });

    await vi.advanceTimersByTimeAsync(5000);
    // Sent immediately WITHOUT the avatar: initials now beat a bubble waiting on a fetch.
    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      title: 'Test User', avatarUrl: undefined,
    }));
    expect(pageFetch).toHaveBeenCalledWith(AVATAR);

    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      avatarUrl: expect.stringContaining('data:'),
    }));
  });

  it('leaves the bubble on initials when even the page cannot fetch it', async () => {
    document.body.innerHTML = header;
    const send = vi.fn();
    const pageFetch = vi.fn(async () => { throw new Error('404'); });
    startConversationWatch('element', { doc: document, win: elementWin(pageFetch), send, sendUnread: vi.fn() });

    await vi.advanceTimersByTimeAsync(6000);
    for (const call of send.mock.calls) expect(call[0]?.avatarUrl).toBeUndefined();
  });

  // Slack, WhatsApp and Messenger serve avatars main CAN fetch, and those must keep crossing
  // as urls: inlining every avatar would push base64 over IPC on every poll.
  it('does not inline a service whose avatars main can fetch', async () => {
    document.body.innerHTML = '<div id="D0ABC"><img src="https://slack.example/a-24">Dan</div>';
    const send = vi.fn();
    const pageFetch = vi.fn();
    startConversationWatch('slack', {
      doc: document,
      win: { location: { pathname: '/client/T1/D0ABC', hash: '', href: 'https://app.slack.com/' }, fetch: pageFetch } as unknown as Window,
      send,
      sendUnread: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(pageFetch).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      avatarUrl: 'https://slack.example/a-72',
    }));
  });
});

/**
 * The transport, tested against a STUBBED adapter.
 *
 * Deliberate: no adapter has an unreadKeys until the per-service tasks land, and afterwards
 * every one of them does — so a test driving a real adapter would fail now and change meaning
 * later. This task owns the push; the adapters own what they see.
 */
describe('unread key push', () => {
  const win2 = (pathname: string): Window =>
    ({ location: { pathname, hash: '', href: 'https://app.slack.com/' } } as unknown as Window);

  let original: ConversationAdapter['unreadKeys'];
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    original = CONVERSATION_ADAPTERS.slack.unreadKeys;
  });
  afterEach(() => {
    vi.useRealTimers();
    CONVERSATION_ADAPTERS.slack.unreadKeys = original;
  });

  /** Drive the watcher with a stubbed adapter and return what it pushed. */
  const run = (unreadKeys: ConversationAdapter['unreadKeys'], ms = 5000): ReturnType<typeof vi.fn> => {
    CONVERSATION_ADAPTERS.slack.unreadKeys = unreadKeys;
    const sendUnread = vi.fn();
    startConversationWatch('slack', {
      doc: document, win: win2('/client/T1/C0ABC'), send: vi.fn(), sendUnread,
    });
    vi.advanceTimersByTime(ms);
    return sendUnread;
  };

  it('pushes the keys the adapter reports', () => {
    expect(run(() => ['C0ABC'])).toHaveBeenCalledWith(['C0ABC']);
  });

  it('sorts and dedupes, so the same set never looks like a different one', () => {
    expect(run(() => ['C0B', 'C0A', 'C0B'])).toHaveBeenCalledWith(['C0A', 'C0B']);
  });

  // This runs every two seconds per loaded service; an unchanged set must not cross IPC.
  it('pushes only when the set changes', () => {
    expect(run(() => ['C0ABC'], 20_000)).toHaveBeenCalledTimes(1);
  });

  // A page that reloads from "two unread" to "none" must say so, or main keeps stale dots for
  // the life of the session.
  it('pushes an EMPTY set on the first scan, so a fresh page clears stale state', () => {
    expect(run(() => [])).toHaveBeenCalledWith([]);
  });

  it('reports nothing for a kind whose adapter has no unreadKeys', () => {
    expect(run(undefined)).toHaveBeenCalledWith([]);
  });

  it('survives an adapter that throws mid-navigation', () => {
    let sendUnread: ReturnType<typeof vi.fn> | undefined;
    expect(() => { sendUnread = run(() => { throw new Error('mid-navigation'); }); }).not.toThrow();
    expect(sendUnread!).toHaveBeenCalledWith([]);
  });
});
