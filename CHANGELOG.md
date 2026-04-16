# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2026-04-16

### Fixed

- Native messaging no longer silently fails when both Loft and Chrome are Flatpak installs. The NM wrapper script now detects when it's running inside a sandbox (via `/.flatpak-info`) and uses `flatpak-spawn --host` to escape — without this, the `flatpak` command isn't available inside Chrome's sandbox and the titlebar Hide button, DOM-based notifications, and other extension-to-daemon messaging all fail silently.
- The combined tray panel icon now appears reliably at login. When multiple services autostart simultaneously, they all used to race to spawn `loft --tray` and multiple tray processes would briefly run — with orphans unregistering the panel icon a few seconds later. The singleton check now uses D-Bus `DoNotQueue` so only one instance ever owns the name.
- Showing a hidden service from a different workspace now pulls the window onto your current workspace, instead of triggering GNOME's focus-stealing-prevention and showing an "X is ready" notification that jumps you to the old workspace when clicked.
- The GNOME dock now shows one icon per service (Messenger, WhatsApp, Slack, Telegram) instead of a single Chrome icon for all of them, when Chrome is installed as a Flatpak. Chrome Flatpak on Wayland identifies every window as `com.google.Chrome` regardless of `--app=`, so GNOME would group them all under Chrome's icon. The shell extension now re-maps these windows to their per-service `.desktop` file and also hides the Chrome app from the dock when its only open windows are Loft's. Added `StartupWMClass` to Loft's generated Chrome `.desktop` files so that native matching also works.
- Messenger desktop notifications now include inline emoji in the message body. Messenger renders custom emoji as `<img>` elements interleaved with text, and the previous extractor took only the first text node and stopped — so any emoji after the first word was silently dropped.
- The Loft titlebar no longer stutters on Telegram when it slides in or out. Animating the app root's height triggered a full re-layout of Telegram's virtualised chat list on each frame; the titlebar now overlays the top 36px of the Telegram window during hover instead of reflowing the whole app.
- Clicking a link to `facebook.com` inside a Messenger conversation (a profile, post, photo, etc.) now opens it in your default browser instead of replacing the Messenger page. Previously the same-origin link was treated as internal navigation; Messenger is now scoped to `/messages/*` so anything else on Facebook is external.

## [0.1.1] - 2026-04-08

### Added

- Loft now reports a status (e.g. `WhatsApp: 4 unread`, `7 unread (WhatsApp 4, Slack 3)`, or `2 services running`) to the GNOME Background Apps list via the `org.freedesktop.portal.Background` portal. Under Flatpak the status is aggregated across all running services (single "Loft" entry). Under native installs each service reports its own badge on its own entry.

### Changed

- Notifications are now suppressed only when the service window has input focus, not merely when it is visible. A visible-but-unfocused window (e.g. behind another app) will still receive desktop notifications.

## [0.1.0] - 2026-04-04

Initial release.

[0.1.1]: https://github.com/keithvassallomt/loft/releases/tag/v0.1.1
[0.1.0]: https://github.com/keithvassallomt/loft/releases/tag/v0.1.0
