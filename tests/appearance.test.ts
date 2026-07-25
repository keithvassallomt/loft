import { describe, it, expect, vi } from 'vitest';
import { colorSchemeToDark, watchAppearance, defaultAppearanceDeps, type AppearanceDeps } from '../src/main/appearance';

describe('colorSchemeToDark', () => {
  it('maps the freedesktop org.freedesktop.appearance color-scheme enum', () => {
    expect(colorSchemeToDark(1)).toBe(true);  // prefer dark
    expect(colorSchemeToDark(0)).toBe(false); // no preference -> light (as the CSS spec resolves it)
    expect(colorSchemeToDark(2)).toBe(false); // prefer light
  });
  it('unwraps dbus Variant values (ReadOne returns <u>, older Read returns <<u>>)', () => {
    expect(colorSchemeToDark({ value: 1 })).toBe(true);
    expect(colorSchemeToDark({ value: { value: 1 } })).toBe(true);
    expect(colorSchemeToDark({ value: { value: 0 } })).toBe(false);
  });
  it('returns null for anything that is not a scheme we recognise', () => {
    expect(colorSchemeToDark(7)).toBe(null);
    expect(colorSchemeToDark('dark')).toBe(null);
    expect(colorSchemeToDark(null)).toBe(null);
    expect(colorSchemeToDark(undefined)).toBe(null);
    expect(colorSchemeToDark({})).toBe(null);
  });
});

describe('watchAppearance', () => {
  function fakeDeps(initial: boolean | null): {
    deps: AppearanceDeps; emit: (v: boolean) => void; stopped: () => boolean;
  } {
    let cb: (dark: boolean) => void = () => {};
    let stopped = false;
    return {
      deps: { current: () => initial, watch: (onChange) => { cb = onChange; return { stop: () => { stopped = true; } }; } },
      emit: (v) => cb(v),
      stopped: () => stopped,
    };
  }

  it('applies the first async value and reports only real transitions', () => {
    const onChange = vi.fn();
    const f = fakeDeps(null); // portal is async: no synchronous seed
    const w = watchAppearance(onChange, f.deps);
    f.emit(true);                       // first known value -> dark
    expect(onChange).toHaveBeenCalledWith(true);
    expect(w.current()).toBe(true);
    f.emit(true);                       // identical repeat -> swallowed
    expect(onChange).toHaveBeenCalledTimes(1);
    f.emit(false);                      // dark -> light
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(w.current()).toBe(false);
    w.stop();
    expect(f.stopped()).toBe(true);
  });

  it('does not fire when the first value equals a known seed', () => {
    const onChange = vi.fn();
    const f = fakeDeps(false);
    const w = watchAppearance(onChange, f.deps);
    f.emit(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(w.current()).toBe(false);
  });
});

describe('defaultAppearanceDeps', () => {
  it('returns a usable deps object without opening a bus or throwing', () => {
    // The live portal/D-Bus backend is exercised manually; construction and current() must
    // not connect or throw (the connection is deferred to watch()).
    const d = defaultAppearanceDeps();
    expect(typeof d.current).toBe('function');
    expect(typeof d.watch).toBe('function');
    expect(() => d.current()).not.toThrow();
  });
});
