# Unread dot on bubbles — design

**Date:** 2026-07-27
**Status:** approved
**Follows:** `2026-07-26-bubbles-design.md` (follow-up 1 of the three recorded there)

## Goal

A pinned conversation shows an unread indicator, and it stays in sync with the app: reading
the chat in the service's own tab clears the bubble's dot.

**A dot, not a count.** Keith's call. That is not only a visual preference — it removes the
hardest part of the scrape, since several of these apps expose "this row is unread" without
exposing a per-conversation number.

## What already exists, and what this reuses

Four of the six badge parsers (`src/preload/badge/parsers.ts`) already walk **per-row** unread
state and then discard which row it was in order to return a count:

| Service | Existing per-row unread test | Row identity already used by the bubble adapter |
|---|---|---|
| Slack | `.p-channel_sidebar__channel--unread` | the row's own `id` attribute = the conversation key |
| Messenger | a text node reading `Unread message:` inside the anchor | the anchor's `href` → thread id |
| Telegram | `.chat-badge-transition` whose text is all digits | the row anchor's `href` (`#8623934162`) |
| Talk | `.counter-bubble__counter` | the row anchor's `href` (`/call/<token>`) |
| WhatsApp | **none per-row** — a single document-wide `aria-label` total | `waRowJid(row)` (React fiber key) |
| Element | **none per-row** — `[N]` from `document.title` | the room tile's `href` (`#/room/!id:server`) |

So for four services this feature is largely *not discarding information we already compute*.
WhatsApp and Element need genuinely new per-row detection: WhatsApp's parser reads a total, and
Element's is title-based precisely because its room list is virtualised with hashed CSS-module
classes (see CLAUDE.md).

## Design

### Two independent signals

Unread state for a pinned conversation comes from two places, and both are needed:

1. **Per-row scrape.** `ConversationAdapter` gains an optional `unreadKeys(doc): string[]` —
   the keys of the conversations the sidebar currently shows as unread. It sits on the
   adapter rather than on the badge parser because it needs the adapter's row→key identity;
   the unread *test* is borrowed from the parser.
2. **The open conversation is read, by definition.** The watcher already reports what is open.
   Main removes that key from the unread set the moment it arrives.

Signal 2 is what actually delivers the requirement. Reading a chat in the service's tab clears
the dot **even when that row has scrolled out of the virtualised window** — which is exactly
the case where signal 1 goes blind. Neither signal alone is sufficient: signal 1 cannot see an
unrendered row, and signal 2 knows nothing about the other conversations.

### Transport

A new `service:unread` IPC push carrying `string[]`, emitted by the **conversation watcher**
(`src/preload/conversation/watch.ts`).

Why the watcher and not the badge scanner: the watcher already owns per-kind row identity (it
imports the adapters) and already runs the right cadence — a 500 ms mutation debounce plus a
2 s poll. The badge scanner owns counts, and giving it a second job would couple two things
that change for different reasons.

Sent only when the set changes, compared as a sorted join — the same discipline
`sameConversation` already applies, and for the same reason: this runs every two seconds per
loaded service.

**The preload sends every unread key it can see, not just the pinned ones**, because it does
not know what is pinned — that lives in main's config. Main intersects. The alternative
(pushing the pinned key list down to each preload and keeping it current through pin, unpin
and remove) buys a smaller payload at the cost of a second thing to keep in sync; the payload
is a handful of short strings.

`unreadKeys` is optional on the adapter. A kind without one contributes no keys and its
bubbles simply never show a dot — the same "a kind with no adapter has no bubbles" degradation
the watcher already applies.

### State in main

```ts
const unreadKeys = new Map<string, Set<string>>();   // serviceId -> unread conversation keys
```

**Ephemeral. Never persisted.** A badge is live state; a dot restored from disk at startup
would be asserting something no view has verified. This mirrors service badges, which are 0
until the service loads.

Cleared for a service when it unloads or is removed, alongside `currentConversation`.

### Gating — the same rule as the service icons

`BubbleItem` gains `unread: boolean`, true when all of:

- the key is in that service's unread set;
- the service is **loaded** — a sleeping service has no view and therefore no honest answer,
  which is the same reason `buildRailModel` forces a sleeping service's badge to 0;
- that service's `badgesEnabled !== false`.

DND is deliberately **not** a gate: it does not suppress service badges today, and the rail
already shows DND separately with its own mark.

One rule to learn, applied to a second control — the same principle `pinTarget` followed in
reusing the grid's focused cell.

### Renderer

`bubbleButton` (`src/renderer/rail/rail.ts`) appends a `<span class="unread">` when
`item.unread`. Top-right, opposite the service badge, ringed in the rail's background colour
so it reads on top of a photo. Computed in main and shipped on `BubbleItem`, because the rail
renderer shares one global scope with the other renderer scripts and cannot import.

### Optimistic clear on click

Clicking a bubble opens that conversation, which makes it the open conversation, which clears
the dot via signal 2 — but up to a poll later. Main clears it immediately on
`rail:selectBubble` so the dot does not linger visibly after the click that read it.

## The actual work: six per-service scrapes

Each needs **one probe run against a chat that is genuinely unread**, not an inference. Six
DOM assumptions is precisely the shape of thing that produced five defects in the bubbles
smoke test, and in every one of those cases the wrong answer was the plausible one.

| Service | Expected mapping | Confidence |
|---|---|---|
| Slack | `.p-channel_sidebar__channel--unread` → the row's `id` | high — but whether the class sits on the element carrying the `id`, or on an ancestor/descendant, is unverified |
| Messenger | existing `Unread message:` walk → thread id from `href` | high — the notification scraper already does exactly this |
| Telegram | `.chat-badge-transition` → `closest('a[href^="#"]')` | medium — the `closest()` bridge is unverified |
| Talk | `.counter-bubble__counter` → `closest('a[href^="/call/"]')` | medium — same |
| WhatsApp | per-row unread marker → `waRowJid(row)` | medium — the per-row marker itself must be found |
| Element | room tile with a notification badge → its `href` | **low** — virtualised, hashed classes, currently title-based for that reason |

## Testing

- Per-adapter `unreadKeys` unit tests over realistic DOM taken from the probe output, one per
  service, including "nothing unread" and "unread row not rendered".
- Main-side: merge, the open-conversation clear, the sleeping and `badgesEnabled` gates, and
  clearing on unload/remove.
- Rail model: `BubbleItem.unread` is derived, not stored.

## Known limitation

A dot can go **stale**: if a pinned conversation's row is virtualised away *and* the chat is
read elsewhere (a phone), the scrape cannot see the change and the last known state persists.
It self-corrects as soon as the row renders again or the chat is opened in Loft. Unread
conversations sort to the top of the list in all six apps, so the row is nearly always
rendered — this is a narrow window, and the alternative (treating "not rendered" as "read")
would make the dot flicker off whenever the list scrolls.

## Out of scope

- **Counts.** Explicitly not wanted.
- **Unread for a sleeping service.** Not knowable without a live view. This is a real
  limitation of the design — arguably the most useful case for a bubble is "tell me when this
  person messages me" — but no amount of design work gets round having no page to scrape.
- **Persisting unread across a restart.** See "State in main".
- The other two recorded follow-ups: dragging bubbles to reorder, and automatic bubbles.
