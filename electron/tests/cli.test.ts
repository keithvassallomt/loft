import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/main/cli';

describe('parseArgs', () => {
  it('defaults to no service, not verbose, not minimized', () => {
    expect(parseArgs(['electron', '.'])).toEqual({ service: undefined, verbose: false, minimized: false });
  });
  it('parses --service=whatsapp', () => {
    expect(parseArgs(['electron', '.', '--service=whatsapp']).service).toBe('whatsapp');
  });
  it('parses --service whatsapp (space form)', () => {
    expect(parseArgs(['electron', '.', '--service', 'slack']).service).toBe('slack');
  });
  it('parses --verbose and --minimized', () => {
    const a = parseArgs(['electron', '.', '--verbose', '--minimized']);
    expect(a.verbose).toBe(true);
    expect(a.minimized).toBe(true);
  });
  it('does not consume a flag as --service value', () => {
    expect(parseArgs(['electron', '.', '--service', '--verbose'])).toEqual({ service: undefined, verbose: true, minimized: false });
  });
  it('parses -v alias for verbose', () => {
    expect(parseArgs(['electron', '.', '-v']).verbose).toBe(true);
  });
});
