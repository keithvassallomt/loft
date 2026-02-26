# Loft

Linux desktop integration layer for Meta web apps (WhatsApp, Facebook Messenger) that provides full functionality including voice/video calling, system tray integration, and proper desktop presence.

## Why Loft?

Meta doesn't provide desktop apps on Linux for Messenger or WhatsApp. Existing workarounds fall short:

- **Electron wrappers** (third-party apps): No voice/video calling due to WebRTC issues with Electron's custom Chromium build.
- **PWAs from Chrome**: Full functionality works, but no tray icon and poor system integration.

Loft uses **real Google Chrome** in `--app=` mode with a companion extension and a Rust daemon for system integration. This gives you a chromeless window with full WebRTC/codec support while the daemon provides desktop integration Chrome alone cannot.

## Features

- Voice and video calling (uses Chrome's native WebRTC)
- System tray icon with unread badge count
- Close-to-tray (window hides, daemon stays alive)
- Do Not Disturb mode per service
- Autostart at login (via XDG autostart or Flatpak portal)
- Separate Chrome profile per service (no interference with your main browser)
- Proper `.desktop` entries with app icons

## Supported Services

| Service            | URL                          |
|--------------------|------------------------------|
| WhatsApp           | https://web.whatsapp.com/    |
| Facebook Messenger | https://www.messenger.com/   |

## Requirements

- Linux with a desktop environment supporting SNI tray icons (GNOME, KDE, etc.)
- Google Chrome (proprietary codecs required for video calling)

## Building

```sh
cargo build --release
```

## Usage

```sh
# Launch the manager GUI
./target/release/loft

# Run a service directly
./target/release/loft --service whatsapp
```

## License

This project is licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE) for details.
