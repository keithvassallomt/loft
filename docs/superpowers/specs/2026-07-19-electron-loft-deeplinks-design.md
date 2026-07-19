# Electron Loft — Per-service deep links: let the app route itself

**Status:** design approved (2026-07-19), pending implementation plan.

Clicking a notification should land you in the conversation it came from. Today that works for Messenger and Telegram only. This makes it work for **WhatsApp, Slack, Element and NextCloud Talk** through one mechanism: invoke the web app's *own* notification click handler and let it route itself.

## Why

The routing plumbing already exists — notification click → `ActionInvoked` → focus the service window → `service:navigate` → the preload acts. What was missing is a conversation identifier for the four services whose notifications arrive through the `Notification`-override path. `bridge.ts` sends them with an empty href:

```js
ipc.send('service:notify', { title: n.title, body: n.body, icon, href: '' });
```

So `navigateAction` falls to `{ kind: 'none' }` and the click focuses the window but goes nowhere.

The obvious fix — recover the conversation id and build a URL per service — is not viable, and a spike proved it rather than us assuming it.

### Spike evidence (`dev_local/`, captured live from real sessions)

| service | path | own click handler | `tag` | `data` |
|---|---|---|---|---|
| WhatsApp | `page` | `options.onClick` **+** `addEventListener('click')` | JID `262135…@lid` | undefined |
| Slack | `page` | `.onclick` | `saved-for-later_…` | undefined |
| Talk | `page` | `.onclick` | `167` (numeric room) | undefined |
| Element | `page` | `.onclick` | **empty** | undefined |

Four conclusions, each load-bearing:

1. **No service uses the service worker.** Every one is `path: "page"`. A click dispatched to a page object could not reach a service-worker `notificationclick` handler, so this was the one finding that could have killed the approach outright.
2. **Every service attaches its own click handler**, so one mechanism covers all four.
3. **Routing from `tag`/`data` is not possible.** `data` is undefined everywhere and **Element supplies no `tag` at all** — there is nothing identifying the room. Designing around tag/data would have left Element unimplementable.
4. **WhatsApp is not the hard case.** It has the richest hooks of the four. The previous plan ("no URL routing; needs sender-matching by scrape") rested on an assumption that proved backwards, and WhatsApp is folded into this slice rather than deferred.

## Decisions

### Invoke the app's own handler

`SilentNotification` currently discards the object it creates, so a handler the app attaches can never fire. Instead: retain the instance, capture whatever handler the app attaches, and on click invoke it. The app then routes using its own internal logic — no URL construction, no DOM matching, no per-service knowledge.

### Identify notifications by our own token

The preload assigns each relayed notification a monotonically increasing `notifyId` and sends it with `service:notify`. Main already keeps a per-notification record from creation to click:

```ts
const pending = new Map<number, { id: string; href?: string }>();
```

That record gains the token, and `ActionInvoked` gains a branch: a `notifyId` sends `service:notify-click` back to that service's view; an `href` keeps today's `service:navigate` behaviour. Keying on our own token — not `tag` — is what makes Element work despite having none.

### Invoke handlers directly, never `dispatchEvent`

The retained object is **not a real `EventTarget`**. It carries `Notification.prototype` (which Slack inspects, and which must not change) but was never constructed by the real `Notification`, so it has no internal EventTarget slots — calling `dispatchEvent` on it throws *"Illegal invocation"*. That is precisely the error Slack already provokes when setting properties on the current dud object.

So we call the captured handlers ourselves, passing a synthetic click-shaped event with working `preventDefault`/`stopPropagation` (apps commonly call them and must not throw).

### Handler precedence, and the one thing the spike did not settle

Three handler forms are in evidence, so all three are captured: the `onclick` property, `addEventListener('click', …)` listeners, and WhatsApp's non-standard `options.onClick`.

WhatsApp registers **both** a click listener and `options.onClick`, and the spike established that both *exist*, not which one actually routes. Invoking both risks double-routing. The rule is therefore:

> Invoke the standard handlers (`onclick` plus any `click` listeners). Only if **no** standard handler was registered, fall back to `options.onClick`.

This yields exactly one invocation and prefers the standard path. **If WhatsApp's click turns out not to route, the fix is to call `options.onClick` as well** — recorded here so the smoke test checks it deliberately rather than discovering it later.

### Bounded retention

Retained instances are capped at the **50** most recent per view, evicted oldest-first, and dropped when the page calls `close()`. A service view lives for the whole session, so unbounded retention would be a slow leak.

## Non-goals

- **Migrating Messenger and Telegram.** They are DOM-scraped, carry real hrefs, and their deep links already work. The `navigateAction` path stays exactly as it is.
- **Constructing URLs per service.** Ruled out by the spike, not by preference.
- **Service-worker notification support.** No service uses it. If one ever does, it needs its own mechanism and this design does not pretend to cover it.
- **Changing what a notification looks like** — title, body, avatar handling are untouched.

## Components

| Unit | Change |
|---|---|
| `src/preload/notify/override.ts` | Return a retained instance; capture `onclick`, `click` listeners and `options.onClick`; expose `click(notifyId)` and `forget(notifyId)`. Keeps `Notification.prototype` and the `permission`/`requestPermission` shims exactly as they are. |
| `src/preload/notify/notifyRegistry.ts` **(new, pure)** | The retention map: `remember`, `take`, eviction at 50. Pure and unit-testable, so the leak-prevention rule is covered by a test rather than by hope. |
| `src/preload/notify/bridge.ts` | Assign `notifyId`, send it with `service:notify`, handle `service:notify-click` by invoking the retained handlers. |
| `src/main/notifications/index.ts` | `pending` records carry `notifyId`; `ActionInvoked` routes to a new `click(serviceId, notifyId)` dep when present, else today's `navigate`. |
| `src/main/index.ts` | Wire `click` to `host.notifyClick(notifyId)`; pass `notifyId` through from `service:notify`. |
| `src/main/serviceView.ts` | `notifyClick(id)` → `safeSend('service:notify-click', id)`, beside the existing `navigate`. |

## Data flow

**Create** — page calls `new Notification(...)` → override captures the instance and any handler, `notifyRegistry.remember()` returns a `notifyId` → `service:notify { title, body, icon, href: '', notifyId }` → main shows the desktop notification and records `pending[dbusId] = { id, href, notifyId }`.

**Click** — `ActionInvoked(dbusId)` → main focuses the service window (existing behaviour) → `notifyId` present ⇒ `service:notify-click { notifyId }` → preload takes the retained entry and invokes its handlers → **the app navigates itself**.

Messenger and Telegram are unchanged: no `notifyId`, an `href`, today's `service:navigate`.

## Error handling and edge cases

- **A handler that throws** is caught and logged; one bad handler must never break the click path or leak an exception into the page.
- **No handler was ever attached** — nothing to invoke. The window is still focused, which is today's behaviour, so this is a no-op rather than a regression.
- **The notification was already evicted** (older than the 50 most recent): the click focuses the window and does nothing else. Acceptable — clicking a very old banner is rare, and the alternative is an unbounded map.
- **`close()` called by the page** drops the entry immediately.
- **Both `href` and `notifyId` present** cannot happen (the scrape path sets no `notifyId`), but main prefers `notifyId` and ignores `href`, so the newer mechanism wins deterministically if it ever does.
- **Focus ordering**: the window is focused *before* the handlers run, since an app handler commonly calls `window.focus()` itself and should not race ours.
- **The `Notification.prototype` invariant is preserved.** Slack inspects the prototype before calling the constructor, and a synthetic prototype makes it skip notifications entirely. The returned object must keep `Orig.prototype`.

## Testing

**Unit** — this slice has a real seam, unlike the last one: `override.ts` is already covered by `tests/notifyOverride.test.ts`.

- `notifyRegistry`: remember/take round-trip, eviction at the cap (oldest first), `take` of an evicted or unknown id, `forget`.
- `override`: captures an `onclick` assignment; captures `addEventListener('click')`; captures `options.onClick`; **invokes standard handlers in preference to `options.onClick`**; invokes `options.onClick` only when no standard handler exists; a throwing handler is contained; the existing relay payload and `Notification.prototype` invariant are unchanged (regression guard).
- `notifications`: `ActionInvoked` with a `notifyId` calls `click` and not `navigate`; with an `href` calls `navigate`; with both prefers `click`.

**Manual smoke (Keith)** — one inbound message per service, app unfocused, then click the banner:
- **Slack, Element, Talk** — lands in the right conversation.
- **WhatsApp** — lands in the right chat. *Check this one deliberately:* if the window focuses but does not navigate, the standard-handler-first rule needs relaxing to also call `options.onClick` (see Decisions).
- **Messenger and Telegram** — still work exactly as before (regression check; they take a different path).
- Clicking a **stale** notification (after ~50 newer ones) focuses the window and does nothing, rather than misrouting.
