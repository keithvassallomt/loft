// Injected into the page's MAIN world at document_start.
// Overrides the Notification constructor so we can:
// 1. Suppress Chrome's default notification (which shows the extension origin)
// 2. Forward notification data to the content script via postMessage
(function () {
  "use strict";

  const OrigNotification = window.Notification;

  class LoftNotification extends EventTarget {
    constructor(title, options = {}) {
      super();
      this.title = title;
      this.body = options.body || "";
      this.icon = options.icon || "";
      this.tag = options.tag || "";
      this.data = options.data !== undefined ? options.data : null;
      this.onclick = null;
      this.onclose = null;
      this.onerror = null;
      this.onshow = null;

      // Only pass HTTPS icon URLs (blob/data URLs won't work with chrome.notifications)
      const safeIcon =
        typeof this.icon === "string" && this.icon.startsWith("https://")
          ? this.icon
          : "";

      window.postMessage(
        {
          __loft_notification: true,
          title: this.title,
          body: this.body,
          icon: safeIcon,
        },
        "*"
      );
    }

    close() {}

    static get permission() {
      return OrigNotification.permission;
    }

    static requestPermission(callback) {
      return OrigNotification.requestPermission(callback);
    }
  }

  window.Notification = LoftNotification;
})();
