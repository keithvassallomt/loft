import { describe, it, expect } from 'vitest';
import { shouldNotify, NotificationGate } from '../src/main/notifications/gate';

const base = { systemDnd: false, globalDnd: false, serviceDnd: false, focused: false, visible: false };

describe('shouldNotify', () => {
  it('allows when nothing suppresses', () => {
    expect(shouldNotify(base)).toBe(true);
  });
  it('suppresses on any DND flag', () => {
    expect(shouldNotify({ ...base, systemDnd: true })).toBe(false);
    expect(shouldNotify({ ...base, globalDnd: true })).toBe(false);
    expect(shouldNotify({ ...base, serviceDnd: true })).toBe(false);
  });
  it('suppresses only when focused AND visible', () => {
    expect(shouldNotify({ ...base, focused: true, visible: true })).toBe(false);
    expect(shouldNotify({ ...base, focused: true, visible: false })).toBe(true);
    expect(shouldNotify({ ...base, focused: false, visible: true })).toBe(true);
  });
});

describe('NotificationGate', () => {
  it('tracks per-service state and computes effective DND + decision', () => {
    const g = new NotificationGate();
    g.setServiceDnd('slack', false);
    g.setFocused('slack', false);
    g.setVisible('slack', true);
    expect(g.effectiveDnd('slack')).toBe(false);
    expect(g.shouldNotify('slack')).toBe(true); // visible but not focused

    g.setGlobalDnd(true);
    expect(g.effectiveDnd('slack')).toBe(true);
    expect(g.shouldNotify('slack')).toBe(false);
    g.setGlobalDnd(false);

    g.setSystemDnd(true);
    expect(g.effectiveDnd('whatsapp')).toBe(true); // system DND applies to unknown services too
    g.setSystemDnd(false);

    g.setFocused('slack', true);
    expect(g.shouldNotify('slack')).toBe(false); // focused + visible
  });
  it('defaults unknown-service focus/visible/dnd to false', () => {
    const g = new NotificationGate();
    expect(g.effectiveDnd('x')).toBe(false);
    expect(g.shouldNotify('x')).toBe(true);
  });
});
