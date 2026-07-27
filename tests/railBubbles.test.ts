import { describe, it, expect } from 'vitest';
import { buildBubbleItems, buildRailState, type RailStateInput } from '../src/main/railModel';
import { bubbleId, type Bubble } from '../src/main/bubbles';
import type { LoftConfig } from '../src/main/config';
import type { ServiceKind } from '../src/main/registry';

const b = (serviceId: string, key: string, title: string): Bubble =>
  ({ id: bubbleId(serviceId, key), serviceId, key, title });

/** Second accounts resolve to their kind; everything else is its own kind. */
const kindOf = (id: string): string => (id === 'whatsapp-2' ? 'whatsapp' : id);

/** Defaults: everything installed, awake, and read. */
const build = (bubbles: Bubble[], over: Partial<Parameters<typeof buildBubbleItems>[0]> = {}) =>
  buildBubbleItems({
    bubbles,
    installed: new Set(bubbles.map((x) => x.serviceId)),
    kindOf,
    sleeping: () => false,
    unread: () => false,
    ...over,
  });

describe('buildBubbleItems', () => {
  it('keeps pin order', () => {
    const items = build([b('slack', 'C1', 'general'), b('whatsapp', '1@lid', 'Dan')]);
    expect(items.map((i) => i.title)).toEqual(['general', 'Dan']);
  });

  it('carries the KIND for the corner badge, not the instance id', () => {
    const items = build([b('whatsapp-2', '1@lid', 'Dan')]);
    expect(items[0]).toMatchObject({
      id: bubbleId('whatsapp-2', '1@lid'), title: 'Dan', serviceId: 'whatsapp-2', kind: 'whatsapp',
    });
  });

  it('carries a glyph and hue for the no-avatar fallback', () => {
    const items = build([b('slack', 'C1', '#general'), b('slack', 'C2', '#random')]);
    // The point of the change: two channels must not look identical.
    expect(items[0].glyph).toBe('#GE');
    expect(items[1].glyph).toBe('#RA');
    expect(items[0].hue).not.toBe(items[1].hue);
  });

  it('hides bubbles whose service is no longer installed, rather than rendering a dead button', () => {
    const items = buildBubbleItems({
      bubbles: [b('gone', 'X', 'Ghost')],
      installed: new Set(['slack']),
      kindOf,
      sleeping: () => false,
      unread: () => false,
    });
    expect(items).toEqual([]);
  });

  it('keeps the installed ones while dropping an orphan', () => {
    const items = buildBubbleItems({
      bubbles: [b('gone', 'X', 'Ghost'), b('slack', 'C1', 'general')],
      installed: new Set(['slack']),
      kindOf,
      sleeping: () => false,
      unread: () => false,
    });
    expect(items.map((i) => i.title)).toEqual(['general']);
  });

  it('returns [] for no bubbles', () => {
    expect(build([])).toEqual([]);
  });

  // --- the unread dot ---

  it('marks the bubble whose key is unread, and only that one', () => {
    const items = build(
      [b('slack', 'C1', 'general'), b('slack', 'C2', 'random')],
      { unread: (sid, key) => sid === 'slack' && key === 'C1' },
    );
    expect(items.map((i) => i.unread)).toEqual([true, false]);
  });

  it('keys unread on the SERVICE as well as the conversation', () => {
    // Two accounts of one kind can pin the same conversation key; they are different bubbles,
    // and only the account that actually has it unread should show a dot.
    const items = build(
      [b('whatsapp', '1@lid', 'Dan'), b('whatsapp-2', '1@lid', 'Dan')],
      { unread: (sid) => sid === 'whatsapp-2' },
    );
    expect(items.map((i) => i.unread)).toEqual([false, true]);
  });

  // --- sleeping ---

  it('marks a bubble sleeping when its service is asleep', () => {
    const items = build(
      [b('slack', 'C1', 'general'), b('whatsapp', '1@lid', 'Dan')],
      { sleeping: (sid) => sid === 'slack' },
    );
    expect(items.map((i) => i.sleeping)).toEqual([true, false]);
  });
});

/**
 * The gating rule, which is where this feature is most likely to go wrong: the adapters report
 * what they see, and buildRailState alone decides what is shown.
 */
describe('buildRailState bubble gating', () => {
  const kinds: ServiceKind[] = [
    { id: 'slack', displayName: 'Slack' } as ServiceKind,
    { id: 'whatsapp', displayName: 'WhatsApp' } as ServiceKind,
  ];

  const state = (over: Partial<RailStateInput> = {}) => buildRailState({
    services: kinds,
    config: { services: { slack: {}, whatsapp: {} } } as unknown as LoftConfig,
    loaded: () => true,
    detached: () => false,
    badge: () => 0,
    activeId: undefined,
    grid: null,
    iconEpoch: 1,
    bubbles: [b('slack', 'C1', 'general')],
    kindOf: (id) => id,
    unreadKeys: () => new Set(['C1']),
    ...over,
  });

  it('shows the dot when the service is loaded and badges are on', () => {
    expect(state().bubbles[0].unread).toBe(true);
  });

  // Same rule buildRailModel applies to the service's own badge: no view, no honest answer.
  it('shows no dot for a sleeping service, and marks the bubble sleeping', () => {
    const s = state({ loaded: () => false });
    expect(s.bubbles[0]).toMatchObject({ unread: false, sleeping: true });
  });

  it('shows no dot when that service has badges disabled', () => {
    const s = state({
      config: { services: { slack: { badgesEnabled: false }, whatsapp: {} } } as unknown as LoftConfig,
    });
    expect(s.bubbles[0].unread).toBe(false);
  });

  // DND does not suppress a service's badge, and the rail shows it separately with its own
  // mark, so it must not suppress the dot either.
  it('still shows the dot when that service is on Do Not Disturb', () => {
    const s = state({
      config: { services: { slack: { dnd: true }, whatsapp: {} } } as unknown as LoftConfig,
    });
    expect(s.bubbles[0].unread).toBe(true);
  });

  it('shows no dot when the key is not in the unread set', () => {
    expect(state({ unreadKeys: () => new Set(['C99']) }).bubbles[0].unread).toBe(false);
  });

  // Element alone reports room TITLES, its markup carrying no room id anywhere. Matching on
  // title as well as key is what lets its contribution land at all.
  it('matches on the TITLE too, for the one service that can only report titles', () => {
    const s = state({ unreadKeys: () => new Set(['general']) });
    expect(s.bubbles[0].unread).toBe(true);
  });
});
