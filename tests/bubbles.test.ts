import { describe, it, expect } from 'vitest';
import {
  bubbleId, addBubble, removeBubble, removeServiceBubbles, refreshBubbleTitle,
  findBubble, sanitizeBubbles, type Bubble,
} from '../src/main/bubbles';

const b = (serviceId: string, key: string, title: string): Bubble =>
  ({ id: bubbleId(serviceId, key), serviceId, key, title });

describe('bubbleId', () => {
  it('is stable for the same service and key', () => {
    expect(bubbleId('whatsapp', '123@lid')).toBe(bubbleId('whatsapp', '123@lid'));
  });
  it('differs per service, so two accounts pinning one chat get two bubbles', () => {
    expect(bubbleId('whatsapp', '123@lid')).not.toBe(bubbleId('whatsapp-2', '123@lid'));
  });
  it('is filesystem and URL safe — it names a file and a loft:// path', () => {
    expect(bubbleId('whatsapp', '35679-1434@g.us')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(bubbleId('talk', '/call/abc?x=1#y')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('addBubble', () => {
  it('appends', () => {
    expect(addBubble([], 'whatsapp', '123@lid', 'Dan')).toEqual([b('whatsapp', '123@lid', 'Dan')]);
  });
  it('is idempotent — pinning the same conversation twice is a no-op', () => {
    const once = addBubble([], 'whatsapp', '123@lid', 'Dan');
    expect(addBubble(once, 'whatsapp', '123@lid', 'Dan renamed')).toHaveLength(1);
  });
  it('does not mutate its input', () => {
    const before: Bubble[] = [];
    addBubble(before, 'whatsapp', '123@lid', 'Dan');
    expect(before).toHaveLength(0);
  });
});

describe('removeBubble / removeServiceBubbles', () => {
  const list = [b('whatsapp', '1@lid', 'A'), b('whatsapp', '2@lid', 'B'), b('slack', 'C1', 'C')];
  it('removes one by id', () => {
    expect(removeBubble(list, bubbleId('whatsapp', '1@lid')).map((x) => x.key)).toEqual(['2@lid', 'C1']);
  });
  it('removes every bubble of a service, so a removed service leaves none behind', () => {
    expect(removeServiceBubbles(list, 'whatsapp').map((x) => x.key)).toEqual(['C1']);
  });
  it('leaves the list alone for an unknown id', () => {
    expect(removeBubble(list, 'nope')).toHaveLength(3);
  });
});

describe('refreshBubbleTitle', () => {
  const list = [b('whatsapp', '1@lid', 'Old Name')];
  it('updates a renamed conversation', () => {
    expect(refreshBubbleTitle(list, 'whatsapp', '1@lid', 'New Name')[0].title).toBe('New Name');
  });
  it('returns the SAME array reference when nothing changed, so callers can skip a config write', () => {
    expect(refreshBubbleTitle(list, 'whatsapp', '1@lid', 'Old Name')).toBe(list);
    expect(refreshBubbleTitle(list, 'whatsapp', 'unpinned@lid', 'X')).toBe(list);
  });
});

describe('findBubble', () => {
  it('finds by id', () => {
    const list = [b('slack', 'C1', 'general')];
    expect(findBubble(list, bubbleId('slack', 'C1'))?.title).toBe('general');
    expect(findBubble(list, 'missing')).toBeUndefined();
  });
});

describe('sanitizeBubbles', () => {
  it('returns [] for anything that is not an array', () => {
    for (const v of [undefined, null, 42, 'x', {}]) expect(sanitizeBubbles(v)).toEqual([]);
  });
  it('keeps good entries and drops malformed ones', () => {
    const out = sanitizeBubbles([
      { serviceId: 'whatsapp', key: '1@lid', title: 'Good' },
      { serviceId: '', key: '1@lid', title: 'no service' },
      { serviceId: 'slack', key: '', title: 'no key' },
      { serviceId: 'slack', key: 'C1', title: 42 },
      null,
      ['nope'],
      { serviceId: 'slack', key: 'C2', title: 'Also good' },
    ]);
    expect(out.map((x) => x.title)).toEqual(['Good', 'Also good']);
  });
  it('recomputes the id rather than trusting it — it names a file on disk', () => {
    const out = sanitizeBubbles([{ id: '../../etc/passwd', serviceId: 'slack', key: 'C1', title: 'x' }]);
    expect(out[0].id).toBe(bubbleId('slack', 'C1'));
  });
  it('drops duplicates of the same conversation', () => {
    const out = sanitizeBubbles([
      { serviceId: 'slack', key: 'C1', title: 'first' },
      { serviceId: 'slack', key: 'C1', title: 'second' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('first');
  });
});
