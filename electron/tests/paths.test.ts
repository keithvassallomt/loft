import { describe, it, expect } from 'vitest';
import {
  dataHome, configHome, applicationsDir, loftDataDir, iconsDir, partitionDir, autostartDir,
} from '../src/main/paths';

const xdg = { XDG_DATA_HOME: '/x/data', XDG_CONFIG_HOME: '/x/cfg', HOME: '/home/u' };
const noXdg = { HOME: '/home/u' } as NodeJS.ProcessEnv;

describe('paths', () => {
  it('honours XDG_DATA_HOME/XDG_CONFIG_HOME', () => {
    expect(dataHome(xdg)).toBe('/x/data');
    expect(configHome(xdg)).toBe('/x/cfg');
    expect(applicationsDir(xdg)).toBe('/x/data/applications');
    expect(loftDataDir(xdg)).toBe('/x/data/loft');
    expect(iconsDir(xdg)).toBe('/x/data/loft/icons');
    expect(partitionDir('whatsapp', xdg)).toBe('/x/data/loft/Partitions/whatsapp');
    expect(autostartDir(xdg)).toBe('/x/cfg/autostart');
  });

  it('falls back to ~/.local/share and ~/.config', () => {
    expect(dataHome(noXdg)).toBe('/home/u/.local/share');
    expect(configHome(noXdg)).toBe('/home/u/.config');
    expect(applicationsDir(noXdg)).toBe('/home/u/.local/share/applications');
    expect(autostartDir(noXdg)).toBe('/home/u/.config/autostart');
  });
});
