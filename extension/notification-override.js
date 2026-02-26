// Injected into the page's MAIN world at document_start.
// Wraps the Notification constructor so we can relay notification metadata
// to the daemon (for badge count updates) while letting Chrome show its
// native notifications (richer than D-Bus, with profile pics, click-to-focus).
(function () {
  "use strict";

  // Guard against double injection (manifest + programmatic injection)
  if (window.__loft_overrides_installed) return;
  window.__loft_overrides_installed = true;

  // Wrap Notification: call the original (Chrome shows the notification)
  // AND relay metadata to the content script → daemon for badge updates.
  const OrigNotification = window.Notification;

  class LoftNotification extends OrigNotification {
    constructor(title, options = {}) {
      super(title, options);

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
        },
        "*"
      );
    }
  }

  window.Notification = LoftNotification;

  // Override document.visibilityState so WhatsApp thinks the page is hidden
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
