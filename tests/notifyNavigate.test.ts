import { describe, it, expect } from 'vitest';
import { navigateAction } from '../src/preload/notify/navigate';

describe('navigateAction', () => {
  it('clicks the matched anchor for any service', () => {
    expect(navigateAction('messenger', '/t/123', true)).toEqual({ kind: 'click' });
    expect(navigateAction('telegram', '#123', true)).toEqual({ kind: 'click' });
  });
  it('messenger falls back to a full facebook navigation', () => {
    expect(navigateAction('messenger', '/t/123', false)).toEqual({ kind: 'href', url: 'https://www.facebook.com/t/123' });
  });
  it('telegram falls back to the hash route when the key is one', () => {
    expect(navigateAction('telegram', '#123', false)).toEqual({ kind: 'hash', url: '#123' });
  });
  it('telegram with a non-hash key does nothing — no wrong navigation', () => {
    expect(navigateAction('telegram', 'peer-42', false)).toEqual({ kind: 'none' });
  });
  it('an unknown service with no anchor does nothing', () => {
    expect(navigateAction('slack', '/x', false)).toEqual({ kind: 'none' });
  });
});
