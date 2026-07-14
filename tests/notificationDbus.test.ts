import { describe, it, expect } from 'vitest';
import { buildHints, buildNotifyArgs } from '../src/main/notifications/dbus';

describe('buildHints', () => {
  it('always includes desktop-entry, adds image-path only when present', () => {
    const bare = buildHints({ desktopEntry: 'chat.loft.Loft' });
    expect(Object.keys(bare)).toEqual(['desktop-entry']);
    const withImg = buildHints({ desktopEntry: 'chat.loft.Loft', imagePath: '/a/b.png' });
    expect(Object.keys(withImg).sort()).toEqual(['desktop-entry', 'image-path']);
  });
});

describe('buildNotifyArgs', () => {
  it('matches the notifications.rs Notify shape', () => {
    const hints = buildHints({ desktopEntry: 'chat.loft.Loft' });
    const args = buildNotifyArgs({ appName: 'WhatsApp', appIcon: '/i/wa.png', summary: 'Ann', body: 'hi', hints });
    expect(args[0]).toBe('WhatsApp');   // app_name
    expect(args[1]).toBe(0);            // replaces_id
    expect(args[2]).toBe('/i/wa.png');  // app_icon
    expect(args[3]).toBe('Ann');        // summary
    expect(args[4]).toBe('hi');         // body
    expect(args[5]).toEqual(['default', 'Open']); // actions
    expect(args[6]).toBe(hints);        // hints
    expect(args[7]).toBe(-1);           // expire_timeout
  });
});
