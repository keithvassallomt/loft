import { describe, it, expect } from 'vitest';
import { dbusName } from '../src/main/dbus/names';

describe('dbusName', () => {
  it('strips all whitespace (matches extension.js displayName.replace(/\\s+/g,""))', () => {
    expect(dbusName('WhatsApp')).toBe('WhatsApp');
    expect(dbusName('NextCloud Talk')).toBe('NextCloudTalk');
    expect(dbusName('Facebook  Messenger')).toBe('FacebookMessenger');
  });
});
