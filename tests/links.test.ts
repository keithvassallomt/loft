import { describe, it, expect } from 'vitest';
import {
  isSameOrigin, isExternallyOpenable, messengerKeepsInApp,
  classifyNavigation, classifyWindowOpen,
} from '../src/main/links';

describe('isSameOrigin', () => {
  it('compares the top-level origin', () => {
    expect(isSameOrigin('https://a.com/x', 'https://a.com/y')).toBe(true);
    expect(isSameOrigin('https://a.com/x', 'https://b.com/y')).toBe(false);
    expect(isSameOrigin('https://a.com', 'https://a.com:8443')).toBe(false); // port differs
    expect(isSameOrigin('https://a.com', 'http://a.com')).toBe(false);       // scheme differs
  });
  it('leaves an unparseable target in-app (treated as same-origin)', () => {
    expect(isSameOrigin('https://a.com', 'not a url')).toBe(true);
    expect(isSameOrigin('https://a.com', 'javascript:void 0')).toBe(true);
  });
  it('a bad current URL with a real target is not same-origin', () => {
    expect(isSameOrigin('garbage', 'https://a.com')).toBe(false);
  });
});

describe('isExternallyOpenable', () => {
  it('allows http(s), mailto, tel', () => {
    for (const u of ['https://x.com', 'http://x.com', 'mailto:a@b.com', 'tel:+15551234'])
      expect(isExternallyOpenable(u)).toBe(true);
  });
  it('rejects schemes we must never hand to the OS', () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'about:blank', 'chrome://x', 'not a url'])
      expect(isExternallyOpenable(u)).toBe(false);
  });
});

describe('messengerKeepsInApp', () => {
  it('keeps the messaging app + auth flows in-window', () => {
    for (const u of [
      'https://www.facebook.com/messages',
      'https://www.facebook.com/messages/t/123',
      'https://www.facebook.com/e2ee/t/1',
      'https://www.facebook.com/login/',
      'https://www.facebook.com/login.php?next=x',
      'https://www.facebook.com/checkpoint/1',
      'https://www.facebook.com/two_factor/',
      // The re-login flow after Messenger logs you out: its "Continue" button goes here to
      // approve the login on another device. The path is /two_step_verification/two_factor,
      // so the /two_factor entry above never matched it and the whole flow was flung to the
      // default browser -- where it cannot complete, the session being in Loft.
      'https://www.facebook.com/two_step_verification/two_factor',
      'https://www.facebook.com/two_step_verification/two_factor/?next=x',
      'https://www.facebook.com/two_step_verification/authentication',
      'https://www.facebook.com/recover/initiate',
      'https://www.facebook.com/',            // logged-out redirect target
    ]) expect(messengerKeepsInApp(u)).toBe(true);
  });
  it('sends real Facebook content out', () => {
    for (const u of [
      'https://www.facebook.com/someuser/posts/123',
      'https://www.facebook.com/photo/?fbid=1',
      'https://www.facebook.com/groups/999',
      'https://www.facebook.com/watch/?v=1',
      'https://www.facebook.com/marketplace/item/1',
      'https://www.facebook.com/profile.php?id=1',
    ]) expect(messengerKeepsInApp(u)).toBe(false);
  });
  it('never hijacks an unparseable target', () => {
    expect(messengerKeepsInApp('javascript:void 0')).toBe(true);
  });
});

describe('classifyNavigation (will-navigate / in-place)', () => {
  it('keeps same-origin app navigations in-app for normal services', () => {
    // Slack's own /client -> /client/T../D.. supersede must not be hijacked.
    expect(classifyNavigation('slack', 'https://app.slack.com/client', 'https://app.slack.com/client/T1/D2')).toBe('in-app');
    expect(classifyNavigation('whatsapp', 'https://web.whatsapp.com/', 'https://web.whatsapp.com/send?phone=1')).toBe('in-app');
  });
  it('sends cross-origin navigations to the browser', () => {
    expect(classifyNavigation('whatsapp', 'https://web.whatsapp.com/', 'https://youtube.com/watch')).toBe('external');
    expect(classifyNavigation('slack', 'https://app.slack.com/client', 'https://example.com/')).toBe('external');
  });
  it('keeps Messenger IN its app but sends Facebook content + cross-site out', () => {
    const cur = 'https://www.facebook.com/messages/t/1';
    expect(classifyNavigation('messenger', cur, 'https://www.facebook.com/messages/t/2')).toBe('in-app');
    expect(classifyNavigation('messenger', cur, 'https://www.facebook.com/someuser/posts/9')).toBe('external');
    expect(classifyNavigation('messenger', cur, 'https://youtube.com/x')).toBe('external');
  });
  it('keeps every leg of Element\'s cross-origin login chain in-app', () => {
    // Element logs in by redirecting the TOP-LEVEL view: app.element.io -> the homeserver's
    // SSO endpoint -> possibly an identity provider -> back with a login token. Homeservers
    // and IdPs are arbitrary, so there is nothing to allow-list; sending any leg to the
    // browser strands the flow there and the callback can never return to Loft.
    const app = 'https://app.element.io/';
    expect(classifyNavigation('element', app, 'https://matrix.example.org/_matrix/client/v3/login/sso/redirect')).toBe('in-app');
    expect(classifyNavigation('element', app, 'https://keycloak.example.org/realms/x/protocol/openid-connect/auth')).toBe('in-app');
    expect(classifyNavigation('element', 'https://keycloak.example.org/x', `${app}#/login_token=abc`)).toBe('in-app');
    // Self-hosted Element behaves the same way.
    expect(classifyNavigation('element', 'https://chat.example.org/', 'https://sso.example.org/auth')).toBe('in-app');
  });
  it('never hijacks an unparseable target', () => {
    expect(classifyNavigation('messenger', 'https://www.facebook.com/messages', 'javascript:void 0')).toBe('in-app');
    expect(classifyNavigation('whatsapp', 'https://web.whatsapp.com/', 'not a url')).toBe('in-app');
  });
});

describe('classifyWindowOpen (setWindowOpenHandler)', () => {
  const fb = 'https://www.facebook.com/messages/t/1';
  it('sends a user-clicked external link (tab) to the browser', () => {
    expect(classifyWindowOpen(fb, 'https://youtube.com/x', 'foreground-tab')).toBe('external');
    expect(classifyWindowOpen(fb, 'https://news.example/x', 'background-tab')).toBe('external');
  });
  it('keeps a same-origin popup in-app — protects Messenger call popups regardless of disposition', () => {
    expect(classifyWindowOpen(fb, 'https://www.facebook.com/groupcall/ROOM', 'foreground-tab')).toBe('in-app');
    expect(classifyWindowOpen(fb, 'https://www.facebook.com/groupcall/ROOM', 'new-window')).toBe('in-app');
    expect(classifyWindowOpen(fb, 'https://www.facebook.com/groupcall/ROOM', 'other')).toBe('in-app');
  });
  it('keeps a cross-origin WINDOWED (featured) popup in-app — protects most SSO/auth', () => {
    expect(classifyWindowOpen('https://app.slack.com/client', 'https://accounts.google.com/o/oauth2/auth', 'new-window')).toBe('in-app');
  });
  it('sends a cross-origin FEATURELESS popup to the browser (known tradeoff)', () => {
    // A featureless window.open is indistinguishable from a user-clicked external
    // link (both are 'foreground-tab' with no features), so it goes to the browser.
    // Correct for external links (the point); wrong only for the rare dimensionless
    // OAuth popup. Pinned so the policy is explicit, not accidental.
    expect(classifyWindowOpen('https://app.slack.com/client', 'https://accounts.google.com/o/oauth2/auth', 'foreground-tab')).toBe('external');
  });
});
