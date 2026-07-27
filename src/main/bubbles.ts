import { createHash } from 'node:crypto';

/** One pinned conversation. */
export interface Bubble {
  /** Stable id; also the avatar filename and the `loft://bubble/<id>` path. */
  id: string;
  /** INSTANCE id (`whatsapp-2`), not the kind — a bubble belongs to one account. */
  serviceId: string;
  /** Per-service conversation key (WhatsApp JID, Slack conversation id, room hash, thread path). */
  key: string;
  /** Label at pin time; refreshed whenever that conversation is observed open. */
  title: string;
}

/**
 * Derived only from what identifies the conversation, so pinning the same chat twice yields
 * the same id — which is what makes `addBubble` idempotent without a separate search.
 *
 * Hashed rather than composed from the key: keys contain `@`, `/`, `#` and `?`, and this
 * string becomes both a filename and a URL path segment.
 */
export function bubbleId(serviceId: string, key: string): string {
  return `${serviceId}-${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
}

export function findBubble(bubbles: readonly Bubble[], id: string): Bubble | undefined {
  return bubbles.find((b) => b.id === id);
}

/** Append, or return an unchanged copy when this conversation is already pinned. */
export function addBubble(
  bubbles: readonly Bubble[], serviceId: string, key: string, title: string,
): Bubble[] {
  const id = bubbleId(serviceId, key);
  if (bubbles.some((b) => b.id === id)) return [...bubbles];
  return [...bubbles, { id, serviceId, key, title }];
}

export function removeBubble(bubbles: readonly Bubble[], id: string): Bubble[] {
  return bubbles.filter((b) => b.id !== id);
}

/** A removed service must not leave bubbles pointing at a view that no longer exists. */
export function removeServiceBubbles(bubbles: readonly Bubble[], serviceId: string): Bubble[] {
  return bubbles.filter((b) => b.serviceId !== serviceId);
}

/**
 * Refresh a pinned conversation's label.
 *
 * Returns the SAME array reference when nothing changed. That is not a micro-optimisation:
 * this runs on every conversation observation (roughly every two seconds per loaded
 * service), and the caller uses reference identity to decide whether to write config.
 */
export function refreshBubbleTitle(
  bubbles: readonly Bubble[], serviceId: string, key: string, title: string,
): Bubble[] {
  const id = bubbleId(serviceId, key);
  const at = bubbles.findIndex((b) => b.id === id);
  if (at === -1 || bubbles[at].title === title) return bubbles as Bubble[];
  const out = [...bubbles];
  out[at] = { ...out[at], title };
  return out;
}

/**
 * The 1-2 character label a bubble draws when it has no avatar.
 *
 * The rail's own `initials()` splits on whitespace only, which is right for people
 * ("Keith Vassallo" -> KV) and useless for the names that actually reach this path: every
 * Slack channel is one token starting with '#', so `#general`, `#random` and `#dev-team` all
 * rendered as a bare '#' — identical bubbles with only a tooltip to tell them apart.
 *
 * So: drop a leading '#', split on separators AND camelCase, take one letter per word, and
 * fall back to the first two letters when there is only one word.
 */
export function bubbleGlyph(title: string): string {
  const stripped = title.trim().replace(/^[#@]+/, '');
  if (!stripped) return '?';
  const words = stripped
    // BotFather -> Bot Father, so a camelCase name yields two distinct letters.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s\-_./|]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length > 1
    ? words.slice(0, 2).map((w) => [...w][0]).join('')
    // One word: two letters beat one, which is the whole point — '#general' and '#git'
    // must not collapse to the same glyph.
    : [...words[0]].slice(0, 2).join('');
  return letters.toUpperCase();
}

/**
 * A stable hue for a bubble with no avatar, so two lettered bubbles differ by colour as well
 * as by glyph. Derived from the conversation key rather than the title, so renaming a group
 * does not make its bubble change colour under the user.
 */
export function bubbleHue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

export interface PinTargetInput {
  /** The selected service tab, if any. */
  activeId: string | undefined;
  /** The grid's focused cell, when the grid is the selection. */
  gridFocusId: string | undefined;
  hasConversation(serviceId: string): boolean;
}

/**
 * Which service the titlebar's pin button acts on, or null when it should be disabled.
 *
 * The grid is why this needs deciding at all: it shows several services at once, so a
 * whole-window control has no single obvious subject. It reuses the focused cell the grid
 * already tracks for zoom rather than introducing a second notion of "the current service" —
 * one rule the user has already learned, applied to a second control.
 */
export function pinTarget(i: PinTargetInput): string | null {
  const id = i.activeId ?? i.gridFocusId;
  if (!id) return null;
  return i.hasConversation(id) ? id : null;
}

export type BubbleAction =
  | { kind: 'focus-detached'; serviceId: string }
  | { kind: 'navigate-only'; serviceId: string }
  | { kind: 'select'; serviceId: string };

export interface BubbleClickInput {
  serviceId: string;
  detached: boolean;
  /** Services currently visible in the content rect: the active tab, or every grid leaf. */
  visibleIds: readonly string[];
}

/**
 * Where a bubble click lands.
 *
 * One uniform rule rather than a case per view mode: send the open command to whatever live
 * view the service already has, and change the rail selection only when it is not already
 * visible. That is what keeps a grid cell in the grid and a detached window in its own
 * window, without this function needing to know anything about either — and it avoids
 * fighting the grid/detach mutual-exclusion invariant rather than special-casing around it.
 */
export function bubbleClickAction(i: BubbleClickInput): BubbleAction {
  if (i.detached) return { kind: 'focus-detached', serviceId: i.serviceId };
  if (i.visibleIds.includes(i.serviceId)) return { kind: 'navigate-only', serviceId: i.serviceId };
  return { kind: 'select', serviceId: i.serviceId };
}

/**
 * Validate persisted bubbles. Malformed entries are dropped individually and the rest
 * survive — a corrupt bubble must cost you the bubble, never the ability to start Loft.
 * That is the rule `sanitizeGridNode` already follows, applied per element because bubbles
 * are independent of one another (a grid, being a tree, is not).
 *
 * The id is RECOMPUTED rather than trusted: it names a file on disk and a `loft://` path,
 * and config.json is hand-editable.
 */
export function sanitizeBubbles(v: unknown): Bubble[] {
  if (!Array.isArray(v)) return [];
  const out: Bubble[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const b = raw as Record<string, unknown>;
    if (typeof b.serviceId !== 'string' || b.serviceId === '') continue;
    if (typeof b.key !== 'string' || b.key === '') continue;
    if (typeof b.title !== 'string') continue;
    const id = bubbleId(b.serviceId, b.key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, serviceId: b.serviceId, key: b.key, title: b.title });
  }
  return out;
}
