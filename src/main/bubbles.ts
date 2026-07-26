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
