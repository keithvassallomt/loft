import { describe, it, expect } from 'vitest';
import { normalizeJid, findJid } from '../src/preload/conversation/whatsappJid';

describe('normalizeJid', () => {
  it('accepts the forms WhatsApp actually produces', () => {
    expect(normalizeJid('262135443656788@lid')).toBe('262135443656788@lid');
    expect(normalizeJid('120363428915615835@g.us')).toBe('120363428915615835@g.us');
    expect(normalizeJid('35679594809-1434238185@g.us')).toBe('35679594809-1434238185@g.us');
    expect(normalizeJid('0@c.us')).toBe('0@c.us');
    expect(normalizeJid('status@broadcast')).toBe('status@broadcast');
  });

  it('strips the chat- prefix, because rows are keyed chat-<jid> and #main carries the bare jid', () => {
    expect(normalizeJid('chat-120363428915615835@g.us')).toBe('120363428915615835@g.us');
    expect(normalizeJid('chat-0@c.us')).toBe('0@c.us');
    expect(normalizeJid('chat-35679594809-1434238185@g.us')).toBe('35679594809-1434238185@g.us');
  });

  // The regression that matters. __x_chatlistPreview.msgKey is `true_<jid>_<hex>_<jid>`, and
  // a greedy SUBSTRING match yields "true_35679594809-1434238185@g.us" — a wrong answer shaped
  // exactly like a right one. The first spike build had this bug and passed only by luck.
  it('rejects composite values that merely CONTAIN a jid', () => {
    expect(normalizeJid('true_35679594809-1434238185@g.us_AC35EE_96589636968653@lid')).toBeNull();
    expect(normalizeJid('false_35679594809-1434238185@g.us_ACDB4C_61735910260962@lid')).toBeNull();
  });

  it('rejects non-strings and junk', () => {
    for (const v of [undefined, null, 42, {}, [], '', 'plain text', 'nope@example.com']) {
      expect(normalizeJid(v)).toBeNull();
    }
  });
});

describe('findJid', () => {
  it('finds a jid nested in a props-shaped object', () => {
    const props = { children: [null, { key: '262135443656788@lid', props: { chat: {} } }] };
    expect(findJid(props)).toBe('262135443656788@lid');
  });

  it('finds it via the _serialized path too, not just the react key', () => {
    const props = { children: [null, { props: { chat: { __x_id: { _serialized: '99@lid' } } } }] };
    expect(findJid(props)).toBe('99@lid');
  });

  it('is not fooled by a composite sitting alongside a real jid', () => {
    const props = { a: { msgKey: 'true_1@g.us_HEX_2@lid' }, b: { key: '999@lid' } };
    expect(findJid(props)).toBe('999@lid');
  });

  it('terminates on a cyclic graph', () => {
    const node: Record<string, unknown> = { key: 'not a jid' };
    node.self = node;
    node.child2 = { key: '123@lid' };
    expect(findJid(node)).toBe('123@lid');
  });

  it('does not follow fiber link fields, which would crawl the whole app', () => {
    const buried = { key: '123@lid' };
    expect(findJid({ return: buried, child: buried, stateNode: buried, alternate: buried })).toBeNull();
  });

  it('respects the depth cap', () => {
    let deep: unknown = { key: '123@lid' };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    expect(findJid(deep, { maxDepth: 3, maxNodes: 1000 })).toBeNull();
  });

  it('respects the node cap', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) wide[`k${i}`] = { pad: 'x' };
    wide.zlast = { key: '123@lid' };
    expect(findJid(wide, { maxDepth: 8, maxNodes: 5 })).toBeNull();
  });

  it('survives a throwing getter', () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, 'bad', { enumerable: true, get() { throw new Error('boom'); } });
    obj.good = { key: '123@lid' };
    expect(findJid(obj)).toBe('123@lid');
  });

  it('returns null for a graph with no jid', () => {
    expect(findJid({ a: 1, b: 'text', c: { d: [1, 2, 3] } })).toBeNull();
  });

  it('returns null for primitives and nullish roots', () => {
    for (const v of [undefined, null, 42, 'text']) expect(findJid(v)).toBeNull();
  });
});
