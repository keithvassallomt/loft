import { describe, it, expect, vi } from 'vitest';
import {
  parseShowBanners, watchSystemDnd, defaultSystemDndDeps, selectSystemDndBackend,
  shellHelperDeps, inhibitedDeps, type SystemDndDeps, type HelperDndSource,
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
    expect(selectSystemDndBackend({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe('freedesktop-inhibited');
    expect(selectSystemDndBackend({ XDG_CURRENT_DESKTOP: 'KDE', FLATPAK_ID: 'chat.loft.Loft' }))
      .toBe('freedesktop-inhibited');
  });
  it('tries Inhibited on every other desktop instead of giving up', () => {
    // Inhibited is not KDE-only by nature, just KDE-tested. Probing it costs no new sandbox
    // permission (org.freedesktop.Notifications is already talk-granted) and a server that does
    // not implement it answers a clean "No such property" — which reads as unknown. So any
    // daemon that does implement it works for free, rather than being excluded by an allowlist.
    for (const d of ['XFCE', 'X-Cinnamon', 'MATE', 'sway', 'Hyprland', 'LXQt', 'COSMIC', 'Budgie']) {
      expect(selectSystemDndBackend({ XDG_CURRENT_DESKTOP: d })).toBe('freedesktop-inhibited');
    }
  });
  it('tries Inhibited even when the desktop is unset', () => {
    expect(selectSystemDndBackend({})).toBe('freedesktop-inhibited');
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

  it('still listens for changes when the initial read fails', async () => {
    // Deliberately tolerant, and this is the KDE backend's long-standing behaviour: a server
    // that cannot answer Get right now (starting up, property added later) should not cost us
    // the change stream. Nothing is reported until it actually says something.
    const h = fakeHelper(async () => { throw new Error('UnknownProperty'); });
    const onChange = vi.fn();

    shellHelperDeps(h.connect).watch(onChange);
    await vi.waitFor(() => expect(h.subscribed()).toBe(true));
    expect(onChange).not.toHaveBeenCalled();

    h.emit(true);

    expect(onChange).toHaveBeenCalledWith(true);
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

describe('propertyDeps connect retry', () => {
  // A manual clock: the retry must be driven, not waited out, or the suite pays 30s.
  const clock = () => {
    let due: Array<{ id: number; fn: () => void }> = [];
    let next = 1;
    return {
      timers: {
        set: (fn: () => void) => { const id = next++; due.push({ id, fn }); return id; },
        clear: (t: unknown) => { due = due.filter((d) => d.id !== t); },
      },
      pending: () => due.length,
      tick: () => { const run = due; due = []; for (const d of run) d.fn(); },
    };
  };

  const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

  // The point of the whole change: a property owner that is not on the bus yet at login must
  // not disable system-DND detection for the session. Loft lost exactly this race against
  // org.freedesktop.Notifications on a measured 2026-09-09 login.
  it('picks the property up when its owner appears after the first attempt fails', async () => {
    const c = clock();
    let live = false;
    const connect = vi.fn(async () => {
      if (!live) throw new Error('ServiceUnknown');
      return {
        read: async () => true,
        subscribe: () => () => {},
        close: () => {},
      };
    });
    const deps = inhibitedDeps(connect, c.timers);
    const onChange = vi.fn();

    deps.watch(onChange);
    await settle();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(deps.current()).toBeNull();       // unknown, never a confident "off"

    live = true;                              // the shell finishes starting
    c.tick();
    await settle();

    expect(deps.current()).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  // Bounded on purpose: a desktop whose server has no such property is the common case, and
  // each attempt opens its own session-bus connection. It must not retry for ever.
  it('gives up after the backoff schedule is exhausted', async () => {
    const c = clock();
    const connect = vi.fn(async () => { throw new Error('ServiceUnknown'); });
    const deps = inhibitedDeps(connect, c.timers);

    deps.watch(vi.fn());
    await settle();
    for (let i = 0; i < 10; i++) { c.tick(); await settle(); }

    expect(connect).toHaveBeenCalledTimes(6);  // initial + [0,2,4,8,16]s
    expect(c.pending()).toBe(0);
    expect(deps.current()).toBeNull();
  });

  it('stops retrying once attached', async () => {
    const c = clock();
    const connect = vi.fn(async () => ({
      read: async () => false,
      subscribe: () => () => {},
      close: () => {},
    }));
    const deps = inhibitedDeps(connect, c.timers);

    deps.watch(vi.fn());
    await settle();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(c.pending()).toBe(0);
  });

  // An attached server answering "no such property" HAS answered; retrying the connect would
  // reopen a bus connection every few seconds to be told the same thing.
  it('does not retry the connect when only the initial read fails', async () => {
    const c = clock();
    const connect = vi.fn(async () => ({
      read: async () => { throw new Error('UnknownProperty'); },
      subscribe: () => () => {},
      close: () => {},
    }));
    const deps = inhibitedDeps(connect, c.timers);

    deps.watch(vi.fn());
    await settle();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(c.pending()).toBe(0);
    expect(deps.current()).toBeNull();
  });

  it('cancels a pending retry on stop()', async () => {
    const c = clock();
    const connect = vi.fn(async () => { throw new Error('ServiceUnknown'); });
    const w = inhibitedDeps(connect, c.timers).watch(vi.fn());
    await settle();
    expect(c.pending()).toBe(1);

    w.stop();

    expect(c.pending()).toBe(0);
    c.tick();
    await settle();
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe('inhibitedDeps', () => {
  // Same implementation as the helper backend, pointed at a different property, so these cover
  // the wiring rather than re-testing the shared teardown/race behaviour above.
  function fakeServer(initial: boolean) {
    let cb: ((v: boolean) => void) | null = null;
    let closed = 0;
    return {
      connect: async (): Promise<HelperDndSource> => ({
        read: async () => initial,
        subscribe: (f) => { cb = f; return () => {}; },
        close: () => { closed += 1; },
      }),
      emit: (v: boolean) => cb?.(v),
      closed: () => closed,
    };
  }

  it('takes DND straight from Inhibited, with no negation', async () => {
    // Unlike GNOME's show-banners (which is inverted), Inhibited already means "suppressed".
    const s = fakeServer(true);
    const seen: boolean[] = [];

    inhibitedDeps(s.connect).watch((v) => seen.push(v));

    await vi.waitFor(() => expect(seen).toEqual([true]));
  });

  it('follows the server\'s later changes and releases the bus on stop', async () => {
    const s = fakeServer(false);
    const seen: boolean[] = [];
    const w = inhibitedDeps(s.connect).watch((v) => seen.push(v));
    await vi.waitFor(() => expect(seen).toEqual([false]));

    s.emit(true);
    w.stop();

    expect(seen).toEqual([false, true]);
    expect(s.closed()).toBe(1); // the KDE backend used to leak this connection
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
