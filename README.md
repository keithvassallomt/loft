<p align="center">
  <img src="assets/icons/loft.svg" alt="Loft" width="128">
</p>

# Loft

Desktop integration for messaging apps on Linux.

Loft provides full desktop integration for WhatsApp, Facebook Messenger, Slack and Telegram on Linux, including voice and video calling, system tray icons, badge counts, and close-to-tray behavior.

Unlike Electron wrappers, Loft uses your real Google Chrome installation for full WebRTC and codec support, while a Rust daemon provides system integration that Chrome alone cannot.

## Features

- Voice and video calling (uses Chrome's native WebRTC)
- System tray icons with unread badge counts (SNI and GNOME panel)
- Close-to-tray (window hides, daemon stays alive)
- Do Not Disturb mode per service
- Desktop notifications with app icons
- Combined tray icon mode (merge all services into one icon)
- Autostart at login with optional start-minimized
- Separate Chrome profile per service
- GNOME Shell integration (focus/hide bypasses focus-stealing prevention, hides minimized windows from alt-tab/overview/dock)
- Zoom controls and custom titlebar

## Supported Services

| Service            | URL                            |
|--------------------|--------------------------------|
| WhatsApp           | https://web.whatsapp.com/      |
| Facebook Messenger | https://facebook.com/messages/ |
| Slack              | https://app.slack.com/client/  |
| Telegram           | https://web.telegram.org/a/    |

## Requirements

- Linux with a desktop environment supporting SNI tray icons (GNOME, KDE Plasma, etc.)
- Google Chrome (proprietary codecs required for video calling)

## Installation

### Flatpak

```sh
flatpak install chat.loft.Loft
```

Available as a standalone `.flatpak` bundle and on [FriendlyHub](https://friendlyhub.org).

### RPM / DEB / AppImage

Pre-built packages are available on the [releases page](https://github.com/keithvassallomt/loft/releases).

### Building from source

```sh
cargo build --release
```

To build all distribution packages (RPM, DEB, AppImage):

```sh
just build
```

To build a local Flatpak bundle:

```sh
just setup-flatpak  # one-time: install GNOME SDK
just build-flatpak
```

## Usage

```sh
# Launch the manager GUI
loft

# Run a service directly
loft --service whatsapp
loft --service messenger
loft --service slack
loft --service telegram

# Start minimized to tray
loft --service whatsapp --minimized

# Enable verbose logging
loft --service whatsapp -v
```

## How It Works

Loft runs Google Chrome in `--app=` mode with a companion Chrome extension and a per-service Rust daemon:

1. **Loft Manager** -- Adwaita GUI for installing/uninstalling services
2. **Service daemon** (`loft --service <name>`) -- manages Chrome, tray icon, D-Bus interface, and native messaging
3. **Chrome extension** -- extracts badge counts, intercepts notifications, provides custom titlebar, and relays messages to the daemon
4. **GNOME Shell extension** -- bypasses focus-stealing prevention and hides minimized Loft windows from alt-tab, overview, and dock

Each service gets its own Chrome profile, tray icon, `.desktop` entry, and D-Bus interface (`chat.loft.<Service>`).

## License

This project is licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE) for details.
