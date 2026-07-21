import { describe, it, expect } from 'vitest';
import { sanitizeGridNode } from '../src/main/config';

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
});
