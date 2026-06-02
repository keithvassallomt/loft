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

  // Element (app.element.io or a self-hosted instance) renders the page under
  // a #matrixchat root. Detected lazily — the page isn't loaded yet at
  // document_start, but notifications only fire long after.
  function isElementPage() {
    return !!document.getElementById("matrixchat");
  }

  // NextCloud Talk exposes the global OCA.Talk app object. Avatars are served
  // from the NextCloud instance and usually require the session cookie, so —
  // like Element — they must be fetched in-page and inlined (the daemon can't
  // authenticate). Detected lazily; the globals exist long before any
  // notification fires.
  function isTalkPage() {
    return !!(window.OCA && window.OCA.Talk);
  }

  // Resolve a notification icon to something the daemon can display.
  //
  // Element serves avatars either as blob: object URLs or as authenticated
  // Matrix media URLs that only the page can fetch (Element's service worker
  // attaches the access token). NextCloud Talk serves avatars from root-relative
  // paths (e.g. /index.php/avatar/<user>/64) that need the session cookie. The
  // daemon can't fetch either, so for Element/Talk we fetch the icon in-page and
  // inline it as a data: URL (the daemon decodes data: URIs). Other services
  // keep the original behaviour: pass https URLs through for the daemon to
  // download, drop anything else.
  function resolveIcon(icon) {
    if (typeof icon !== "string" || !icon) return Promise.resolve("");
    if (icon.startsWith("data:")) return Promise.resolve(icon);

    // Resolve relative icon URLs (NextCloud passes root-relative avatar paths)
    // against the page so they become fetchable.
    let abs = icon;
    if (!/^(blob:|https?:)/.test(icon)) {
      try {
        abs = new URL(icon, window.location.href).href;
      } catch {
        return Promise.resolve("");
      }
    }

    if ((isElementPage() || isTalkPage()) && /^(blob:|https?:)/.test(abs)) {
      return fetch(abs)
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("fetch failed"))))
        .then(
          (blob) =>
            new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () =>
                resolve(typeof reader.result === "string" ? reader.result : "");
              reader.onerror = () => resolve("");
              reader.readAsDataURL(blob);
            })
        )
        // Fall back to the original URL if it's at least daemon-downloadable.
        .catch(() => (abs.startsWith("https://") ? abs : ""));
    }

    return Promise.resolve(abs.startsWith("https://") ? abs : "");
  }

  // NextCloud's Notifications app hands `new Notification()` the *Talk app icon*
  // (the spreed logo), never the sender's avatar. Recover the avatar from the
  // conversation list instead: each row's avatar element carries the display
  // name in its `title` attribute and wraps an <img> whose src is the
  // (cookie-authenticated, root-relative) avatar URL. The notification title
  // begins with that same name ("<Name> sent you a private message", "<Name>
  // mentioned you in …"), so match on it. resolveIcon() then inlines the URL.
  // Returns `fallback` off Talk pages or when no row matches.
  function talkAvatarIcon(title, fallback) {
    if (!isTalkPage() || typeof title !== "string") return fallback;
    let best = null;
    for (const span of document.querySelectorAll(".conversation-icon__avatar[title]")) {
      const name = span.getAttribute("title");
      const src = span.querySelector("img")?.getAttribute("src");
      // Prefer the longest matching name so a short name that is a substring of
      // another conversation's name doesn't win.
      if (name && src && title.includes(name) && (!best || name.length > best.name.length)) {
        best = { name, src };
      }
    }
    return best ? best.src : fallback;
  }

  function relayMetadata(title, options = {}) {
    resolveIcon(talkAvatarIcon(title, options.icon)).then((icon) => {
      window.postMessage(
        {
          __loft_notification: true,
          title: title,
          body: options.body || "",
          icon: icon,
          tag: options.tag || "",
        },
        "*"
      );
    });
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
  const isElement = window.location.href.startsWith("https://app.element.io");

  const internalDomains = isMessenger
    ? ["facebook.com", "www.facebook.com"]
    : isWhatsApp
    ? ["web.whatsapp.com"]
    : isSlack
    ? ["app.slack.com", "slack.com"]
    : isTelegram
    ? ["web.telegram.org", "telegram.org"]
    : isElement
    ? ["app.element.io"]
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
