import { describe, it, expect, vi } from 'vitest';
import { startGnomePanelTray } from '../src/main/tray/gnomePanel';
import type { TrayDeps } from '../src/main/tray/index';
import type { ShellHelperClient } from '../src/main/gnome/shellHelper';

/** Records the available-channel pushes to the (absent) GNOME helper. */
function fakeHelper() {
  const running: string[] = [];
  const combinedRemovals: string[] = [];
  const availableAdds: Array<[string, string]> = [];
  const availableRemovals: string[] = [];
  let appeared: (() => void) | undefined;
  const helper: ShellHelperClient = {
    setLoftWindows: async () => {},
    focusWindow: async () => {},
    hideWindow: async () => {},
    registerCombined: async () => {},
    unregisterCombined: async () => {},
    updateCombinedService: async (name) => { running.push(name); },
    removeCombinedService: async (name) => { combinedRemovals.push(name); },
    updateAvailableService: async (name, displayName) => { availableAdds.push([name, displayName]); },
    removeAvailableService: async (name) => { availableRemovals.push(name); },
    updateGlobalDnd: async () => {},
    onHelperAppeared: (cb) => { appeared = cb; },
  };
  return { helper, running, combinedRemovals, availableAdds, availableRemovals, fireAppeared: () => appeared?.() };
}

// One running (Slack), one configured-but-not-running (Telegram).
const deps = (): TrayDeps => ({
  configuredServices: [
    { id: 'slack', displayName: 'Slack', dnd: false, running: true, visible: true },
    { id: 'telegram', displayName: 'Telegram', dnd: false, running: false, visible: false },
  ],
  globalDnd: false,
  onToggleService: vi.fn(),
  onLaunchService: vi.fn(),
  onQuitService: vi.fn(),
  onToggleDnd: vi.fn(),
  onToggleGlobalDnd: vi.fn(),
  onShowWindow: vi.fn(),
  onShowHub: vi.fn(),
  onQuit: vi.fn(),
});

describe('startGnomePanelTray available services', () => {
  it('pushes not-running services on the available channel, running ones on the combined channel', async () => {
    const { helper, running, availableAdds } = fakeHelper();
    await startGnomePanelTray(deps(), helper);
    expect(running).toEqual(['slack']);
    expect(availableAdds).toEqual([['telegram', 'Telegram']]);
  });

  it('launch moves a service available -> running (remove available + add combined)', async () => {
    const { helper, running, availableRemovals } = fakeHelper();
    const tray = await startGnomePanelTray(deps(), helper);
    running.length = 0;

    tray.setRunning('telegram', true);
    expect(availableRemovals).toEqual(['telegram']);
    expect(running).toEqual(['telegram']);
  });

  it('quit moves a service running -> available (remove combined + add available)', async () => {
    const { helper, combinedRemovals, availableAdds } = fakeHelper();
    const tray = await startGnomePanelTray(deps(), helper);
    combinedRemovals.length = 0;
    availableAdds.length = 0;

    tray.setRunning('slack', false);
    expect(combinedRemovals).toEqual(['slack']);
    expect(availableAdds).toEqual([['slack', 'Slack']]);
  });

  it('re-pushes the available section when the helper reappears (suspend/resume)', async () => {
    const { helper, availableAdds, fireAppeared } = fakeHelper();
    await startGnomePanelTray(deps(), helper);
    availableAdds.length = 0;

    fireAppeared();
    expect(availableAdds).toEqual([['telegram', 'Telegram']]);
  });
});
