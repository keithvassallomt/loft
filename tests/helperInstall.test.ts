import { describe, it, expect, vi } from 'vitest';
import { ensureGnomeHelper, HELPER_UUID, type HelperInstallDeps } from '../src/main/gnome/helperInstall';

function makeDeps(over: Partial<HelperInstallDeps> = {}): HelperInstallDeps & {
  installed: string[]; iconCalls: number;
} {
  const installed: string[] = [];
  const base = {
    installed,
    iconCalls: 0,
    getExtensionInfo: vi.fn(async () => ({}) as Record<string, unknown>),
    installRemoteExtension: vi.fn(async (uuid: string) => { installed.push(uuid); return 'successful'; }),
    prompt: vi.fn(async () => true),
    installSymbolicIcon: vi.fn(() => { base.iconCalls++; }),
  };
  return Object.assign(base, over);
}

describe('ensureGnomeHelper', () => {
  it('installs from EGO when absent and the user accepts', async () => {
    const deps = makeDeps();
    await ensureGnomeHelper(deps);
    expect(deps.installRemoteExtension).toHaveBeenCalledWith(HELPER_UUID);
    expect(deps.iconCalls).toBe(1);
  });

  it('does not install when the user declines', async () => {
    const deps = makeDeps({ prompt: vi.fn(async () => false) });
    await ensureGnomeHelper(deps);
    expect(deps.installRemoteExtension).not.toHaveBeenCalled();
  });

  it('does nothing (no prompt) when already installed', async () => {
    const deps = makeDeps({ getExtensionInfo: vi.fn(async () => ({ uuid: HELPER_UUID, state: 1 })) });
    await ensureGnomeHelper(deps);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.installRemoteExtension).not.toHaveBeenCalled();
  });

  it('falls back silently (no prompt/install) when GNOME Shell is unavailable', async () => {
    const deps = makeDeps({ getExtensionInfo: vi.fn(async () => { throw new Error('no shell'); }) });
    await ensureGnomeHelper(deps);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.installRemoteExtension).not.toHaveBeenCalled();
  });

  it('never throws even if installRemoteExtension rejects', async () => {
    const deps = makeDeps({ installRemoteExtension: vi.fn(async () => { throw new Error('cancelled'); }) });
    await expect(ensureGnomeHelper(deps)).resolves.toBeUndefined();
  });

  it('always installs the symbolic icon', async () => {
    const deps = makeDeps({ getExtensionInfo: vi.fn(async () => ({ state: 1 })) });
    await ensureGnomeHelper(deps);
    expect(deps.iconCalls).toBe(1);
  });
});
