# Loft — Bubbles: pin a conversation to the rail

**Status:** designed (2026-07-26). Branch `feature/bubbles`. Spike artefacts in `dev_local/bubbles_spike/`.

Pin a single conversation — a WhatsApp chat, a Slack channel, an Element room — to the Loft
rail as a round avatar button with the service's icon badged bottom-right. Click it and Loft
takes you back to that conversation.

## Why this needed a spike first

A bubble is two capabilities, and neither existed:

1. **Capture** — while a conversation is open, produce a durable identifier for it.
2. **Reopen** — later, possibly after a restart, navigate that service back to that identifier.

Everything else (rail rendering, persistence, avatar fetching) is plumbing Loft already has.
Capture and reopen are entirely per-service, and the prior deep-links work
(`2026-07-19-electron-loft-deeplinks-design.md`) had explicitly ruled out URL construction as a
routing mechanism — for notifications, where the only handle is a `Notification` object. Bubbles
are different: the user is *looking at* the conversation when they pin it, so the whole page is
available. That difference is what made a fresh spike worth running rather than inheriting the
old conclusion.

WhatsApp was the risk. It is the flagship service and had no known per-chat URL. It is now the
best-evidenced service in the feature.

### Spike evidence, captured live from a real session (2026-07-26)

| Service | Capture | Reopen | Status |
|---|---|---|---|
| WhatsApp | JID from `#main` React props | row by `fiber[2].key` → leaf dispatch | **measured** |
| Slack | URL `/client/<TEAM>/<ID>` | row by `id` attribute → leaf dispatch | **measured** |
| Messenger | `/messages/t/<id>` | anchor click | already shipped for notifications |
| Telegram | `#<chatId>` | set `location.hash` | hash path already shipped |
| Element | `#/room/<id>` | set `location.hash` | inferred (standard Matrix routing) |
| NextCloud Talk | `/call/<token>` | `location.href` | inferred — no account available to test |

Telegram and Talk are **not** configured on the development machine, so they are inferred, not
measured. Both are hash/URL-routed and Telegram's hash navigation is already in production code
for notification clicks. Implementation must verify both before they ship.

Four findings from the spike are load-bearing and are stated as decisions below: the leaf
dispatch rule, WhatsApp's extractor rule, the `pushState` trap, and Slack's avatar split.

## Decisions

### The click must originate at a leaf

Neither WhatsApp nor Slack responds to `.click()` on a conversation row. Neither responds to a
full synthetic mouse sequence dispatched *on the row* either. Both respond to the same sequence
dispatched at the row's **deepest leaf**.

The reason is structural, not incidental: the handler sits on a *descendant* of the row, and DOM
events bubble up but never propagate down. An event whose target is the row wrapper can never
reach a handler below it. Starting at a leaf makes the bubble path cross every ancestor, so it
cannot miss.

Measured on WhatsApp, targeting one row four ways:

| Target | Navigated? |
|---|---|
| `row.click()` | no |
| mouse sequence on the row | no |
| mouse sequence on `[role="gridcell"]` inside the row | no |
| **mouse sequence on the row's deepest leaf** | **yes** |
| mouse sequence on `elementFromPoint(row centre)` | yes |

`elementFromPoint` works for the same reason — it returns the innermost element at a pixel — but
it is rejected as the primary mechanism because it requires the row to be inside the visible
scroll area and unoccluded. Neither is guaranteed when a bubble is clicked immediately after
waking a sleeping service. The leaf traversal has no geometry dependency. It is kept as a
documented fallback because it is independently verified.

The sequence must be realistic: `pointerover, mouseover, pointerdown, mousedown, pointerup,
mouseup, click`, every one with `bubbles: true, composed: true` and real client coordinates.

**This is one shared helper, not per-service code.** It is verified on two unrelated apps
(WhatsApp's `role="row"`, Slack's `role="treeitem"`). What differs per service is only how to
*find* the row.

### `pushState` + `popstate` is a trap, not an option

Tested on Slack: the URL changed, no reload occurred, and every automatic check reported
success — while the header still showed the previous conversation and the target opened in a
**stray popup window**. Loft routes same-origin `window.open` in-app as a popup
(`classifyWindowOpen`, `src/main/links.ts`), so a router confused by a synthetic `popstate`
produces a window nobody asked for.

It is recorded here because it is the obvious thing to reach for, it looks like it works, and
only a human looking at the rendered header catches it. **No adapter may use it.**

### Adapters return a plan; shared code executes it

Per-service code stays pure and unit-testable. This mirrors the existing `navigateAction`
(`src/preload/notify/navigate.ts`), which already returns a discriminated union of actions.

```ts
export type OpenPlan =
  | { kind: 'hash'; hash: string }               // Telegram, Element — instant, no reload
  | { kind: 'row'; find(doc: Document): Element | null; via?: 'leaf' | 'anchor' }
  | { kind: 'url'; url: string }                 // Talk — full reload
  | { kind: 'none' };

export interface ConversationAdapter {
  /** What is open right now, or null. Pure: reads the document, returns data. */
  capture(doc: Document, win: Window): CapturedConversation | null;
  /** How to get back to `key`. Pure: returns a plan, performs nothing. */
  plan(key: string, doc: Document, win: Window): OpenPlan;
  /** For `row` plans: the scrollable container to step when the row is absent. */
  scroller?(doc: Document): Element | null;
}

export interface CapturedConversation {
  key: string;
  title: string;
  avatarUrl?: string;
}
```

Registered per **kind** in a `CONVERSATION_ADAPTERS` map keyed exactly like `BADGE_PARSERS`, and
selected by the `--loft-service=<kind>` preload argument.

`via` is explicit rather than inferred, and defaults to `'leaf'`. **Messenger sets
`via: 'anchor'`** because its conversation rows are real `<a href>` elements and
`anchor.click()` is the mechanism already shipped and proven for notification clicks
(`navigateAction`). Leaf dispatch would probably work there too, but "probably" is not a reason
to change a working path, and an explicit hint beats the executor guessing from the tag name.

### WhatsApp's extractor must match whole values, anchored

The JID is available from two independent sources in `#main`'s React props —
`props.children.1.key` and `props.children.1.props.chat.__x_id._serialized` — and it survived a
reload byte-identically, which is what makes a bubble able to outlive a restart.

Two rules, both learned by getting them wrong:

**Do not hardcode the path.** `props.children.1.props.chat.…` bakes in a child index and a
nesting depth. Use a bounded search (depth ≤ 8, node cap, visited set, skipping `return`/`child`/
`sibling`/`stateNode`/`alternate`) so a tree reshuffle degrades into "search further" rather than
"returns undefined".

**Match anchored, against the whole value:**

```
/^(?:chat-)?([0-9A-Za-z]+(?:-[0-9]+)?@(?:c\.us|g\.us|lid|s\.whatsapp\.net|broadcast|newsletter))$/
```

A substring match is actively dangerous. `__x_chatlistPreview.msgKey` has the form
`true_<jid>_<hex>_<jid>`, and a greedy substring match yields `true_<jid>@g.us` — a wrong answer
shaped exactly like a right one. The first spike version had this flaw and produced correct
results only because `key` happened to be traversed before `msgKey`. The `chat-` prefix is
optional because list rows are keyed `chat-<jid>` while `#main` carries the bare JID; comparing
the two forms without normalising never matches.

Row lookup for WhatsApp is `fiber[2].key` — 71/71 rendered rows mapped, uniformly, at two
different scroll positions. Slack's is the row's own `id` attribute — 14/14 real conversations,
with the 8 unmapped rows being exactly the static entries (Threads, Huddles, Drafts, section
headings).

### A missing row is scrolled to, then given up on

WhatsApp renders ~71 of 92 rows at any scroll offset, so **roughly a quarter of pinned WhatsApp
chats have no row to click at the moment their bubble is clicked**. Slack has the same problem
from a different cause: its sidebar contents depend on the active top-level tab (Home / DMs /
Activity, user-customisable), so a channel row does not exist while the DMs tab is showing.

The fallback is to step the scroll container and re-check, bounded (20 steps of ~80% of the
container's `clientHeight`, wrapping from the top). The spike confirmed the render window
*slides* — a bottom-scrolled WhatsApp scan returned an entirely different chat set — so every
conversation is reachable this way.

If the bounded scroll exhausts, Loft **stops**. The user is left on the service, which is where
they wanted to go anyway. No error dialog, no broken-bubble state.

Driving the search box was considered and rejected for v1: it keys on the title (which renames
break), types into the user's UI, and leaves state to clean up.

### The preload pushes the open conversation; main caches it

Rather than a request/response round trip at pin time, each service preload reports the currently
open conversation on the same driver the badge scanner already uses (MutationObserver +
debounce + periodic poll), sending `service:conversation` with `{key, title, avatarUrl}` or null.

Main caches the latest per service. Three things fall out for free:

- Pinning needs no round trip — main already knows what to pin.
- The titlebar pin button can be correctly enabled/disabled, because main knows whether a
  conversation is open.
- An existing bubble whose conversation is observed open gets its **title refreshed**, so a
  renamed group stops showing a stale label without any extra mechanism.

### Bubbles key on the instance, not the kind

`serviceId` is the instance id (`whatsapp-2`), so a bubble on a second account resolves to that
account's partition and view. The kind is derived from it to select the adapter — exactly what
`--loft-service=` already does for badge parsers.

### Avatars are downloaded at pin time, not stored as URLs

Two reasons a stored URL cannot work: a bubble must render while its service is **asleep** (no
page to ask), and the CDN URLs expire — WhatsApp's carry signed `stp=` parameters, Slack's carry
a size suffix and a hash.

So at pin time main fetches via that instance's own partition session
(`session.fromPartition('persist:<id>').fetch(url)`, the mechanism already used for authenticated
Element and Talk notification avatars), decodes with `nativeImage`, resizes to 64px, and writes
`~/.local/share/loft/bubbles/<bubbleId>.png`. Served as `loft://bubble/<id>?e=<epoch>` by
extending the existing `loft://` protocol handler, with the same cache-buster epoch the instance
icons use.

**Slack channels have no avatar at all** — the spike found only an unrelated huddles onboarding
GIF in the header and no channel emoji. No generated image is needed: the rail's existing
`img.onerror` handler already falls back to initials (`src/renderer/rail/rail.ts`), and a Slack
channel title stored as `#general` yields `#` from the existing `initials()` helper. The fallback
is free.

### Rail placement, and no drag in v1

Bubbles sit **below** the services, behind their own divider. Services stay the fixed spine of
the rail and never shift as bubbles come and go; the rail already scrolls, so a long bubble list
pushes only itself off-screen.

**Bubbles are not draggable in v1.** Order is pin order; removal is via context menu. This is a
deliberate scope cut: the rail's drag machinery (`railGesture.ts`, `railDrag.ts`, `railSlots.ts`,
`gridDrop.ts`) carries the load-bearing invariants documented in CLAUDE.md — grid/detach mutual
exclusion, the drop-plan single source of truth, the never-re-render-mid-drag rule. Adding a
second entry type to it is a materially riskier change than the rest of this feature combined,
and it buys ordering control the user can get by unpinning and repinning. Reorder is the second
follow-up.

### Two entry points for pinning

A pin button in the service titlebar (greyed when no conversation is open), and "Pin current
conversation" in the service's existing rail context menu. One action, two entry points: the
titlebar for discovery, the context menu for muscle memory.

**In grid mode the titlebar button targets the focused cell's service** — the grid already
maintains a focused cell for zoom, so there is an existing answer to "which service does a
whole-window control act on", and inventing a second one would be worse. With no focused cell,
the button is greyed. The context-menu entry is never ambiguous: it names its own service.

Pinning is idempotent — pinning an already-pinned conversation is a no-op, not a duplicate.

### Clicking a bubble targets whatever live view the service already has

The rule is uniform across grid, tab and detached: **send the open command to the service's
existing live view, and change the rail selection only if that service is not already visible.**

- Detached → focus its window, navigate there, leave the rail selection alone.
- A grid leaf while the grid is selected → navigate in place, stay in the grid.
- Otherwise → select it as the active tab, waking it if asleep, then navigate.

This avoids fighting the grid/detach invariants rather than special-casing around them.

The service view appears **immediately**; navigation lands when the page is ready. A cold
WhatsApp start is 10+ seconds, and a shortcut that shows a blank rectangle for ten seconds reads
as broken.

### Reopen retries, because "loaded" is not "ready"

`did-finish-load` fires well before WhatsApp has populated its chat list. So the preload retries
the plan with bounded backoff (roughly 500ms intervals for up to 20s) before reporting
`not-found`. Without this, every bubble click on a sleeping service fails.

## Non-goals

- **Unread indication on bubbles.** Service badge only in v1. An unread *dot* is the first
  planned follow-up; it needs per-conversation unread scraping in all six parsers, which is a
  feature in its own right. A count is further out still — WhatsApp counts messages, Telegram
  counts conversations, and Element reads a title, so the three do not agree today.
- **Reordering bubbles by drag.** Second follow-up. See the rail-placement decision for why.
- **Marking stale or broken bubbles.** A failed reopen leaves the user on the service, silently.
- **Floating chat-head windows.** A bubble is a rail shortcut, not a window.
- **Pinning from a notification.**
- **The search-box fallback** for unreachable conversations.
- **Any use of a service's internal module registry** (`require`, WhatsApp's Store,
  `Cmd.openChat`). Everything here reads properties and synthesises input events — what a user
  does with a mouse. That boundary is deliberate: it keeps the failure mode "the feature degrades
  when the DOM changes" rather than "the account is treated as an unofficial client".

## Components

| Unit | Change |
|---|---|
| `src/main/bubbles.ts` **(new, pure)** | The model: add (idempotent), remove, lookup, title refresh, and recursive load validation that drops malformed entries. A corrupt bubble must cost you the bubble, never the ability to start Loft — the same rule `grid` follows. |
| `src/main/bubbleAvatars.ts` **(new)** | Fetch via the instance's partition session, decode/resize with `nativeImage`, write `~/.local/share/loft/bubbles/<id>.png`, bump the icon epoch. |
| `src/preload/conversation/adapters.ts` **(new, pure)** | Per-kind `capture` + `plan` + `scroller`. The six implementations; five are a few lines each. |
| `src/preload/conversation/whatsappJid.ts` **(new, pure)** | The bounded React-props search and the anchored normaliser. Separate file because it carries the two rules most likely to be got wrong. |
| `src/preload/conversation/open.ts` **(new)** | The shared executor: leaf traversal, the realistic event sequence, bounded scroll-and-retry, bounded ready-retry. The only impure part, written and tested once. |
| `src/preload/conversation/watch.ts` **(new)** | Drives `capture` on the badge scanner's cadence, sends `service:conversation` on change. |
| `src/preload/service.ts` | Start the conversation watcher; handle `bubble:open`. |
| `src/main/paths.ts` | `bubblesDir()`. |
| `src/main/config.ts` | `bubbles: Bubble[]` at the top level. Additive and absent-means-empty, so `configVersion` is unchanged and no migration is needed. |
| `src/main/railModel.ts` | `RailState.bubbles: BubbleItem[]` (`id`, `title`, `serviceId`, `kind` for the badge). |
| `src/renderer/rail/rail.ts` + `rail.css` | Render the bubble section: round avatar, service-icon badge bottom-right, initials fallback via the existing `img.onerror` path, click and context menu. |
| `src/renderer/titlebar/` | Pin button, enabled from pushed conversation state. |
| `src/main/index.ts` | `service:conversation` cache; `bubble:select`/`bubble:pin`/`bubble:remove` IPC; extend the `loft://` handler with a `bubble` host; add "Pin current conversation" to the service context menu; remove a service's bubbles when the service is removed. |

## Data flow

**Observe** — service preload's watcher runs `capture(doc, win)` on mutation/poll → on change,
`service:conversation { key, title, avatarUrl }` → main caches it per instance, refreshes the
title of any bubble with that key, and pushes titlebar enablement.

**Pin** — titlebar button or context menu → `bubble:pin { serviceId }` → main reads its cache,
mints `id = <serviceId>-<sha1(key)[0..12]>`, fetches and writes the avatar, appends to
`config.bubbles` (no-op if the key is already pinned), pushes new rail state.

**Click** — rail `bubble:select { id }` → main resolves the bubble to its instance → focuses the
detached window, or leaves the grid alone, or selects the tab and wakes the service → once the
view has loaded, `bubble:open { key }` → preload builds the plan and executes it, retrying while
the page settles → `bubble:opened { key, outcome }`.

**Remove** — rail context menu → `bubble:remove { id }` → drop from config, delete the avatar
file, push new rail state.

## Error handling and edge cases

- **Conversation not found after the bounded scroll** — leave the user on the service. Silent.
- **Service asleep** — the view is shown immediately and navigation lands when ready; the preload
  absorbs the gap between "loaded" and "chat list populated" by retrying.
- **Avatar fetch fails, or the conversation has no avatar** (every Slack channel) — no file is
  written, the `loft://bubble/<id>` request 404s, and the renderer's existing error handler draws
  initials. Not a special case.
- **Avatar URL expired** by the time a refresh runs — the old file stays; a stale avatar beats no
  avatar.
- **Conversation deleted or archived** — indistinguishable from not-found. Same silent outcome.
- **Title renamed** — refreshed automatically the next time that conversation is observed open.
  Until then the bubble shows the old label. Accepted.
- **Service removed** — its bubbles are removed and their avatar files deleted.
- **Second account of the same kind** — separate `serviceId`, therefore a separate bubble, a
  separate avatar file and a separate view. Pinning the same chat on two accounts yields two
  bubbles, which is correct.
- **Malformed `bubbles` in config** — invalid entries are dropped on load, the rest survive,
  Loft starts.
- **A kind with no adapter** — `capture` returns null (nothing to pin, button greyed) and `plan`
  returns `{ kind: 'none' }`. Adding a service without conversation support degrades to "no
  bubbles for that service", not a crash.

## Testing

Everything valuable here is pure, which is the point of the plan/execute split.

**Unit (Vitest)**
- `bubbles.ts`: add is idempotent on a repeated key; remove; title refresh; load validation drops
  malformed entries while keeping good ones; removing a service removes exactly its bubbles.
- `whatsappJid.ts`: the anchored normaliser accepts `chat-<jid>`, bare `<jid>`, `0@c.us`,
  `<num>-<num>@g.us` and `status@broadcast`, and **rejects** `true_<jid>_<hex>_<jid>` and
  `false_<jid>_…` — the composite that already produced a plausible wrong answer once. The
  bounded search finds a JID in a synthetic props tree and terminates on a cyclic one.
- `adapters.ts`: per kind, `capture` against a synthetic DOM, and `plan` returning the right
  variant — hash for Telegram/Element, row for WhatsApp/Slack/Messenger, url for Talk.
- `open.ts`: leaf traversal picks the deepest node; the event sequence is emitted in order with
  `bubbles`/`composed` set; scroll-retry stops at the cap; ready-retry stops at the cap.
- `railModel.ts`: `buildRailState` with bubbles present, with none, and with a bubble whose
  service was removed.
- Avatar path/epoch derivation.

**Manual**
- Pin and reopen on each configured service, from both entry points.
- Reopen a WhatsApp chat far enough down the list that its row is not rendered (exercises the
  scroll fallback).
- Reopen a Slack channel while the DMs tab is active (exercises the same fallback, different
  cause).
- Click a bubble whose service is asleep — the view must appear immediately and land on the
  conversation when ready.
- Restart Loft and confirm bubbles render before their services are woken.
- **Verify Telegram and NextCloud Talk**, which are inferred rather than measured.
