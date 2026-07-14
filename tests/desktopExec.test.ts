import { describe, it, expect } from 'vitest';
import { desktopExec } from '../src/main/desktop';

describe('desktopExec', () => {
  it('uses the AppImage path when $APPIMAGE is set', () => {
    expect(desktopExec({ env: { APPIMAGE: '/home/u/Loft.AppImage' } as NodeJS.ProcessEnv }))
      .toBe('/home/u/Loft.AppImage');
  });

  it('uses `flatpak run chat.loft.Loft` under Flatpak', () => {
    expect(desktopExec({ env: { FLATPAK_ID: 'chat.loft.Loft' } as NodeJS.ProcessEnv }))
      .toBe('flatpak run chat.loft.Loft');
  });

  it('uses the given execPath for a packaged/native run', () => {
    expect(desktopExec({ env: {} as NodeJS.ProcessEnv, execPath: '/opt/Loft/loft' }))
      .toBe('/opt/Loft/loft');
  });
});
