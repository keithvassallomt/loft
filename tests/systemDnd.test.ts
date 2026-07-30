import { describe, it, expect, vi } from 'vitest';
import {
  parseShowBanners, watchSystemDnd, defaultSystemDndDeps, selectSystemDndBackend,
  shellHelperDeps, type SystemDndDeps, type HelperDndSource,
} from '../src/main/notifications/systemDnd';

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

describe('selectSystemDndBackend', () => {
  it('routes GNOME under Flatpak to the Shell helper, not to nothing', () => {
    // The sandbox has no route to the host's dconf and the Settings portal does not carry
    // org.gnome.desktop.notifications, so gsettings is out. The helper runs INSIDE
    // gnome-shell, outside the sandbox, and Loft already has talk access to its bus name.
    expect(selectSystemDndBackend({ XDG_CURRENT_DESKTOP: 'GNOME', FLATPAK_ID: 'chat.loft.Loft' }))
      .toBe('gnome-shell-helper');
  });
  it('keeps unsandboxed GNOME on gsettings, which needs no extension', () => {
    expect(selectSystemDndBackend({ XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('gnome-gsettings');
  });
  it('keeps KDE on the Inhibited property, sandboxed or not', () => {
    expect(selectSystemDndBackend({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe('kde');
    expect(selectSystemDndBackend({ XDG_CURRENT_DESKTOP: 'KDE', FLATPAK_ID: 'chat.loft.Loft' })).toBe('kde');
  });
  it('has no backend for other desktops', () => {
    expect(selectSystemDndBackend({})).toBe('none');
  });
});

describe('shellHelperDeps', () => {
  function fakeHelper(initial: boolean | (() => Promise<boolean>)) {
    let cb: ((v: boolean) => void) | null = null;
    let unsubscribed = false;
    let closed = 0;
    const source: HelperDndSource = {
      read: typeof initial === 'function' ? initial : async () => initial,
      subscribe: (f) => { cb = f; return () => { unsubscribed = true; }; },
      close: () => { closed += 1; },
    };
    return {
      connect: async () => source,
      emit: (v: boolean) => cb?.(v),
      unsubscribed: () => unsubscribed,
      subscribed: () => cb !== null,
      closed: () => closed,
    };
  }

  it('reports the helper\'s current DND state once the async read resolves', async () => {
    const h = fakeHelper(true);
    const seen: boolean[] = [];

    shellHelperDeps(h.connect).watch((v) => seen.push(v));

    await vi.waitFor(() => expect(seen).toEqual([true]));
  });

  it('caches the resolved value so current() stops saying "unknown"', async () => {
    const h = fakeHelper(true);
    const deps = shellHelperDeps(h.connect);
    expect(deps.current()).toBeNull(); // async backend: nothing known yet

    deps.watch(() => {});

    await vi.waitFor(() => expect(deps.current()).toBe(true));
  });

  it('reports later changes pushed by the helper', async () => {
    const h = fakeHelper(false);
    const seen: boolean[] = [];
    shellHelperDeps(h.connect).watch((v) => seen.push(v));
    await vi.waitFor(() => expect(h.subscribed()).toBe(true));

    h.emit(true);

    expect(seen).toEqual([false, true]);
  });

  it('stays unknown when the helper is missing or too old to have the property', async () => {
    // An installed-from-EGO helper predating this change answers UnknownProperty. That must
    // read as "unknown" — never a confident "DND off", which is the bug being fixed.
    const onChange = vi.fn();
    const deps = shellHelperDeps(async () => { throw new Error('UnknownProperty'); });

    deps.watch(onChange);
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.current()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes the bus connection it opened when stopped', async () => {
    // A session-bus connection left open under Flatpak is the documented unstartable-app
    // failure: the flatpak instance never exits, so GNOME activates a corpse on the next
    // click. stop() is the only chance to release it — the session-end handler has ~21ms
    // and does nothing but exit (shutdown.ts).
    const h = fakeHelper(true);
    const deps = shellHelperDeps(h.connect);

    const w = deps.watch(() => {});
    await vi.waitFor(() => expect(h.subscribed()).toBe(true));
    w.stop();

    expect(h.closed()).toBe(1);
  });

  it('closes the connection even when the property read fails', async () => {
    // The failure path leaks just as hard as the success path, and an old EGO-installed
    // helper makes it the COMMON path, not the rare one.
    const h = fakeHelper(async () => { throw new Error('UnknownProperty'); });

    shellHelperDeps(h.connect).watch(() => {});

    await vi.waitFor(() => expect(h.closed()).toBe(1));
  });

  it('delivers nothing after stop(), even when stop races the async connect', async () => {
    const h = fakeHelper(true);
    const onChange = vi.fn();

    const w = shellHelperDeps(h.connect).watch(onChange);
    w.stop(); // fires while connect() is still in flight
    await vi.waitFor(() => expect(h.unsubscribed()).toBe(true));

    h.emit(false);
    expect(onChange).not.toHaveBeenCalled();
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
