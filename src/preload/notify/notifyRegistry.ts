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
      const v = entries.get(id);
      if (v !== undefined) entries.delete(id);
      return v;
    },
    forget(id) { entries.delete(id); },
    size: () => entries.size,
  };
}
