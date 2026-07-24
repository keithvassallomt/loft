import { describe, it, expect, vi } from 'vitest';

// loftWindow — and the serviceView module it imports — destructure Electron APIs at import
// time; outside Electron `electron` resolves to a path string, so the import would throw.
// Mock just the surface the import chain touches (same approach as serviceWindow.test.ts).
// createServiceView is never CALLED here: every attach passes a pre-built view, which is the
// injection point that makes this module reachable at all. Menu is only destructured.
vi.mock('electron', () => {
  let nextId = 1;
  class FakeWebContents {
    id = nextId++;
    on(): this { return this; }
    send(): void {}
    loadFile(): Promise<void> { return Promise.resolve(); }
    isDestroyed(): boolean { return false; }
    close(): void {}
  }
  class WebContentsView {
    webContents = new FakeWebContents();
    setBounds(): void {}
    setVisible(): void {}
    setBackgroundColor(): void {}
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
    Menu: { buildFromTemplate: () => ({ popup: (): void => {} }) },
    session: { fromPartition: () => ({ getUserAgent: () => 'ua', setUserAgent: () => {} }) },
    shell: { openExternal: () => Promise.resolve() },
  };
});

import { createLoftWindow, type LoftWindow, type LoftWindowDeps } from '../src/main/loftWindow';
import { GRID_ID, type GridNode } from '../src/main/gridTree';
import type { LoftConfig } from '../src/main/config';
import type { ServiceView } from '../src/main/serviceView';

const DEFS = [
  { id: 'whatsapp', displayName: 'WhatsApp', url: 'https://web.whatsapp.com/' },
  { id: 'slack', displayName: 'Slack', url: 'https://app.slack.com/client/' },
  { id: 'telegram', displayName: 'Telegram', url: 'https://web.telegram.org/a/' },
];

/** What the fake recorded, for the tests that are about the hooks rather than the tree. */
interface ViewHooks {
  /** 'focus' listeners bound straight onto the webContents by a HOST. Must stay 0: the real
   *  ServiceView binds one internally and hosts re-point it through setOnFocus, or every
   *  return from a detached window stacks another. */
  rawFocusListeners: number;
  /** Every setOnFocus call, so a re-attach can be seen replacing rather than adding. */
  onFocus: (() => void)[];
}

/** The minimum a ServiceView has to do to survive attach → select → detach/unload. */
function fakeView(id: string): ServiceView & { hooks: ViewHooks } {
  const def = DEFS.find((d) => d.id === id)!;
  const hooks: ViewHooks = { rawFocusListeners: 0, onFocus: [] };
  return Object.assign({
    def,
    view: {
      webContents: {
        id: 900,
        isDestroyed: () => false,
        close: () => {},
        on: (ev: string) => { if (ev === 'focus') hooks.rawFocusListeners += 1; },
      },
    },
    mount: () => {},
    unmount: () => {},
    raise: () => {},
    setOnLoad: () => {},
    setOnFocus: (fn: () => void) => { hooks.onFocus.push(fn); },
    setRect: () => {},
    setVisible: () => {},
    setZoom: () => {},
    getZoom: () => 1,
    pushDnd: () => {},
    pushHidden: () => {},
    navigate: () => {},
    notifyClick: () => {},
    loadUrl: () => {},
    reload: () => {},
    clearAndReload: async () => {},
    ownsWebContents: () => false,
    dispose: () => {},
  } as unknown as ServiceView, { hooks });
}

interface Harness {
  loft: LoftWindow;
  cfg: LoftConfig;
  ensureAttached: ReturnType<typeof vi.fn>;
  activeChanges: (string | undefined)[];
}

function make(grid: GridNode | null | undefined, attachIds: string[]): Harness {
  const cfg: LoftConfig = { services: { whatsapp: {}, slack: {}, telegram: {} } };
  if (grid !== undefined) cfg.grid = grid;

  const activeChanges: (string | undefined)[] = [];
  // Declines every wake: what matters is WHETHER it is asked for a service being torn down,
  // not what it would have built. A real wake would attach a second live view of it.
  const ensureAttached = vi.fn();

  const deps: LoftWindowDeps = {
    cfg,
    services: () => DEFS as never,
    onQuit: () => true,
    badge: () => 0,
    // The moment the Critical defect lives in: mid-detach, config has NOT been flipped yet
    // (the ordering contract forbids it), so nothing here reports the service as detached.
    detached: () => false,
    loadedElsewhere: () => false,
    buildServiceMenu: () => [],
    buildGridAddMenu: () => [],
    onActiveChanged: (id) => { activeChanges.push(id); },
    onServiceLoad: () => {},
    ensureAttached,
    railPreload: 'rail.js', railHtml: 'rail.html',
    gridPreload: 'grid.js', gridHtml: 'grid.html', overlayHtml: 'overlay.html',
    titlebarPreload: 'tb.js', titlebarHtml: 'tb.html',
    managerPreload: 'mgr.js', managerHtml: 'mgr.html',
    iconPath: 'loft.png',
  };

  const loft = createLoftWindow(deps);
  for (const id of attachIds) loft.attach(DEFS.find((d) => d.id === id)! as never, fakeView(id));
  return { loft, cfg, ensureAttached, activeChanges };
}

const split = (a: string, b: string): GridNode => ({
  kind: 'split', dir: 'row', ratio: 0.5,
  a: { kind: 'leaf', service: a },
  b: { kind: 'leaf', service: b },
});

describe('detach/unload prune the leaf out of the grid', () => {
  it('detach collapses the split into the surviving leaf', () => {
    const h = make(split('whatsapp', 'slack'), ['whatsapp', 'slack']);
    h.loft.select(GRID_ID);

    h.loft.detach('slack');

    expect(h.cfg.grid).toEqual({ kind: 'leaf', service: 'whatsapp' });
  });

  it('detach never re-wakes the service it is detaching', () => {
    // The Critical defect: refreshAll() runs mid-transition, and refreshGrid →
    // placeGridCells wakes any leaf with no view. `slack`'s view has just left `views` and
    // its own window does not exist yet, so a surviving leaf makes it look "gridded, awake,
    // viewless" — and ensureAttached builds a SECOND view in the same session partition.
    // Fails if pruneFromGrid moves below refreshAll(), or is deleted.
    const h = make(split('whatsapp', 'slack'), ['whatsapp', 'slack']);
    h.loft.select(GRID_ID);

    h.loft.detach('slack');

    expect(h.ensureAttached).not.toHaveBeenCalledWith('slack');
  });

  it('unload prunes the leaf and never re-wakes the service', () => {
    const h = make(split('whatsapp', 'slack'), ['whatsapp', 'slack']);
    h.loft.select(GRID_ID);

    h.loft.unload('slack');

    expect(h.cfg.grid).toEqual({ kind: 'leaf', service: 'whatsapp' });
    expect(h.ensureAttached).not.toHaveBeenCalledWith('slack');
  });
});

describe('a prune that changes nothing writes nothing', () => {
  it('leaves the tree object itself untouched when the service is not a leaf', () => {
    const tree = split('whatsapp', 'telegram');
    const h = make(tree, ['whatsapp', 'slack', 'telegram']);

    h.loft.detach('slack');

    // Identity, not equality: remove() returns the same object for a no-op, and the prune
    // must pass that through rather than stamping an equal-but-new tree over config.
    expect(h.cfg.grid).toBe(tree);
  });

  it('does not invent a grid key when config has none', () => {
    const h = make(undefined, ['slack']);

    h.loft.detach('slack');

    expect('grid' in h.cfg).toBe(false);
  });
});

describe('the detach ordering contract still holds', () => {
  it('selects the neighbouring service when the selected tab is detached', () => {
    // nextActiveId locates `slack` in the ATTACHED list, so it has to be snapshotted before
    // the transition. Pruning slack's leaf on the way past must not disturb that.
    const h = make(split('slack', 'whatsapp'), ['whatsapp', 'slack', 'telegram']);
    h.loft.select('slack');

    h.loft.detach('slack');

    expect(h.loft.activeId()).toBe('telegram');
    expect(h.activeChanges.at(-1)).toBe('telegram');
    expect(h.cfg.grid).toEqual({ kind: 'leaf', service: 'whatsapp' });
  });
});

describe('the focused-cell hook is set, not stacked', () => {
  it('re-points it when the same live view comes back from its own window', () => {
    // attach() is called again with the SAME ServiceView on every return from a detached
    // window, and unmount() removes child views but no webContents listeners — so a 'focus'
    // listener bound in attach() leaked one handler per move, and the Nth return ran the
    // grid's focus handling N times per click.
    const h = make(undefined, []);
    const sv = fakeView('slack');

    h.loft.attach(DEFS[1] as never, sv);
    const back = h.loft.detach('slack');
    h.loft.attach(DEFS[1] as never, back);

    expect(sv.hooks.rawFocusListeners).toBe(0);
    // Two sets, one per attach — and the real ServiceView keeps only the last.
    expect(sv.hooks.onFocus).toHaveLength(2);
  });
});

describe('dropFromGrid — the sleeping-service detach path', () => {
  it('drops a leaf for a service that has no view at all', () => {
    // index.ts's setDetached only reaches loft.detach when the service is loaded; a sleeping
    // gridded service would otherwise keep an orphaned cell the user cannot clear.
    const h = make(split('whatsapp', 'slack'), ['whatsapp']);

    h.loft.dropFromGrid('slack');

    expect(h.cfg.grid).toEqual({ kind: 'leaf', service: 'whatsapp' });
  });

  it('is a no-op, by identity, for a service that is not in the grid', () => {
    const tree = split('whatsapp', 'telegram');
    const h = make(tree, ['whatsapp']);

    h.loft.dropFromGrid('slack');

    expect(h.cfg.grid).toBe(tree);
  });
});
