import { describe, it, expect, vi, beforeEach } from 'vitest';

// child_process is mocked because the side effect under test IS the spawn: a long-lived
// `gsettings monitor` child. Under Flatpak that child is pure liability — it can never report
// anything (the sandbox has no route to the host's dconf, and the Settings portal carries no
// org.gnome.desktop.notifications namespace; re-verified 2026-07-30), and it outlives the
// process: Node does not reap spawned children, and a surviving child holds bwrap open, so the
// app's flatpak instance never exits. GNOME Shell then treats Loft as still running and
// ACTIVATES it on an icon click instead of launching it — the app is unstartable until the
// corpse is killed by hand.
//
// That used to be handled by killing the child from the session-end signal handler. It no
// longer can be: at a Flatpak logout that handler has ~21ms before Chromium aborts, so it
// exits immediately and does no work at all (see shutdown.ts). Not spawning the useless child
// in the first place is what closes the hole.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ stdout: null, on: vi.fn(), kill: vi.fn() })),
  execFileSync: vi.fn(() => 'false'),
}));

// dbus-next is mocked so that watching the Flatpak backend cannot reach the real session bus.
// The Flatpak GNOME backend now connects to the Shell helper, and a unit test that opens a live
// connection is both a flake and a leak.
vi.mock('dbus-next', () => ({
  sessionBus: vi.fn(() => ({
    getProxyObject: vi.fn(async () => { throw new Error('no helper in tests'); }),
    disconnect: vi.fn(),
  })),
}));

const { spawn } = await import('node:child_process');
const { defaultSystemDndDeps } = await import('../src/main/notifications/systemDnd');

const FLATPAK_GNOME = { XDG_CURRENT_DESKTOP: 'GNOME', FLATPAK_ID: 'chat.loft.Loft' };

describe('defaultSystemDndDeps under Flatpak', () => {
  beforeEach(() => vi.mocked(spawn).mockClear());

  it('does not spawn a gsettings monitor on GNOME under Flatpak', () => {
    const deps = defaultSystemDndDeps(FLATPAK_GNOME);

    deps.watch(() => {});

    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports "unknown" rather than a bogus "banners on" under Flatpak', () => {
    // A sandboxed gsettings read does not fail — the schema ships in the freedesktop runtime,
    // so it returns the DEFAULT show-banners=true, i.e. a confident wrong "DND off". null keeps
    // the gate honest until the Shell helper answers: unknown, not "off".
    const deps = defaultSystemDndDeps(FLATPAK_GNOME);

    expect(deps.current()).toBeNull();
  });

  it('still spawns the monitor on GNOME outside Flatpak', () => {
    const deps = defaultSystemDndDeps({ XDG_CURRENT_DESKTOP: 'GNOME' });

    deps.watch(() => {});

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
