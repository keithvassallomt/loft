import { describe, it, expect } from 'vitest';
import { formatWindowTitle } from '../src/main/serviceTitle';

describe('formatWindowTitle', () => {
  it('is the bare name at zero', () => {
    expect(formatWindowTitle('WhatsApp', 0)).toBe('WhatsApp');
  });
  it('appends a parenthesised count when positive', () => {
    expect(formatWindowTitle('WhatsApp', 3)).toBe('WhatsApp (3)');
  });
  it('treats negative/NaN as zero', () => {
    expect(formatWindowTitle('Slack', -1)).toBe('Slack');
    expect(formatWindowTitle('Slack', Number.NaN)).toBe('Slack');
  });
});
