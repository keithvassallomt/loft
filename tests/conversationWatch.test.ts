// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sameConversation, startConversationWatch } from '../src/preload/conversation/watch';

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
    startConversationWatch('nosuchkind', { doc: document, win: slackWin('/'), send });
    vi.advanceTimersByTime(10_000);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the open conversation once it settles', () => {
    document.body.innerHTML = '<div id="C0ABC">general</div>';
    const send = vi.fn();
    startConversationWatch('slack', { doc: document, win: slackWin('/client/T1/C0ABC'), send });
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ key: 'C0ABC' }));
  });

  it('does not re-send an unchanged conversation', () => {
    document.body.innerHTML = '<div id="C0ABC">general</div>';
    const send = vi.fn();
    startConversationWatch('slack', { doc: document, win: slackWin('/client/T1/C0ABC'), send });
    vi.advanceTimersByTime(15_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends null when the conversation goes away, so the pin control can grey out', () => {
    document.body.innerHTML = '<div id="C0ABC">general</div>';
    const loc = { pathname: '/client/T1/C0ABC', hash: '' };
    const send = vi.fn();
    startConversationWatch('slack', { doc: document, win: { location: loc } as unknown as Window, send });
    vi.advanceTimersByTime(5_000);
    send.mockClear();
    loc.pathname = '/client/T1';
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledWith(null);
  });

  it('reports the very first observation even when it is null', () => {
    const send = vi.fn();
    startConversationWatch('slack', { doc: document, win: slackWin('/client/T1'), send });
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledWith(null);
  });

  it('sends the new conversation when the user switches', () => {
    document.body.innerHTML = '<div id="C0ABC">general</div><div id="C0DEF">random</div>';
    const loc = { pathname: '/client/T1/C0ABC', hash: '' };
    const send = vi.fn();
    startConversationWatch('slack', { doc: document, win: { location: loc } as unknown as Window, send });
    vi.advanceTimersByTime(5_000);
    loc.pathname = '/client/T1/C0DEF';
    vi.advanceTimersByTime(3_000);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'C0DEF' }));
  });

  it('survives an adapter that throws, reporting null rather than dying', () => {
    const send = vi.fn();
    // A window with no location at all makes the slack adapter throw on read.
    startConversationWatch('slack', { doc: document, win: {} as unknown as Window, send });
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    expect(send).toHaveBeenCalledWith(null);
  });
});
