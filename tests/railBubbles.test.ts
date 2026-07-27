import { describe, it, expect } from 'vitest';
import { buildBubbleItems } from '../src/main/railModel';
import { bubbleId, type Bubble } from '../src/main/bubbles';

const b = (serviceId: string, key: string, title: string): Bubble =>
  ({ id: bubbleId(serviceId, key), serviceId, key, title });

/** Second accounts resolve to their kind; everything else is its own kind. */
const kindOf = (id: string): string => (id === 'whatsapp-2' ? 'whatsapp' : id);

describe('buildBubbleItems', () => {
  it('keeps pin order', () => {
    const items = buildBubbleItems(
      [b('slack', 'C1', 'general'), b('whatsapp', '1@lid', 'Dan')],
      new Set(['slack', 'whatsapp']), kindOf);
    expect(items.map((i) => i.title)).toEqual(['general', 'Dan']);
  });

  it('carries the KIND for the corner badge, not the instance id', () => {
    const items = buildBubbleItems([b('whatsapp-2', '1@lid', 'Dan')], new Set(['whatsapp-2']), kindOf);
    expect(items[0]).toMatchObject({
      id: bubbleId('whatsapp-2', '1@lid'), title: 'Dan', serviceId: 'whatsapp-2', kind: 'whatsapp',
    });
  });

  it('carries a glyph and hue for the no-avatar fallback', () => {
    const items = buildBubbleItems(
      [b('slack', 'C1', '#general'), b('slack', 'C2', '#random')],
      new Set(['slack']), kindOf);
    // The point of the change: two channels must not look identical.
    expect(items[0].glyph).toBe('#GE');
    expect(items[1].glyph).toBe('#RA');
    expect(items[0].hue).not.toBe(items[1].hue);
  });

  it('hides bubbles whose service is no longer installed, rather than rendering a dead button', () => {
    const items = buildBubbleItems([b('gone', 'X', 'Ghost')], new Set(['slack']), kindOf);
    expect(items).toEqual([]);
  });

  it('keeps the installed ones while dropping an orphan', () => {
    const items = buildBubbleItems(
      [b('gone', 'X', 'Ghost'), b('slack', 'C1', 'general')], new Set(['slack']), kindOf);
    expect(items.map((i) => i.title)).toEqual(['general']);
  });

  it('returns [] for no bubbles', () => {
    expect(buildBubbleItems([], new Set(['slack']), kindOf)).toEqual([]);
  });
});
