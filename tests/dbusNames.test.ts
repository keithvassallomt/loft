import { describe, it, expect } from 'vitest';
import { dbusName } from '../src/main/dbus/names';
import { objectPathFor } from '../src/main/dbus/loftService';

describe('dbusName', () => {
  it('strips all whitespace (matches extension.js displayName.replace(/\\s+/g,""))', () => {
    expect(dbusName('WhatsApp')).toBe('WhatsApp');
    expect(dbusName('NextCloud Talk')).toBe('NextCloudTalk');
    expect(dbusName('Facebook  Messenger')).toBe('FacebookMessenger');
  });
});

describe('per-instance object paths', () => {
  it('keeps the documented paths for the first account of a kind', () => {
    expect(objectPathFor('WhatsApp')).toBe('/chat/loft/WhatsApp');
    expect(objectPathFor('NextCloudTalk')).toBe('/chat/loft/NextCloudTalk');
  });

  it('gives a second account its own path', () => {
    expect(objectPathFor('WhatsApp2')).toBe('/chat/loft/WhatsApp2');
  });
});
