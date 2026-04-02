(function () {
  "use strict";

  // Guard against double-injection in the same isolated world.
  // When Chrome loads the extension via CDP it both auto-injects via the
  // manifest AND background.js calls injectContentScripts() for already-open
  // tabs.  Without this guard both injections run to completion, producing
  // two independent scanForUnreadMessages() loops with separate
  // notifiedConversations Sets — the root cause of duplicate Messenger
  // notifications (one without photo, one with).
  // After a CDP reload the isolated world is brand-new so the flag is unset
  // and we fall through normally.
  //
  // IMPORTANT: This guard must come BEFORE the stale DOM cleanup below.
  // If the second injection removes the live titlebar first and then exits
  // at the guard, the titlebar is gone and never re-created.
  if (window.__loft_content_installed) return;
  window.__loft_content_installed = true;

  // Clean up stale Loft DOM elements — they may survive from a previous
  // isolated world (dead after CDP reload) whose JS is gone but whose DOM
  // nodes persist.  Safe to run here because the guard above ensures we
  // only reach this point in a fresh world.
  const oldBar = document.getElementById('loft-titlebar');
  if (oldBar) oldBar.remove();
  const oldBubble = document.getElementById('loft-first-run-bubble');
  if (oldBubble) oldBubble.remove();

  // Determine which service we're on
  const url = window.location.href;
  let service = null;
  if (url.startsWith("https://web.whatsapp.com")) {
    service = "whatsapp";
  } else if (url.startsWith("https://facebook.com/messages") || url.startsWith("https://www.facebook.com/messages")) {
    service = "messenger";
  } else if (url.startsWith("https://app.slack.com")) {
    service = "slack";
  } else if (url.startsWith("https://web.telegram.org")) {
    service = "telegram";
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

  // Messenger notification tracking — hoisted to outer scope so both the
  // scanner (inside the messenger block) and the dnd_changed listener
  // (outside it) can access them.
  // Map<href, previewFingerprint> — tracks conversation href AND the latest
  // message preview so new messages in an already-unread conversation are
  // detected as fresh notification events.
  const notifiedConversations = new Map();
  let messengerDnd = false;

  // ================================================================
  // Loft titlebar — auto-hide bar with hide-to-tray button
  // ================================================================
  const TITLEBAR_HEIGHT = 36;
  let titlebarEnabled = true;

  function createLoftTitleBar() {
    // Use Shadow DOM to fully isolate titlebar CSS from the host page.
    // Facebook/Messenger aggressively styles elements and can override
    // inline styles via !important rules on broad selectors.
    const host = document.createElement('div');
    host.id = 'loft-titlebar';
    host.style.cssText = [
      'position: fixed !important',
      'top: -' + TITLEBAR_HEIGHT + 'px',
      'left: 0 !important',
      'width: 100% !important',
      'height: ' + TITLEBAR_HEIGHT + 'px !important',
      'z-index: 2147483647 !important',
      'display: block !important',
      'visibility: visible !important',
      'opacity: 1 !important',
      'transition: top 0.2s ease',
      'pointer-events: auto !important',
    ].join('; ');

    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        height: ${TITLEBAR_HEIGHT}px;
        background: #1a1a1a;
        border-bottom: 1px solid #333;
        box-sizing: border-box;
        padding: 0 8px;
        user-select: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .label {
        color: #888;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.5px;
      }
      .controls {
        display: flex;
        gap: 2px;
        align-items: center;
      }
      button {
        all: unset;
        color: #666;
        font-size: 14px;
        cursor: pointer;
        padding: 4px 12px;
        line-height: 1;
        border-radius: 3px;
        box-sizing: border-box;
      }
      button:hover {
        color: #fff;
        background: rgba(255,255,255,0.1);
      }
      button.hide-btn { padding: 4px 10px; }
      button.hide-btn svg { width: 14px; height: 14px; display: block; }
    `;
    shadow.appendChild(style);

    const bar = document.createElement('div');
    bar.className = 'bar';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Loft';

    const rightGroup = document.createElement('div');
    rightGroup.className = 'controls';

    const zoomOutBtn = document.createElement('button');
    zoomOutBtn.textContent = '\u2212';
    zoomOutBtn.title = 'Zoom out';
    zoomOutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      safeSendMessage({ type: 'zoom_out' });
    });

    const zoomInBtn = document.createElement('button');
    zoomInBtn.textContent = '+';
    zoomInBtn.title = 'Zoom in';
    zoomInBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      safeSendMessage({ type: 'zoom_in' });
    });

    const hideBtn = document.createElement('button');
    hideBtn.className = 'hide-btn';
    hideBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="m 1.004,1 v 14 H 15.004 v -14 z m 1.4,1.4 H 13.604 V 13.6 H 2.404 Z" style="stroke-width:1.4"/><g fill="currentColor" transform="matrix(0,-117.36063,117.36063,0,-865.535,1005.444)"><path d="M 8.535339,7.4211389 8.5671,7.3893779 8.552727,7.3750039 8.520966,7.4067649 8.506555,7.3923539 l -0.00762,0.00762 v 0.043196 h 0.043196 l 0.00762,-0.00762 z" style="stroke-width:0.00508184"/></g></svg>';
    hideBtn.title = 'Hide to tray';
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      safeSendMessage({ type: 'hide_request' });
    });

    rightGroup.appendChild(zoomOutBtn);
    rightGroup.appendChild(zoomInBtn);
    rightGroup.appendChild(hideBtn);
    bar.appendChild(label);
    bar.appendChild(rightGroup);
    shadow.appendChild(bar);
    // Append (not prepend) so the host is last in DOM order — ensures it
    // paints on top of any same-z-index fixed elements inside the app.
    document.body.appendChild(host);

    // Find the app's root container (works for WhatsApp #app, Messenger, etc.)
    function getAppRoot() {
      const app = document.getElementById('app');
      if (app) return app;
      for (const child of document.body.children) {
        if (child.id && child.id.startsWith('loft-')) continue;
        if (['STYLE', 'SCRIPT', 'LINK'].includes(child.tagName)) continue;
        // Skip zero-height helper divs (e.g. Slack's empty absolute wrappers)
        if (child.offsetHeight === 0) continue;
        return child;
      }
      return null;
    }

    // Show/hide bar when mouse enters top edge of window
    let barVisible = false;
    let hideTimeout = null;
    // Detect whether the app root uses fixed/absolute positioning.
    // margin-top has no effect on fixed/absolute elements — use top instead.
    function isFixedOrAbsolute(el) {
      const pos = getComputedStyle(el).position;
      return pos === 'fixed' || pos === 'absolute';
    }

    function showBar() {
      if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
      if (barVisible || !titlebarEnabled) return;
      barVisible = true;
      host.style.top = '0';
      const root = getAppRoot();
      if (root) {
        if (isFixedOrAbsolute(root)) {
          root.style.setProperty('transition', 'top 0.2s ease, height 0.2s ease', 'important');
          root.style.setProperty('top', TITLEBAR_HEIGHT + 'px', 'important');
          root.style.setProperty('height', 'calc(100vh - ' + TITLEBAR_HEIGHT + 'px)', 'important');
        } else {
          root.style.setProperty('transition', 'margin-top 0.2s ease, height 0.2s ease', 'important');
          root.style.setProperty('margin-top', TITLEBAR_HEIGHT + 'px', 'important');
          root.style.setProperty('height', 'calc(100vh - ' + TITLEBAR_HEIGHT + 'px)', 'important');
        }
      }
    }
    function hideBar() {
      if (!barVisible) return;
      barVisible = false;
      host.style.top = '-' + TITLEBAR_HEIGHT + 'px';
      const root = getAppRoot();
      if (root) {
        if (isFixedOrAbsolute(root)) {
          root.style.setProperty('top', '0', 'important');
          root.style.setProperty('height', '100vh', 'important');
          setTimeout(() => {
            root.style.removeProperty('top');
            root.style.removeProperty('height');
            root.style.removeProperty('transition');
          }, 200);
        } else {
          root.style.setProperty('margin-top', '0', 'important');
          root.style.setProperty('height', '100vh', 'important');
          setTimeout(() => {
            root.style.removeProperty('margin-top');
            root.style.removeProperty('height');
            root.style.removeProperty('transition');
          }, 200);
        }
      }
    }
    function scheduleHide() {
      if (hideTimeout) return;
      hideTimeout = setTimeout(() => { hideTimeout = null; hideBar(); }, 3000);
    }

    document.addEventListener('mousemove', (e) => {
      const trigger = barVisible ? TITLEBAR_HEIGHT : 5;
      if (e.clientY <= trigger) {
        showBar();
      } else if (barVisible) {
        scheduleHide();
      }
    });

    // Hide bar when mouse leaves the window
    document.addEventListener('mouseleave', scheduleHide);

    // Expose hideBar so the titlebar_config handler can dismiss it
    window.__loftHideBar = hideBar;
  }

  function initTitleBar() {
    if (document.body) {
      createLoftTitleBar();
    } else {
      setTimeout(initTitleBar, 100);
    }
  }
  initTitleBar();

  const SERVICE_DISPLAY_NAMES = {
    whatsapp: "WhatsApp",
    messenger: "Messenger",
    slack: "Slack",
    telegram: "Telegram",
  };

  // First-run speech bubble
  function showFirstRunBubble() {
    if (!chrome.storage) return;
    const storageKey = "loftFirstRunDismissed_" + service;
    chrome.storage.local.get(storageKey, (data) => {
      if (data[storageKey]) return;

      const displayName = SERVICE_DISPLAY_NAMES[service] || service;

      const bubble = document.createElement("div");
      bubble.id = "loft-first-run-bubble";
      bubble.style.cssText = [
        "position: fixed",
        "top: 40px",
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
        "Use the \u25B2 button or tray icon to hide " +
        displayName +
        ". Clicking Close (\u00d7) resets your window.";

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

  // Badge extraction — both apps use DOM scraping, not the page title.
  let lastBadgeCount = 0;

  // WhatsApp: scan for elements with aria-label like "N unread message(s)"
  if (service === "whatsapp") {
    function scanWhatsAppUnreads() {
      let count = 0;
      const el = document.querySelector('[aria-label*="unread message"]');
      if (el) {
        const match = el.getAttribute('aria-label').match(/^(\d+) unread message/);
        if (match) count = parseInt(match[1], 10);
      }
      if (count !== lastBadgeCount) {
        lastBadgeCount = count;
        safeSendMessage({ type: "badge_update", count });
      }
    }

    // Observe DOM mutations in the conversation list area
    const waObserver = new MutationObserver(scanWhatsAppUnreads);
    waObserver.observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });

    setInterval(scanWhatsAppUnreads, 2000);
    setTimeout(scanWhatsAppUnreads, 3000);
  }

  // Slack: count sidebar items with unread dots (p-unread-dot class)
  // Slack: hide "download app" banner
  if (service === "slack") {
    if (!document.getElementById('loft-slack-fix')) {
      const style = document.createElement('style');
      style.id = 'loft-slack-fix';
      style.textContent = '[data-qa="workspace-banner-download-app"] { display: none !important; }';
      document.head.appendChild(style);
    }
  }

  if (service === "slack") {
    function scanSlackUnreads() {
      const count = document.querySelectorAll('.p-channel_sidebar__channel--unread').length;
      if (count !== lastBadgeCount) {
        lastBadgeCount = count;
        safeSendMessage({ type: "badge_update", count });
      }
    }

    const slackObserver = new MutationObserver(scanSlackUnreads);
    slackObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
    });
    setInterval(scanSlackUnreads, 2000);
    setTimeout(scanSlackUnreads, 3000);
  }

  // Telegram: count sidebar badges (unread conversation indicators)
  if (service === "telegram") {
    function scanTelegramUnreads() {
      let count = 0;
      for (const el of document.querySelectorAll('.chat-badge-transition')) {
        // Skip action buttons (e.g. "Open" for bots) — only count numeric badges
        if (/^\d+$/.test(el.textContent.trim())) count++;
      }
      if (count !== lastBadgeCount) {
        lastBadgeCount = count;
        safeSendMessage({ type: "badge_update", count });
      }
    }

    const tgObserver = new MutationObserver(scanTelegramUnreads);
    tgObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
    });
    setInterval(scanTelegramUnreads, 2000);
    setTimeout(scanTelegramUnreads, 3000);
  }

  // Messenger: badge count is handled by scanForUnreadMessages() below.

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
        style.textContent = '* { --header-height: 0px !important; } [role="dialog"], [role="dialog"] * { --header-height: 56px !important; }';
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
    // Suppress notifications during a startup grace period.  Messenger's
    // React UI re-renders conversation elements multiple times during load,
    // creating "new" hrefs that a simple first-scan boolean would miss.
    // A time-based window catches all of these initial renders.
    const loadTime = Date.now();
    const STARTUP_GRACE_MS = 15000;

    /**
     * Get a lightweight fingerprint of a conversation's latest message.
     * Returns the first two substantial text nodes after the "Unread message:"
     * marker (typically sender name + message preview), joined with "|".
     * When a new message arrives, the preview changes, producing a different
     * fingerprint — which lets the scanner detect it as a new event.
     */
    function getConversationFingerprint(anchor) {
      const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT, null);
      let foundMarker = false;
      let textNode;
      const parts = [];
      while ((textNode = walker.nextNode())) {
        if (foundMarker) {
          const text = textNode.textContent.trim();
          if (text && text.length > 1 && !/^\d+[hms]$/.test(text) && text !== "·" && !/^Active\b/.test(text)) {
            parts.push(text);
            if (parts.length >= 2) break;
          }
        }
        if (textNode.textContent.trim() === "Unread message:") {
          foundMarker = true;
        }
      }
      return parts.join("|");
    }

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

        // Muted conversations are excluded entirely — no badge count,
        // no notifications.  Messenger marks them with an SVG using
        // the --disabled-icon CSS variable.
        if (anchor.querySelector('[style*="--disabled-icon"]')) continue;

        currentlyUnread.add(href);

        // Compare fingerprint (sender + preview) to detect new messages
        // in an already-unread conversation, not just new conversations.
        const fingerprint = getConversationFingerprint(anchor);
        if (notifiedConversations.get(href) === fingerprint) continue;

        // Don't fire notifications during startup grace period
        if (Date.now() - loadTime < STARTUP_GRACE_MS) {
          notifiedConversations.set(href, fingerprint);
          continue;
        }

        // When DND is active, mark conversations as handled (so they don't
        // re-trigger when DND is turned off) but don't send the notification.
        if (messengerDnd) {
          notifiedConversations.set(href, fingerprint);
          continue;
        }

        notifiedConversations.set(href, fingerprint);

        const notification = extractConversationData(anchor, href);
        if (notification) {
          safeSendMessage(notification);
        }
      }

      // Remove conversations that are no longer unread so we
      // re-notify if they become unread again later
      for (const [href] of notifiedConversations) {
        if (!currentlyUnread.has(href)) {
          notifiedConversations.delete(href);
        }
      }

      // Update badge count from DOM-verified unread conversations
      const unreadCount = currentlyUnread.size;
      if (unreadCount !== lastBadgeCount) {
        lastBadgeCount = unreadCount;
        safeSendMessage({
          type: "badge_update",
          count: unreadCount,
        });
      }
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
          !text.match(/^Active\b/) &&    // skip online status ("Active Now", "Active 2h ago")
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
        // Initial scans — retry a few times to catch slow page loads
        setTimeout(scanForUnreadMessages, 3000);
        setTimeout(scanForUnreadMessages, 8000);
        setTimeout(scanForUnreadMessages, 15000);
        // Periodic fallback scan (catches cases where MutationObserver misses a change)
        setInterval(scanForUnreadMessages, 10000);
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

  // ================================================================
  // External link interception — open in default browser via daemon
  // ================================================================
  const SERVICE_DOMAINS = {
    whatsapp: ["web.whatsapp.com"],
    messenger: ["facebook.com", "www.facebook.com"],
    slack: ["app.slack.com", "slack.com"],
    telegram: ["web.telegram.org", "telegram.org"],
  };

  const allowedDomains = SERVICE_DOMAINS[service] || [];

  function isInternalUrl(href) {
    try {
      const linkUrl = new URL(href, window.location.origin);
      // Same-page anchors and javascript: are always internal
      if (linkUrl.protocol === "javascript:" || linkUrl.protocol === "blob:") return true;
      if (linkUrl.origin === window.location.origin) return true;
      return allowedDomains.some((d) => linkUrl.hostname === d || linkUrl.hostname.endsWith("." + d));
    } catch {
      return true; // Malformed URL — don't intercept
    }
  }

  document.addEventListener("click", (e) => {
    // Walk up from the click target to find the nearest <a>
    const anchor = e.target.closest("a[href]");
    if (!anchor) return;
    const href = anchor.href;
    if (!href) return;
    if (isInternalUrl(href)) return;

    e.preventDefault();
    e.stopPropagation();
    safeSendMessage({ type: "open_url", url: href });
  }, true);

  // Slack avatar cache: maps display name → avatar URL.
  // Built up over time by scanning rendered messages so avatars are available
  // even when the notification's channel isn't the active view.
  const slackAvatarCache = new Map();

  function scanSlackAvatars() {
    if (service !== "slack") return;
    const msgs = document.querySelectorAll('[data-msg-ts]');
    for (const msg of msgs) {
      const nameBtn = msg.querySelector('[data-qa="message_sender_name"]');
      if (!nameBtn) continue;
      const name = nameBtn.textContent.trim();
      if (!name || slackAvatarCache.has(name)) continue;
      const img = msg.querySelector('.c-base_icon__width_only_container img[src*="slack-edge"]');
      if (img && img.src.startsWith("https://")) {
        slackAvatarCache.set(name, img.src.replace(/-\d+$/, '-128'));
      }
    }
  }

  if (service === "slack") {
    // Scan on DOM changes to populate cache as user browses channels
    const avatarObserver = new MutationObserver(scanSlackAvatars);
    avatarObserver.observe(document.body, { childList: true, subtree: true });
    setTimeout(scanSlackAvatars, 3000);
  }

  // Slack avatar lookup: find the sender's profile picture URL.
  // Tries: (1) exact message element via tag, (2) avatar cache, (3) sidebar.
  function findSlackAvatar(title, tag) {
    if (service !== "slack") return "";

    // Precise lookup via message timestamp (tag = "tag_<ts>")
    if (tag) {
      const ts = tag.replace(/^tag_/, "");
      const msgEl = document.querySelector('[data-msg-ts="' + ts + '"]');
      if (msgEl) {
        const img = msgEl.querySelector('.c-base_icon__width_only_container img[src*="slack-edge"]');
        if (img && img.src.startsWith("https://")) {
          return img.src.replace(/-\d+$/, '-128');
        }
      }
    }

    // Extract sender name from notification body or title
    let senderName = "";
    // Channel notifications: body is "Keith: message text"
    // DM notifications: title is "New message from Keith"
    if (title) {
      const fromMatch = title.match(/^New message from (.+)$/);
      if (fromMatch) senderName = fromMatch[1].trim();
    }

    // Cache lookup
    if (senderName && slackAvatarCache.has(senderName)) {
      return slackAvatarCache.get(senderName);
    }

    // Fallback: search sidebar for sender name (DMs)
    if (senderName) {
      const channels = document.querySelectorAll(
        '.p-channel_sidebar__channel--unread'
      );
      for (const ch of channels) {
        const nameSpan = ch.querySelector('.p-channel_sidebar__name > span:first-child');
        if (!nameSpan || nameSpan.textContent.trim() !== senderName) continue;
        const img = ch.querySelector('.c-base_icon__width_only_container img[src*="slack-edge"]');
        if (img && img.src.startsWith("https://")) {
          return img.src.replace(/-\d+$/, '-128');
        }
      }
    }
    return "";
  }

  // Relay messages from MAIN world to background script
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.__loft_notification) {
      let icon = event.data.icon;
      // For Slack, the native Notification API doesn't include an icon.
      // Look up the sender's avatar from the message DOM or sidebar.
      if (!icon && service === "slack") {
        icon = findSlackAvatar(event.data.title, event.data.tag);
        // For channel notifications, try extracting sender from body ("Keith: msg")
        if (!icon && event.data.body) {
          const colonIdx = event.data.body.indexOf(": ");
          if (colonIdx > 0) {
            const sender = event.data.body.substring(0, colonIdx);
            if (slackAvatarCache.has(sender)) {
              icon = slackAvatarCache.get(sender);
            }
          }
        }
      }
      safeSendMessage({
        type: "notification",
        title: event.data.title,
        body: event.data.body,
        icon: icon,
      });
    }
    // Relay window.open() interceptions from notification-override.js
    if (event.data && event.data.__loft_open_url) {
      safeSendMessage({ type: "open_url", url: event.data.url });
    }
  });

  // Protect against accidental window close (e.g. muscle memory).
  // Shows Chrome's native "Leave site?" confirmation dialog.
  // For Slack, only block once the user is in an active workspace (URL contains
  // /client/T...) — the sign-in flow needs to navigate away freely.
  let slackSignedIn = service === "slack"
    ? /\/client\/T/.test(window.location.pathname)
    : false;

  window.addEventListener("beforeunload", (event) => {
    if (service === "slack" && !slackSignedIn) return;
    event.preventDefault();
  });

  if (service === "slack" && !slackSignedIn) {
    // Watch for navigation into a workspace (SPA routing updates the URL)
    const navObserver = new MutationObserver(() => {
      if (/\/client\/T/.test(window.location.pathname)) {
        slackSignedIn = true;
        navObserver.disconnect();
      }
    });
    navObserver.observe(document.body, { childList: true, subtree: true });
  }

  // Listen for daemon messages (e.g., DND changes, titlebar config)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "dnd_changed") {
      console.log("Loft: DND changed to", msg.enabled);
      // Update Messenger DND tracking so scanForUnreadMessages() knows
      // whether to suppress notifications for new unread conversations.
      if (service === "messenger") {
        messengerDnd = !!msg.enabled;
      }
      // Relay to MAIN world so notification-override.js can suppress notifications
      window.postMessage({ __loft_dnd: !!msg.enabled }, "*");
    }
    if (msg.type === "titlebar_config") {
      titlebarEnabled = !!msg.show;
      console.log("Loft: Titlebar enabled:", titlebarEnabled);
      if (!titlebarEnabled && window.__loftHideBar) {
        window.__loftHideBar();
      }
    }
  });
})();
