import { describe, it, expect } from 'vitest';
import { sanitizeGridNode } from '../src/main/config';
import type { GridNode } from '../src/main/gridTree';

const leaf = (service: string) => ({ kind: 'leaf', service });

describe('sanitizeGridNode', () => {
  it('accepts a well-formed leaf', () => {
    expect(sanitizeGridNode(leaf('whatsapp'))).toEqual(leaf('whatsapp'));
  });

  it('accepts a well-formed nested split and drops unknown keys', () => {
    const raw = {
      kind: 'split', dir: 'row', ratio: 0.6, colour: 'red',
      a: leaf('whatsapp'),
      b: { kind: 'split', dir: 'col', ratio: 0.25, a: leaf('slack'), b: leaf('telegram') },
    };
    expect(sanitizeGridNode(raw)).toEqual({
      kind: 'split', dir: 'row', ratio: 0.6,
      a: leaf('whatsapp'),
      b: { kind: 'split', dir: 'col', ratio: 0.25, a: leaf('slack'), b: leaf('telegram') },
    });
  });

  it('collapses anything malformed to null rather than throwing', () => {
    expect(sanitizeGridNode(undefined)).toBeNull();
    expect(sanitizeGridNode(null)).toBeNull();
    expect(sanitizeGridNode('whatsapp')).toBeNull();
    expect(sanitizeGridNode([])).toBeNull();
    expect(sanitizeGridNode({ kind: 'leaf' })).toBeNull();
    expect(sanitizeGridNode({ kind: 'leaf', service: 42 })).toBeNull();
    expect(sanitizeGridNode({ kind: 'branch', a: leaf('a'), b: leaf('b') })).toBeNull();
    expect(sanitizeGridNode({ kind: 'split', dir: 'diag', ratio: 0.5, a: leaf('a'), b: leaf('b') })).toBeNull();
    expect(sanitizeGridNode({ kind: 'split', dir: 'row', ratio: 0, a: leaf('a'), b: leaf('b') })).toBeNull();
    expect(sanitizeGridNode({ kind: 'split', dir: 'row', ratio: 1, a: leaf('a'), b: leaf('b') })).toBeNull();
    expect(sanitizeGridNode({ kind: 'split', dir: 'row', ratio: Number.NaN, a: leaf('a'), b: leaf('b') })).toBeNull();
    expect(sanitizeGridNode({ kind: 'split', dir: 'row', ratio: 0.5, a: leaf('a') })).toBeNull();
  });

  it('collapses a split whose child is malformed — no half-trees', () => {
    expect(sanitizeGridNode({
      kind: 'split', dir: 'row', ratio: 0.5, a: leaf('whatsapp'), b: { kind: 'leaf' },
    })).toBeNull();
  });

  it('refuses a duplicated service — one view cannot render twice', () => {
    expect(sanitizeGridNode({
      kind: 'split', dir: 'row', ratio: 0.5, a: leaf('whatsapp'), b: leaf('whatsapp'),
    })).toBeNull();
  });

  it('collapses to null when a malformed node is a grandchild, not just a direct child', () => {
    expect(sanitizeGridNode({
      kind: 'split', dir: 'row', ratio: 0.5,
      a: leaf('whatsapp'),
      b: {
        kind: 'split', dir: 'col', ratio: 0.5,
        a: leaf('slack'),
        b: { kind: 'leaf' }, // no `service` — malformed two levels down
      },
    })).toBeNull();
  });

  it('refuses a duplicated service even when the two occurrences sit at different depths', () => {
    expect(sanitizeGridNode({
      kind: 'split', dir: 'row', ratio: 0.5,
      a: leaf('whatsapp'),
      b: {
        kind: 'split', dir: 'col', ratio: 0.5,
        a: leaf('slack'),
        b: leaf('whatsapp'), // same service as the root-level `a`, but nested two levels down
      },
    })).toBeNull();
  });

  it('clamps a ratio outside the structural bounds instead of rejecting it', () => {
    expect(sanitizeGridNode({
      kind: 'split', dir: 'row', ratio: 0.001, a: leaf('whatsapp'), b: leaf('slack'),
    })).toEqual({
      kind: 'split', dir: 'row', ratio: 0.05, a: leaf('whatsapp'), b: leaf('slack'),
    });
  });

  it('does not throw on a chain nested past the depth cap, and collapses it to null', () => {
    // Far deeper than any real grid — gridLayout's minimum cell size refuses splits long
    // before 10 levels — but this is exactly the shape that used to blow the call stack.
    let node: unknown = leaf('base');
    for (let i = 0; i < 10_000; i++) {
      node = { kind: 'split', dir: 'row', ratio: 0.5, a: node, b: leaf(`s${i}`) };
    }
    expect(() => sanitizeGridNode(node)).not.toThrow();
    expect(sanitizeGridNode(node)).toBeNull();
  });

  it('does not throw on a self-referential cycle, and collapses it to null', () => {
    const node = {
      kind: 'split', dir: 'row', ratio: 0.5, a: leaf('whatsapp'), b: leaf('slack'),
    } as unknown as GridNode;
    // Assign the node into its own child slot — reachable in practice once a grid can
    // arrive over IPC, where structured clone preserves cycles a JSON round-trip cannot.
    (node as unknown as { b: unknown }).b = node;
    expect(() => sanitizeGridNode(node)).not.toThrow();
    expect(sanitizeGridNode(node)).toBeNull();
  });

  it('still validates a legitimately deep tree (10 levels) — the cap is not a general depth limit', () => {
    let node: unknown = leaf('leaf0');
    for (let i = 1; i <= 10; i++) {
      node = { kind: 'split', dir: 'row', ratio: 0.5, a: node, b: leaf(`leaf${i}`) };
    }
    expect(sanitizeGridNode(node)).not.toBeNull();
  });
});
