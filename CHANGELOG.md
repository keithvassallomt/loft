# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Logging out no longer leaves an "Electron crashed" report waiting at your next login.** Loft now registers with GNOME as a session client and quits cleanly when the session ends. Previously it was only told to quit at the same instant its sandbox lost its connection to the desktop's message bus, and it aborted instead of exiting — harmless to your accounts and settings, but it filed a crash report on every single logout.
- Window sizes and positions are now saved as you move and resize, rather than when Loft exits, so they survive the app being closed abruptly.
- The Flatpak build submitted to FriendlyHub now builds there. The 1.0.0 submission failed because the manifest referenced the source in a way that only works from a full checkout, which their builder doesn't have.

### Changed

- Tightened the Flatpak sandbox: Loft no longer claims a wildcard of D-Bus names, only the one it actually uses, and drops two permissions the sandbox grants every app anyway.
- The Flatpak build moved to the 25.08 freedesktop runtime, so it keeps receiving system library and security updates.

## [1.0.0] - 2026-07-25

> [!IMPORTANT]
> Version 1.0.0 of Loft isn't an update, it's a **total re-write!** The bad news is that you'll have to login again to your services. The good news is:
> - You get a fantastic unified view.
> - You get proper titlebars, no longer needing to hover and wait to hide services.
> - You get great new (entirely optional!) features like grid view, logging into multiple accounts, and more control over auto-open modes.
> - You no longer need to have Google Chrome installed.
> - Rich notifications, video and voice call support, and everything that made Loft great to
> start with still work, of course.

### Added

- Unified view: every service now lives in a single Loft window with a sidebar rail of service icons, instead of opening a separate window for each one. Click an icon in the rail to switch to that service full-size; each has its own titlebar showing its name and unread count, with zoom controls and a close button that hides it to the tray while it keeps running in the background. Drag the rail icons to reorder them. Prefer a service in its own window? Turn on **Open in its own window** in its settings and Loft remembers the choice. Moving a service between the shared window, its own window, and the grid keeps its page live, so scroll position, half-typed drafts, and ongoing calls (including video and screen-share) all survive the move.
- Grid view: a new **Grid** entry at the top of the service rail tiles several services on screen at once, so you can watch WhatsApp, Slack and Telegram together instead of switching between them. Add a service to the grid by dragging its rail icon into the grid, or from the ＋ menu in the titlebar; drop it against a cell's edge to choose which half it takes. Drag the dividers to resize, drag a cell by the handle in its header to move it, and remove one with its ✕ — the service keeps running and stays in the rail either way. The arrangement is remembered across restarts. Clicking a service in the rail still opens it full-size; the grid keeps its layout and comes back when you select it again. Calls, including video and screen-share, survive being tiled, resized and moved.
- Multiple accounts: Loft can now hold more than one account of the same service — two WhatsApps, two Slacks, two NextCloud Talk servers — each with its own login, badges, and notifications. Add another from the **Add another** gallery in the manager. Give each account its own name and icon (a brand icon, a set of pastel colour variants, or a custom image file) so they're easy to tell apart in the rail, the tray, and the window titlebar.
- Developer mode: a new toggle in **Settings** enables a developer context menu for troubleshooting a service's web page. With it on, **Shift+right-click** inside a service opens a Chromium menu with Inspect Element, DevTools, Reload and back/forward — while a plain right-click still uses the web app's own menu. Off by default.
- Auto Open modes: each service's per-service settings now offer a three-way **Auto Open** choice instead of a single "open on startup" checkbox — **Disabled**, **On login** (runs in the background from login, starting Loft automatically), or **On launching Loft** (loads only when you actually open Loft, not at login). Existing "open on startup" services become **On login**, so nothing changes unless you want it to.

### Changed

- Loft is now a single self-contained application and no longer launches or depends on a separate Google Chrome installation. Voice and video calling, tray icons, badges, notifications, and close-to-tray all work as before, with improved GNOME and KDE Plasma integration.
- The GNOME Shell helper is now installed from extensions.gnome.org on request (Loft asks first) instead of being bundled, so it updates independently of the app and no longer requires logging out to finish an update.

### Note

- **You'll need to sign in to each service again after upgrading.** Logins were previously stored in Chrome's profile; Loft now keeps its own per-service sessions.
- **For packagers/GNOME users**: renaming an account now works correctly on the GNOME panel (rather than losing or duplicating its row) only once the Shell helper is updated to the version that ships alongside this release.

## [0.2.0] - 2026-06-15

### Added

- The service manager now shows whether each installed service is running, along with its unread message count, and keeps this up to date live while the window is open.

### Changed

- The service manager has been redesigned to be cleaner and less cluttered, and to stay that way as more services are added. Your installed services and the ones available to add now appear in separate sections; each installed service has its own **Open** and settings buttons (clicking the row no longer opens settings), available services are shown as a grid of tiles, and the window sizes itself to fit its contents.

### Fixed

- Showing a service from the GNOME activities overview (via its panel/tray icon) now takes you straight to the window. Previously the overview stayed open with the window invisible until you manually left it.
- Loft services now keep their place in the GNOME Alt+Tab switcher. A service you just switched to now appears at the front of the list (most recently used) instead of being pushed to the end, and the switcher reliably highlights the next app on the following Alt+Tab.

## [0.1.4] - 2026-06-02

### Added

- Element (Matrix) is now a supported service, with unread badges and Do Not Disturb support. Self-hosted Element Web instances work via a custom server URL in the service's settings.
- NextCloud Talk is now a supported service. It's always self-hosted, so set your instance's URL in the service's settings. Includes unread badges and notifications with sender avatars.
- Loft now prompts you to log out and back in when it updates its bundled GNOME Shell helper, since GNOME only loads new extension code at session start.

### Fixed

- Services set to start hidden no longer leave ghost windows in the GNOME activities overview after login.

## [0.1.3] - 2026-05-12

### Fixed

- SNI tray icons now appear when Loft is installed as a Flatpak. The sandbox's D-Bus proxy refused ksni's standard `org.kde.StatusNotifierItem-<pid>-<N>` bus name (only `chat.loft.*` is permitted by the manifest), so the tray never registered with `org.kde.StatusNotifierWatcher`. Loft now uses ksni's `disable_dbus_name` workaround when running under Flatpak, registering via its unique connection name instead.

## [0.1.2] - 2026-04-16

### Fixed

- The panel/tray icon now reliably shows up at login when you have multiple services set to autostart.
- Hide-to-tray from the Loft titlebar now works when Loft and Chrome are both installed as Flatpaks.
- Clicking a service from a different workspace brings its window to you, instead of showing a "X is ready" notification and throwing you back to the workspace the window was on.
- The dock now shows a proper icon for each service (Messenger, WhatsApp, Slack, Telegram) instead of lumping them all under a single Chrome icon. Alt-tabbing to a service also correctly raises its window.
- Messenger notifications now include emoji that were part of the message (previously, anything after the first word, if it contained an emoji, was dropped from the notification body).
- The Loft titlebar slides in smoothly on Telegram instead of stuttering.
- Links to Facebook itself (profiles, posts, photos…) inside a Messenger conversation now open in your default browser instead of replacing the conversation window.
- Logging out with Loft services running no longer produces "Chrome has crashed" notifications on your next login. Loft now registers with GNOME's session manager and shuts Chrome down cleanly before the Wayland session tears down.

## [0.1.1] - 2026-04-08

### Added

- Loft now reports a status (e.g. `WhatsApp: 4 unread`, `7 unread (WhatsApp 4, Slack 3)`, or `2 services running`) to the GNOME Background Apps list via the `org.freedesktop.portal.Background` portal. Under Flatpak the status is aggregated across all running services (single "Loft" entry). Under native installs each service reports its own badge on its own entry.

### Changed

- Notifications are now suppressed only when the service window has input focus, not merely when it is visible. A visible-but-unfocused window (e.g. behind another app) will still receive desktop notifications.

## [0.1.0] - 2026-04-04

Initial release.