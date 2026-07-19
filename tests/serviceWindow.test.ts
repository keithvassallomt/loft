import { describe, it, expect, vi } from 'vitest';

// serviceWindow — and the serviceView module it imports — destructure Electron APIs at import
// time; outside Electron `electron` resolves to a path string, so the import would throw.
// Mock just the surface the import chain touches. createServiceView is never CALLED here:
// every test passes `opts.view`, which is precisely the moved-in-live-view path under test.
vi.mock('electron', () => {
  let nextId = 1;
  class FakeWebContents {
    id = nextId++;
    on(): this { return this; }
    send(): void {}
    loadFile(): void {}
    loadURL(): Promise<void> { return Promise.resolve(); }
    insertCSS(): Promise<string> { return Promise.resolve(''); }
    setUserAgent(): void {}
    setZoomFactor(): void {}
    setWindowOpenHandler(): void {}
    getURL(): string { return ''; }
    isDestroyed(): boolean { return false; }
    reload(): void {}
    close(): void {}
  }
  class WebContentsView {
    webContents = new FakeWebContents();
    setBounds(): void {}
    setVisible(): void {}
  }
  class BrowserWindow {
    contentView = { addChildView: (): void => {}, removeChildView: (): void => {} };
    on(): this { return this; }
    getContentSize(): number[] { return [1100, 800]; }
    getSize(): number[] { return [1100, 800]; }
    getPosition(): number[] { return [0, 0]; }
    setTitle(): void {}
    show(): void {}
    focus(): void {}
    hide(): void {}
    isVisible(): boolean { return true; }
    isDestroyed(): boolean { return false; }
    destroy(): void {}
  }
  return {
    BrowserWindow,
    WebContentsView,
    session: { fromPartition: () => ({ getUserAgent: () => 'ua', setUserAgent: () => {} }) },
    shell: { openExternal: () => Promise.resolve() },
  };
});

import { createServiceWindow } from '../src/main/serviceWindow';

const DEF = { id: 'slack', displayName: 'Slack', url: 'https://app.slack.com/client/' };

/**
 * Stands in for a LIVE ServiceView being moved in from the Loft window. The one behaviour
 * that matters: the real ServiceView tracks its own `visible` flag and mount() RE-ASSERTS it
 * (serviceView.ts) rather than forcing visible — so a view that was an unselected background
 * tab arrives here still hidden. Mount therefore leaves `visible` untouched, exactly as the
 * real one does.
 */
function fakeView(startVisible: boolean) {
  let visible = startVisible;
  return {
    def: DEF,
    view: { webContents: { id: 999 } },
    mount: (): void => {}, // re-asserts current state — does NOT force visible
    unmount: (): void => {},
    setOnLoad: (): void => {},
    setRect: (): void => {},
    setVisible: (v: boolean): void => { visible = v; },
    setZoom: (): void => {},
    getZoom: (): number => 1,
    pushDnd: (): void => {},
    pushHidden: (): void => {},
    navigate: (): void => {},
    loadUrl: (): void => {},
    reload: (): void => {},
    clearAndReload: async (): Promise<void> => {},
    ownsWebContents: (): boolean => false,
    dispose: (): void => {},
    get visible(): boolean { return visible; },
  };
}

const make = (view: ReturnType<typeof fakeView>, minimized = false): void => {
  createServiceWindow(DEF as never, { services: {} } as never, {
    minimized,
    onQuit: () => false,
    view: view as never,
  });
};

describe('createServiceWindow — the detached window shows its service', () => {
  it('makes a view moved in from a NEVER-SELECTED background tab visible', () => {
    // loftWindow.attach() does setVisible(false) and only select() sets it back — so a service
    // that was loaded but never switched to arrives here hidden. Without an explicit
    // setVisible(true) the window draws only its titlebar over an unpainted content rect
    // (the "glitched / transparent content" bug).
    const sv = fakeView(false);
    make(sv);
    expect(sv.visible).toBe(true);
  });

  it('keeps an already-visible view visible (the previously-working active-tab path)', () => {
    const sv = fakeView(true);
    make(sv);
    expect(sv.visible).toBe(true);
  });

  it('makes the view visible even when the WINDOW starts minimized', () => {
    // `minimized` hides the window, never the view inside it — a fresh view has always been
    // visible in this case, so a moved-in one must be too, or restoring from the tray shows
    // a transparent window.
    const sv = fakeView(false);
    make(sv, true);
    expect(sv.visible).toBe(true);
  });
});
