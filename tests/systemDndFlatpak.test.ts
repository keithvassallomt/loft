import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked because the side effect under test IS the spawn: a long-lived `gsettings monitor`
// child. Under Flatpak that child is pure liability — it can never report anything (the
// sandbox has no route to the host's dconf, so it reads empty in-sandbox schema defaults;
// see the KNOWN LIMITATION block in systemDnd.ts and CLAUDE.md §9), and it outlives the
// process: Node does not reap spawned children, and a surviving child holds bwrap open, so
// the app's flatpak instance never exits. GNOME Shell then treats Loft as still running and
// ACTIVATES it on an icon click instead of launching it — the app is unstartable until the
// corpse is killed by hand.
//
// That used to be handled by killing the child from the session-end signal handler. It no
// longer can be: at a Flatpak logout that handler has ~21ms before Chromium aborts, so it
// exits immediately and does no work at all (see shutdown.ts). Not spawning the useless
// child in the first place is what closes the hole.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ stdout: null, on: vi.fn(), kill: vi.fn() })),
  execFileSync: vi.fn(() => 'false'),
}));

const { spawn } = await import('node:child_process');
const { defaultSystemDndDeps } = await import('../src/main/notifications/systemDnd');

describe('defaultSystemDndDeps under Flatpak', () => {
  beforeEach(() => vi.mocked(spawn).mockClear());

  it('does not spawn a gsettings monitor on GNOME under Flatpak', () => {
    const deps = defaultSystemDndDeps({ XDG_CURRENT_DESKTOP: 'GNOME', FLATPAK_ID: 'chat.loft.Loft' });

    deps.watch(() => {});

    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports "unknown" rather than a bogus "banners on" under Flatpak', () => {
    // The sandboxed read returns the schema default (show-banners=true → DND off), which
    // would masquerade as a real answer. null keeps the gate honest: unknown, not "off".
    const deps = defaultSystemDndDeps({ XDG_CURRENT_DESKTOP: 'GNOME', FLATPAK_ID: 'chat.loft.Loft' });

    expect(deps.current()).toBeNull();
  });

  it('still spawns the monitor on GNOME outside Flatpak', () => {
    const deps = defaultSystemDndDeps({ XDG_CURRENT_DESKTOP: 'GNOME' });

    deps.watch(() => {});

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
