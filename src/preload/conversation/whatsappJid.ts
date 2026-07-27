/**
 * Anchored, whole-value match, with no underscore permitted in the local part.
 *
 * Both properties are load-bearing, and both were learned by getting them wrong:
 *
 *  - `__x_chatlistPreview.msgKey` has the form `true_<jid>_<hex>_<jid>`. A substring match
 *    greedily returns `true_<jid>@g.us`, which looks exactly like a valid answer. Matching
 *    the WHOLE value rejects every composite. (Underscore is excluded from the local part
 *    for the same reason: it is what joins those composites together.)
 *  - Chat-list rows are keyed `chat-<jid>` while `#main` carries the bare jid, so the prefix
 *    is optional and stripped. Comparing the two forms without normalising never matches,
 *    which silently reduces "reopen" to "do nothing".
 */
const JID =
  /^(?:chat-)?([0-9A-Za-z]+(?:-[0-9]+)?@(?:c\.us|g\.us|lid|s\.whatsapp\.net|broadcast|newsletter))$/;

/** The bare jid for any accepted form, else null. */
export function normalizeJid(v: unknown): string | null {
  return typeof v === 'string' ? (JID.exec(v)?.[1] ?? null) : null;
}

/**
 * React fiber link fields. Following them turns a targeted look at one node into a crawl of
 * the entire application and — worse for correctness — reaches the shared chat COLLECTION,
 * where every chat's jid is visible and "the first hit" is arbitrary. Measured during the
 * spike: a row's ancestor fibers expose all 26+ loaded chats this way.
 */
const SKIP = new Set([
  'return', 'child', 'sibling', 'stateNode', 'alternate',
  '_owner', '_debugOwner', 'dependencies', 'updateQueue',
]);

export interface SearchLimits { maxDepth: number; maxNodes: number }
export const DEFAULT_LIMITS: SearchLimits = { maxDepth: 8, maxNodes: 20_000 };

/**
 * The first whole-value jid in an object graph, or null.
 *
 * Deliberately a bounded SEARCH rather than a fixed path. The jid was observed at both
 * `props.children.1.key` and `props.children.1.props.chat.__x_id._serialized`, but
 * hardcoding either bakes in a child index and a nesting depth, so a WhatsApp tree reshuffle
 * would silently start returning nothing. A search degrades into "look a bit further".
 *
 * Bounded three ways, because the input is a React fiber graph: cyclic (visited set),
 * enormous (node cap) and deep (depth cap).
 */
export function findJid(root: unknown, limits: SearchLimits = DEFAULT_LIMITS): string | null {
  const seen = new WeakSet<object>();
  let nodes = 0;

  const walk = (val: unknown, depth: number): string | null => {
    if (nodes++ > limits.maxNodes || depth > limits.maxDepth) return null;
    if (typeof val === 'string') return normalizeJid(val);
    if (!val || typeof val !== 'object') return null;
    const obj = val as object;
    if (seen.has(obj)) return null;
    seen.add(obj);

    let keys: string[];
    try { keys = Object.keys(obj); } catch { return null; }
    for (const k of keys) {
      if (SKIP.has(k)) continue;
      let child: unknown;
      // A property can be a getter that throws; one bad key must not abort the whole search.
      try { child = (obj as Record<string, unknown>)[k]; } catch { continue; }
      const hit = walk(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  return walk(root, 0);
}

/**
 * React attaches the component's props and fiber to the DOM node itself, under a
 * hash-suffixed key (`__reactProps$abc123`), so they can only be found by prefix.
 */
export function reactProp(el: Element, prefix: '__reactProps' | '__reactFiber'): unknown {
  const k = Object.keys(el).find((x) => x.startsWith(prefix));
  return k ? (el as unknown as Record<string, unknown>)[k] : undefined;
}
