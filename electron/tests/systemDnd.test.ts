import { describe, it, expect, vi } from 'vitest';
import { parseShowBanners, watchSystemDnd } from '../src/main/notifications/systemDnd';

describe('parseShowBanners', () => {
  it('parses gsettings get output', () => {
    expect(parseShowBanners('true')).toBe(true);
    expect(parseShowBanners('false\n')).toBe(false);
  });
  it('parses gsettings monitor output', () => {
    expect(parseShowBanners('show-banners: false')).toBe(false);
    expect(parseShowBanners("  show-banners: true ")).toBe(true);
  });
  it('returns null for noise', () => {
    expect(parseShowBanners('')).toBeNull();
    expect(parseShowBanners('nonsense')).toBeNull();
  });
});

describe('watchSystemDnd', () => {
  it('seeds from the initial value and updates on monitor lines (DND = !show-banners)', () => {
    let emit: (line: string) => void = () => {};
    const changes: boolean[] = [];
    const w = watchSystemDnd((dnd) => changes.push(dnd), {
      getInitial: () => 'true',                         // banners on → DND off
      spawnMonitor: (onLine) => { emit = onLine; return { kill: vi.fn() }; },
    });
    expect(w.current()).toBe(false);
    emit('show-banners: false');                        // banners off → DND on
    expect(w.current()).toBe(true);
    expect(changes).toEqual([true]);                    // only real transitions emit
    emit('show-banners: false');                        // no change
    expect(changes).toEqual([true]);
    w.stop();
  });
  it('treats a missing initial value as no DND', () => {
    const w = watchSystemDnd(() => {}, { getInitial: () => null, spawnMonitor: () => ({ kill: () => {} }) });
    expect(w.current()).toBe(false);
    w.stop();
  });
});
