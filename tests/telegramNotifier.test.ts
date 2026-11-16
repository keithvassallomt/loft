import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { TelegramNotifier } from '../src/preload/notify/telegram';

function row(href: string, name: string, preview: string, opts: { badge?: string; muted?: boolean; avatar?: string } = {}): string {
  return `<a href="${href}" class="ListItem">
    <div class="Avatar">${opts.avatar ? `<img src="${opts.avatar}">` : ''}</div>
    <div class="title"><h3 class="fullName">${name}</h3></div>
    <div class="last-message-summary">${preview}</div>
    ${opts.muted ? '<i class="chat-muted-icon"></i>' : ''}
    <div class="chat-badge-transition">${opts.badge ?? '1'}</div>
  </a>`;
}
const doc = (html: string): Document => new JSDOM(`<div>${html}</div>`).window.document;

describe('TelegramNotifier', () => {
  it('notifies a fresh numeric-badge chat after grace', () => {
    const n = new TelegramNotifier({ graceMs: 0, now: () => 5000 });
    const out = n.scan(doc(row('#/im?p=1', 'Ann', 'hi', { avatar: 'blob:tg/aaa' })));
    expect(out).toEqual([{ sender: 'Ann', body: 'hi', icon: 'blob:tg/aaa', href: '#/im?p=1' }]);
  });
  it('ignores non-numeric badges (action buttons)', () => {
    const n = new TelegramNotifier({ graceMs: 0, now: () => 5000 });
    expect(n.scan(doc(row('#/im?p=2', 'Bot', 'x', { badge: 'Open' })))).toEqual([]);
  });
  it('suppresses during grace and skips muted; DND silent-adds', () => {
    const n = new TelegramNotifier({ graceMs: 1000, now: () => 0 });
    expect(n.scan(doc(row('#/im?p=3', 'C', 'x')))).toEqual([]); // grace
    const n2 = new TelegramNotifier({ graceMs: 0, now: () => 5000 });
    expect(n2.scan(doc(row('#/im?p=4', 'D', 'x', { muted: true })))).toEqual([]); // muted
    n2.setDnd(true);
    expect(n2.scan(doc(row('#/im?p=5', 'E', 'x')))).toEqual([]); // DND silent-add
  });
  it('never notifies a draft (your own text, synced from another device)', () => {
    const n = new TelegramNotifier({ graceMs: 0, now: () => 5000 });
    expect(n.scan(doc(row('#/im?p=7', 'G', 'Draft: half-typed reply')))).toEqual([]);
  });
  it('a draft over a notified message stays quiet, and so does clearing it', () => {
    const n = new TelegramNotifier({ graceMs: 0, now: () => 5000 });
    expect(n.scan(doc(row('#/im?p=8', 'H', 'hello'))).length).toBe(1);
    expect(n.scan(doc(row('#/im?p=8', 'H', 'Draft: reply')))).toEqual([]); // your draft
    expect(n.scan(doc(row('#/im?p=8', 'H', 'hello')))).toEqual([]);        // draft cleared
    expect(n.scan(doc(row('#/im?p=8', 'H', 'new one'))).length).toBe(1);   // real news
  });
  it('re-notifies on preview change', () => {
    const n = new TelegramNotifier({ graceMs: 0, now: () => 5000 });
    expect(n.scan(doc(row('#/im?p=6', 'F', 'one'))).length).toBe(1);
    expect(n.scan(doc(row('#/im?p=6', 'F', 'one'))).length).toBe(0);
    expect(n.scan(doc(row('#/im?p=6', 'F', 'two'))).length).toBe(1);
  });
});
