import type { OpenPlan } from './adapters';

export type OpenOutcome = 'done' | 'not-found';

/** How many times to step the scroll container looking for an unrendered row. */
export const SCROLL_STEPS = 20;
export const RETRY_INTERVAL_MS = 500;
/**
 * Total budget for a `row` plan. Deliberately longer than SCROLL_STEPS * RETRY_INTERVAL_MS:
 * `did-finish-load` fires well before WhatsApp has populated its chat list, so once the
 * scrolling phase is spent we keep re-checking in place while the app finishes waking.
 */
export const READY_TIMEOUT_MS = 20_000;

export interface ExecDeps {
  doc: Document;
  win: Window;
  sleep(ms: number): Promise<void>;
  /** For `row` plans; from the adapter's `scroller()`. */
  scroller?: Element | null;
}

/**
 * The deepest first-descendant.
 *
 * The click MUST originate here. On both WhatsApp and Slack the handler sits on a
 * DESCENDANT of the conversation row, and DOM events bubble up but never propagate down — so
 * an event targeted at the row wrapper can never reach it. Measured on WhatsApp:
 * `row.click()`, a full mouse sequence on the row, and one on `[role=gridcell]` all failed;
 * a leaf-originated sequence worked. Verified again on Slack, first try.
 *
 * `elementFromPoint(row centre)` also works, for the same reason, and is the documented
 * fallback — but it needs the row inside the visible scroll area and unoccluded, neither of
 * which holds right after waking a sleeping service. This has no geometry dependency.
 */
export function deepestLeaf(el: Element): Element {
  let n = el;
  while (n.firstElementChild) n = n.firstElementChild;
  return n;
}

/**
 * Construct an event, dropping `view` if the environment refuses it.
 *
 * `view` is part of the sequence the spike verified against real WhatsApp and Slack, so it
 * stays in production rather than being dropped for convenience. But jsdom under Vitest
 * rejects its OWN window for that member — `window instanceof window.Window` is false there,
 * because Vitest re-exports the jsdom globals — and would otherwise make this function
 * untestable. Chromium accepts it, so this fallback never fires in the app.
 */
function makeEvent(
  Ctor: typeof MouseEvent, type: string, init: MouseEventInit,
): MouseEvent {
  try {
    return new Ctor(type, init);
  } catch {
    const { view: _view, ...rest } = init;
    return new Ctor(type, rest);
  }
}

/**
 * What a real mouse produces, in order. A bare `.click()` moves neither app.
 *
 * `PointerEvent` is used when the environment has it and `MouseEvent` otherwise — listeners
 * match on the event TYPE string, so the fallback is behaviourally equivalent for our
 * purposes and keeps this testable.
 */
export function dispatchRealClick(el: Element, win: Window): void {
  const r = el.getBoundingClientRect();
  const clientX = Math.round(r.left + r.width / 2);
  const clientY = Math.round(r.top + r.height / 2);
  const down: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    // Composed so the event still crosses a shadow boundary if one of these apps ever
    // renders its rows into a shadow root.
    composed: true,
    view: win as unknown as Window & typeof globalThis,
    clientX,
    clientY,
    button: 0,
    buttons: 1,
  };
  const up: MouseEventInit = { ...down, buttons: 0 };
  const w = win as unknown as {
    PointerEvent?: typeof MouseEvent;
    MouseEvent: typeof MouseEvent;
  };
  const Pointer = w.PointerEvent ?? w.MouseEvent;

  el.dispatchEvent(makeEvent(Pointer, 'pointerover', down));
  el.dispatchEvent(makeEvent(w.MouseEvent, 'mouseover', down));
  el.dispatchEvent(makeEvent(Pointer, 'pointerdown', down));
  el.dispatchEvent(makeEvent(w.MouseEvent, 'mousedown', down));
  el.dispatchEvent(makeEvent(Pointer, 'pointerup', up));
  el.dispatchEvent(makeEvent(w.MouseEvent, 'mouseup', up));
  el.dispatchEvent(makeEvent(w.MouseEvent, 'click', { ...up, detail: 1 }));
}

/** One scroll step, wrapping to the top at the bottom so the whole list gets swept. */
function stepScroll(scroller: Element): void {
  const el = scroller as HTMLElement;
  const step = Math.max(1, Math.floor(el.clientHeight * 0.8));
  const next = el.scrollTop + step;
  el.scrollTop = next >= el.scrollHeight - el.clientHeight ? 0 : next;
}

/**
 * Carry out a plan. The only impure part of the feature, written once and shared by every
 * service, because the leaf-dispatch rule is a property of the DOM rather than of any app.
 *
 * A `row` plan retries for two distinct reasons: the row may not be rendered (WhatsApp
 * renders ~71 of 92 chats at any scroll offset; Slack's sidebar depends on the active
 * top-level tab), or the page may still be waking up. Scrolling addresses the first, and
 * continuing to re-check in place addresses the second. When the budget expires the caller
 * is simply left on the service — which is where they were going anyway.
 */
export async function executePlan(plan: OpenPlan, deps: ExecDeps): Promise<OpenOutcome> {
  if (plan.kind === 'none') return 'not-found';
  if (plan.kind === 'hash') { deps.win.location.hash = plan.hash; return 'done'; }
  if (plan.kind === 'url') { deps.win.location.href = plan.url; return 'done'; }

  const attempts = Math.ceil(READY_TIMEOUT_MS / RETRY_INTERVAL_MS);
  for (let i = 0; i < attempts; i++) {
    const el = plan.find(deps.doc);
    if (el) {
      if (plan.via === 'anchor') (el as HTMLElement).click();
      else dispatchRealClick(deepestLeaf(el), deps.win);
      return 'done';
    }
    if (deps.scroller && i < SCROLL_STEPS) stepScroll(deps.scroller);
    await deps.sleep(RETRY_INTERVAL_MS);
  }
  return 'not-found';
}
