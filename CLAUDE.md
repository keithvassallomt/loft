# Loft

Linux desktop integration layer for web apps (WhatsApp, Facebook Messenger, Slack, Telegram, Element, NextCloud Talk) that provides full functionality including voice/video calling, system tray integration, and proper desktop presence.

## Problem

Messaging apps don't provide good desktop apps on Linux. Existing workarounds:

- **Electron wrappers** (e.g. third-party apps): No voice/video calling due to WebRTC issues with Electron's custom Chromium build.
- **PWAs from Chrome**: Full functionality works, but no tray icon and poor system integration.

## Architecture

Loft uses **real Chrome** in `--app=` mode with a companion extension and a Rust daemon for system integration. This gives us a chromeless window with full WebRTC/codec support (Chrome handles it natively) while the daemon provides desktop integration Chrome alone cannot.

There are two layers:

1. **Loft Manager** — minimal Adwaita GUI for installing/uninstalling services
2. **Per-service daemon** — one instance per installed service, each with its own tray icon, Chrome window, and `.desktop` entry

```
loft (manager GUI)
  → Install WhatsApp  → creates .desktop file, registers service
  → Install Messenger → creates .desktop file, registers service

loft-whatsapp.desktop (or user clicks tray icon)
  → loft --service whatsapp
  → daemon instance launches:
      google-chrome
        --user-data-dir=~/.local/share/loft/profiles/whatsapp
        --remote-debugging-pipe   (extension loaded via CDP, see below)
        --app=https://web.whatsapp.com/
  → extension ←→ daemon via native messaging
  → daemon manages: its own SNI tray icon, badge count, show/hide
```

### Components

1. **Loft Manager** — Adwaita GUI (`loft` with no args)
   - Lists available services (WhatsApp, Messenger, Slack, Telegram, Element, NextCloud Talk)
   - Install: creates `.desktop` file, registers autostart, sets up native messaging host
   - Uninstall: removes `.desktop` file, removes autostart, cleans up
   - Minimal UI — just a list of services with install/uninstall controls

2. **Service daemon** (`loft --service <name>`) — one per installed service
   - Spawns/manages its own Chrome process
   - Provides its own SNI tray icon with badge count (via `ksni`)
   - Tray menu controls: show/hide window, do not disturb, quit
   - Communicates with the extension via Chrome native messaging (length-prefixed JSON over stdin/stdout)
   - Show/hide via GNOME Shell extension D-Bus (GNOME), KWin scripting (KDE), or Chrome extension `chrome.windows.update` (other DEs)
   - Sends desktop notifications via `org.freedesktop.Notifications` D-Bus with avatar support and click-to-navigate
   - Exposes D-Bus interface for its service (show/hide, status, notifications)

3. **Chrome extension** (unpacked, shared by all services)
   - Injected into the web app pages
   - Detects which service it's running in from the page URL
   - Extracts badge counts / unread message counts from the DOM
   - Forwards notification metadata to the daemon via native messaging
   - Declares a native messaging host so Chrome connects it to the daemon
   - Messenger: removes Facebook navigation banner, fixes CSS (`--header-height`, `top`, `height`) so content fills viewport
   - Messenger: scrapes DOM for unread conversations and creates `chrome.notifications` (WhatsApp uses Chrome's native notifications)
   - MAIN world script (`notification-override.js`) wraps `Notification` constructor to suppress Messenger notifications (handled via DOM scraping instead) and gate WhatsApp/Slack/Telegram notifications on DND state
   - Custom titlebar with show/hide toggle, close-to-tray button, and zoom controls (+/-)
   - Window bounds persistence via `chrome.storage.local`
   - Zoom level persistence via `chrome.storage.local` (range 0.3–3.0, step 0.1)
   - Offscreen document (`offscreen.html`) to keep the service worker alive

4. **GNOME Shell extension** (`loft-shell-helper@loft.chat`)
   - Deployed to `~/.local/share/gnome-shell/extensions/` during service install
   - D-Bus interface (`chat.loft.ShellHelper`) with methods: `FocusWindow`, `HideWindow`, `RegisterService`, `UnregisterService`, `UpdateBadge`, `UpdateDnd`, `UpdateVisible`, plus combined-icon methods `RegisterCombined`, `UnregisterCombined`, `UpdateCombinedService`, `RemoveCombinedService`
   - Service identity is data-driven: each service's window class and display name come from the daemon's `RegisterService`/`UpdateCombinedService` calls (no hardcoded service lists), and the window class is derived from the effective launch URL so self-hosted instances match too
   - Loft ships this helper; the daemon (re)deploys the bundled copy when it's missing or newer than what's installed (compared via `version-name`, never downgrading a newer EGO build) and prompts the user to log out/in, since GNOME loads new extension JS only at session start
   - Bypasses GNOME's focus-stealing prevention by calling `meta_window.activate()` from inside the compositor
   - Hides minimized Loft windows from alt-tab (patches `AppSwitcherPopup`), overview (patches `Workspace`), and dock/dash (patches `Shell.AppSystem.get_running`)
   - Provides native GNOME panel icons with badge counts, DND state, and show/hide controls as an alternative to SNI tray icons
   - Daemon calls it in parallel with Chrome extension relay — D-Bus is faster, so window is focused before Chrome extension acts

5. **`.desktop` files** — one per installed service (e.g. `loft-whatsapp.desktop`, `loft-messenger.desktop`)
   - Created/removed by the manager during install/uninstall
   - Each launches `loft --service <name>`
   - Icons: embedded SVGs + PNGs, deployed at install time

### Per-Service Tray Icon

Each running service gets its own independent tray icon:

```
[WhatsApp icon (3)]  ← click to focus WhatsApp window
  ├─ Show / Hide
  ├─ Do Not Disturb
  └─ Quit

[Messenger icon (1)] ← click to focus Messenger window
  ├─ Show / Hide
  ├─ Do Not Disturb
  └─ Quit
```

#### Tray backend & combined icon

The tray backend is selected by `tray_backend` in `config.toml` (`auto` |
`gnome-panel` | `sni`; `auto` → GNOME panel icons on GNOME, SNI elsewhere).

Independently, `combine_tray_icons` (default true on GNOME) collapses the
per-service icons above into a single Loft icon whose menu lists every running
service. The combined SNI icon runs in a separate process (`loft --tray`,
`src/combined_tray/`) that owns the `chat.loft.Tray` D-Bus name; each daemon
registers with it. On GNOME the combined icon is instead a single panel button
managed by the shell helper (`RegisterCombined`/`UpdateCombinedService`).

### Window Behavior

- **Close (X button)**: Window hides, daemon + tray icon stay alive. Click tray icon to reopen.
- **Show/Hide**: Tray menu toggle. On GNOME, the daemon calls the GNOME Shell extension via D-Bus (`FocusWindow`/`HideWindow`) which bypasses focus-stealing prevention. On KDE, the daemon uses KWin scripting via D-Bus to focus/hide/skip-taskbar. The Chrome extension relay fires in parallel as a fallback (works on all DEs).
- **Quit**: Tray menu "Quit" kills both daemon and Chrome process.

### Chrome Launch Details

- **Separate profile per service**: `~/.local/share/loft/profiles/<service>/` (e.g. `profiles/whatsapp/`, `profiles/messenger/`)
- Extension loaded at runtime via `--remote-debugging-pipe` + CDP `Extensions.loadUnpacked` (branded Chrome 137+ removed `--load-extension`); the daemon drives the CDP pipe on fds 3/4 (`pre_exec` dup2 in the spawn logic)
- Unpacked-extension loading enabled via `--enable-unsafe-extension-debugging`
- `--app=<url>` for chromeless window
- **Window focus**: On GNOME, the daemon calls the GNOME Shell extension via D-Bus (`chat.loft.ShellHelper.FocusWindow`) which uses `meta_window.activate()` — bypasses focus-stealing prevention. On KDE, the daemon uses KWin scripting via D-Bus (`org.kde.kwin.Scripting`) to find and activate windows by WM class. On other DEs, the Chrome extension handles focus via `chrome.windows.update({focused: true})`.

### Native Messaging Protocol

Communication between the extension and daemon uses Chrome's native messaging format: 4-byte little-endian length prefix followed by a UTF-8 JSON message. Every message has a `type` field.

**Extension → Daemon:**

| Type             | Fields                                           | Description                              |
|------------------|--------------------------------------------------|------------------------------------------|
| `ready`          | `{ type, service: string }`                      | Extension identified which service it's on (from page URL) |
| `badge_update`   | `{ type, count: number }`                        | Unread message count changed             |
| `notification`   | `{ type, title: string, body: string, icon?: string }` | Notification metadata (informational — Chrome shows the actual notification) |
| `dom_notification` | `{ type, sender: string, body: string, icon?: string, href?: string }` | DOM-scraped notification (Messenger/Slack) with conversation link |
| `window_hidden`  | `{ type }`                                       | User closed the window (X button); Chrome still alive in background |
| `window_shown`   | `{ type }`                                       | Window was restored/shown (e.g. via alt-tab) |
| `window_focused` | `{ type }`                                       | Window gained input focus (used to suppress notifications while focused) |
| `window_unfocused` | `{ type }`                                     | Window lost input focus |
| `hide_request`   | `{ type }`                                       | Content script titlebar button requests hide-to-tray |
| `open_url`       | `{ type, url: string }`                          | Content script requests opening a URL in the default browser |

**Daemon → Extension:**

| Type             | Fields                                           | Description                              |
|------------------|--------------------------------------------------|------------------------------------------|
| `dnd_changed`    | `{ type, enabled: boolean }`                     | Do Not Disturb toggled from tray menu    |
| `hide_window`    | `{ type }`                                       | Hide/minimize the Chrome window          |
| `show_window`    | `{ type }`                                       | Show/focus the Chrome window             |
| `titlebar_config`| `{ type, show: boolean }`                        | Toggle titlebar visibility               |
| `navigate_to_conversation` | `{ type, url: string }`                | Navigate to a specific conversation (on notification click) |
| `ping`           | `{ type }`                                       | Health check                             |

### D-Bus Interface

Each service daemon registers on the session bus:

- **Bus name**: `chat.loft.<Service>` (e.g., `chat.loft.WhatsApp`, `chat.loft.Messenger`)
- **Object path**: `/chat/loft/<Service>` (e.g., `/chat/loft/WhatsApp`)
- **Interface**: `chat.loft.Service`

| Method              | Signature       | Description                                    |
|---------------------|-----------------|------------------------------------------------|
| `Show()`            | `→ ()`          | Show / focus the Chrome window                 |
| `Hide()`            | `→ ()`          | Hide the Chrome window                         |
| `Toggle()`          | `→ ()`          | Toggle show/hide                               |
| `Quit()`            | `→ ()`          | Shut down daemon and Chrome process            |
| `GetStatus()`       | `→ (bub)`       | Returns `(visible: bool, badge: u32, dnd: bool)` |
| `SetDnd(b)`         | `(b) → ()`      | Set Do Not Disturb state, persists to config   |
| `SetShowTitlebar(b)` | `(b) → ()`     | Toggle titlebar visibility, persists to config |
| `SetBadgesEnabled(b)` | `(b) → ()`    | Enable/disable badge indicator, persists to config |

### Chrome Detection

Chrome is located by searching in order:

1. `google-chrome` / `google-chrome-stable` on `$PATH`
2. `/usr/bin/google-chrome-stable`
3. `/usr/bin/google-chrome`
4. `/opt/google/chrome/google-chrome`
5. Flatpak: `com.google.Chrome` (via `flatpak info`)
6. AppImage: scan `~/Applications/`, `~/.local/bin/` for `*[Cc]hrome*.AppImage`

If none found, prompt the user to install Google Chrome.

User can override with a custom path in settings (power user option).

**Minimum version**: Chrome 137 or later (the CDP-based unpacked-extension loading via `--remote-debugging-pipe` replaced `--load-extension`, which branded Chrome removed in 137).

Only Google Chrome is officially supported (proprietary codecs required for video calling). Other Chromium-based browsers may work but are not guaranteed.

### Error Handling & Resilience

- **Chrome crash / killed externally**: Daemon detects process exit and attempts to respawn Chrome with the same arguments
- **Chrome not installed**: After exhausting all detection paths (PATH, well-known binaries, AppImage), show a dialog prompting the user to install Google Chrome
- **Multiple daemon instances**: Each service daemon enforces a singleton — if a second instance is launched for the same service, it sends a `Show()` D-Bus call to the running instance and exits

### Autostart

- Each service controls its own autostart independently
- User chooses per-service whether to autostart at login
- Implemented via XDG autostart `.desktop` files

### Supported Apps

| App                | URL                          |
|--------------------|------------------------------|
| WhatsApp           | https://web.whatsapp.com/    |
| Facebook Messenger | https://facebook.com/messages/   |
| Slack              | https://app.slack.com/client/    |
| Telegram           | https://web.telegram.org/a/      |
| Element (Matrix)   | https://app.element.io/      |
| NextCloud Talk     | self-hosted only (`custom_url`)  |

Element is self-hostable, so its per-service config supports a `custom_url`
(set in the manager's service detail page) to point at a self-hosted Element
Web instance instead of `app.element.io`. Because Loft deploys its own
extension, `deploy_extension()` templates the manifest at deploy time — adding
the custom origin to `host_permissions` + `content_scripts.matches` and writing
a generated `loft-overrides.js` (`origin → service` map). The custom origin is
thus a *granted* host permission at load time (no runtime permission prompt),
and the content script / service worker recognise it as `element` via the map,
so badge/notification/titlebar integration works on any domain.

Element specifics: badge count is read from `document.title` (`Element [N]`,
where N = rooms with unread notifications — matching Element's own favicon),
not DOM-scraped (Element's room list uses hashed CSS-module classes and is
virtualized). Notifications use the standard `Notification` API with no focus
gating, so they flow through the shared `notification-override.js` + daemon
D-Bus path like Slack/WhatsApp — no Element-specific notification code.

NextCloud Talk is **always self-hosted** — there is no central instance, so
unlike Element its built-in `url`/`chrome_desktop_id` in the service registry
are placeholders and `custom_url` is effectively *required*. The manager's
Connection field is the only way to make it work; once set, the daemon derives
the window class from that URL and `deploy_extension()` templates the manifest
with its origin (same `loft-overrides.js` `origin → service` mechanism as a
self-hosted Element). The content script recognises the origin as `talk`.

Talk specifics: badge count is **DOM-scraped** (not title-based) — the
conversation list renders an unread badge per conversation as
`<div class="counter-bubble__counter">N</div>`; `content.js` sums the numbers
across all `.counter-bubble__counter` elements (non-numeric/mention bubbles
count as 1). Notifications flow through the shared `notification-override.js`
path like Element/Slack, but the avatar needs extra work: NextCloud's
Notifications app calls `new Notification()` with the *Talk app icon* (the
spreed logo), never the sender's avatar. So `talkAvatarIcon()` recovers it from
the conversation list — each row's `.conversation-icon__avatar[title]` holds the
display name and wraps an `<img>` whose root-relative `/avatar/<name>/64/dark`
src needs the session cookie — by matching the row whose `title` appears in the
notification title. `resolveIcon()` then resolves that relative URL and fetches
it in-page (Talk detected via the `window.OCA.Talk` global), inlining it as a
`data:` URL since the daemon can't authenticate — same treatment as Element.

The Talk window is also de-chromed for an app feel (`content.js`, gated on
`service === "talk"`): NextCloud's global `#header` is hidden and `--header-height`
zeroed, and `#content`/`#content-vue` are stretched edge-to-edge (no margin,
full width/height, no border-radius). Because Talk's header is fixed and its
content is a separate offset container, the Loft titlebar can't use the normal
`getAppRoot()` shift — it instead translates `<body>` down (a transform makes
`<body>` the containing block for the fixed header too) while the titlebar host
is attached to `<html>` so it stays pinned at the viewport top.

## Tech Stack

- **Language**: Rust (entire application)
- **GUI**: libadwaita (latest version) via `libadwaita-rs` bindings — manager UI only
- **Tray icon**: `ksni` (pure Rust SNI D-Bus protocol implementation — no C library dependencies)
- **D-Bus**: `zbus`
- **Extension**: JavaScript (Chrome extension manifest v3)
- **Desktop entries**: XDG `.desktop` files

## Logging

Centralised logging for all components (manager, daemons):

- **Log levels**: `trace`, `debug`, `info`, `warn`, `error` — supported from day 1
- **Default behaviour**: `info` and above written to both stdout and a log file
- **Verbose mode**: CLI flag (e.g., `--verbose` / `-v`) to also show `debug`/`trace` on stdout
- **Log file location**: `~/.local/share/loft/logs/` (e.g., `loft.log`, `whatsapp.log`)

## File Layout

```
~/.config/loft/                    # XDG_CONFIG_HOME — settings
  config.toml                      # global config (chrome path override, etc.)
  services/
    whatsapp.toml                  # per-service config (autostart, DND, etc.)
    messenger.toml
    slack.toml
    telegram.toml

~/.local/share/loft/               # XDG_DATA_HOME — data
  profiles/
    whatsapp/                      # Chrome user-data-dir for WhatsApp
    messenger/                     # Chrome user-data-dir for Messenger
    slack/                         # Chrome user-data-dir for Slack
    telegram/                      # Chrome user-data-dir for Telegram
  icons/
    whatsapp.svg                   # embedded icons, deployed at install time
    messenger.svg
    slack.svg
    telegram.svg
  extension/                       # unpacked Chrome extension
  logs/
    loft.log                       # manager log
    whatsapp.log                   # per-service daemon log
    messenger.log
    slack.log
    telegram.log

~/.local/share/gnome-shell/extensions/
  loft-shell-helper@loft.chat/    # GNOME Shell extension (focus/hide, alt-tab hiding)
```

## Packaging

Loft is distributed as native Linux packages: **RPM**, **DEB**, and **AppImage**.

Loft is also distributed as a **Flatpak** (`chat.loft.Loft`) — both as a standalone `.flatpak` file and on [FriendlyHub](https://friendlyhub.org). Loft requires launching Chrome on the host (for proprietary codecs / WebRTC), which needs `org.freedesktop.Flatpak` (`flatpak-spawn --host`). This is effectively a sandbox escape, so **Flathub** won't accept it — FriendlyHub is used instead.

## Testing

- **Unit tests**: Core logic — config parsing, Chrome detection, native message serialization/deserialization, service registry
- **Integration tests**: D-Bus interface (spawn daemon, call methods, verify responses), native messaging round-trips
- **Manual testing checklist**: Chrome launch/focus, tray icon behaviour, badge count updates, close-to-tray, DND toggle, install/uninstall flow

Run tests with:

```sh
cargo test
```

## Development Rules

- **Always check latest versions**: When adding or referencing any dependency (crate, library, extension API, etc.), look up the current version online. Do not assume version numbers from training data.

## Development

For local iteration and testing, use a **debug build** — it compiles far faster
and, crucially, uses much less RAM than a release build. Release turns on full
LLVM optimization, whose optimizer + final link are memory-hungry enough to OOM
a laptop. Only build `--release` when producing a package to distribute or
measuring real runtime performance (e.g. video-call smoothness), and ideally
with bounded parallelism (`cargo build --release -j2`) on a machine with RAM to
spare.

```sh
# Build + run for local testing (fast, low memory)
cargo build
./target/debug/loft
./target/debug/loft --service whatsapp

# Release build — only for packaging / perf measurement (heavy; OOM risk)
cargo build --release
./target/release/loft
```
