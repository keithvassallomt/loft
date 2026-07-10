import { describe, it, expect } from 'vitest';
import { dechromeCssFor } from '../src/main/dechromeCss';

describe('dechromeCssFor', () => {
  it('returns Talk CSS that hides the header and zeroes --header-height', () => {
    const css = dechromeCssFor('talk')!;
    expect(css).toContain('#header { display: none !important; }');
    expect(css).toContain('--header-height: 0px !important');
  });
  it('returns Slack banner-hide CSS', () => {
    expect(dechromeCssFor('slack')).toContain('workspace-banner-download-app');
  });
  it('restores 56px header-height inside dialogs for Messenger', () => {
    expect(dechromeCssFor('messenger')).toContain('[role="dialog"]');
  });
  it('returns null for services with no static de-chrome', () => {
    expect(dechromeCssFor('whatsapp')).toBeNull();
    expect(dechromeCssFor('element')).toBeNull();
  });
});
