# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.1]: https://github.com/keithvassallomt/loft/releases/tag/v0.1.1
[0.1.0]: https://github.com/keithvassallomt/loft/releases/tag/v0.1.0
