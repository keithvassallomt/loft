import { describe, it, expect } from 'vitest';
import { TrayModel } from '../src/main/tray/model';

describe('TrayModel', () => {
  it('derives the menu model and icon overlay from service state', () => {
    const m = new TrayModel();
    m.addService({ id: 'whatsapp', displayName: 'WhatsApp', badge: 0, dnd: false, visible: true });
    m.addService({ id: 'slack', displayName: 'Slack', badge: 2, dnd: false, visible: false });
    expect(m.iconOverlay()).toBe('unread');
    const mm = m.menuModel();
    expect(mm.services.map((s) => [s.id, s.unread])).toEqual([['whatsapp', false], ['slack', true]]);
    m.setDnd('slack', true);
    expect(m.iconOverlay()).toBe('dnd');
    expect(mm.services.find((s) => s.id === 'slack')); // re-fetch: mm is a snapshot
    expect(m.menuModel().services.find((s) => s.id === 'slack')!.dnd).toBe(true);
  });

  it('fires onChange only when a mutation actually changes state', () => {
    const m = new TrayModel();
    m.addService({ id: 'whatsapp', displayName: 'WhatsApp', badge: 0, dnd: false, visible: false });
    let changes = 0;
    m.onChange = () => { changes += 1; };
    m.setBadge('whatsapp', 3);
    m.setBadge('whatsapp', 3); // no-op — same value
    m.setVisible('whatsapp', false); // no-op — same value
    m.setDnd('whatsapp', true);
    expect(changes).toBe(2);
  });
});
