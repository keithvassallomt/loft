import { describe, it, expect } from 'vitest';
import { shouldNotify, NotificationGate } from '../src/main/notifications/gate';

// active: true here reflects the pre-Task-2 assumption baked into these fixtures — a
// lone window has no other tab to be behind. shouldNotify() itself requires `active`
// explicitly (no default); the `?? true` default lives only in NotificationGate.
const base = { systemDnd: false, globalDnd: false, serviceDnd: false, focused: false, visible: false, active: true };

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

  it('notifies an inactive tab even when its window is focused and visible', () => {
    // The Loft window hosts several services; only one is the selected tab. The
    // others are focused+visible by the window's reckoning but are NOT on screen,
    // so they must still notify. Getting this wrong makes every background tab
    // silent — a failure you notice as an absence, weeks later.
    expect(shouldNotify({
      systemDnd: false, globalDnd: false, serviceDnd: false,
      focused: true, visible: true, active: false,
    })).toBe(true);
  });

  it('suppresses only the service the user is actually looking at', () => {
    expect(shouldNotify({
      systemDnd: false, globalDnd: false, serviceDnd: false,
      focused: true, visible: true, active: true,
    })).toBe(false);
  });

  it('still notifies an active service whose window is hidden or unfocused', () => {
    expect(shouldNotify({
      systemDnd: false, globalDnd: false, serviceDnd: false,
      focused: false, visible: true, active: true,
    })).toBe(true);
    expect(shouldNotify({
      systemDnd: false, globalDnd: false, serviceDnd: false,
      focused: true, visible: false, active: true,
    })).toBe(true);
  });

  it('lets any DND flag beat focus regardless of active', () => {
    for (const flag of ['systemDnd', 'globalDnd', 'serviceDnd'] as const) {
      expect(shouldNotify({
        systemDnd: false, globalDnd: false, serviceDnd: false,
        focused: false, visible: false, active: false,
        [flag]: true,
      })).toBe(false);
    }
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

describe('NotificationGate.setActive', () => {
  it('defaults active to true so a lone window behaves exactly as before', () => {
    // A detached service is always "active" — there is no other tab to be behind.
    // The default must therefore be true, or every detached window would keep
    // notifying while the user reads it.
    const g = new NotificationGate();
    g.setFocused('slack', true);
    g.setVisible('slack', true);
    expect(g.shouldNotify('slack')).toBe(false);
  });

  it('an inactive tab notifies even when focused and visible', () => {
    const g = new NotificationGate();
    g.setFocused('slack', true);
    g.setVisible('slack', true);
    g.setActive('slack', false);
    expect(g.shouldNotify('slack')).toBe(true);
    g.setActive('slack', true);
    expect(g.shouldNotify('slack')).toBe(false);
  });
});
