# Unread dot on bubbles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pinned conversation shows an unread dot that clears when the chat is read anywhere, and a bubble whose service is asleep renders greyed out.

**Architecture:** Each conversation adapter gains `unreadKeys(doc)`, reusing the row→key identity it already has plus the unread test the badge parser already has. The conversation watcher pushes the key list over a new `service:unread` IPC on its existing cadence; main holds it in an ephemeral `Map<serviceId, Set<string>>`, clears the open conversation's key from it, and the rail model derives `BubbleItem.unread` and `.sleeping`.

**Tech Stack:** TypeScript, Electron 43, Vitest (node by default; `// @vitest-environment jsdom` per file), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-27-bubble-unread-design.md`

## Global Constraints

- **A dot, never a count.** No per-conversation numbers anywhere in this feature.
- **Unread state is ephemeral.** It is never written to `config.json` and never read from it.
- **The rail renderer cannot import.** `src/renderer/rail/rail.ts` shares one global scope with the other renderer scripts; anything derived must be computed in main and shipped on `BubbleItem` (this is why `bubbleGlyph`/`bubbleHue` live in `src/main/bubbles.ts`).
- **Adapters stay pure.** `unreadKeys(doc)` reads the DOM and returns strings. No IPC, no fetching, no mutation.
- **Keys must match `capture()` exactly.** A key produced by `unreadKeys` that does not equal the key `capture()` produces for the same conversation is invisible — main intersects by string equality. Messenger's canonical `/messages/t/<id>` form is the one that bites.
- **Gating lives in `buildRailState`, not in the adapters.** Adapters report what they see; main decides what to show.
- Run `npm test`, `npm run build` and `npm run check` before every commit. `npm test` does not type-check — `npm run build` is what catches type errors.

---

### Task 1: Probe the unread row→key mapping on all six services

This task produces **evidence, not code**. It cannot be completed by an agent alone: Keith runs the probe in each service's DevTools and pastes the output back.

Six DOM assumptions is exactly the shape of thing that produced five defects in the bubbles smoke test, and in every one of those the wrong answer was the plausible one (`via: 'anchor'` "already proven for notifications"; `a[href="<pathname>"]` when the href carries a trailing slash the pathname does not). The per-service tasks below contain concrete code written from the existing measured parsers — **if the probe contradicts it, the probe wins, and the plan text gets corrected too.**

**Files:**
- Create: `dev_local/bubbles_spike/probe-unread.js`
- Create: `dev_local/bubbles_spike/FINDINGS-unread.md`

- [ ] **Step 1: Write the probe**

```js
/**
 * Bubbles — unread row→key mapping. READ-ONLY.
 *
 * For each conversation the sidebar currently shows as UNREAD, report the key our adapter
 * would produce for it. That key must equal what capture() produces for the same
 * conversation, or the dot can never appear.
 *
 * Run it with at least one genuinely unread conversation on screen.
 */
(() => {
  const out = [];
  const log = (s = '') => out.push(s);
  const trunc = (s, n = 90) => (!s ? '' : s.length > n ? `${s.slice(0, n)}…` : s);
  const host = location.hostname;
  log(`=== unread probe @ ${new Date().toISOString()} — ${host} ===`);
  log(`  pathname=${JSON.stringify(location.pathname)}  hash=${JSON.stringify(location.hash)}`);

  /** Report one unread row: what marked it unread, and every id-ish thing near it. */
  const report = (i, marker, key, extra = '') => {
    log(`  ${i}. key=${key === null ? 'NULL  <-- unmapped, the dot cannot work' : JSON.stringify(key)}`);
    log(`     marker=<${marker.tagName.toLowerCase()} class="${trunc(marker.getAttribute('class') || '', 60)}">${extra}`);
  };

  if (host.includes('whatsapp')) {
    log('\n== WHATSAPP ==');
    const rows = [...(document.querySelector('#pane-side')?.querySelectorAll('[role="listitem"], [role="row"]') ?? [])];
    log(`  rendered rows: ${rows.length}`);
    let n = 0;
    for (const row of rows) {
      // Every candidate per-row unread marker we might key off.
      const aria = row.querySelector('[aria-label*="unread" i]');
      const anyBadge = [...row.querySelectorAll('span')].find((s) => /^\d+$/.test((s.textContent || '').trim()));
      if (!aria && !anyBadge) continue;
      let f = row, jid = null;
      for (const p of ['__reactFiber']) {
        const k = Object.keys(row).find((x) => x.startsWith(p));
        let fib = k ? row[k] : null;
        for (let d = 0; fib && d < 8; d++) {
          if (typeof fib.key === 'string' && /@(c\.us|g\.us|lid|s\.whatsapp\.net|broadcast|newsletter)$/.test(fib.key.replace(/^chat-/, ''))) {
            jid = fib.key.replace(/^chat-/, ''); break;
          }
          fib = fib.return;
        }
      }
      report(++n, aria || anyBadge || row, jid,
        `  aria-label=${JSON.stringify(trunc(aria?.getAttribute('aria-label'), 50))}  numericBadge=${anyBadge ? JSON.stringify((anyBadge.textContent || '').trim()) : 'none'}`);
      if (n >= 6) break;
    }
    if (!n) log('  NO unread rows found — open the app with an unread chat and re-run.');

  } else if (host.includes('slack')) {
    log('\n== SLACK ==');
    const rows = [...document.querySelectorAll('.p-channel_sidebar__channel--unread')];
    log(`  unread rows: ${rows.length}`);
    rows.slice(0, 8).forEach((row, i) => {
      const own = row.id || '';
      const up = row.closest('[id]')?.id || '';
      const down = row.querySelector('[id]')?.id || '';
      const pick = [own, up, down].find((x) => /^[CDG][A-Z0-9]{6,}$/.test(x)) ?? null;
      report(i, row, pick, `  ownId=${JSON.stringify(own)} closestId=${JSON.stringify(up)} descendantId=${JSON.stringify(down)}`);
    });
    if (!rows.length) log('  NO unread rows — the selector may have changed, or nothing is unread.');

  } else if (host.includes('telegram')) {
    log('\n== TELEGRAM ==');
    const badges = [...document.querySelectorAll('.chat-badge-transition')];
    log(`  .chat-badge-transition: ${badges.length}`);
    badges.slice(0, 8).forEach((b, i) => {
      const text = (b.textContent || '').trim();
      const href = b.closest('a[href^="#"]')?.getAttribute('href') ?? null;
      report(i, b, href, `  text=${JSON.stringify(text)} numeric=${/^\d+$/.test(text)}`);
    });

  } else if (host.includes('facebook') || host.includes('messenger')) {
    log('\n== MESSENGER ==');
    let n = 0;
    for (const a of document.querySelectorAll('a[href*="/messages/"]')) {
      const w = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
      let unread = false, node;
      while ((node = w.nextNode())) if ((node.textContent || '').trim() === 'Unread message:') { unread = true; break; }
      if (!unread) continue;
      const href = a.getAttribute('href') || '';
      const id = (href.match(/^\/messages\/(?:[^/]+\/)?t\/([^/?#]+)/) || [])[1] ?? null;
      report(++n, a, id ? `/messages/t/${id}` : null,
        `  href=${JSON.stringify(trunc(href, 50))} muted=${!!a.querySelector('[style*="--disabled-icon"]')}`);
      if (n >= 8) break;
    }
    if (!n) log('  NO unread rows — send yourself a message and re-run.');

  } else if (host.includes('element') || document.querySelector('.mx_RoomHeader')) {
    log('\n== ELEMENT ==');
    const badges = [...document.querySelectorAll('[class*="NotificationBadge" i], [class*="mx_NotificationBadge"]')];
    log(`  notification-badge-ish elements: ${badges.length}`);
    badges.slice(0, 8).forEach((b, i) => {
      const href = b.closest('a[href^="#/room/"]')?.getAttribute('href')
        ?? b.closest('[class*="RoomTile" i]')?.querySelector('a[href^="#/room/"]')?.getAttribute('href')
        ?? null;
      report(i, b, href, `  text=${JSON.stringify((b.textContent || '').trim())}`);
    });
    log('\n  [ROOM TILE SHAPE] — first 3, so we can see where the href and the badge live:');
    [...document.querySelectorAll('[class*="RoomTile" i]')].slice(0, 3).forEach((t, i) => {
      log(`   ${i}. <${t.tagName.toLowerCase()} class="${trunc(t.getAttribute('class') || '', 70)}">`);
      log(`      a[href]=${JSON.stringify(t.querySelector('a[href]')?.getAttribute('href') ?? null)}`);
      log(`      badge-ish inside=${t.querySelector('[class*="Badge" i]')?.getAttribute('class') ?? 'none'}`);
    });

  } else {
    log('\n== NEXTCLOUD TALK ==');
    const counters = [...document.querySelectorAll('.counter-bubble__counter')];
    log(`  .counter-bubble__counter: ${counters.length}`);
    counters.slice(0, 8).forEach((c, i) => {
      const href = c.closest('a[href^="/call/"]')?.getAttribute('href') ?? null;
      report(i, c, href, `  text=${JSON.stringify((c.textContent || '').trim())}`);
    });
  }

  const rep = out.join('\n');
  console.log(rep);
  try { copy(rep); console.log('\n(copied to clipboard)'); } catch { /* not DevTools */ }
})();
```

- [ ] **Step 2: Do NOT try to commit it**

`dev_local/` is gitignored — it holds spike artefacts deliberately kept out of the repo, as
the bubbles spike's own probes are. `git add` will report "nothing to commit"; that is
correct, not a failure.

- [ ] **Step 3: Hand it to Keith, one service at a time**

Ask him to open each service with **at least one genuinely unread conversation visible**, paste the probe into that view's DevTools console, and paste back the report. Six runs: WhatsApp, Slack, Messenger, Telegram, Talk, Element.

The single thing to read in each report is whether `key=` is a real value or `NULL`. A `NULL` means the marker cannot be mapped to a conversation and that service needs a different approach before its task is written.

- [ ] **Step 4: Record what was measured**

Write `dev_local/bubbles_spike/FINDINGS-unread.md` with, per service: the unread marker
selector, the element the key came from, the key format, and whether it matches that adapter's
`capture()` key format. Also gitignored — it is the input to Tasks 5–8, not a deliverable.

**Blocking:** Tasks 5–8 must not start until this task's findings exist for the services they cover. Tasks 2–4 have no DOM dependency and can proceed in parallel.

---

### Task 2: `unreadKeys` on the adapter, and the `service:unread` push

**Files:**
- Modify: `src/preload/conversation/adapters.ts` (the `ConversationAdapter` interface only)
- Modify: `src/preload/conversation/watch.ts`
- Modify: `src/preload/service.ts`
- Test: `tests/conversationWatch.test.ts`

**Interfaces:**
- Consumes: `CONVERSATION_ADAPTERS`, `startConversationWatch(kind, deps)` as they exist today.
- Produces:
  - `ConversationAdapter.unreadKeys?(doc: Document): string[]`
  - `WatchDeps.sendUnread(keys: string[]): void`
  - IPC channel `'service:unread'` carrying `string[]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/conversationWatch.test.ts`:

These tests **stub** the adapter rather than using a real one. That is deliberate and
load-bearing: no adapter has an `unreadKeys` until Task 5, and after Task 8 every one of them
does — so a test written against a real adapter would either fail now or change meaning later.
This task owns the transport; Tasks 5–8 own the scrapes.

```ts
describe('unread key push', () => {
  const win2 = (pathname: string): Window =>
    ({ location: { pathname, hash: '', href: 'https://app.slack.com/' } } as unknown as Window);

  let original: ConversationAdapter['unreadKeys'];
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    original = CONVERSATION_ADAPTERS.slack.unreadKeys;
  });
  afterEach(() => {
    vi.useRealTimers();
    CONVERSATION_ADAPTERS.slack.unreadKeys = original;
  });

  /** Drive the watcher with a stubbed adapter and return what it pushed. */
  const run = (unreadKeys: ConversationAdapter['unreadKeys'], ms = 5000): ReturnType<typeof vi.fn> => {
    CONVERSATION_ADAPTERS.slack.unreadKeys = unreadKeys;
    const sendUnread = vi.fn();
    startConversationWatch('slack', {
      doc: document, win: win2('/client/T1/C0ABC'), send: vi.fn(), sendUnread,
    });
    vi.advanceTimersByTime(ms);
    return sendUnread;
  };

  it('pushes the keys the adapter reports', () => {
    expect(run(() => ['C0ABC'])).toHaveBeenCalledWith(['C0ABC']);
  });

  it('sorts and dedupes, so the same set never looks like a different one', () => {
    expect(run(() => ['C0B', 'C0A', 'C0B'])).toHaveBeenCalledWith(['C0A', 'C0B']);
  });

  // This runs every two seconds per loaded service; an unchanged set must not cross IPC.
  it('pushes only when the set changes', () => {
    expect(run(() => ['C0ABC'], 20_000)).toHaveBeenCalledTimes(1);
  });

  // A page that reloads from "two unread" to "none" must say so, or main keeps stale dots
  // for the life of the session.
  it('pushes an EMPTY set on the first scan, so a fresh page clears stale state', () => {
    expect(run(() => [])).toHaveBeenCalledWith([]);
  });

  it('reports nothing for a kind whose adapter has no unreadKeys', () => {
    expect(run(undefined)).toHaveBeenCalledWith([]);
  });

  it('survives an adapter that throws mid-navigation', () => {
    let sendUnread: ReturnType<typeof vi.fn>;
    expect(() => { sendUnread = run(() => { throw new Error('mid-navigation'); }); }).not.toThrow();
    expect(sendUnread!).toHaveBeenCalledWith([]);
  });
});
```

Add to that file's imports:

```ts
import { CONVERSATION_ADAPTERS, type ConversationAdapter } from '../src/preload/conversation/adapters';
```

The file already imports `describe, it, expect, vi, beforeEach, afterEach` from vitest.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/conversationWatch.test.ts`
Expected: FAIL — `sendUnread` is not called (and TypeScript would reject the extra dep, though vitest does not type-check).

- [ ] **Step 3: Add `unreadKeys` to the adapter interface**

In `src/preload/conversation/adapters.ts`, inside `export interface ConversationAdapter`, after `scroller?`:

```ts
  /**
   * The keys of every conversation the sidebar currently shows as UNREAD.
   *
   * Returns ALL of them, not just the pinned ones — the page has no idea what is pinned, that
   * lives in main's config. Main intersects.
   *
   * These keys MUST be in the same form `capture()` produces, or a conversation can never be
   * matched: main compares by string equality. Messenger is the one that bites, since its
   * capture key is canonicalised to `/messages/t/<id>`.
   *
   * Optional: a kind without one contributes no keys and its bubbles never show a dot.
   */
  unreadKeys?(doc: Document): string[];
```

- [ ] **Step 4: Push the keys from the watcher**

In `src/preload/conversation/watch.ts`, add to `WatchDeps`:

```ts
  /** Keys of conversations currently unread; see ConversationAdapter.unreadKeys. */
  sendUnread(keys: string[]): void;
```

Then, inside `startConversationWatch`, after the `let reported = false;` line:

```ts
  // `null`, not '': the first scan must ALWAYS send, including when nothing is unread. A
  // reloaded page whose unread chats have all been read would otherwise never say so, and
  // main would hold stale dots for the life of the session.
  let lastUnread: string | null = null;

  const scanUnread = (): void => {
    let keys: string[] = [];
    // Same containment as capture(): a page mid-navigation can make any adapter throw, and
    // that is an ordinary transient rather than an error.
    try { keys = adapter.unreadKeys?.(deps.doc) ?? []; } catch { keys = []; }
    const sorted = [...new Set(keys)].sort();
    // Sorted join, so an unchanged set does not cross IPC every two seconds — the same
    // discipline sameConversation already applies, for the same reason. NUL separated so no
    // key's content can forge a boundary.
    const fingerprint = sorted.join('\u0000');
    if (fingerprint === lastUnread) return;
    lastUnread = fingerprint;
    deps.sendUnread(sorted);
  };

  /** One tick drives both: they read the same DOM at the same cadence. */
  const tick = (): void => { scan(); scanUnread(); };
```

Note `scan` is declared with `const scan = ...` above, so `tick` must be declared **after** it.

Then replace the three `scan` call sites at the bottom of the function with `tick`:

```ts
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const onMutation = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(tick, DEBOUNCE_MS);
  };
```

and

```ts
  setInterval(tick, POLL_MS);
  setTimeout(tick, FIRST_SCAN_MS);
```

- [ ] **Step 5: Wire the IPC in the preload**

In `src/preload/service.ts`, extend the `startConversationWatch` call:

```ts
  startConversationWatch(serviceId, {
    doc: document,
    win: window,
    send: (conversation) => ipcRenderer.send('service:conversation', conversation),
    sendUnread: (keys) => ipcRenderer.send('service:unread', keys),
  });
```

- [ ] **Step 6: Verify**

Run: `npx vitest run tests/conversationWatch.test.ts` → PASS
Run: `npm test && npm run build && npm run check` → all clean

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(bubbles): adapters report unread keys, watcher pushes them"
```

---

### Task 3: Main holds unread state; the rail model derives `unread` and `sleeping`

**Files:**
- Modify: `src/main/railModel.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/loftWindow.ts`
- Test: `tests/railBubbles.test.ts`

**Interfaces:**
- Consumes: IPC `'service:unread'` from Task 2.
- Produces:
  - `BubbleItem.unread: boolean`, `BubbleItem.sleeping: boolean`
  - `buildBubbleItems(i: BubbleItemInput): BubbleItem[]` — **signature changes to a single object parameter**
  - `RailStateInput.unreadKeys(serviceId: string): ReadonlySet<string>`
  - `LoftWindowDeps.unreadKeys(serviceId: string): ReadonlySet<string>`

- [ ] **Step 1: Write the failing tests**

Replace the whole body of `tests/railBubbles.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { buildBubbleItems } from '../src/main/railModel';
import { bubbleId, type Bubble } from '../src/main/bubbles';

const b = (serviceId: string, key: string, title: string): Bubble =>
  ({ id: bubbleId(serviceId, key), serviceId, key, title });

/** Second accounts resolve to their kind; everything else is its own kind. */
const kindOf = (id: string): string => (id === 'whatsapp-2' ? 'whatsapp' : id);

/** Defaults: everything installed, awake, and read. */
const build = (bubbles: Bubble[], over: Partial<Parameters<typeof buildBubbleItems>[0]> = {}) =>
  buildBubbleItems({
    bubbles,
    installed: new Set(bubbles.map((x) => x.serviceId)),
    kindOf,
    sleeping: () => false,
    unread: () => false,
    ...over,
  });

describe('buildBubbleItems', () => {
  it('keeps pin order', () => {
    const items = build([b('slack', 'C1', 'general'), b('whatsapp', '1@lid', 'Dan')]);
    expect(items.map((i) => i.title)).toEqual(['general', 'Dan']);
  });

  it('carries the KIND for the corner badge, not the instance id', () => {
    const items = build([b('whatsapp-2', '1@lid', 'Dan')]);
    expect(items[0]).toMatchObject({
      id: bubbleId('whatsapp-2', '1@lid'), title: 'Dan', serviceId: 'whatsapp-2', kind: 'whatsapp',
    });
  });

  it('carries a glyph and hue for the no-avatar fallback', () => {
    const items = build([b('slack', 'C1', '#general'), b('slack', 'C2', '#random')]);
    expect(items[0].glyph).toBe('#GE');
    expect(items[1].glyph).toBe('#RA');
    expect(items[0].hue).not.toBe(items[1].hue);
  });

  it('hides bubbles whose service is no longer installed, rather than rendering a dead button', () => {
    const items = buildBubbleItems({
      bubbles: [b('gone', 'X', 'Ghost')],
      installed: new Set(['slack']),
      kindOf,
      sleeping: () => false,
      unread: () => false,
    });
    expect(items).toEqual([]);
  });

  it('returns [] for no bubbles', () => {
    expect(build([])).toEqual([]);
  });

  // --- the unread dot ---

  it('marks the bubble whose key is unread, and only that one', () => {
    const items = build(
      [b('slack', 'C1', 'general'), b('slack', 'C2', 'random')],
      { unread: (sid, key) => sid === 'slack' && key === 'C1' },
    );
    expect(items.map((i) => i.unread)).toEqual([true, false]);
  });

  it('keys unread on the SERVICE as well as the conversation', () => {
    // Two accounts of one kind can pin the same conversation key; they are different bubbles.
    const items = build(
      [b('whatsapp', '1@lid', 'Dan'), b('whatsapp-2', '1@lid', 'Dan')],
      { unread: (sid) => sid === 'whatsapp-2' },
    );
    expect(items.map((i) => i.unread)).toEqual([false, true]);
  });

  // --- sleeping ---

  it('marks a bubble sleeping when its service is asleep', () => {
    const items = build(
      [b('slack', 'C1', 'general'), b('whatsapp', '1@lid', 'Dan')],
      { sleeping: (sid) => sid === 'slack' },
    );
    expect(items.map((i) => i.sleeping)).toEqual([true, false]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/railBubbles.test.ts`
Expected: FAIL — `buildBubbleItems` takes positional arguments, so passing one object yields `undefined` reads.

- [ ] **Step 3: Change `BubbleItem` and `buildBubbleItems`**

In `src/main/railModel.ts`, add to `BubbleItem` after `hue`:

```ts
  /** Unread mark. Already gated: false when the service sleeps or has badges disabled. */
  unread: boolean;
  /** Service not loaded — rendered greyed, exactly as a sleeping service icon is. A bubble
   *  with no dot would otherwise be ambiguous between "nothing unread" and "nobody is
   *  looking", and those are very different things to someone deciding whether they have
   *  been messaged. */
  sleeping: boolean;
```

Replace `buildBubbleItems` with:

```ts
export interface BubbleItemInput {
  bubbles: readonly Bubble[];
  installed: ReadonlySet<string>;
  kindOf(serviceId: string): string;
  /** No view -> no honest unread answer; the bubble renders greyed. */
  sleeping(serviceId: string): boolean;
  /** Fully gated by the caller — see buildRailState. */
  unread(serviceId: string, key: string): boolean;
}

/**
 * Bubbles for the rail, in pin order.
 *
 * A bubble whose service is no longer installed is omitted rather than drawn: clicking it
 * could only fail. Config cleanup happens on service removal; this filter is the safety net
 * for a hand-edited config, and for the window between the two.
 */
export function buildBubbleItems(i: BubbleItemInput): BubbleItem[] {
  return i.bubbles
    .filter((b) => i.installed.has(b.serviceId))
    .map((b) => ({
      id: b.id,
      title: b.title,
      serviceId: b.serviceId,
      kind: i.kindOf(b.serviceId),
      glyph: bubbleGlyph(b.title),
      hue: bubbleHue(b.key),
      unread: i.unread(b.serviceId, b.key),
      sleeping: i.sleeping(b.serviceId),
    }));
}
```

- [ ] **Step 4: Gate it in `buildRailState`**

In `src/main/railModel.ts`, add to `RailStateInput`:

```ts
  /** Conversation keys currently unread for a service, as reported by its preload. */
  unreadKeys(serviceId: string): ReadonlySet<string>;
```

and replace the `bubbles:` property inside `buildRailState`'s returned object:

```ts
    bubbles: buildBubbleItems({
      bubbles: i.bubbles,
      installed: new Set(i.services.filter((d) => i.config.services[d.id] !== undefined).map((d) => d.id)),
      kindOf: i.kindOf,
      sleeping: (sid) => !i.loaded(sid),
      // The same two gates buildRailModel applies to a service's own badge, for the same
      // reasons: a sleeping service has no view and so cannot have an honest count, and a
      // service with badges disabled should not show one by another route. DND is
      // deliberately NOT a gate — it does not suppress service badges, and the rail shows it
      // separately with its own mark.
      unread: (sid, key) => i.loaded(sid)
        && i.config.services[sid]?.badgesEnabled !== false
        && i.unreadKeys(sid).has(key),
    }),
```

- [ ] **Step 5: Verify the model**

Run: `npx vitest run tests/railBubbles.test.ts` → PASS

- [ ] **Step 6: Hold the state in main**

In `src/main/index.ts`, immediately after the `currentConversation` declaration (line ~100):

```ts
/**
 * Conversation keys each loaded service currently reports as unread, pushed by its preload.
 *
 * EPHEMERAL by design — never persisted. A dot restored from disk at startup would be
 * asserting something no view has verified. This mirrors service badges, which are 0 until
 * the service loads.
 */
const unreadKeys = new Map<string, Set<string>>();
```

Add the handler next to the `service:conversation` handler:

```ts
  ipcMain.on('service:unread', (e, keys?: unknown) => {
    const sw = findBySenderId(e.sender.id);
    if (!sw || !Array.isArray(keys)) return;
    const id = sw.def.id;
    const set = new Set(keys.filter((k): k is string => typeof k === 'string'));
    // The conversation currently open is read BY DEFINITION, and this is the signal that
    // makes the feature work at all: it still holds when the row has scrolled out of a
    // virtualised list, which is exactly where the scrape goes blind.
    const open = currentConversation.get(id);
    if (open) set.delete(open.key);
    unreadKeys.set(id, set);
    loft?.refreshRail();
  });
```

Inside the existing `service:conversation` handler, in the branch where `conv` is built, immediately after `currentConversation.set(id, conv);`:

```ts
    // Opening a conversation reads it. The scrape will agree on its next tick; this makes the
    // dot clear at the moment the user actually read it rather than up to a poll later.
    if (unreadKeys.get(id)?.delete(conv.key)) loft?.refreshRail();
```

In the `rail:selectBubble` handler, immediately after the `if (!bubble) return;` line:

```ts
    // Optimistic: the click IS the read. The open-conversation signal would clear this within
    // a poll anyway, but a dot that lingers after the click that dismissed it looks broken.
    if (unreadKeys.get(bubble.serviceId)?.delete(bubble.key)) loft?.refreshRail();
```

At line ~643, next to the existing `currentConversation.delete(id);`:

```ts
  unreadKeys.delete(id);
```

- [ ] **Step 7: Pass it to the rail**

In `src/main/loftWindow.ts`, add to the deps interface (beside `badge`):

```ts
  /** Conversation keys currently unread for a service; empty for a sleeping one. */
  unreadKeys(serviceId: string): ReadonlySet<string>;
```

and add to the `buildRailState({...})` call in `refreshRail`:

```ts
      unreadKeys: deps.unreadKeys,
```

In `src/main/index.ts`, add to the `createLoftWindow({...})` call beside `badge:`:

```ts
      unreadKeys: (id) => unreadKeys.get(id) ?? new Set<string>(),
```

- [ ] **Step 8: Verify**

Run: `npm test && npm run build && npm run check`
Expected: all clean. If `npm run build` reports a missing `unreadKeys` on a `buildRailState` or `createLoftWindow` call, that call site was missed — there is exactly one of each.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(bubbles): main holds unread state, rail model derives the dot"
```

---

### Task 4: Render the dot, and grey a sleeping bubble

**Files:**
- Modify: `src/renderer/rail/rail.ts`
- Modify: `src/renderer/rail/rail.css`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `BubbleItem.unread`, `BubbleItem.sleeping` from Task 3.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Render it**

In `src/renderer/rail/rail.ts`, inside `bubbleButton`, replace the two lines that set the title and aria-label:

```ts
  b.title = item.title;
  b.setAttribute('aria-label', item.unread ? `${item.title} (unread)` : item.title);
  b.classList.toggle('sleeping', item.sleeping);
```

and, immediately before `return b;`, after the service badge is appended:

```ts
  // Top-right, opposite the service badge — the one free corner. Appended last so it sits
  // above the avatar. A sleeping bubble never has one: main gates it (no view, no honest
  // answer), and the greyed treatment is what says so.
  if (item.unread) {
    const dot = document.createElement('span');
    dot.className = 'unread';
    dot.setAttribute('aria-hidden', 'true');
    b.append(dot);
  }
```

- [ ] **Step 2: Style it**

In `src/renderer/rail/rail.css`, change the existing sleeping rule (line ~26) to cover both, so the two treatments cannot drift apart:

```css
.item.sleeping, .bubble.sleeping { opacity: .45; filter: grayscale(1); }
```

and add after the `.bubble .glyph.wide` rule:

```css
/* Ringed in the rail's own background colour so it reads as a mark sitting ON the avatar
   rather than part of the image — the same trick the service badge below it uses. */
.bubble .unread {
  position: absolute; top: -2px; right: -2px;
  width: 11px; height: 11px; border-radius: 50%;
  background: #0071e3; border: 2px solid #e5e5e7;
}
```

and inside the existing `@media (prefers-color-scheme: dark)` block that already contains `.bubble`:

```css
  .bubble .unread { background: #0a84ff; border-color: #3d3d3f; }
```

- [ ] **Step 3: Verify**

Run: `npm test && npm run build && npm run check`
Expected: all clean.

There is no unit test for this step. The rail renderer is a DOM script with no test harness in this codebase — `tests/railBubbles.test.ts` covers the model that feeds it, which is where the logic lives. Do not invent a harness for four lines of DOM construction.

- [ ] **Step 4: Document it**

In `CLAUDE.md`, in the numbered component list, find the sentence describing bubbles in the rail and add:

```
A pinned conversation shows an unread **dot** (never a count) top-right, gated exactly like a service's own badge — nothing while that service sleeps or has badges disabled. A bubble whose service is asleep is greyed out with the same `opacity: .45; filter: grayscale(1)` the service icons use, because a bubble with no dot would otherwise be ambiguous between "nothing unread" and "nobody is looking". Unread state is ephemeral and never persisted.
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(bubbles): unread dot and greyed sleeping bubbles"
```

---

### Task 5: Slack and Messenger `unreadKeys`

The two highest-confidence services: each keys off an identifier its adapter already uses.

**Files:**
- Modify: `src/preload/conversation/adapters.ts`
- Test: `tests/conversationAdapters.test.ts`

**Interfaces:**
- Consumes: `ConversationAdapter.unreadKeys` from Task 2; `messengerThreadId` and `MESSENGER_THREAD` already in `adapters.ts`.
- Produces: `slack.unreadKeys`, `messenger.unreadKeys`.

**Before starting:** read `dev_local/bubbles_spike/FINDINGS-unread.md` from Task 1. If it contradicts the code below, follow the findings and correct this plan text too.

- [ ] **Step 1: Write the failing tests**

Append to `tests/conversationAdapters.test.ts`:

```ts
describe('slack unreadKeys', () => {
  const slack = CONVERSATION_ADAPTERS.slack;

  it('reports the conversation id of each unread row', () => {
    document.body.innerHTML = `
      <div id="C0ABCDEF" class="p-channel_sidebar__channel--unread">general</div>
      <div id="D0GHIJKL" class="p-channel_sidebar__channel--unread">Dan</div>
      <div id="C0MNOPQR">random</div>`;
    expect(slack.unreadKeys!(document).sort()).toEqual(['C0ABCDEF', 'D0GHIJKL']);
  });

  // The existing badge parser excludes this row from its count; so must this.
  it('ignores the "add more items" affordance', () => {
    document.body.innerHTML = `
      <div id="C0ABCDEF" class="p-channel_sidebar__channel--unread">
        <div class="p-channel_sidebar__link--add-more-items">more</div>
      </div>`;
    expect(slack.unreadKeys!(document)).toEqual([]);
  });

  it('finds the id when the unread class is on a wrapper rather than the row itself', () => {
    document.body.innerHTML =
      '<div class="p-channel_sidebar__channel--unread"><div id="C0ABCDEF">general</div></div>';
    expect(slack.unreadKeys!(document)).toEqual(['C0ABCDEF']);
  });

  it('reports nothing when nothing is unread', () => {
    document.body.innerHTML = '<div id="C0ABCDEF">general</div>';
    expect(slack.unreadKeys!(document)).toEqual([]);
  });
});

describe('messenger unreadKeys', () => {
  const mg = CONVERSATION_ADAPTERS.messenger;
  const unreadRow = (href: string, muted = false) => `
    <a href="${href}">
      <span>Unread message:</span><span>RAOB Currock Lodge</span>
      ${muted ? '<div style="--disabled-icon: 1"></div>' : ''}
    </a>`;

  // The key MUST be the canonical form capture() produces, or main can never match it.
  it('reports the CANONICAL key, not the raw href', () => {
    document.body.innerHTML = unreadRow('/messages/e2ee/t/6382594055138206/');
    expect(mg.unreadKeys!(document)).toEqual(['/messages/t/6382594055138206']);
  });

  it('ignores read rows and muted ones', () => {
    document.body.innerHTML =
      unreadRow('/messages/t/111/') + '<a href="/messages/t/222/"><span>Read</span></a>'
      + unreadRow('/messages/t/333/', true);
    expect(mg.unreadKeys!(document)).toEqual(['/messages/t/111']);
  });

  // Messenger renders the same thread as more than one anchor; the badge parser dedupes too.
  it('dedupes a thread rendered as two anchors', () => {
    document.body.innerHTML = unreadRow('/messages/t/111/') + unreadRow('/messages/t/111');
    expect(mg.unreadKeys!(document)).toEqual(['/messages/t/111']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/conversationAdapters.test.ts`
Expected: FAIL — `slack.unreadKeys` and `messenger.unreadKeys` are `undefined`.

- [ ] **Step 3: Implement Slack**

In `src/preload/conversation/adapters.ts`, above `const slack: ConversationAdapter = {`:

```ts
/**
 * The conversation id on or near an unread sidebar row.
 *
 * Three places are tried because the unread class and the id need not be on the same element,
 * and the shape is Slack's to change. The format guard is what makes that safe: only a real
 * conversation id (C/D/G plus at least six upper-case alphanumerics) is accepted, so climbing
 * to an unrelated container cannot produce a false key.
 */
function slackConversationId(row: Element): string | null {
  const candidates = [row, row.closest('[id]'), row.querySelector('[id]')];
  for (const el of candidates) {
    const id = (el as HTMLElement | null)?.id ?? '';
    if (/^[CDG][A-Z0-9]{6,}$/.test(id)) return id;
  }
  return null;
}
```

and add to the `slack` adapter object, after `scroller`:

```ts
  unreadKeys: (doc) => {
    const out = new Set<string>();
    doc.querySelectorAll('.p-channel_sidebar__channel--unread').forEach((row) => {
      // Same exclusion the badge parser applies — this row is an affordance, not a channel.
      if (row.querySelector('.p-channel_sidebar__link--add-more-items')) return;
      const id = slackConversationId(row);
      if (id) out.add(id);
    });
    return [...out];
  },
```

- [ ] **Step 4: Implement Messenger**

In `src/preload/conversation/adapters.ts`, above `const messenger: ConversationAdapter = {`:

```ts
/** NodeFilter.SHOW_TEXT, inlined: notify/messenger.ts does the same, because that module runs
 *  under a plain 'node' vitest environment where the NodeFilter global is not guaranteed. */
const SHOW_TEXT = 0x4;

/** A row is unread when a text node inside it reads exactly "Unread message:" — the rule the
 *  shipped badge parser and notification scraper both already use. */
function messengerRowUnread(doc: Document, anchor: Element): boolean {
  const walker = doc.createTreeWalker(anchor, SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if ((node.textContent ?? '').trim() === 'Unread message:') return true;
  }
  return false;
}
```

and add to the `messenger` adapter object, after `plan`:

```ts
  unreadKeys: (doc) => {
    const out = new Set<string>();
    for (const a of doc.querySelectorAll('a[href*="/messages/"]')) {
      if (a.querySelector('[style*="--disabled-icon"]')) continue; // muted
      if (!messengerRowUnread(doc, a)) continue;
      const id = messengerThreadId(a.getAttribute('href') ?? '');
      // CANONICAL form — the same key capture() stores. Main matches by string equality.
      if (id) out.add(`/messages/t/${id}`);
    }
    return [...out];
  },
```

- [ ] **Step 5: Verify**

Run: `npx vitest run tests/conversationAdapters.test.ts` → PASS
Run: `npm test && npm run build && npm run check` → all clean

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(bubbles): unread keys for Slack and Messenger"
```

---

### Task 6: Telegram and Talk `unreadKeys`

Both have the same shape: a counter element inside a row anchor, so the key is one `closest()` away.

**Files:**
- Modify: `src/preload/conversation/adapters.ts`
- Test: `tests/conversationAdapters.test.ts`

**Interfaces:**
- Consumes: `ConversationAdapter.unreadKeys` from Task 2.
- Produces: `telegram.unreadKeys`, `talk.unreadKeys`.

**Before starting:** read `dev_local/bubbles_spike/FINDINGS-unread.md`. The `closest()` bridge is the unverified part of both; if the probe shows the counter is not inside the anchor, use the mapping the probe found and correct this plan.

- [ ] **Step 1: Write the failing tests**

Append to `tests/conversationAdapters.test.ts`:

```ts
describe('telegram unreadKeys', () => {
  const tg = CONVERSATION_ADAPTERS.telegram;

  it('reports the hash of each chat with a numeric unread badge', () => {
    document.body.innerHTML = `
      <div class="ListItem"><a href="#8623934162"><div class="chat-badge-transition">3</div></a></div>
      <div class="ListItem"><a href="#93372553"><div class="chat-badge-transition">1</div></a></div>
      <div class="ListItem"><a href="#8078674329">read</a></div>`;
    // The read chat (#8078674329) must NOT appear.
    expect(tg.unreadKeys!(document).sort()).toEqual(['#8623934162', '#93372553']);
  });

  // The badge parser skips non-numeric badges (action buttons like "Open"); so must this.
  it('ignores a non-numeric badge', () => {
    document.body.innerHTML =
      '<div class="ListItem"><a href="#111"><div class="chat-badge-transition">Open</div></a></div>';
    expect(tg.unreadKeys!(document)).toEqual([]);
  });

  it('reports nothing when no badge is inside a chat anchor', () => {
    document.body.innerHTML = '<div class="chat-badge-transition">3</div>';
    expect(tg.unreadKeys!(document)).toEqual([]);
  });
});

describe('talk unreadKeys', () => {
  const tk = CONVERSATION_ADAPTERS.talk;

  it('reports the call path of each conversation with a counter', () => {
    document.body.innerHTML = `
      <a href="/call/37egz8x9"><div class="counter-bubble__counter">2</div></a>
      <a href="/call/abc12345"><div class="counter-bubble__counter">@</div></a>
      <a href="/call/nounread">read</a>`;
    expect(tk.unreadKeys!(document).sort()).toEqual(['/call/37egz8x9', '/call/abc12345']);
  });

  it('reports nothing when a counter is not inside a conversation anchor', () => {
    document.body.innerHTML = '<div class="counter-bubble__counter">2</div>';
    expect(tk.unreadKeys!(document)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/conversationAdapters.test.ts`
Expected: FAIL — both `unreadKeys` are `undefined`.

- [ ] **Step 3: Implement Telegram**

Add to the `telegram` adapter object, after `scroller`:

```ts
  unreadKeys: (doc) => {
    const out = new Set<string>();
    doc.querySelectorAll('.chat-badge-transition').forEach((badge) => {
      // Numeric only — the badge parser skips action buttons like "Open" the same way.
      if (!/^\d+$/.test((badge.textContent || '').trim())) return;
      const href = badge.closest(TELEGRAM_ROW)?.getAttribute('href');
      if (href) out.add(href);
    });
    return [...out];
  },
```

- [ ] **Step 4: Implement Talk**

Add to the `talk` adapter object, after `scroller`:

```ts
  unreadKeys: (doc) => {
    const out = new Set<string>();
    // No numeric filter here, unlike Telegram: the badge parser deliberately counts a
    // non-numeric bubble (a mention marker) as 1, so it is unread too.
    doc.querySelectorAll('.counter-bubble__counter').forEach((counter) => {
      const href = counter.closest('a[href^="/call/"]')?.getAttribute('href');
      if (href) out.add(href);
    });
    return [...out];
  },
```

- [ ] **Step 5: Verify**

Run: `npx vitest run tests/conversationAdapters.test.ts` → PASS
Run: `npm test && npm run build && npm run check` → all clean

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(bubbles): unread keys for Telegram and NextCloud Talk"
```

---

### Task 7: WhatsApp `unreadKeys`

The first of the two that needs genuinely new detection — its badge parser reads a single document-wide total, not per-row state.

**Files:**
- Modify: `src/preload/conversation/adapters.ts`
- Test: `tests/conversationAdapters.test.ts`

**Interfaces:**
- Consumes: `waRows`, `waRowJid` (both already in `adapters.ts`).
- Produces: `whatsapp.unreadKeys`.

**Before starting:** read `dev_local/bubbles_spike/FINDINGS-unread.md`. The probe reports, per unread row, both the `aria-label` it found and whether a purely numeric badge span was present. **Use whichever the probe actually found**; the selector below is the expectation, not the measurement.

- [ ] **Step 1: Write the failing tests**

Append to `tests/conversationAdapters.test.ts`:

```ts
describe('whatsapp unreadKeys', () => {
  const wa = CONVERSATION_ADAPTERS.whatsapp;

  /** A rendered row: the jid lives on an ancestor fiber, exactly as the spike measured. */
  const row = (jid: string, unread: boolean): Element => {
    const el = document.createElement('div');
    el.setAttribute('role', 'listitem');
    el.innerHTML = unread ? '<span aria-label="3 unread messages"></span>' : '<span></span>';
    Object.defineProperty(el, '__reactFiber$test', {
      value: { key: null, return: { key: null, return: { key: `chat-${jid}`, return: null } } },
      enumerable: true, configurable: true,
    });
    return el;
  };

  it('reports the jid of each unread row', () => {
    document.body.innerHTML = '<div id="pane-side"></div>';
    const pane = document.getElementById('pane-side')!;
    pane.append(row('123@lid', true), row('456@c.us', false), row('789@g.us', true));
    expect(wa.unreadKeys!(document).sort()).toEqual(['123@lid', '789@g.us']);
  });

  it('reports nothing when the chat list is not rendered', () => {
    document.body.innerHTML = '';
    expect(wa.unreadKeys!(document)).toEqual([]);
  });

  it('skips an unread row whose jid cannot be read', () => {
    document.body.innerHTML = '<div id="pane-side"></div>';
    const el = document.createElement('div');
    el.setAttribute('role', 'listitem');
    el.innerHTML = '<span aria-label="3 unread messages"></span>';
    document.getElementById('pane-side')!.append(el);
    expect(wa.unreadKeys!(document)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/conversationAdapters.test.ts`
Expected: FAIL — `whatsapp.unreadKeys` is `undefined`.

- [ ] **Step 3: Implement**

Add to the `whatsapp` adapter object, after `scroller`:

```ts
  unreadKeys: (doc) => {
    const out = new Set<string>();
    for (const row of waRows(doc)) {
      // Per-ROW, unlike the badge parser, which reads one document-wide total. Matched
      // case-insensitively on "unread" so both "3 unread messages" and "unread message"
      // qualify — WhatsApp uses both, singular and plural.
      if (!row.querySelector('[aria-label*="unread" i]')) continue;
      const jid = waRowJid(row);
      if (jid) out.add(jid);
    }
    return [...out];
  },
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/conversationAdapters.test.ts` → PASS
Run: `npm test && npm run build && npm run check` → all clean

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(bubbles): unread keys for WhatsApp"
```

---

### Task 8: Element `unreadKeys`

The lowest-confidence service. Its room list is virtualised with hashed CSS-module classes, which is exactly why its badge parser reads `document.title` instead of the DOM.

**Files:**
- Modify: `src/preload/conversation/adapters.ts`
- Test: `tests/conversationAdapters.test.ts`

**Interfaces:**
- Consumes: `ConversationAdapter.unreadKeys` from Task 2.
- Produces: `element.unreadKeys`.

**Before starting:** read `dev_local/bubbles_spike/FINDINGS-unread.md`. If its Element section shows `key=NULL` for every badge, **stop and report** rather than shipping a scrape that cannot work: Element then needs either a different anchor for room identity or to be left without a dot, and that is a decision for Keith, not a guess to make here.

- [ ] **Step 1: Write the failing tests**

Append to `tests/conversationAdapters.test.ts`:

```ts
describe('element unreadKeys', () => {
  const el = CONVERSATION_ADAPTERS.element;

  it('reports the room hash of each tile with a notification badge', () => {
    document.body.innerHTML = `
      <div class="mx_RoomTile">
        <a href="#/room/!abc:example.org">General<span class="mx_NotificationBadge">3</span></a>
      </div>
      <div class="mx_RoomTile"><a href="#/room/!def:example.org">Quiet</a></div>`;
    expect(el.unreadKeys!(document)).toEqual(['#/room/!abc:example.org']);
  });

  it('finds the href when the badge is a sibling of the link rather than inside it', () => {
    document.body.innerHTML = `
      <div class="mx_RoomTile">
        <a href="#/room/!abc:example.org">General</a>
        <span class="mx_NotificationBadge">3</span>
      </div>`;
    expect(el.unreadKeys!(document)).toEqual(['#/room/!abc:example.org']);
  });

  it('reports nothing when a badge cannot be mapped to a room', () => {
    document.body.innerHTML = '<span class="mx_NotificationBadge">3</span>';
    expect(el.unreadKeys!(document)).toEqual([]);
  });

  it('reports nothing when no room has a badge', () => {
    document.body.innerHTML =
      '<div class="mx_RoomTile"><a href="#/room/!abc:example.org">General</a></div>';
    expect(el.unreadKeys!(document)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/conversationAdapters.test.ts`
Expected: FAIL — `element.unreadKeys` is `undefined`.

- [ ] **Step 3: Implement**

In `src/preload/conversation/adapters.ts`, above `const element: ConversationAdapter = {`:

```ts
/** Element's own stable `mx_` classes only. The per-release hashed layout classes
 *  (`_avatar_va14e_8`) are worthless as selectors — they change every release. */
const ELEMENT_BADGE = '.mx_NotificationBadge';
const ELEMENT_TILE = '.mx_RoomTile';
const ELEMENT_ROOM_LINK = 'a[href^="#/room/"]';
```

and add to the `element` adapter object, after `plan`:

```ts
  unreadKeys: (doc) => {
    const out = new Set<string>();
    for (const badge of doc.querySelectorAll(ELEMENT_BADGE)) {
      // Two shapes, because the badge may sit inside the room link or beside it in the tile.
      const href = badge.closest(ELEMENT_ROOM_LINK)?.getAttribute('href')
        ?? badge.closest(ELEMENT_TILE)?.querySelector(ELEMENT_ROOM_LINK)?.getAttribute('href');
      if (href) out.add(href);
    }
    return [...out];
  },
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/conversationAdapters.test.ts` → PASS
Run: `npm test && npm run build && npm run check` → all clean

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(bubbles): unread keys for Element"
```

---

## After the tasks

1. **Whole-feature review.** Run it even though every task was reviewed: per-task reviews each see one brief, and only the whole-feature pass sees cross-task drift. On the grid view that pass found a Critical eleven task reviews had missed. The specific things to look for here: a key format mismatch between an `unreadKeys` implementation and its `capture()` (the failure is silent — the dot simply never appears), and any path that clears `currentConversation` without clearing `unreadKeys`.
2. **Build and install the Flatpak**, then hand Keith a numbered smoke-test list covering: a dot appearing on a pinned chat that receives a message; reading it **in the service's own tab** and watching the dot clear; clicking a bubble and watching the dot clear immediately; quitting a service and watching its bubbles grey out; and disabling badges for a service and watching its bubbles' dots disappear.
