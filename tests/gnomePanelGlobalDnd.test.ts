import { describe, it, expect, vi } from 'vitest';
import { startGnomePanelTray } from '../src/main/tray/gnomePanel';
import type { TrayDeps } from '../src/main/tray/index';
import type { ShellHelperClient } from '../src/main/gnome/shellHelper';

/** Records what the panel backend pushes to the (absent) GNOME helper. */
function fakeHelper() {
  const globalDnd: boolean[] = [];
  const calls: string[] = [];
  let appeared: (() => void) | undefined;
  const helper: ShellHelperClient = {
    setLoftWindows: async () => {},
    focusWindow: async () => {},
    hideWindow: async () => {},
    registerCombined: async () => { calls.push('registerCombined'); },
    unregisterCombined: async () => {},
    updateCombinedService: async () => { calls.push('updateCombinedService'); },
    removeCombinedService: async () => { calls.push('removeCombinedService'); },
    updateAvailableService: async () => { calls.push('updateAvailableService'); },
    removeAvailableService: async () => { calls.push('removeAvailableService'); },
    updateGlobalDnd: async (enabled) => { calls.push('updateGlobalDnd'); globalDnd.push(enabled); },
    onHelperAppeared: (cb) => { appeared = cb; },
  };
  return { helper, globalDnd, calls, fireAppeared: () => appeared?.() };
}

const deps = (globalDnd: boolean): TrayDeps => ({
  configuredServices: [{ id: 'slack', displayName: 'Slack', segment: 'slack', dnd: false, running: true, visible: true }],
  globalDnd,
  onToggleService: vi.fn(),
  onLaunchService: vi.fn(),
  onQuitService: vi.fn(),
  onToggleDnd: vi.fn(),
  onToggleGlobalDnd: vi.fn(),
  onShowWindow: vi.fn(),
  onShowHub: vi.fn(),
  onQuit: vi.fn(),
});

describe('startGnomePanelTray global DND', () => {
  it('pushes the seeded state at registration', async () => {
    const { helper, globalDnd } = fakeHelper();
    await startGnomePanelTray(deps(true), helper);
    expect(globalDnd).toEqual([true]);
  });

  // The extension renders the switch and the icon's DND dash from this flag, so
  // it has to arrive before anything it affects — and after the icon exists.
  it('pushes global DND after registering the icon and before the service rows', async () => {
    const { helper, calls } = fakeHelper();
    await startGnomePanelTray(deps(true), helper);
    expect(calls).toEqual(['registerCombined', 'updateGlobalDnd', 'updateCombinedService']);
  });

  // A global-DND change emits no per-service push (nothing per-service changed),
  // which is exactly why the extension must re-render off UpdateGlobalDnd alone.
  it('emits no per-service updates when only global DND changes', async () => {
    const { helper, calls } = fakeHelper();
    const tray = await startGnomePanelTray(deps(false), helper);
    calls.length = 0;

    tray.setGlobalDnd(true);
    expect(calls).toEqual(['updateGlobalDnd']);
  });

  it('pushes on change and stays quiet on a redundant set', async () => {
    const { helper, globalDnd } = fakeHelper();
    const tray = await startGnomePanelTray(deps(false), helper);
    globalDnd.length = 0;

    tray.setGlobalDnd(true);
    tray.setGlobalDnd(true); // redundant — the model swallows it
    expect(globalDnd).toEqual([true]);

    tray.setGlobalDnd(false);
    expect(globalDnd).toEqual([true, false]);
  });

  it('re-pushes when the helper reappears (suspend/resume drops the panel button)', async () => {
    const { helper, globalDnd, fireAppeared } = fakeHelper();
    const tray = await startGnomePanelTray(deps(false), helper);
    tray.setGlobalDnd(true);
    globalDnd.length = 0;

    fireAppeared();
    expect(globalDnd).toEqual([true]);
  });
});
