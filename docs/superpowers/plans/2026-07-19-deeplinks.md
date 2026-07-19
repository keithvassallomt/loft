# Per-service Deep Links — Let the App Route Itself

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a notification lands you in the conversation it came from, for WhatsApp, Slack, Element and NextCloud Talk.

**Architecture:** Instead of recovering a conversation id and building a URL per service, keep the `Notification` object the page created, capture whatever click handler the app attached to it, and invoke that handler when the user clicks our desktop banner. The app then routes using its own internal logic. A token we mint ourselves (`notifyId`) travels out with the notification and back on click, riding the per-notification record main already keeps.

**Tech Stack:** TypeScript, Electron 43, Vitest. No new dependencies.

## Global Constraints

- **Never call `dispatchEvent` on the retained object.** It carries `Notification.prototype` but was never constructed by the real `Notification`, so it has no internal EventTarget slots and dispatching throws *"Illegal invocation"*. Invoke the captured handlers directly.
- **`Notification.prototype` must stay `Orig.prototype`.** Slack inspects the prototype before calling the constructor; a synthetic one makes it skip notifications entirely.
- **Standard handlers win.** Invoke `onclick` plus any `click` listeners; fall back to WhatsApp's non-standard `options.onClick` **only when no standard handler was registered**. Invoking both risks routing twice.
- **A handler that throws must be contained** — caught and logged, never allowed to break the click path or leak into the page.
- **Retention is capped at 50** per view, evicted oldest-first. A service view lives for the whole session, so an unbounded map is a slow leak.
- **Messenger and Telegram are not touched.** They are DOM-scraped, carry real hrefs, and already work; their `service:navigate` path stays exactly as it is.
- Build with `npm run build`; tests are `npm test`.

---

### Task 1: `notifyRegistry` — bounded retention

**Files:**
- Create: `src/preload/notify/notifyRegistry.ts`
- Test: `tests/notifyRegistry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function createNotifyRegistry<T>(cap?: number): NotifyRegistry<T>` where
  `export interface NotifyRegistry<T> { remember(value: T): number; take(id: number): T | undefined; forget(id: number): void; size(): number }`.
  Ids start at 1 and increase; `take` removes; the default cap is 50.

- [ ] **Step 1: Write the failing test**

Create `tests/notifyRegistry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createNotifyRegistry } from '../src/preload/notify/notifyRegistry';

describe('createNotifyRegistry', () => {
  it('hands back an increasing id and retrieves what was stored', () => {
    const r = createNotifyRegistry<string>();
    const a = r.remember('a');
    const b = r.remember('b');
    expect(b).toBeGreaterThan(a);
    expect(r.take(a)).toBe('a');
    expect(r.take(b)).toBe('b');
  });

  it('take removes, so a second take finds nothing', () => {
    const r = createNotifyRegistry<string>();
    const id = r.remember('once');
    expect(r.take(id)).toBe('once');
    expect(r.take(id)).toBeUndefined();
  });

  it('take of an id it never issued is undefined, not a throw', () => {
    const r = createNotifyRegistry<string>();
    expect(r.take(9999)).toBeUndefined();
  });

  it('removes an entry even when the stored value is legitimately undefined', () => {
    const r = createNotifyRegistry<string | undefined>();
    const id = r.remember(undefined);
    expect(r.take(id)).toBeUndefined();
    // The point: it really went, rather than merely returning undefined while still stored.
    expect(r.size()).toBe(0);
    expect(r.take(id)).toBeUndefined();
  });

  it('forget drops an entry without retrieving it', () => {
    const r = createNotifyRegistry<string>();
    const id = r.remember('x');
    r.forget(id);
    expect(r.take(id)).toBeUndefined();
    expect(r.size()).toBe(0);
  });

  it('evicts the OLDEST once the cap is exceeded', () => {
    const r = createNotifyRegistry<string>(3);
    const first = r.remember('1');
    r.remember('2');
    r.remember('3');
    expect(r.size()).toBe(3);
    const fourth = r.remember('4');
    expect(r.size()).toBe(3);
    expect(r.take(first)).toBeUndefined(); // the oldest went
    expect(r.take(fourth)).toBe('4');      // the newest stayed
  });

  it('defaults to a cap of 50', () => {
    const r = createNotifyRegistry<number>();
    const ids = Array.from({ length: 60 }, (_, i) => r.remember(i));
    expect(r.size()).toBe(50);
    expect(r.take(ids[0])).toBeUndefined();
    expect(r.take(ids[59])).toBe(59);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/notifyRegistry.test.ts`
Expected: FAIL — cannot resolve `../src/preload/notify/notifyRegistry`.

- [ ] **Step 3: Write the implementation**

Create `src/preload/notify/notifyRegistry.ts`:

```ts
export interface NotifyRegistry<T> {
  /** Store a value and return the token that retrieves it. */
  remember(value: T): number;
  /** Retrieve AND remove. Undefined if never issued, already taken, or evicted. */
  take(id: number): T | undefined;
  /** Drop without retrieving (the page closed the notification). */
  forget(id: number): void;
  size(): number;
}

/**
 * Bounded store of the notification objects we are holding on to so their click
 * handlers can be invoked later.
 *
 * A service view lives for the whole session, so this must not grow without limit —
 * hence the cap and oldest-first eviction. Clicking a banner older than `cap` newer
 * ones then does nothing, which is a fair trade for a fixed ceiling.
 */
export function createNotifyRegistry<T>(cap = 50): NotifyRegistry<T> {
  const entries = new Map<number, T>();
  let next = 1;

  return {
    remember(value) {
      const id = next++;
      entries.set(id, value);
      // Map iterates in insertion order, so the first key is always the oldest.
      while (entries.size > cap) {
        const oldest: number | undefined = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return id;
    },
    take(id) {
      // has(), not a value check: T is unconstrained, so `undefined` can be a legitimate
      // stored value and must still be removed. Gating on the value would leave it behind.
      if (!entries.has(id)) return undefined;
      const v = entries.get(id);
      entries.delete(id);
      return v;
    },
    forget(id) { entries.delete(id); },
    size: () => entries.size,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/notifyRegistry.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/preload/notify/notifyRegistry.ts tests/notifyRegistry.test.ts
git commit -m "feat(notify): bounded registry for retained notification objects"
```

---

### Task 2: `override` — capture the app's handler and invoke it

**Files:**
- Modify: `src/preload/notify/override.ts`
- Test: `tests/notifyOverride.test.ts` (extend; one existing assertion changes)

**Interfaces:**
- Consumes: `createNotifyRegistry` from `src/preload/notify/notifyRegistry.ts` (Task 1).
- Produces:
  - `OverrideNotice` gains `notifyId: number`.
  - `OverrideHandle` gains `click(notifyId: number): void`.

- [ ] **Step 1: Update the existing relay assertion**

`OverrideNotice` gains a field, so the existing exact-payload assertion must include it. In `tests/notifyOverride.test.ts`, replace:

```ts
    expect(onNotify).toHaveBeenCalledWith({ title: 'Ann', body: 'hi', icon: 'https://x/a.png', tag: 't1' });
```

with:

```ts
    expect(onNotify).toHaveBeenCalledWith(
      { title: 'Ann', body: 'hi', icon: 'https://x/a.png', tag: 't1', notifyId: expect.any(Number) },
    );
```

- [ ] **Step 2: Write the failing tests for handler capture and invocation**

Append to `tests/notifyOverride.test.ts`, inside the existing `describe('installNotificationOverride', ...)` block:

```ts
  // Reaches the notifyId the override minted for the most recent notification.
  const lastNotifyId = (onNotify: { mock: { calls: unknown[][] } }): number =>
    (onNotify.mock.calls[onNotify.mock.calls.length - 1][0] as { notifyId: number }).notifyId;

  it('invokes an onclick the page assigned after construction', () => {
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    n.onclick = clicked;
    h.click(lastNotifyId(onNotify));
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('invokes click listeners added with addEventListener', () => {
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    n.addEventListener('click', clicked);
    n.addEventListener('close', vi.fn()); // a non-click listener must not be invoked
    h.click(lastNotifyId(onNotify));
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('falls back to a non-standard options.onClick when nothing standard was registered', () => {
    // WhatsApp hands its own router in the options object rather than attaching it.
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const optionClick = vi.fn();
    new win.Notification('Ann', { body: 'hi', onClick: optionClick });
    h.click(lastNotifyId(onNotify));
    expect(optionClick).toHaveBeenCalledTimes(1);
  });

  it('prefers standard handlers and does NOT also fire options.onClick', () => {
    // WhatsApp registers BOTH; invoking both would route twice.
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const optionClick = vi.fn();
    const listener = vi.fn();
    const n = new win.Notification('Ann', { body: 'hi', onClick: optionClick });
    n.addEventListener('click', listener);
    h.click(lastNotifyId(onNotify));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(optionClick).not.toHaveBeenCalled();
  });

  it('passes an event whose preventDefault/stopPropagation are safe to call', () => {
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    let seen: { type?: string } = {};
    n.onclick = (e: { type: string; preventDefault(): void; stopPropagation(): void }) => {
      e.preventDefault();
      e.stopPropagation();
      seen = e;
    };
    expect(() => h.click(lastNotifyId(onNotify))).not.toThrow();
    expect(seen.type).toBe('click');
  });

  it('contains a handler that throws', () => {
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    n.onclick = () => { throw new Error('boom'); };
    expect(() => h.click(lastNotifyId(onNotify))).not.toThrow();
  });

  it('does nothing for an unknown id, and only fires a handler once', () => {
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    n.onclick = clicked;
    const id = lastNotifyId(onNotify);
    h.click(id);
    h.click(id);       // the entry was taken by the first click
    h.click(123456);   // never issued
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('forgets a notification the page closed', () => {
    const { win, doc } = fakeEnv();
    const onNotify = vi.fn();
    const h = installNotificationOverride(win, doc, onNotify);
    const n = new win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    n.onclick = clicked;
    n.close();
    h.click(lastNotifyId(onNotify));
    expect(clicked).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/notifyOverride.test.ts`
Expected: FAIL — `h.click is not a function`, and the relay assertion fails on the missing `notifyId`.

- [ ] **Step 4: Implement capture and invocation**

In `src/preload/notify/override.ts`, add the import at the top of the file:

```ts
import { createNotifyRegistry } from './notifyRegistry';
```

Replace the two interface declarations at the top:

```ts
export interface OverrideNotice { title: string; body: string; icon: string; tag: string }
export interface OverrideHandle { setHidden(hidden: boolean): void }
```

with:

```ts
export interface OverrideNotice { title: string; body: string; icon: string; tag: string; notifyId: number }
export interface OverrideHandle {
  setHidden(hidden: boolean): void;
  /** Invoke the page's own click handler for a notification we relayed. */
  click(notifyId: number): void;
}

/** What we hold on to per notification so its click can be replayed into the page. */
interface Captured {
  instance: unknown;
  /** The `onclick` property, if the app assigned one after construction. */
  onclick?: unknown;
  /** Listeners added via addEventListener('click', …). */
  listeners: unknown[];
  /** WhatsApp's non-standard options.onClick — a fallback, never fired alongside the above. */
  optionsOnClick?: unknown;
}
```

Replace the `relay` definition and the `SilentNotification` function:

```ts
  const relay = (title: unknown, options: any): void =>
    onNotify({ title: String(title ?? ''), body: options?.body ?? '', icon: options?.icon ?? '', tag: options?.tag ?? '' });

  const Orig = win.Notification;
  function SilentNotification(this: unknown, title: unknown, options: any = {}) { relay(title, options); }
```

with:

```ts
  const registry = createNotifyRegistry<Captured>();

  const relay = (title: unknown, options: any, notifyId: number): void =>
    onNotify({
      title: String(title ?? ''), body: options?.body ?? '',
      icon: options?.icon ?? '', tag: options?.tag ?? '', notifyId,
    });

  const Orig = win.Notification;
  function SilentNotification(this: any, title: unknown, options: any = {}) {
    // Keep the object and whatever handler the app attaches to it. Discarding it (as this
    // did before) is why a notification click could never reach the app's own router.
    const self = this ?? {};
    const captured: Captured = { instance: self, listeners: [] };
    if (typeof options?.onClick === 'function') captured.optionsOnClick = options.onClick;
    const notifyId = registry.remember(captured);

    relay(title, options, notifyId);

    // An accessor, so an assignment made AFTER construction still lands in `captured`.
    try {
      Object.defineProperty(self, 'onclick', {
        configurable: true,
        get() { return captured.onclick; },
        set(fn: unknown) { captured.onclick = fn; },
      });
    } catch { /* ignore */ }
    self.addEventListener = (type: string, fn: unknown): void => {
      if (type === 'click' && typeof fn === 'function') captured.listeners.push(fn);
    };
    self.removeEventListener = (type: string, fn: unknown): void => {
      if (type !== 'click') return;
      const i = captured.listeners.indexOf(fn);
      if (i >= 0) captured.listeners.splice(i, 1);
    };
    self.close = (): void => { registry.forget(notifyId); };
    return self;
  }

  /**
   * Replay a click into the page. NOT dispatchEvent: this object carries
   * Notification.prototype but was never constructed by the real Notification, so it has
   * no internal EventTarget slots and dispatching throws "Illegal invocation" — the same
   * error Slack already provokes against the old dud object.
   */
  const click = (notifyId: number): void => {
    const c = registry.take(notifyId);
    if (!c) return;
    const event = {
      type: 'click',
      target: c.instance,
      currentTarget: c.instance,
      preventDefault(): void { /* apps call these; they must not throw */ },
      stopPropagation(): void { /* ditto */ },
    };
    const call = (fn: unknown): void => {
      if (typeof fn !== 'function') return;
      try { (fn as (e: unknown) => void).call(c.instance, event); }
      catch (err) { console.error('Loft: notification click handler threw', err); }
    };
    // Standard handlers win. options.onClick is a fallback only — WhatsApp registers both,
    // and firing both would route twice.
    const standard = [c.onclick, ...c.listeners].filter((f) => typeof f === 'function');
    if (standard.length > 0) { for (const fn of standard) call(fn); return; }
    call(c.optionsOnClick);
  };
```

Replace the service-worker branch:

```ts
    SWReg.prototype.showNotification = function (title: unknown, options: any = {}) { relay(title, options); return Promise.resolve(); };
```

with:

```ts
    // A service-worker notification has no page object to attach a handler to, so it gets
    // an entry with no handlers: clicking it focuses the window and does nothing more. No
    // service was observed using this path (every one delivers via the page Notification).
    SWReg.prototype.showNotification = function (title: unknown, options: any = {}) {
      relay(title, options, registry.remember({ instance: undefined, listeners: [] }));
      return Promise.resolve();
    };
```

Finally, replace the handle construction near the end:

```ts
  const handle: OverrideHandle = { setHidden };
```

with:

```ts
  const handle: OverrideHandle = { setHidden, click };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/notifyOverride.test.ts`
Expected: PASS — the existing tests plus 8 new ones.

- [ ] **Step 6: Commit**

```bash
git add src/preload/notify/override.ts tests/notifyOverride.test.ts
git commit -m "feat(notify): capture the page's notification click handler and replay it"
```

---

### Task 3: `bridge` — carry the token out, take the click back in

**Files:**
- Modify: `src/preload/notify/bridge.ts`
- Test: `tests/notifyBridge.test.ts` (extend)

**Interfaces:**
- Consumes: `OverrideNotice.notifyId` and `OverrideHandle.click` (Task 2).
- Produces: `service:notify` payloads gain `notifyId`; the preload handles `service:notify-click`.

- [ ] **Step 1: Write the failing test**

Read `tests/notifyBridge.test.ts` first to reuse its existing fake ipc/win/doc helpers rather than writing new ones, then append these tests to its main `describe` block:

```ts
  it('sends the notifyId out with a relayed notification', () => {
    const t = setup('slack');
    new t.win.Notification('Ann', { body: 'hi' });
    const sent = t.sent.find(([ch]) => ch === 'service:notify');
    expect(sent).toBeTruthy();
    expect((sent![1] as { notifyId: number }).notifyId).toEqual(expect.any(Number));
  });

  it('routes service:notify-click into the page handler', () => {
    const t = setup('slack');
    const n = new t.win.Notification('Ann', { body: 'hi' });
    const clicked = vi.fn();
    n.onclick = clicked;
    const sent = t.sent.find(([ch]) => ch === 'service:notify')!;
    const { notifyId } = sent[1] as { notifyId: number };
    t.fire('service:notify-click', notifyId);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('ignores a service:notify-click that is not a number', () => {
    const t = setup('slack');
    expect(() => t.fire('service:notify-click', 'nope')).not.toThrow();
  });
```

If the existing file's helper is not named `setup`/`t.sent`/`t.fire`, adapt these three tests to the helpers it actually provides — keep the assertions identical.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/notifyBridge.test.ts`
Expected: FAIL — no `notifyId` on the sent payload; the click does nothing.

- [ ] **Step 3: Implement**

In `src/preload/notify/bridge.ts`, inside `handleNotice`, replace this line:

```ts
    ipc.send('service:notify', { title: n.title, body: n.body, icon, href: '' });
```

with:

```ts
    // notifyId, not href: these services give no conversation id, so the click is routed by
    // replaying it into the app's own handler rather than by navigating to a URL.
    ipc.send('service:notify', { title: n.title, body: n.body, icon, href: '', notifyId: n.notifyId });
```

Then add this handler immediately after the existing `ipc.on('service:navigate', …)` block, before the closing brace of `startNotifyBridge`:

```ts
  // Main clicked one of our banners: hand it back to the page's own handler.
  ipc.on('service:notify-click', (_e: unknown, notifyId?: unknown) => {
    if (typeof notifyId === 'number') overrideHandle.click(notifyId);
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/notifyBridge.test.ts`
Expected: PASS — existing tests plus 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/preload/notify/bridge.ts tests/notifyBridge.test.ts
git commit -m "feat(notify): carry notifyId out and route the click back into the page"
```

---

### Task 4: main — thread the token through and route the click

**Files:**
- Modify: `src/main/notifications/index.ts`
- Modify: `src/main/serviceHost.ts`
- Modify: `src/main/serviceView.ts`
- Modify: `src/main/serviceWindow.ts`
- Modify: `src/main/loftWindow.ts`
- Modify: `src/main/index.ts`
- Test: `tests/notifications.test.ts` (extend)

**Interfaces:**
- Consumes: the `service:notify-click` channel and the `notifyId` field (Task 3).
- Produces: `ServiceHost.notifyClick(notifyId: number): void`; `NotificationsDeps.click(id: string, notifyId: number): void`; `NotifyPayload.notifyId?: number`.

**Note:** `ServiceHost` is implemented **twice** — by `serviceWindow.ts`'s `api` object and by `loftWindow.ts`'s `hostFor`. Both must gain the method or the build fails.

- [ ] **Step 1: Write the failing test**

Read `tests/notifications.test.ts` for its `makeDeps()` helper, add a `click` spy to it alongside the existing `navigate` spy, then append these tests:

```ts
  it('routes a click to the page handler when the notification carries a notifyId', async () => {
    const server = makeFakeServer();
    connectNotificationServerMock.mockResolvedValue(server);
    const deps = makeDeps();
    const n = await startNotifications(deps);
    n.registerService('slack');
    await n.handle('slack', { title: 'Ann', body: 'hi', notifyId: 7 });

    server.fireAction(1);
    expect(deps.focusCalls).toEqual(['slack']);
    expect(deps.clickCalls).toEqual([['slack', 7]]);
    expect(deps.navigateCalls).toEqual([]);
  });

  it('still navigates by href when there is no notifyId (Messenger/Telegram)', async () => {
    const server = makeFakeServer();
    connectNotificationServerMock.mockResolvedValue(server);
    const deps = makeDeps();
    const n = await startNotifications(deps);
    n.registerService('messenger');
    await n.handle('messenger', { title: 'Ann', body: 'hi', href: '/t/123' });

    server.fireAction(1);
    expect(deps.navigateCalls).toEqual([['messenger', '/t/123']]);
    expect(deps.clickCalls).toEqual([]);
  });

  it('prefers the notifyId when both are somehow present', async () => {
    const server = makeFakeServer();
    connectNotificationServerMock.mockResolvedValue(server);
    const deps = makeDeps();
    const n = await startNotifications(deps);
    n.registerService('slack');
    await n.handle('slack', { title: 'Ann', body: 'hi', href: '/x', notifyId: 3 });

    server.fireAction(1);
    expect(deps.clickCalls).toEqual([['slack', 3]]);
    expect(deps.navigateCalls).toEqual([]);
  });
```

Add to `makeDeps()` (matching however it records `navigate`):

```ts
  const clickCalls: Array<[string, number]> = [];
  // …and in the returned object:
  //   clickCalls,
  //   click: (id: string, notifyId: number) => { clickCalls.push([id, notifyId]); },
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/notifications.test.ts`
Expected: FAIL — `click` is not called; TypeScript rejects `notifyId` on the payload.

- [ ] **Step 3: Extend the notifications module**

In `src/main/notifications/index.ts`, add to `NotifyPayload`:

```ts
  /** Token identifying the page-side Notification object, so its own click handler can be
   *  replayed. Absent for the DOM-scraped services, which route by href instead. */
  notifyId?: number;
```

Add to `NotificationsDeps`, directly below `navigate`:

```ts
  /** Replay the click into the page's own notification handler. */
  click(id: string, notifyId: number): void;
```

Replace the pending map and its action handler:

```ts
  const pending = new Map<number, { id: string; href?: string }>();
  server?.onActionDefault((notifId) => {
    const m = pending.get(notifId);
    if (!m) return;
    pending.delete(notifId);
    deps.focusService(m.id);
    if (m.href) deps.navigate(m.id, m.href);
  });
```

with:

```ts
  const pending = new Map<number, { id: string; href?: string; notifyId?: number }>();
  server?.onActionDefault((notifId) => {
    const m = pending.get(notifId);
    if (!m) return;
    pending.delete(notifId);
    deps.focusService(m.id);
    // Focus first: an app's own handler commonly calls window.focus() and should not race
    // ours. A notifyId means the page owns the routing; href is the DOM-scrape path.
    if (m.notifyId !== undefined) deps.click(m.id, m.notifyId);
    else if (m.href) deps.navigate(m.id, m.href);
  });
```

And where the pending entry is recorded, replace:

```ts
        pending.set(notifId, { id, href: p.href });
```

with:

```ts
        pending.set(notifId, { id, href: p.href, notifyId: p.notifyId });
```

- [ ] **Step 4: Add `notifyClick` to the host contract and both implementations**

In `src/main/serviceHost.ts`, add directly below the existing `navigate` member:

```ts
  /** Replay a notification click into the page's own handler (notification click). */
  notifyClick(notifyId: number): void;
```

In `src/main/serviceView.ts`, add to the `ServiceView` interface directly below its `navigate` member:

```ts
  /** Replay a notification click into the page's own handler. */
  notifyClick(notifyId: number): void;
```

and to the returned `api` object, directly below the existing `navigate` property:

```ts
    notifyClick: (notifyId) => safeSend(serviceView, 'service:notify-click', notifyId),
```

In `src/main/serviceWindow.ts`, add to the `api` object directly below its `navigate` property:

```ts
    notifyClick: (notifyId: number) => sv.notifyClick(notifyId),
```

In `src/main/loftWindow.ts`, add to the `hostFor` host object directly below its `navigate` property:

```ts
        notifyClick: (n) => sv.notifyClick(n),
```

- [ ] **Step 5: Wire it in index.ts**

In `src/main/index.ts`, in the `startNotifications({...})` deps object, add directly below the existing `navigate` line:

```ts
        click: (id, notifyId) => hostOf(id)?.notifyClick(notifyId),
```

Then find the `service:notify` IPC handler and widen its payload type and forwarding. Replace:

```ts
  ipcMain.on('service:notify', (e, p?: { title?: string; body?: string; icon?: string; href?: string }) => {
```

with:

```ts
  ipcMain.on('service:notify', (e, p?: { title?: string; body?: string; icon?: string; href?: string; notifyId?: number }) => {
```

and in the same handler replace the forwarding call:

```ts
    void notifications?.handle(sw.def.id, { title: p.title, body: p.body, icon: p.icon, href: p.href });
```

with:

```ts
    void notifications?.handle(sw.def.id, { title: p.title, body: p.body, icon: p.icon, href: p.href, notifyId: p.notifyId });
```

- [ ] **Step 6: Run the tests and build**

Run: `npm run build && npm test`
Expected: build completes with no TypeScript errors; all tests pass, including the three new notifications tests.

- [ ] **Step 7: Commit**

```bash
git add src/main tests/notifications.test.ts
git commit -m "feat(notify): route a notification click back into the page that raised it"
```

---

### Task 5: Verify end to end

**Files:** none modified — verification only.

**Interfaces:**
- Consumes: everything above.
- Produces: a smoke-test result.

- [ ] **Step 1: Full build and test**

Run: `npm run build && npm test`
Expected: build clean; all tests pass.

- [ ] **Step 2: Confirm no stray diagnostics survived the earlier spike**

Run: `grep -rn "notify-debug\|__loftNotifyDebug\|TEMPORARY DIAGNOSTIC" src/`
Expected: no output.

- [ ] **Step 3: Build the Flatpak**

Run:
```bash
flatpak-builder --user --disable-cache --force-clean --repo=.flatpak-repo build-dir chat.loft.Loft.yml
```
Expected: exit 0. If it fails with `rofiles-fuse ... Permission denied`, clear a stale mount and retry: `rm -rf .flatpak-builder/rofiles`.

- [ ] **Step 4: Install and verify the bytes**

Run:
```bash
flatpak update --user -y chat.loft.Loft
grep -c "service:notify-click" ~/.local/share/flatpak/app/chat.loft.Loft/current/active/files/main/dist/main/serviceView.js
```
Expected: at least 1.

- [ ] **Step 5: Hand the smoke test to Keith**

Do NOT launch the Flatpak GUI from automation (zypak's renderer spawn breaks). Report that the build is installed and ask Keith to quit and relaunch Loft, then for each service send an inbound message with that service unfocused and click the banner:

1. **Slack** — lands in the right conversation.
2. **Element** — lands in the right room.
3. **NextCloud Talk** — lands in the right conversation.
4. **WhatsApp** — lands in the right chat. **Check this one deliberately:** WhatsApp registers both a `click` listener and a non-standard `options.onClick`, and which one actually routes is not known. If the window focuses but does not navigate, the standard-handlers-win rule needs relaxing so `options.onClick` fires too.
5. **Messenger** — still works (regression check; it takes the older href path, which was not touched).
6. **Telegram** — still works (same regression check).

- [ ] **Step 6: Record the result**

Once Keith confirms, append the outcome to `.superpowers/sdd/progress.md` and tick the deep-links items in `dev_local/scratchpad.md`.

---

## Self-Review

**Spec coverage.** Every decision in the spec maps to a task: the retention cap and eviction (Task 1); retaining the instance, capturing all three handler forms, the handler-precedence rule, the synthetic event, contained throws, and never using `dispatchEvent` (Task 2); the token travelling out and the click coming back (Task 3); the `pending` record, the `ActionInvoked` branch, focus-before-handlers, and the host plumbing (Task 4); the smoke checklist including the WhatsApp caveat and the Messenger/Telegram regression check (Task 5). The spec's non-goals hold: Messenger and Telegram keep the `navigateAction` path, no URL is constructed anywhere, and no service-worker routing is attempted.

**Placeholders.** None — every code step shows the exact text to replace and its replacement, and every command states its expected output. Task 3 Step 1 and Task 4 Step 1 tell the implementer to read the existing test helpers first and adapt the harness wiring while keeping the assertions identical; the assertions themselves are given in full.

**Type consistency.** `notifyId` is a `number` at every boundary: `OverrideNotice.notifyId` (Task 2) → `service:notify` payload (Task 3) → `NotifyPayload.notifyId?: number` and `pending` (Task 4) → `NotificationsDeps.click(id: string, notifyId: number)` → `ServiceHost.notifyClick(notifyId: number)` → `ServiceView.notifyClick` → `service:notify-click` → `OverrideHandle.click(notifyId: number)`. `createNotifyRegistry<Captured>` in Task 2 matches the generic signature from Task 1. `ServiceHost` gaining a member obliges both implementers, which Task 4 Step 4 does explicitly.
