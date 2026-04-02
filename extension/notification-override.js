// Injected into the page's MAIN world at document_start.
// Wraps the Notification constructor so we can relay notification metadata
// to the daemon (for badge count updates) while letting Chrome show its
// native notifications (richer than D-Bus, with profile pics, click-to-focus).
(function () {
  "use strict";

  // Guard against double injection (manifest + programmatic injection)
  if (window.__loft_overrides_installed) return;
  window.__loft_overrides_installed = true;

  // Messenger notifications are handled entirely via DOM scraping in
  // content.js.  Suppress Chrome's native Notification constructor for
  // Messenger to avoid duplicate / "Active now" spam on page load.
  // WhatsApp relies on native notifications, so keep them there.
  const isMessenger =
    window.location.href.startsWith("https://facebook.com/messages") ||
    window.location.href.startsWith("https://www.facebook.com/messages");

  const OrigNotification = window.Notification;

  // Per-service DND flag, toggled from the tray menu via content.js relay.
  let loftDnd = false;
  window.addEventListener("message", (e) => {
    if (e.data && e.data.__loft_dnd !== undefined) {
      loftDnd = !!e.data.__loft_dnd;
    }
  });

  function relayMetadata(title, options = {}) {
    const safeIcon =
      typeof options.icon === "string" && options.icon.startsWith("https://")
        ? options.icon
        : "";

    window.postMessage(
      {
        __loft_notification: true,
        title: title,
        body: options.body || "",
        icon: safeIcon,
        tag: options.tag || "",
      },
      "*"
    );
  }

  // Silent stub that suppresses visible notifications.  Slack inspects
  // Notification.prototype before deciding to call the constructor, so the
  // prototype must be the real one.  Slack then tries to assign event
  // handlers (.onclick etc.) on the returned object — the native setters
  // throw "Illegal invocation" on a non-native instance, but Slack catches
  // that error internally.  No native notification is created; the relay
  // via chrome.notifications (with avatar) is the only visible notification.
  function SilentNotification(title, options = {}) {
    relayMetadata(title, options);
  }
  Object.defineProperty(SilentNotification, 'name', { value: 'Notification', configurable: true });
  SilentNotification.toString = () => 'function Notification() { [native code] }';
  Object.defineProperty(SilentNotification, 'permission', {
    get() { return OrigNotification.permission; },
    enumerable: true,
    configurable: true,
  });
  SilentNotification.requestPermission = OrigNotification.requestPermission.bind(OrigNotification);
  SilentNotification.prototype = OrigNotification.prototype;

  // Suppress native notifications for all services — the daemon handles
  // desktop notifications via D-Bus for full control over app name, icon,
  // and avatar display.  Metadata is relayed via SilentNotification so the
  // daemon can recreate them as rich D-Bus notifications.
  window.Notification = SilentNotification;

  // Also wrap ServiceWorkerRegistration.prototype.showNotification, which
  // some services use instead of `new Notification()`.  Relay metadata to the
  // content script for badge count updates.
  const origShowNotification =
    ServiceWorkerRegistration.prototype.showNotification;

  ServiceWorkerRegistration.prototype.showNotification = function (title, options = {}) {
    relayMetadata(title, options);
    // All notifications are handled by the daemon via D-Bus — don't show native ones.
  };

  // Intercept window.open() to route external URLs to the default browser
  // via the daemon (xdg-open) instead of opening a new Chrome window.
  const origWindowOpen = window.open;
  const isWhatsApp = window.location.href.startsWith("https://web.whatsapp.com");
  const isSlack = window.location.href.startsWith("https://app.slack.com");
  const isTelegram = window.location.href.startsWith("https://web.telegram.org");

  const internalDomains = isMessenger
    ? ["facebook.com", "www.facebook.com"]
    : isWhatsApp
    ? ["web.whatsapp.com"]
    : isSlack
    ? ["app.slack.com", "slack.com"]
    : isTelegram
    ? ["web.telegram.org", "telegram.org"]
    : [];

  function isInternalOrigin(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.origin === window.location.origin) return true;
      return internalDomains.some((d) => parsed.hostname === d || parsed.hostname.endsWith("." + d));
    } catch {
      return true;
    }
  }

  window.open = function (url, target, features) {
    if (url && !isInternalOrigin(url)) {
      window.postMessage({ __loft_open_url: true, url: url }, "*");
      return null;
    }
    return origWindowOpen.call(this, url, target, features);
  };

  // Override document.visibilityState so the page thinks it is hidden
  // when the window loses focus. Without this, WhatsApp never fires
  // new Notification() because --app= mode keeps visibilityState "visible"
  // even when the window is unfocused.
  let loftHidden = false;

  Object.defineProperty(document, "visibilityState", {
    get() {
      return loftHidden ? "hidden" : "visible";
    },
    configurable: true,
  });

  Object.defineProperty(document, "hidden", {
    get() {
      return loftHidden;
    },
    configurable: true,
  });

  function fireVisibilityChange() {
    document.dispatchEvent(new Event("visibilitychange"));
  }

  window.addEventListener("blur", () => {
    loftHidden = true;
    fireVisibilityChange();
  });

  window.addEventListener("focus", () => {
    loftHidden = false;
    fireVisibilityChange();
  });

})();
