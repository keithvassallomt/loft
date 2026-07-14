import { describe, it, expect, vi } from 'vitest';
import { parseShowBanners, watchSystemDnd, defaultSystemDndDeps, type SystemDndDeps } from '../src/main/notifications/systemDnd';

describe('parseShowBanners', () => {
  it('parses gsettings get + monitor lines', () => {
    expect(parseShowBanners('true')).toBe(true);
    expect(parseShowBanners('false')).toBe(false);
    expect(parseShowBanners("  org.gnome.desktop.notifications show-banners: false")).toBe(false);
    expect(parseShowBanners('nonsense')).toBe(null);
  });
});

describe('watchSystemDnd', () => {
  function fakeDeps(initial: boolean | null): { deps: SystemDndDeps; emit: (v: boolean) => void; stopped: () => boolean } {
    let cb: (dnd: boolean) => void = () => {};
    let stopped = false;
    return {
      deps: { current: () => initial, watch: (onChange) => { cb = onChange; return { stop: () => { stopped = true; } }; } },
      emit: (v) => cb(v),
      stopped: () => stopped,
    };
  }
  it('seeds from current() and reports only real transitions', () => {
    const onChange = vi.fn();
    const f = fakeDeps(false);
    const w = watchSystemDnd(onChange, f.deps);
    expect(w.current()).toBe(false);
    f.emit(false);            // no transition
    expect(onChange).not.toHaveBeenCalled();
    f.emit(true);             // transition → dnd on
    expect(onChange).toHaveBeenCalledWith(true);
    expect(w.current()).toBe(true);
    w.stop();
    expect(f.stopped()).toBe(true);
  });
  it('treats unknown initial as not-DND and applies the first async value', () => {
    const onChange = vi.fn();
    const f = fakeDeps(null);
    const w = watchSystemDnd(onChange, f.deps);
    expect(w.current()).toBe(false);
    f.emit(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('defaultSystemDndDeps', () => {
  it('selects by desktop environment without throwing', () => {
    // We only assert it returns a usable deps object per env; the live gsettings/
    // D-Bus backends are exercised manually. current() must be callable + not throw.
    for (const env of [{ XDG_CURRENT_DESKTOP: 'KDE' }, { XDG_CURRENT_DESKTOP: 'GNOME' }, {}]) {
      const d = defaultSystemDndDeps(env);
      expect(typeof d.current).toBe('function');
      expect(typeof d.watch).toBe('function');
      expect(() => d.current()).not.toThrow();
    }
  });
});
