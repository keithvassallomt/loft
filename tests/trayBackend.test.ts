import { describe, it, expect } from 'vitest';
import { resolveTrayBackend, isGnome } from '../src/main/trayBackend';

describe('resolveTrayBackend', () => {
  it('auto → gnome-panel on GNOME', () => {
    expect(resolveTrayBackend('auto', { XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('gnome-panel');
    expect(resolveTrayBackend(undefined, { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBe('gnome-panel');
    expect(resolveTrayBackend('auto', { XDG_CURRENT_DESKTOP: 'gnome' })).toBe('gnome-panel'); // case-insensitive
  });
  it('auto → sni off GNOME', () => {
    expect(resolveTrayBackend('auto', { XDG_CURRENT_DESKTOP: 'KDE' })).toBe('sni');
    expect(resolveTrayBackend(undefined, {})).toBe('sni');
    expect(resolveTrayBackend('auto', { XDG_CURRENT_DESKTOP: 'GNOME-Classic' })).toBe('sni'); // token match, not substring
  });
  it('concrete values pass through', () => {
    expect(resolveTrayBackend('sni', { XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('sni');
    expect(resolveTrayBackend('gnome-panel', {})).toBe('gnome-panel');
  });
});

describe('isGnome', () => {
  it('matches a GNOME token, not a substring', () => {
    expect(isGnome({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBe(true);
    expect(isGnome({ XDG_CURRENT_DESKTOP: 'GNOME-Classic' })).toBe(false);
    expect(isGnome({})).toBe(false);
  });
});
