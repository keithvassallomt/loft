// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { BADGE_PARSERS } from '../src/preload/badge/parsers';

function docFrom(html: string, title = ''): Document {
  document.title = title;
  document.body.innerHTML = html;
  return document;
}

describe('badge parsers', () => {
  it('whatsapp reads the aria-label count', () => {
    const doc = docFrom('<div aria-label="5 unread messages"></div>');
    expect(BADGE_PARSERS.whatsapp(doc)).toBe(5);
  });
  it('whatsapp is 0 with no unread label', () => {
    expect(BADGE_PARSERS.whatsapp(docFrom('<div></div>'))).toBe(0);
  });
  it('element reads [N] from the title, bare * is 0', () => {
    expect(BADGE_PARSERS.element(docFrom('', 'Element [7]'))).toBe(7);
    expect(BADGE_PARSERS.element(docFrom('', 'Element *'))).toBe(0);
  });
  it('talk sums counter bubbles (non-numeric counts as 1)', () => {
    const doc = docFrom(
      '<div class="counter-bubble__counter">3</div>' +
      '<div class="counter-bubble__counter">2</div>' +
      '<div class="counter-bubble__counter">@</div>',
    );
    expect(BADGE_PARSERS.talk(doc)).toBe(6);
  });
  it('slack counts unread channel rows', () => {
    const doc = docFrom(
      '<div class="p-channel_sidebar__channel--unread"></div>' +
      '<div class="p-channel_sidebar__channel--unread"></div>',
    );
    expect(BADGE_PARSERS.slack(doc)).toBe(2);
  });
  it('messenger counts unread, non-muted conversations', () => {
    const doc = docFrom(
      '<a href="/messages/t/1"><span>Unread message:</span></a>' +
      '<a href="/messages/t/2"><span>Unread message:</span><i style="--disabled-icon:1"></i></a>' +
      '<a href="/messages/t/3">read</a>',
    );
    expect(BADGE_PARSERS.messenger(doc)).toBe(1);
  });
  it('messenger dedupes the same unread thread across multiple anchors', () => {
    const doc = docFrom(
      '<a href="/messages/t/9"><span>Unread message:</span></a>' +
      '<a href="/messages/t/9"><span>Unread message:</span></a>',
    );
    expect(BADGE_PARSERS.messenger(doc)).toBe(1);
  });
  it('telegram counts numeric unread badges, skipping action buttons', () => {
    const doc = docFrom(
      '<span class="chat-badge-transition">3</span>' +
      '<span class="chat-badge-transition">12</span>' +
      '<span class="chat-badge-transition">Open</span>',
    );
    expect(BADGE_PARSERS.telegram(doc)).toBe(2);
  });
});
