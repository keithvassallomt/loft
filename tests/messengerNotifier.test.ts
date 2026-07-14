import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { MessengerNotifier } from '../src/preload/notify/messenger';

function row(href: string, sender: string, preview: string, opts: { muted?: boolean; img?: string } = {}): string {
  return `<a href="${href}">
    ${opts.muted ? '<i style="--disabled-icon:1"></i>' : ''}
    <span>Unread message:</span><span>${sender}</span><span>${preview}</span>
    ${opts.img ? `<img src="${opts.img}">` : ''}
  </a>`;
}
const doc = (html: string): Document => new JSDOM(`<div>${html}</div>`).window.document;

describe('MessengerNotifier', () => {
  it('suppresses during the startup grace, then notifies new unreads', () => {
    let t = 0;
    const n = new MessengerNotifier({ graceMs: 1000, now: () => t });
    const d = doc(row('/messages/t/1', 'Ann', 'hi', { img: 'https://scontent.fbcdn.net/a.jpg' }));
    expect(n.scan(d)).toEqual([]);           // within grace → silent-add
    t = 2000;
    expect(n.scan(d)).toEqual([]);           // same fingerprint → nothing new
  });
  it('notifies a fresh conversation after grace with sender/body/icon/href', () => {
    let t = 5000;
    const n = new MessengerNotifier({ graceMs: 1000, now: () => t });
    t += 2000; // advance the clock past the grace window before scanning (constructing and
    // scanning at the same instant would always read as "within grace", by construction)
    const out = n.scan(doc(row('/messages/t/2', 'Bob', 'yo', { img: 'https://scontent.fbcdn.net/b.jpg' })));
    expect(out).toEqual([{ sender: 'Bob', body: 'yo', icon: 'https://scontent.fbcdn.net/b.jpg', href: '/messages/t/2' }]);
  });
  it('re-notifies when the preview (fingerprint) changes', () => {
    let t = 5000;
    const n = new MessengerNotifier({ graceMs: 0, now: () => t });
    expect(n.scan(doc(row('/messages/t/3', 'Cy', 'first'))).length).toBe(1);
    expect(n.scan(doc(row('/messages/t/3', 'Cy', 'first'))).length).toBe(0); // unchanged
    expect(n.scan(doc(row('/messages/t/3', 'Cy', 'second'))).length).toBe(1); // changed
  });
  it('skips muted conversations and honours DND silent-add', () => {
    let t = 5000;
    const n = new MessengerNotifier({ graceMs: 0, now: () => t });
    expect(n.scan(doc(row('/messages/t/4', 'D', 'x', { muted: true })))).toEqual([]);
    n.setDnd(true);
    expect(n.scan(doc(row('/messages/t/5', 'E', 'x')))).toEqual([]); // DND → silent-add
    n.setDnd(false);
    expect(n.scan(doc(row('/messages/t/5', 'E', 'x')))).toEqual([]); // already tracked → no burst
  });
});
