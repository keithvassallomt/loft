import { describe, it, expect } from 'vitest';
import { isKde } from '../src/main/trayBackend';
import { buildKwinScript } from '../src/main/kde/kwin';

describe('isKde', () => {
  it('detects KDE tokens case-insensitively', () => {
    expect(isKde({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe(true);
    expect(isKde({ XDG_CURRENT_DESKTOP: 'plasma:KDE' })).toBe(true);
    expect(isKde({ XDG_CURRENT_DESKTOP: 'kde' })).toBe(true);
  });
  it('is false for GNOME / empty', () => {
    expect(isKde({ XDG_CURRENT_DESKTOP: 'GNOME' })).toBe(false);
    expect(isKde({})).toBe(false);
  });
});

describe('buildKwinScript', () => {
  it('matches by caption prefix and feature-detects Plasma 6/5', () => {
    const js = buildKwinScript('show', 'Messenger');
    expect(js).toContain('workspace.windowList');   // Plasma 6
    expect(js).toContain('workspace.clientList');    // Plasma 5 fallback
    expect(js).toContain('"activeWindow" in workspace');
    expect(js).toContain('w.caption === "Messenger"');
    // the builder emits the key literal concatenated with " (" — not a pre-joined literal
    expect(js).toContain('w.caption.indexOf("Messenger" + " (") === 0');
  });
  it('show restores + activates; hide minimizes + skips taskbar', () => {
    const show = buildKwinScript('show', 'A');
    expect(show).toContain('w.skipTaskbar = false');
    expect(show).toContain('w.minimized = false');
    expect(show).toContain('workspace.activeWindow = w');
    const hide = buildKwinScript('hide', 'A');
    expect(hide).toContain('w.skipTaskbar = true');
    expect(hide).toContain('w.minimized = true');
    expect(hide).not.toContain('activeWindow = w');
  });
  it('escapes keys with quotes safely', () => {
    const js = buildKwinScript('show', 'We"ird');
    expect(js).toContain('w.caption === "We\\"ird"');
  });
});
