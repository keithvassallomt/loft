import { describe, it, expect } from 'vitest';
import { buildRailModel, nextActiveId, orderedRailIds, type RailModelInput } from '../src/main/railModel';
import type { ServiceDef } from '../src/main/registry';

const def = (id: string, displayName: string): ServiceDef =>
  ({ id, displayName, url: `https://${id}.test/`, selfHosted: false, origins: [] });

const SERVICES = [def('whatsapp', 'WhatsApp'), def('slack', 'Slack'), def('element', 'Element')];

function input(over: Partial<RailModelInput> = {}): RailModelInput {
  return {
    services: SERVICES,
    config: { services: { whatsapp: {}, slack: {} } },
    loaded: () => true,
    detached: () => false,
    badge: () => 0,
    activeId: undefined,
    ...over,
  };
}

describe('buildRailModel', () => {
  it('lists only installed services — the rail is not the registry', () => {
    expect(buildRailModel(input()).map((i) => i.id)).toEqual(['whatsapp', 'slack']);
  });

  it('honours railOrder, and sorts unlisted ids after it in registry order', () => {
    const items = buildRailModel(input({
      config: { services: { whatsapp: {}, slack: {}, element: {} }, railOrder: ['slack'] },
    }));
    expect(items.map((i) => i.id)).toEqual(['slack', 'whatsapp', 'element']);
  });

  it('ignores railOrder entries for services that are not installed', () => {
    const items = buildRailModel(input({
      config: { services: { whatsapp: {} }, railOrder: ['slack', 'whatsapp'] },
    }));
    expect(items.map((i) => i.id)).toEqual(['whatsapp']);
  });

  it('marks an unloaded service sleeping and gives it no badge', () => {
    const items = buildRailModel(input({ loaded: (id) => id !== 'slack', badge: () => 7 }));
    const slack = items.find((i) => i.id === 'slack')!;
    expect(slack.sleeping).toBe(true);
    // A sleeping service has no view, so it cannot have scraped a count. Showing a
    // stale one would claim unread messages nothing is watching for.
    expect(slack.badge).toBe(0);
  });

  it('zeroes the badge when the service disables badges, without claiming it is sleeping', () => {
    const items = buildRailModel(input({
      config: { services: { whatsapp: { badgesEnabled: false } } },
      badge: () => 5,
    }));
    expect(items[0].badge).toBe(0);
    expect(items[0].sleeping).toBe(false);
  });

  it('treats a missing badgesEnabled as enabled', () => {
    expect(buildRailModel(input({ badge: () => 3 }))[0].badge).toBe(3);
  });

  it('reports dnd and detached per service', () => {
    const items = buildRailModel(input({
      config: { services: { whatsapp: { dnd: true }, slack: {} } },
      detached: (id) => id === 'slack',
    }));
    expect(items.find((i) => i.id === 'whatsapp')!.dnd).toBe(true);
    expect(items.find((i) => i.id === 'slack')!.detached).toBe(true);
  });

  it('marks exactly one item active, and none when activeId is unknown', () => {
    expect(buildRailModel(input({ activeId: 'slack' })).filter((i) => i.active).map((i) => i.id))
      .toEqual(['slack']);
    expect(buildRailModel(input({ activeId: 'nope' })).some((i) => i.active)).toBe(false);
    expect(buildRailModel(input({ activeId: undefined })).some((i) => i.active)).toBe(false);
  });

  it('never marks a detached service active — it is not a tab in this window', () => {
    const items = buildRailModel(input({ detached: (id) => id === 'slack', activeId: 'slack' }));
    expect(items.some((i) => i.active)).toBe(false);
  });
});

describe('nextActiveId', () => {
  const items = (ids: string[], detached: string[] = [], sleeping: string[] = []) =>
    ids.map((id) => ({
      id, displayName: id, badge: 0, dnd: false, sleeping: sleeping.includes(id),
      detached: detached.includes(id), active: false,
    }));

  it('picks the next attached service after the one closing', () => {
    expect(nextActiveId(items(['a', 'b', 'c']), 'b')).toBe('c');
  });

  it('wraps backwards when the last one closes', () => {
    expect(nextActiveId(items(['a', 'b', 'c']), 'c')).toBe('b');
  });

  it('skips detached services — they are not selectable tabs', () => {
    expect(nextActiveId(items(['a', 'b', 'c'], ['c']), 'b')).toBe('a');
  });

  it('skips sleeping services — they have no view to select, only the manager would show', () => {
    // The failure this guards: unload the active service with the next one asleep, and a
    // naive nextActiveId hands back a sleeping id that select() then refuses — stranding a
    // dead active id and a blank content rect.
    expect(nextActiveId(items(['a', 'b', 'c'], [], ['b']), 'a')).toBe('c');
  });

  it('returns undefined when every remaining attached service is asleep, so the manager shows', () => {
    expect(nextActiveId(items(['a', 'b', 'c'], [], ['b', 'c']), 'a')).toBeUndefined();
  });

  it('returns undefined when nothing attached is left, so the manager shows', () => {
    expect(nextActiveId(items(['a']), 'a')).toBeUndefined();
    expect(nextActiveId(items(['a', 'b'], ['b']), 'a')).toBeUndefined();
  });

  it('returns undefined for an id that is not in the rail', () => {
    expect(nextActiveId(items(['a', 'b']), 'zz')).toBeUndefined();
  });
});

describe('orderedRailIds', () => {
  const services = [
    { id: 'whatsapp', displayName: 'WhatsApp', url: 'u' },
    { id: 'slack', displayName: 'Slack', url: 'u' },
    { id: 'telegram', displayName: 'Telegram', url: 'u' },
  ] as never;

  it('lists only installed services, in registry order when railOrder is absent', () => {
    const config = { services: { whatsapp: {}, telegram: {} } } as never;
    expect(orderedRailIds(services, config)).toEqual(['whatsapp', 'telegram']);
  });

  it('honours railOrder, with unlisted ids after it in registry order', () => {
    const config = {
      services: { whatsapp: {}, slack: {}, telegram: {} },
      railOrder: ['telegram', 'slack'],
    } as never;
    expect(orderedRailIds(services, config)).toEqual(['telegram', 'slack', 'whatsapp']);
  });

  it('ignores railOrder entries for services that are not installed', () => {
    const config = { services: { slack: {} }, railOrder: ['telegram', 'slack'] } as never;
    expect(orderedRailIds(services, config)).toEqual(['slack']);
  });
});
