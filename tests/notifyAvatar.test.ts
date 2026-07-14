import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  resolveIconUrl, pickTalkAvatarSrc, slackSenderFromTitle, findSlackAvatar, scanSlackAvatars,
} from '../src/preload/notify/avatar';

const doc = (html: string): Document => new JSDOM(html).window.document;

describe('resolveIconUrl', () => {
  it('passes data:, resolves relative, drops blob/empty/other', () => {
    expect(resolveIconUrl('', 'https://p/')).toBe('');
    expect(resolveIconUrl('blob:https://p/xyz', 'https://p/')).toBe('');
    expect(resolveIconUrl('data:image/png;base64,AAAA', 'https://p/')).toBe('data:image/png;base64,AAAA');
    expect(resolveIconUrl('/avatar/x/64', 'https://cloud.example/index.php/')).toBe('https://cloud.example/avatar/x/64');
    expect(resolveIconUrl('https://cdn/x.png', 'https://p/')).toBe('https://cdn/x.png');
    expect(resolveIconUrl('ftp://x', 'https://p/')).toBe('');
  });
});

describe('pickTalkAvatarSrc', () => {
  it('matches the longest conversation name contained in the title', () => {
    const d = doc(`
      <span class="conversation-icon__avatar" title="Ann"><img src="/avatar/Ann/64"></span>
      <span class="conversation-icon__avatar" title="Ann Marie"><img src="/avatar/AnnMarie/64"></span>`);
    expect(pickTalkAvatarSrc(d, 'Ann Marie sent you a message')).toBe('/avatar/AnnMarie/64');
    expect(pickTalkAvatarSrc(d, 'Nobody here')).toBe('');
  });
});

describe('slack helpers', () => {
  it('extracts the DM sender name', () => {
    expect(slackSenderFromTitle('New message from Keith')).toBe('Keith');
    expect(slackSenderFromTitle('#general')).toBe('');
  });
  it('finds an avatar by message timestamp and upscales to -128', () => {
    const d = doc(`<div data-msg-ts="171.5">
      <div class="c-base_icon__width_only_container"><img src="https://ca.slack-edge.com/AAA-24"></div></div>`);
    expect(findSlackAvatar(d, new Map(), 'New message from X', 'tag_171.5')).toBe('https://ca.slack-edge.com/AAA-128');
  });
  it('builds a name→avatar cache from rendered messages', () => {
    const d = doc(`<div data-msg-ts="1"><button data-qa="message_sender_name">Keith</button>
      <div class="c-base_icon__width_only_container"><img src="https://ca.slack-edge.com/BBB-48"></div></div>`);
    const cache = new Map<string, string>();
    scanSlackAvatars(d, cache);
    expect(cache.get('Keith')).toBe('https://ca.slack-edge.com/BBB-128');
    expect(findSlackAvatar(doc('<div></div>'), cache, 'New message from Keith', '')).toBe('https://ca.slack-edge.com/BBB-128');
  });
});
