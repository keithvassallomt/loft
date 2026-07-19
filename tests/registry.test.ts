import { describe, it, expect } from 'vitest';
import { SERVICES, getService, listServices, effectiveUrl } from '../src/main/registry';

describe('service registry', () => {
  it('contains the six services', () => {
    expect(listServices().map((s) => s.id).sort()).toEqual(
      ['element', 'messenger', 'slack', 'talk', 'telegram', 'whatsapp'],
    );
  });

  it('looks up a service by id', () => {
    expect(getService('whatsapp')?.url).toBe('https://web.whatsapp.com/');
    expect(getService('nope')).toBeUndefined();
  });

  it('marks element and talk as self-hosted', () => {
    expect(getService('element')?.selfHosted).toBe(true);
    expect(getService('talk')?.selfHosted).toBe(true);
    expect(getService('whatsapp')?.selfHosted).toBe(false);
  });

  it('flags only Slack to clear its wedge-prone service worker before the first load', () => {
    expect(getService('slack')?.clearCachesOnStart).toBe(true);
    // No other service pays the cold-start re-fetch cost.
    for (const id of ['whatsapp', 'messenger', 'telegram', 'element', 'talk']) {
      expect(getService(id)?.clearCachesOnStart ?? false).toBe(false);
    }
  });

  it('effectiveUrl prefers a customUrl only for self-hosted services', () => {
    const el = getService('element')!;
    expect(effectiveUrl(el, 'https://chat.example.org/')).toBe('https://chat.example.org/');
    expect(effectiveUrl(el, undefined)).toBe(el.url);
    const wa = getService('whatsapp')!;
    expect(effectiveUrl(wa, 'https://evil.example/')).toBe(wa.url);
  });

  it('adds a missing scheme rather than handing loadURL something invalid', () => {
    // The settings field's placeholder is a bare host, so this is what users type.
    const el = getService('element')!;
    expect(effectiveUrl(el, 'chat.example.org')).toBe('https://chat.example.org/');
  });

  it('lands Talk in the Talk app, not the NextCloud dashboard', () => {
    // Talk is an app INSIDE NextCloud; the server root is the dashboard. Entering the
    // server (which is what the field asks for) must still open Talk.
    const talk = getService('talk')!;
    expect(effectiveUrl(talk, 'https://cloud.example.com')).toBe('https://cloud.example.com/apps/spreed/');
    expect(effectiveUrl(talk, 'https://cloud.example.com/')).toBe('https://cloud.example.com/apps/spreed/');
    expect(effectiveUrl(talk, 'cloud.example.com')).toBe('https://cloud.example.com/apps/spreed/');
  });

  it('respects a NextCloud installed in a subdirectory', () => {
    const talk = getService('talk')!;
    expect(effectiveUrl(talk, 'https://example.com/nextcloud'))
      .toBe('https://example.com/nextcloud/apps/spreed/');
  });

  it('does not double-append when the user already gave the Talk path', () => {
    const talk = getService('talk')!;
    expect(effectiveUrl(talk, 'https://cloud.example.com/apps/spreed/'))
      .toBe('https://cloud.example.com/apps/spreed/');
    expect(effectiveUrl(talk, 'https://cloud.example.com/apps/spreed'))
      .toBe('https://cloud.example.com/apps/spreed');
  });

  it('leaves a self-hosted service with no app path alone', () => {
    // Element Web's own root IS the app, so nothing should be appended to it.
    const el = getService('element')!;
    expect(effectiveUrl(el, 'https://chat.example.org/some/path')).toBe('https://chat.example.org/some/path');
  });

  it('requires a server only for a service with no usable default', () => {
    // Talk's registry url is a placeholder, so a server is mandatory. Element ships a real
    // default (app.element.io), so pointing it at your own server is optional.
    expect(getService('talk')!.serverRequired).toBe(true);
    expect(getService('element')!.serverRequired).toBeUndefined();
    expect(effectiveUrl(getService('element')!, undefined)).toBe('https://app.element.io/');
  });

  it('falls back to the raw input if it cannot be parsed as a URL', () => {
    const talk = getService('talk')!;
    expect(effectiveUrl(talk, 'not a url')).toBe('not a url');
  });
});
