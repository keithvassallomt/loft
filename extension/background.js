const NM_HOST_NAME = "chat.loft.host";
let port = null;
let appWindowId = null;
let appUrl = null;
let savedBounds = null;
let offscreenCreated = false;
let lastPolledVisible = null;
let dndEnabled = false;

// Maps chrome.notifications ID → conversation href for click-to-navigate
const notificationHrefs = new Map();

function connectNativeHost() {
  try {
    port = chrome.runtime.connectNative(NM_HOST_NAME);
  } catch (e) {
    console.error("Loft: Failed to connect to native host:", e);
    setTimeout(connectNativeHost, 5000);
    return;
  }

  // Send ready immediately so the NM relay can identify the service and
  // connect to the right daemon socket.  Detect the service from any known
  // app URL (set by detectAppWindow or content script).
  if (appUrl) {
    const svc = detectServiceFromUrl(appUrl);
    if (svc) {
      port.postMessage({ type: "ready", service: svc });
      console.log("Loft: Sent ready for", svc);
    }
  }

  port.onMessage.addListener((msg) => {
    if (msg.type === "hide_window") {
      hideAppWindow();
      return;
    }

    if (msg.type === "show_window") {
      showAppWindow();
      return;
    }

    // Track DND state locally for notification suppression
    if (msg.type === "dnd_changed") {
      dndEnabled = !!msg.enabled;
    }

    // Forward other daemon messages (e.g. dnd_changed) to all Loft tabs
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (isLoftTab(tab.url)) {
          chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
        }
      }
    });
  });

  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    console.log("Loft: Native host disconnected", error ? error.message : "");
    port = null;
    setTimeout(connectNativeHost, 5000);
  });
}

function isLoftTab(url) {
  return (
    url &&
    (url.startsWith("https://web.whatsapp.com") ||
      url.startsWith("https://facebook.com/messages") ||
      url.startsWith("https://www.facebook.com/messages"))
  );
}

function detectServiceFromUrl(url) {
  if (!url) return null;
  if (url.startsWith("https://web.whatsapp.com")) return "whatsapp";
  if (url.startsWith("https://facebook.com/messages") || url.startsWith("https://www.facebook.com/messages")) return "messenger";
  return null;
}

// Save window bounds to storage so they survive Chrome restarts
function saveWindowBounds(win) {
  if (win.state === "normal" && win.width > 0) {
    savedBounds = { left: win.left, top: win.top, width: win.width, height: win.height };
    chrome.storage.local.set({ loftWindowBounds: savedBounds });
  }
}

// Track the app window ID from any existing windows on startup
async function detectAppWindow() {
  // Restore saved bounds from storage
  try {
    const data = await chrome.storage.local.get("loftWindowBounds");
    if (data.loftWindowBounds) {
      savedBounds = data.loftWindowBounds;
    }
  } catch (e) {
    // ignore
  }

  const windows = await chrome.windows.getAll({ populate: true });
  for (const win of windows) {
    if (win.tabs && win.tabs.some((tab) => isLoftTab(tab.url))) {
      appWindowId = win.id;
      // Restore saved bounds to the existing window (--app= creates it at default size)
      if (savedBounds) {
        chrome.windows.update(win.id, savedBounds, () => {
          if (chrome.runtime.lastError) {
            console.warn("Loft: Failed to restore window bounds:", chrome.runtime.lastError.message);
          } else {
            console.log("Loft: Restored window bounds", savedBounds);
          }
        });
      } else {
        saveWindowBounds(win);
      }
      // Remember the app URL from the tab
      const loftTab = win.tabs.find((tab) => isLoftTab(tab.url));
      if (loftTab) {
        appUrl = loftTab.url;
      }
      break;
    }
  }
}

function hideAppWindow() {
  if (appWindowId != null) {
    chrome.windows.update(appWindowId, { state: "minimized" }, () => {
      if (chrome.runtime.lastError) {
        console.warn("Loft: Failed to minimize window:", chrome.runtime.lastError.message);
      } else {
        console.log("Loft: Window minimized");
        if (port) {
          port.postMessage({ type: "window_hidden" });
        }
      }
    });
  }
}

function showAppWindow() {
  if (appWindowId != null) {
    chrome.windows.update(appWindowId, { state: "normal", focused: true }, () => {
      if (chrome.runtime.lastError) {
        console.warn("Loft: Failed to show window:", chrome.runtime.lastError.message);
        // Window may have been destroyed, try creating a new one
        appWindowId = null;
        createAppWindow();
      } else {
        console.log("Loft: Window restored and focused");
        if (port) {
          port.postMessage({ type: "window_shown" });
        }
      }
    });
  } else {
    // No window tracked — create a new one
    createAppWindow();
  }
}

// Create a new popup window for the app, restoring saved bounds if available
async function createAppWindow() {
  if (!appUrl) {
    console.warn("Loft: No app URL known, cannot create window");
    return;
  }
  try {
    const opts = { url: appUrl, type: "popup", focused: true };
    if (savedBounds) {
      Object.assign(opts, savedBounds);
    }
    const win = await chrome.windows.create(opts);
    appWindowId = win.id;
    console.log("Loft: Created new app window", win.id);
  } catch (e) {
    console.error("Loft: Failed to create app window:", e);
  }
}

// Track window position/size changes
chrome.windows.onBoundsChanged.addListener((win) => {
  if (win.id === appWindowId) {
    saveWindowBounds(win);
  }
});

// Detect when the app window gains focus (e.g. user restored from alt-tab)
// so the daemon can update its visible state and tray menu label.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === appWindowId) {
    if (port) {
      port.postMessage({ type: "window_shown" });
      console.log("Loft: Sent window_shown to daemon (window focused)");
    }
  }
});

// When the app window is closed, notify the daemon so tray state updates.
// The offscreen document keeps Chrome alive without a visible window.
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== appWindowId) return;

  appWindowId = null;
  console.log("Loft: App window closed");

  // Ensure offscreen document exists to keep Chrome alive
  ensureOffscreen();

  // Notify daemon that window was hidden (so tray state updates).
  if (!port) {
    connectNativeHost();
  }
  if (port) {
    port.postMessage({ type: "window_hidden" });
    console.log("Loft: Sent window_hidden to daemon");
  } else {
    console.warn("Loft: Could not send window_hidden — no NM connection");
  }
});

// Listen for messages from content scripts and forward to native host
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Track the window ID from the content script's tab
  if (sender.tab && sender.tab.windowId != null) {
    appWindowId = sender.tab.windowId;
  }

  // Remember the app URL from the content script
  if (sender.tab && sender.tab.url && isLoftTab(sender.tab.url)) {
    appUrl = sender.tab.url;
  }

  // Handle Messenger DOM notifications locally (don't forward to daemon)
  if (msg.type === "dom_notification") {
    if (!dndEnabled) {
      const notifId = msg.href || ("msg-" + Date.now());
      const opts = {
        type: "basic",
        title: msg.sender || "Messenger",
        message: msg.body || "",
        iconUrl: (msg.icon && msg.icon.startsWith("http")) ? msg.icon : "icons/icon128.png",
      };
      chrome.notifications.create(notifId, opts, () => {
        if (chrome.runtime.lastError) {
          console.warn("Loft: Failed to create notification:", chrome.runtime.lastError.message);
        }
      });
      notificationHrefs.set(notifId, msg.href);
    }
    return false;
  }

  if (port) {
    port.postMessage(msg);
  }
  return false;
});

// Handle notification clicks: focus window and navigate to conversation
chrome.notifications.onClicked.addListener((notificationId) => {
  const href = notificationHrefs.get(notificationId);
  notificationHrefs.delete(notificationId);
  chrome.notifications.clear(notificationId);

  showAppWindow();

  if (href) {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.url && (tab.url.startsWith("https://facebook.com/messages") ||
            tab.url.startsWith("https://www.facebook.com/messages"))) {
          chrome.tabs.sendMessage(tab.id, { type: "navigate_to_conversation", url: href }).catch(() => {});
        }
      }
    });
  }
});

// Clean up notification tracking when notifications are closed
chrome.notifications.onClosed.addListener((notificationId) => {
  notificationHrefs.delete(notificationId);
});

// Create an offscreen document to keep Chrome alive when the app window is
// closed.  Unlike a minimized window, an offscreen document is invisible —
// it does not appear in alt-tab or the taskbar.
async function ensureOffscreen() {
  if (offscreenCreated) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["LOCAL_STORAGE"],
      justification: "Keep Chrome process alive while app window is closed",
    });
    offscreenCreated = true;
    console.log("Loft: Offscreen document created");
  } catch (e) {
    // "Only a single offscreen document may be created" — already exists
    if (e.message && e.message.includes("single offscreen")) {
      offscreenCreated = true;
    } else {
      console.error("Loft: Failed to create offscreen document:", e);
    }
  }
}

// Poll window state to detect external visibility changes (e.g. alt-tab
// restore on Linux where onFocusChanged may not fire reliably).
setInterval(async () => {
  if (appWindowId == null || !port) return;
  try {
    const win = await chrome.windows.get(appWindowId);
    const isVisible = win.state !== "minimized";
    if (isVisible !== lastPolledVisible) {
      lastPolledVisible = isVisible;
      port.postMessage({ type: isVisible ? "window_shown" : "window_hidden" });
    }
  } catch (e) {
    // Window no longer exists — onRemoved handler will clean up
  }
}, 500);

// When the extension is loaded via CDP into an already-open tab, the content
// scripts don't get injected automatically.  Re-inject them programmatically
// so notifications, badge extraction, etc. work without a manual page reload.
async function injectContentScripts() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!isLoftTab(tab.url)) continue;
    try {
      // Inject the MAIN-world notification override first
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["notification-override.js"],
        world: "MAIN",
      });
      // Then inject the ISOLATED-world content script
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      console.log("Loft: Injected content scripts into tab", tab.id);
    } catch (e) {
      console.warn("Loft: Failed to inject into tab", tab.id, e);
    }
  }
}

// Connect on startup — detect the app window first so appUrl is set
// before the NM host connection sends the ready message.
detectAppWindow().then(() => {
  connectNativeHost();
  ensureOffscreen();
  injectContentScripts();
});
