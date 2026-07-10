import { describe, it, expect } from 'vitest';
import { TrayModel } from '../src/main/tray/model';

describe('TrayModel', () => {
  it('splits running vs available and derives unread + overlay', () => {
    const m = new TrayModel();
    m.addService({ id: 'whatsapp', displayName: 'WhatsApp', badge: 0, dnd: false, visible: true, running: true });
    m.addService({ id: 'slack', displayName: 'Slack', badge: 2, dnd: false, visible: false, running: true });
    m.addService({ id: 'telegram', displayName: 'Telegram', badge: 0, dnd: false, visible: false, running: false });

    expect(m.iconOverlay()).toBe('unread'); // slack has 2 unread
    const mm = m.menuModel();
    expect(mm.running.map((s) => s.id)).toEqual(['whatsapp', 'slack']);
    expect(mm.available.map((s) => s.id)).toEqual(['telegram']);
    expect(mm.running.find((s) => s.id === 'slack')!.unread).toBe(true);
  });

  it('global DND mutes the overlay and clears per-service unread', () => {
    const m = new TrayModel();
    m.addService({ id: 'slack', displayName: 'Slack', badge: 2, dnd: false, visible: true, running: true });
    expect(m.iconOverlay()).toBe('unread');
    m.setGlobalDnd(true);
    expect(m.iconOverlay()).toBe('dnd');
    expect(m.menuModel().globalDnd).toBe(true);
    expect(m.menuModel().running[0].unread).toBe(false);
  });

  it('setRunning(false) moves a service into the available section', () => {
    const m = new TrayModel();
    m.addService({ id: 'slack', displayName: 'Slack', badge: 0, dnd: false, visible: true, running: true });
    m.setRunning('slack', false);
    const mm = m.menuModel();
    expect(mm.running).toEqual([]);
    expect(mm.available.map((s) => s.id)).toEqual(['slack']);
  });

  it('fires onChange only when a mutation actually changes state', () => {
    const m = new TrayModel();
    m.addService({ id: 'whatsapp', displayName: 'WhatsApp', badge: 0, dnd: false, visible: false, running: true });
    let changes = 0;
    m.onChange = () => { changes += 1; };
    m.setBadge('whatsapp', 3);
    m.setBadge('whatsapp', 3); // no-op — same value
    m.setVisible('whatsapp', false); // no-op — same value
    m.setDnd('whatsapp', true);
    expect(changes).toBe(2);
  });
});
