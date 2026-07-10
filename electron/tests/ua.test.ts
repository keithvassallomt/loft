import { describe, it, expect } from 'vitest';
import { chromeUserAgent, CHROME_VERSION } from '../src/main/ua';

describe('chromeUserAgent', () => {
  it('contains no Electron or app-name token', () => {
    const ua = chromeUserAgent();
    expect(ua).not.toMatch(/electron/i);
    expect(ua).not.toMatch(/loft/i);
  });
  it('embeds the Chrome version and Linux platform', () => {
    expect(chromeUserAgent('150.0.0.0')).toContain('Chrome/150.0.0.0');
    expect(chromeUserAgent()).toContain('X11; Linux x86_64');
    expect(chromeUserAgent()).toContain(CHROME_VERSION);
  });
});
