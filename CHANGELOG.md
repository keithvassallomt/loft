# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-04-08

### Added

- Loft now reports a status (e.g. `WhatsApp: 4 unread`, `7 unread (WhatsApp 4, Slack 3)`, or `2 services running`) to the GNOME Background Apps list via the `org.freedesktop.portal.Background` portal. Under Flatpak the status is aggregated across all running services (single "Loft" entry). Under native installs each service reports its own badge on its own entry.

### Changed

- Notifications are now suppressed only when the service window has input focus, not merely when it is visible. A visible-but-unfocused window (e.g. behind another app) will still receive desktop notifications.

## [0.1.0] - 2026-04-04

Initial release.

[0.1.1]: https://github.com/keithvassallomt/loft/releases/tag/v0.1.1
[0.1.0]: https://github.com/keithvassallomt/loft/releases/tag/v0.1.0
