// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  deepestLeaf, dispatchRealClick, executePlan, SCROLL_STEPS, type ExecDeps,
} from '../src/preload/conversation/open';
import type { OpenPlan } from '../src/preload/conversation/adapters';

/** Deterministic deps: nothing waits, and every sleep is recorded. */
function deps(over: Partial<ExecDeps> = {}): ExecDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    doc: document,
    win: window as unknown as Window,
    sleep: async (ms: number) => { sleeps.push(ms); },
    sleeps,
    ...over,
  };
}

/** A scroll container jsdom will not lay out for us. */
function fakeScroller(clientHeight: number, scrollHeight: number): HTMLElement {
  document.body.innerHTML += '<div id="pane"></div>';
  const el = document.querySelector('#pane') as HTMLElement;
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  return el;
}

describe('deepestLeaf', () => {
  it('descends to the deepest first child', () => {
    document.body.innerHTML = '<div id="row"><div><span><i id="leaf"></i></span></div></div>';
    expect(deepestLeaf(document.querySelector('#row')!).id).toBe('leaf');
  });
  it('returns the element itself when it has no children', () => {
    document.body.innerHTML = '<div id="row"></div>';
    expect(deepestLeaf(document.querySelector('#row')!).id).toBe('row');
  });
});

describe('dispatchRealClick', () => {
  it('emits a realistic sequence, in order', () => {
    document.body.innerHTML = '<div id="t"></div>';
    const el = document.querySelector('#t')!;
    const seen: string[] = [];
    for (const t of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.addEventListener(t, () => seen.push(t));
    }
    dispatchRealClick(el, window as unknown as Window);
    expect(seen).toEqual(
      ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  });

  // The property the whole feature rests on. On both WhatsApp and Slack the handler sits on
  // a DESCENDANT of the row, and events bubble up but never down — which is exactly why
  // row.click() and a row-targeted sequence both failed during the spike.
  it('bubbles, so a leaf-dispatched click reaches an ancestor handler', () => {
    document.body.innerHTML = '<div id="row"><div><span id="leaf"></span></div></div>';
    let reached = 0;
    document.querySelector('#row')!.addEventListener('click', () => { reached++; });
    dispatchRealClick(document.querySelector('#leaf')!, window as unknown as Window);
    expect(reached).toBe(1);
  });

  it('marks the events as composed, so a handler inside a shadow root still sees them', () => {
    document.body.innerHTML = '<div id="t"></div>';
    const el = document.querySelector('#t')!;
    let composed = false;
    el.addEventListener('click', (e) => { composed = e.composed; });
    dispatchRealClick(el, window as unknown as Window);
    expect(composed).toBe(true);
  });
});

describe('executePlan', () => {
  it('sets the hash for a hash plan', async () => {
    const out = await executePlan({ kind: 'hash', hash: '#/room/!x:y' }, deps());
    expect(out).toBe('done');
    expect(window.location.hash).toBe('#/room/!x:y');
  });

  it('reports not-found for a none plan without waiting', async () => {
    const d = deps();
    expect(await executePlan({ kind: 'none' }, d)).toBe('not-found');
    expect(d.sleeps).toHaveLength(0);
  });

  it('clicks a rendered row at its leaf', async () => {
    document.body.innerHTML = '<div id="row"><span id="leaf"></span></div>';
    let clicked = 0;
    document.querySelector('#row')!.addEventListener('click', () => { clicked++; });
    const plan: OpenPlan = { kind: 'row', find: (doc) => doc.querySelector('#row') };
    expect(await executePlan(plan, deps())).toBe('done');
    expect(clicked).toBe(1);
  });

  it('uses .click() for an anchor plan, preserving the shipped Messenger path', async () => {
    document.body.innerHTML = '<a id="a" href="#x">go</a>';
    const a = document.querySelector('#a') as HTMLAnchorElement;
    const spy = vi.spyOn(a, 'click').mockImplementation(() => {});
    const plan: OpenPlan = { kind: 'row', via: 'anchor', find: (doc) => doc.querySelector('#a') };
    expect(await executePlan(plan, deps())).toBe('done');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('finds a row immediately without sleeping at all', async () => {
    document.body.innerHTML = '<div id="row"></div>';
    const d = deps();
    await executePlan({ kind: 'row', find: (doc) => doc.querySelector('#row') }, d);
    expect(d.sleeps).toHaveLength(0);
  });

  it('scrolls and retries until the row appears', async () => {
    document.body.innerHTML = '';
    const pane = fakeScroller(100, 1000);
    let attempts = 0;
    const plan: OpenPlan = { kind: 'row', find: () => (++attempts >= 4 ? document.body : null) };
    expect(await executePlan(plan, deps({ scroller: pane }))).toBe('done');
    expect(pane.scrollTop).toBeGreaterThan(0);
  });

  it('gives up after the bounded retries rather than looping forever', async () => {
    const d = deps();
    expect(await executePlan({ kind: 'row', find: () => null }, d)).toBe('not-found');
    expect(d.sleeps.length).toBeGreaterThan(SCROLL_STEPS);
    expect(d.sleeps.length).toBeLessThan(200);
  });

  it('keeps retrying in place after the scrolling phase, for a service still waking up', async () => {
    document.body.innerHTML = '';
    const pane = fakeScroller(100, 1000);
    let attempts = 0;
    // Appears well after the scroll budget is spent — the cold-start case.
    const plan: OpenPlan = { kind: 'row', find: () => (++attempts > SCROLL_STEPS + 5 ? document.body : null) };
    expect(await executePlan(plan, deps({ scroller: pane }))).toBe('done');
  });

  it('wraps the scroll back to the top rather than parking at the bottom', async () => {
    document.body.innerHTML = '';
    const pane = fakeScroller(100, 150);
    await executePlan({ kind: 'row', find: () => null }, deps({ scroller: pane }));
    expect(pane.scrollTop).toBeLessThanOrEqual(50);
  });

  it('still terminates when there is no scroller to step', async () => {
    const d = deps({ scroller: null });
    expect(await executePlan({ kind: 'row', find: () => null }, d)).toBe('not-found');
  });
});
