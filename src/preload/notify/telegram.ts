import type { NotifyPayload } from './messenger';

export class TelegramNotifier {
  private notified = new Map<string, string>();
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

    for (const badge of Array.from(doc.querySelectorAll('.chat-badge-transition'))) {
      // Skip action buttons (e.g. "Open" for bots) — only count numeric badges.
      if (!/^\d+$/.test((badge.textContent ?? '').trim())) continue;

      const row = this.findChatRow(doc, badge);
      if (!row) continue;

      // Skip muted chats — Telegram marks them with a muted icon.
      if (row.querySelector('.chat-muted-icon, .muted-icon, .icon-muted')) continue;

      const key = this.chatKey(row);
      currentlyUnread.add(key);

      // A draft is the user's own text, and Telegram syncs drafts to every device, showing
      // one in place of the last message. The original port stripped the "Draft:" prefix
      // and notified, so a reply started elsewhere arrived looking like an incoming message.
      // Skipped without recording a fingerprint, as in MessengerNotifier, so clearing the
      // draft does not re-notify the message underneath it.
      if (this.isDraft(row)) continue;

      const fp = this.fingerprint(row);
      if (this.notified.get(key) === fp) continue;

      const inGrace = this.now() - this.loadTime < this.graceMs;
      this.notified.set(key, fp);            // record in all paths (grace/DND/emit)
      if (inGrace || this.dnd) continue;

      const payload = this.extract(row, key);
      if (payload) out.push(payload);
    }

    for (const [key] of this.notified) if (!currentlyUnread.has(key)) this.notified.delete(key);
    return out;
  }

  // Ported from content.js findTelegramChatRow(): walk up from the badge to
  // find the enclosing chat row — Web A uses an <a href> row, Web K wraps the
  // row in a .chatlist-chat/.ListItem container (whose own <a href>, if any,
  // is preferred).
  private findChatRow(doc: Document, badge: Element): Element | null {
    let el: Element | null = badge;
    while (el && el !== doc.body) {
      if (el.tagName === 'A' && el.getAttribute('href')) return el;
      if (el.classList && (el.classList.contains('chatlist-chat') || el.classList.contains('ListItem'))) {
        return el.querySelector('a[href]') ?? el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // Ported from content.js getTelegramChatKey().
  private chatKey(row: Element): string {
    if (row.tagName === 'A' && row.getAttribute('href')) return row.getAttribute('href')!;
    const link = row.querySelector('a[href]');
    if (link) return link.getAttribute('href') ?? '';
    return row.getAttribute('data-peer-id') ?? (row.textContent ?? '').substring(0, 50);
  }

  private summary(row: Element): string {
    return (row.querySelector('.last-message-summary')?.textContent ?? '').trim();
  }

  private isDraft(row: Element): boolean {
    return /^Draft\s*:/.test(this.summary(row));
  }

  // Ported from content.js extractTelegramData(): sender from h3.fullName,
  // preview from .last-message-summary (truncating long previews). Avatar is
  // resolved separately in extract() since the fingerprint doesn't need it.
  // Draft rows never get here (see scan), so there is no prefix to strip.
  private extractData(row: Element): { sender: string; preview: string } {
    const sender = (row.querySelector('h3.fullName')?.textContent ?? '').trim();

    let preview = this.summary(row);
    if (preview.length > 200) preview = preview.substring(0, 200) + '…';

    return { sender, preview };
  }

  // Ported from content.js getTelegramFingerprint().
  private fingerprint(row: Element): string {
    const { sender, preview } = this.extractData(row);
    return `${sender}|${preview}`;
  }

  // Ported from content.js extractTelegramData() + sendTelegramNotification():
  // avatar is the raw `.Avatar img` src (blob:/https:) — no fetch/convert
  // here, the bridge converts blob: → data: before IPC.
  private extract(row: Element, key: string): NotifyPayload | null {
    const { sender, preview } = this.extractData(row);
    if (!sender && !preview) return null;

    const icon = row.querySelector('.Avatar img')?.getAttribute('src') ?? '';
    return { sender, body: preview, icon, href: key };
  }
}
