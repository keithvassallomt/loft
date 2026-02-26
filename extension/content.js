(function () {
  "use strict";

  // Determine which service we're on
  const url = window.location.href;
  let service = null;
  if (url.startsWith("https://web.whatsapp.com")) {
    service = "whatsapp";
  } else if (url.startsWith("https://facebook.com/messages") || url.startsWith("https://www.facebook.com/messages")) {
    service = "messenger";
  }

  if (!service) return;

  // Wrapper that silently drops messages if the extension context has been
  // invalidated (e.g. extension reloaded while the page is still open).
  function safeSendMessage(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch {
      // Extension context invalidated — nothing we can do
    }
  }

  const SERVICE_DISPLAY_NAMES = {
    whatsapp: "WhatsApp",
    messenger: "Messenger",
  };

  // First-run speech bubble
  function showFirstRunBubble() {
    const storageKey = "loftFirstRunDismissed_" + service;
    chrome.storage.local.get(storageKey, (data) => {
      if (data[storageKey]) return;

      const displayName = SERVICE_DISPLAY_NAMES[service] || service;

      const bubble = document.createElement("div");
      bubble.id = "loft-first-run-bubble";
      bubble.style.cssText = [
        "position: fixed",
        "top: 16px",
        "left: 50%",
        "transform: translateX(-50%)",
        "z-index: 2147483647",
        "background: #323232",
        "color: #fff",
        "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        "font-size: 14px",
        "line-height: 1.4",
        "padding: 12px 40px 12px 16px",
        "border-radius: 8px",
        "box-shadow: 0 4px 12px rgba(0,0,0,0.3)",
        "max-width: 480px",
        "cursor: default",
        "user-select: none",
      ].join("; ");

      bubble.textContent =
        "Use the tray icon to show/hide " +
        displayName +
        ". Clicking Close (x) resets your window.";

      const closeBtn = document.createElement("span");
      closeBtn.textContent = "\u00d7";
      closeBtn.style.cssText = [
        "position: absolute",
        "top: 8px",
        "right: 12px",
        "font-size: 20px",
        "cursor: pointer",
        "opacity: 0.7",
        "line-height: 1",
      ].join("; ");
      closeBtn.addEventListener("mouseenter", () => {
        closeBtn.style.opacity = "1";
      });
      closeBtn.addEventListener("mouseleave", () => {
        closeBtn.style.opacity = "0.7";
      });
      closeBtn.addEventListener("click", () => {
        bubble.remove();
        chrome.storage.local.set({ [storageKey]: true });
      });

      bubble.appendChild(closeBtn);
      document.body.appendChild(bubble);

      // Auto-dismiss after 15 seconds
      setTimeout(() => {
        if (bubble.parentNode) {
          bubble.remove();
          chrome.storage.local.set({ [storageKey]: true });
        }
      }, 15000);
    });
  }

  // Show bubble after page settles
  setTimeout(showFirstRunBubble, 3000);

  // Send ready message
  safeSendMessage({ type: "ready", service: service });

  // Badge extraction
  let lastBadgeCount = 0;

  function extractBadgeCount() {
    let count = 0;

    if (service === "whatsapp") {
      // WhatsApp shows unread count in page title: "(3) WhatsApp"
      const titleMatch = document.title.match(/^\((\d+)\)/);
      if (titleMatch) {
        count = parseInt(titleMatch[1], 10);
      }
    } else if (service === "messenger") {
      // Messenger shows unread count in page title: "Messenger (3)" or "(3) Messenger"
      const titleMatch = document.title.match(/\((\d+)\)/);
      if (titleMatch) {
        count = parseInt(titleMatch[1], 10);
      }
    }

    if (count !== lastBadgeCount) {
      lastBadgeCount = count;
      safeSendMessage({
        type: "badge_update",
        count: count,
      });
    }
  }

  // Observe title changes (most reliable for both apps)
  const titleEl = document.querySelector("title");
  if (titleEl) {
    const titleObserver = new MutationObserver(extractBadgeCount);
    titleObserver.observe(titleEl, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  // Periodic fallback
  setInterval(extractBadgeCount, 2000);

  // Initial extraction (delayed to let page load)
  setTimeout(extractBadgeCount, 3000);

  // Relay notifications from MAIN world override to background script
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.__loft_notification) {
      safeSendMessage({
        type: "notification",
        title: event.data.title,
        body: event.data.body,
        icon: event.data.icon,
      });
    }
  });

  // Protect against accidental window close (e.g. muscle memory).
  // Shows Chrome's native "Leave site?" confirmation dialog.
  window.addEventListener("beforeunload", (event) => {
    event.preventDefault();
  });

  // Listen for daemon messages (e.g., DND changes)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "dnd_changed") {
      console.log("Loft: DND changed to", msg.enabled);
    }
  });
})();
