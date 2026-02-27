(function () {
  "use strict";

  // Guard against double injection (manifest + programmatic via injectContentScripts)
  if (window.__loft_content_installed) return;
  window.__loft_content_installed = true;

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

  // ================================================================
  // Messenger DOM cleanup — remove Facebook chrome (banner, nav bar)
  // ================================================================
  if (service === "messenger") {
    function cleanMessengerUI() {
      // Remove the top banner (Facebook navigation bar)
      const banner = document.querySelector('[role="banner"]');
      if (banner) {
        const sibling = banner.nextElementSibling;
        banner.remove();

        // In the div immediately after the banner, find the nested div
        // that has a 'top' CSS property set and clear it so content
        // sits flush at the top after banner removal.
        if (sibling) {
          const nested = sibling.querySelector('div');
          if (nested) {
            const inner = nested.querySelector('div');
            if (inner && getComputedStyle(inner).top !== 'auto') {
              inner.style.top = '0';
              inner.style.height = '100%';
            }
          }
        }
      }

      // Force --header-height to 0 everywhere via injected stylesheet.
      // A :root setProperty isn't enough because React re-sets the variable
      // on descendant elements, overriding inheritance from :root.
      if (!document.getElementById('loft-header-fix')) {
        const style = document.createElement('style');
        style.id = 'loft-header-fix';
        style.textContent = '* { --header-height: 0px !important; }';
        document.head.appendChild(style);
      }
    }

    // Run cleanup after page settles, and re-run on DOM changes
    // (React may re-render these elements)
    let cleanupTimeout = null;
    const cleanupObserver = new MutationObserver(() => {
      if (cleanupTimeout) clearTimeout(cleanupTimeout);
      cleanupTimeout = setTimeout(cleanMessengerUI, 300);
    });

    function startCleanupObserver() {
      if (document.body) {
        cleanupObserver.observe(document.body, {
          childList: true,
          subtree: true,
        });
        setTimeout(cleanMessengerUI, 2000);
      } else {
        setTimeout(startCleanupObserver, 500);
      }
    }
    startCleanupObserver();
  }

  // ================================================================
  // Messenger DOM notification scraping (Messenger only)
  // ================================================================
  if (service === "messenger") {
    // Set of conversation hrefs we've already notified about.
    // Cleared when the conversation loses its "Unread message:" indicator,
    // so re-appearing unreads trigger a fresh notification.
    const notifiedConversations = new Set();
    // Suppress notifications during a startup grace period.  Messenger's
    // React UI re-renders conversation elements multiple times during load,
    // creating "new" hrefs that a simple first-scan boolean would miss.
    // A time-based window catches all of these initial renders.
    const loadTime = Date.now();
    const STARTUP_GRACE_MS = 15000;

    /**
     * Scan the conversation list for unread messages and send
     * dom_notification messages for any newly detected ones.
     */
    function scanForUnreadMessages() {
      const allAnchors = document.querySelectorAll('a[href*="/messages/"]');
      const currentlyUnread = new Set();

      for (const anchor of allAnchors) {
        const href = anchor.getAttribute("href");
        if (!href) continue;

        // Walk text nodes inside this anchor looking for "Unread message:"
        let isUnread = false;
        const walker = document.createTreeWalker(
          anchor,
          NodeFilter.SHOW_TEXT,
          null
        );
        let textNode;
        while ((textNode = walker.nextNode())) {
          if (textNode.textContent.trim() === "Unread message:") {
            isUnread = true;
            break;
          }
        }

        if (!isUnread) continue;
        currentlyUnread.add(href);

        // Skip if we already notified about this conversation
        if (notifiedConversations.has(href)) continue;
        notifiedConversations.add(href);

        // Don't fire notifications during startup grace period
        if (Date.now() - loadTime < STARTUP_GRACE_MS) continue;

        const notification = extractConversationData(anchor, href);
        if (notification) {
          safeSendMessage(notification);
        }
      }

      // Remove conversations that are no longer unread so we
      // re-notify if they become unread again later
      for (const href of notifiedConversations) {
        if (!currentlyUnread.has(href)) {
          notifiedConversations.delete(href);
        }
      }

      // (grace period is time-based, no flag to set)
    }

    /**
     * Extract sender name, message preview, and profile pic URL
     * from a Messenger conversation row anchor element.
     */
    function extractConversationData(anchor, href) {
      // Sender name: first leaf-level <span> that isn't utility text
      let senderName = "";
      for (const span of anchor.querySelectorAll("span")) {
        const text = span.textContent.trim();
        if (
          text &&
          text !== "Unread message:" &&
          text.length > 1 &&
          text.length < 100 &&
          !text.match(/^\d+[hms]$/) &&  // skip timestamps like "2h", "5m"
          !text.match(/^·$/) &&          // skip separator dots
          !span.querySelector("span")    // prefer leaf-level spans
        ) {
          senderName = text;
          break;
        }
      }

      // Message preview: first text node after the "Unread message:" marker
      let messagePreview = "";
      const walker = document.createTreeWalker(
        anchor,
        NodeFilter.SHOW_TEXT,
        null
      );
      let foundMarker = false;
      let textNode;
      while ((textNode = walker.nextNode())) {
        if (foundMarker) {
          const text = textNode.textContent.trim();
          if (text && text !== senderName && text.length > 1) {
            messagePreview = text;
            break;
          }
        }
        if (textNode.textContent.trim() === "Unread message:") {
          foundMarker = true;
        }
      }

      // Profile picture: <img> with fbcdn.net source
      let profilePic = "";
      const img = anchor.querySelector('img[src*="fbcdn.net"]');
      if (img) {
        profilePic = img.src;
      }

      if (!senderName && !messagePreview) return null;

      return {
        type: "dom_notification",
        sender: senderName,
        body: messagePreview,
        icon: profilePic,
        href: href,
      };
    }

    // Observe DOM changes and debounce scans to avoid excessive work
    let scanTimeout = null;
    const domObserver = new MutationObserver(() => {
      if (scanTimeout) clearTimeout(scanTimeout);
      scanTimeout = setTimeout(scanForUnreadMessages, 500);
    });

    function startDomObserver() {
      if (document.body) {
        domObserver.observe(document.body, {
          childList: true,
          subtree: true,
        });
        // Initial scan after page settles
        setTimeout(scanForUnreadMessages, 5000);
      } else {
        setTimeout(startDomObserver, 500);
      }
    }
    startDomObserver();

    // Handle navigate_to_conversation from daemon (notification click)
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "navigate_to_conversation" && msg.url) {
        // Try SPA navigation first by clicking the matching anchor
        const anchor = document.querySelector('a[href="' + msg.url + '"]');
        if (anchor) {
          anchor.click();
        } else {
          // Fallback: full navigation
          window.location.href = "https://www.facebook.com" + msg.url;
        }
      }
    });
  }

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
