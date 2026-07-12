export interface NotifyPayload { sender: string; body: string; icon: string; href: string }

const TIMESTAMP_RE = /^\d+[hms]$/;
const ACTIVE_RE = /^Active\b/;

// NodeFilter.SHOW_* constants, inlined: this module runs under a plain 'node'
// vitest environment (tests build their own JSDOM Document rather than using
// jsdom-as-global), so the `NodeFilter` global is not guaranteed to exist.
const SHOW_ELEMENT = 0x1;
const SHOW_TEXT = 0x4;
const TEXT_NODE = 3;

export class MessengerNotifier {
  private notified = new Map<string, string>();
  private avatarCache = new Map<string, string>();
  private dnd = false;
  private readonly loadTime: number;
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(opts: { graceMs?: number; now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.graceMs = opts.graceMs ?? 15_000;
    this.loadTime = this.now();
  }

  setDnd(v: boolean): void { this.dnd = v; }

  scan(doc: Document): NotifyPayload[] {
    const out: NotifyPayload[] = [];
    const currentlyUnread = new Set<string>();
    this.cacheAllAvatars(doc);

    for (const anchor of Array.from(doc.querySelectorAll('a[href*="/messages/"]'))) {
      const href = anchor.getAttribute('href');
      if (!href || !this.isUnread(doc, anchor)) continue;
      if (anchor.querySelector('[style*="--disabled-icon"]')) continue; // muted
      currentlyUnread.add(href);

      const fp = this.fingerprint(doc, anchor);
      if (this.notified.get(href) === fp) continue;

      const inGrace = this.now() - this.loadTime < this.graceMs;
      this.notified.set(href, fp);            // record in all paths (grace/DND/emit)
      if (inGrace || this.dnd) continue;

      const payload = this.extract(doc, anchor, href);
      if (payload) out.push(payload);
    }
    for (const [href] of this.notified) if (!currentlyUnread.has(href)) this.notified.delete(href);
    return out;
  }

  // Ported from content.js scanForUnreadMessages(): a row is unread when a
  // text node inside the anchor is exactly "Unread message:".
  private isUnread(doc: Document, anchor: Element): boolean {
    const walker = doc.createTreeWalker(anchor, SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if ((node.textContent ?? '').trim() === 'Unread message:') return true;
    }
    return false;
  }

  // Ported from content.js getConversationFingerprint(): first two
  // "substantial" text nodes after the marker, ignoring timestamps/dot/Active,
  // falling back to short emoji img[alt] (not fbcdn) when < 2 parts found.
  private fingerprint(doc: Document, anchor: Element): string {
    const walker = doc.createTreeWalker(anchor, SHOW_TEXT);
    let foundMarker = false;
    let node: Node | null;
    const parts: string[] = [];
    while ((node = walker.nextNode())) {
      const text = (node.textContent ?? '').trim();
      if (foundMarker) {
        if (text && !TIMESTAMP_RE.test(text) && text !== '·' && !ACTIVE_RE.test(text)) {
          parts.push(text);
          if (parts.length >= 2) break;
        }
      }
      if (text === 'Unread message:') foundMarker = true;
    }
    if (parts.length < 2) {
      for (const eImg of Array.from(anchor.querySelectorAll('img[alt]'))) {
        const alt = eImg.getAttribute('alt') ?? '';
        const src = eImg.getAttribute('src') ?? '';
        if (alt && alt.length <= 2 && !src.includes('fbcdn.net')) {
          parts.push(alt);
          if (parts.length >= 2) break;
        }
      }
    }
    return parts.join('|');
  }

  // Ported from content.js extractConversationData().
  private extract(doc: Document, anchor: Element, href: string): NotifyPayload | null {
    let sender = '';
    for (const span of Array.from(anchor.querySelectorAll('span'))) {
      const text = (span.textContent ?? '').trim();
      if (
        text
        && text !== 'Unread message:'
        && text.length > 1
        && text.length < 100
        && !TIMESTAMP_RE.test(text)
        && text !== '·'
        && !ACTIVE_RE.test(text)
        && !span.querySelector('span')
      ) {
        sender = text;
        break;
      }
    }

    let body = '';
    const previewWalker = doc.createTreeWalker(anchor, SHOW_TEXT | SHOW_ELEMENT);
    let foundMarker = false;
    let node: Node | null;
    while ((node = previewWalker.nextNode())) {
      if (node.nodeType === TEXT_NODE) {
        const text = (node.textContent ?? '').trim();
        if (!foundMarker) {
          if (text === 'Unread message:') foundMarker = true;
          continue;
        }
        if (!text || text === sender || text === '·' || TIMESTAMP_RE.test(text) || ACTIVE_RE.test(text)) continue;
        body += (body ? ' ' : '') + text;
      } else if (foundMarker && (node as Element).tagName === 'IMG') {
        const el = node as Element;
        const alt = el.getAttribute('alt') ?? '';
        const src = el.getAttribute('src') ?? '';
        if (alt && alt.length <= 2 && !src.includes('fbcdn.net')) {
          body += alt;
        }
      }
    }

    let icon = '';
    const img = anchor.querySelector('img[src*="fbcdn.net"]') ?? anchor.querySelector('img[src^="https://"]');
    const imgSrc = img?.getAttribute('src') ?? '';
    if (imgSrc) {
      icon = imgSrc;
      this.avatarCache.set(href, icon);
    } else if (this.avatarCache.has(href)) {
      icon = this.avatarCache.get(href)!;
    }

    if (!sender && !body) return null;
    return { sender, body, icon, href };
  }

  // Ported from content.js scanMessengerAvatars(): populate the avatar cache
  // from ALL rows (unread or not) so avatars survive React re-renders.
  private cacheAllAvatars(doc: Document): void {
    for (const anchor of Array.from(doc.querySelectorAll('a[href*="/messages/"]'))) {
      const href = anchor.getAttribute('href');
      if (!href || this.avatarCache.has(href)) continue;
      const img = anchor.querySelector('img[src*="fbcdn.net"]') ?? anchor.querySelector('img[src^="https://"]');
      const src = img?.getAttribute('src') ?? '';
      if (src) this.avatarCache.set(href, src);
    }
  }
}
