import { describe, it, expect } from 'vitest';
import { formatAggregate } from '../src/main/gnome/backgroundStatus';

const s = (arr: Array<[string, number]>) => arr.map(([displayName, badge]) => ({ displayName, badge }));

describe('formatAggregate', () => {
  it('empty → ""', () => expect(formatAggregate([])).toBe(''));
  it('one running, no unread', () => expect(formatAggregate(s([['WhatsApp', 0]]))).toBe('1 service running'));
  it('many running, no unread', () => expect(formatAggregate(s([['WhatsApp', 0], ['Slack', 0]]))).toBe('2 services running'));
  it('exactly one unread', () => expect(formatAggregate(s([['WhatsApp', 4], ['Slack', 0]]))).toBe('WhatsApp: 4 unread'));
  it('multiple unread', () => expect(formatAggregate(s([['WhatsApp', 4], ['Slack', 3]]))).toBe('7 unread (WhatsApp 4, Slack 3)'));
});
