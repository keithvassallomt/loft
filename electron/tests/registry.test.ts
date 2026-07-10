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

  it('effectiveUrl prefers a customUrl only for self-hosted services', () => {
    const el = getService('element')!;
    expect(effectiveUrl(el, 'https://chat.example.org/')).toBe('https://chat.example.org/');
    expect(effectiveUrl(el, undefined)).toBe(el.url);
    const wa = getService('whatsapp')!;
    expect(effectiveUrl(wa, 'https://evil.example/')).toBe(wa.url);
  });
});
