# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - TEST BUNDLED WITH FLATPAK

### Added

- Element (Matrix) is now a supported service, using `https://app.element.io/`. The tray badge reflects the number of rooms with unread notifications, and notifications respect Do Not Disturb like the other services.
- Element can point at a self-hosted Element Web instance via a custom server URL in the service's settings. Loft templates its extension manifest with the custom origin at deploy time, so badge, notification, and titlebar integration work on any domain without a browser permission prompt.
- NextCloud Talk is now a supported service. Because Talk is always self-hosted, there is no default server — point it at your NextCloud instance via the custom server URL in the service's settings (e.g. `https://cloud.example.com/apps/spreed/`). The tray badge reflects unread conversations, and notifications (including contact avatars) flow through the daemon and respect Do Not Disturb like the other services.
- When Loft installs or updates its bundled GNOME Shell helper (because the installed copy is missing or older than the one shipped — e.g. while an Extensions website update is still pending review), it now prompts you to log out and back in, since GNOME only loads new extension code at session start. The bundled helper is only deployed when it's newer than what's installed, so a more recent build is never downgraded.

### Fixed

- Services set to start hidden no longer leave ghost windows in the GNOME activities overview after login. The overview is open at login while each hidden service's window maps briefly before being minimized; the GNOME helper now keeps a service's window out of the overview until the daemon reports it visible, so start-hidden windows never appear there.

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

[0.1.3]: https://github.com/keithvassallomt/loft/releases/tag/v0.1.3
[0.1.2]: https://github.com/keithvassallomt/loft/releases/tag/v0.1.2
[0.1.1]: https://github.com/keithvassallomt/loft/releases/tag/v0.1.1
[0.1.0]: https://github.com/keithvassallomt/loft/releases/tag/v0.1.0
