<p align="center">
  <img src="assets/icons/loft.svg" alt="Loft" width="128">
</p>

# Loft

Desktop integration for messaging apps on Linux.

Loft provides full desktop integration for WhatsApp, Facebook Messenger, Slack, Telegram, Element and NextCloud Talk on Linux, including voice and video calling, system tray icons, badge counts, and close-to-tray behavior.

Loft is a self-contained Electron app — no separate browser to install or manage. Voice/video calling and screen-sharing use Electron's own bundled Chromium, while Loft's own tray, notification, and window-management code (not a browser extension) provides the desktop integration a plain web app can't.

> [!NOTE]
> <img width="200" height="auto" alt="friendly-manifesto-badge" src="https://github.com/user-attachments/assets/cb91210b-0f66-46fe-93a8-a3a67857593c" /> <br>
> This project voluntarily adheres to The Friendly Manifesto. Read more [here](https://friendlymanifesto.org)

## Features

- Voice and video calling, and screen sharing
- A single tray icon covering every running service, with unread badge counts (SNI and native GNOME panel backends)
- Close-to-tray (window hides, app stays running)
- Do Not Disturb — global, per-service, or automatically following the system's own DND setting
- Desktop notifications with app icons and click-to-navigate
- Autostart at login, per service (opens minimized to tray)
- Its own isolated login/session per service (no shared browser profile)
- GNOME Shell integration (focus/hide bypasses focus-stealing prevention, hides minimized windows from alt-tab/overview/dock) and KDE Plasma integration (KWin scripting for the same)
- Pin chats (or group messages/channels) to bubbles
- Zoom controls

## Supported Services

| Service            | URL                            |
|--------------------|--------------------------------|
| WhatsApp           | https://web.whatsapp.com/      |
| Facebook Messenger | https://www.facebook.com/messages/ |
| Slack              | https://app.slack.com/client/  |
| Telegram           | https://web.telegram.org/a/    |
| Element (Matrix)   | https://app.element.io/ (or self-hosted) |
| NextCloud Talk     | self-hosted (your instance URL) |

Element and NextCloud Talk are self-hostable: set your instance's URL in the service's settings in the Loft hub. Element defaults to `app.element.io`; NextCloud Talk has no public server, so its URL is required.

## Requirements

- Linux with a GNOME or KDE Plasma desktop (other desktop environments may work via the generic SNI tray, but window focus/hide integration targets GNOME and KDE specifically)

Google Chrome is **not** required — Loft bundles everything it needs.

## Installation

### Flatpak

```sh
flatpak install chat.loft.Loft
```

Available as a standalone `.flatpak` bundle and on [FriendlyHub](https://friendlyhub.org).

### RPM / DEB / AppImage

Pre-built packages are available on the [releases page](https://github.com/keithvassallomt/loft/releases).

### Building from source

Requires Node.js (see `package.json` `devDependencies` for the toolchain versions currently in use) and npm.

```sh
npm ci
npm run build
npm start
```

To build the DEB/RPM/AppImage packages:

```sh
npm run dist
```

To build a local Flatpak bundle from the from-source manifest at the repo root:

```sh
flatpak-builder --user --force-clean --repo=.flatpak-repo build-dir chat.loft.Loft.yml
flatpak build-bundle .flatpak-repo Loft.flatpak chat.loft.Loft
```

See `flatpak/README.md` for the manifest layout and how to regenerate the offline Node sources.

### Cutting a release (maintainers)

Work is written up under `## [Unreleased]` at the top of [`CHANGELOG.md`](CHANGELOG.md) as it lands, never under a version heading. Cutting a release is what turns that section into a version.

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml):

1. Make one commit, `chore: update versions to X.Y.Z`, that changes all of these together:
   - `package.json` and `package-lock.json`: `npm version X.Y.Z --no-git-tag-version` sets both.
   - `CHANGELOG.md`: rename `## [Unreleased]` to `## [X.Y.Z] - <date>` and open a fresh empty `## [Unreleased]` above it.
   - `data/chat.loft.Loft.metainfo.xml`: add a matching `<release>` with a short description and a real date. The CI AppStream validation step rejects a placeholder date on tag builds.
   - `chat.loft.Loft.yml`: point the app source's `tag:` at `vX.Y.Z`. This is the manifest FriendlyHub builds, and it fetches exactly that tag.

   `tests/flatpakManifest.test.ts` fails unless `package.json`, the manifest's tag and the newest metainfo `<release>` all name the same version, so run `npm test` before committing. `generated-sources.json` (the Flatpak's offline npm sources) only needs regenerating with `flatpak-node-generator` when dependencies in `package-lock.json` change. A version bump alone does not count.
2. Push the commit, then create an annotated tag and push it: `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push origin vX.Y.Z`.
3. GitHub Actions checks out the tag, runs the test/typecheck suite, builds the DEB/RPM/AppImage packages (`electron-builder`) and the Flatpak bundle (`flatpak-builder`, from the committed offline sources), lifts the `## [X.Y.Z]` changelog section into the release notes (`scripts/changelogSection.mjs`), and publishes all four artifacts to a GitHub Release for that tag. The release-notes step runs only after every package is built, so if the section is still headed `[Unreleased]` the run fails at the very end, on a tag that is already pushed. Check the rename before tagging.
4. Submit the Flatpak to FriendlyHub by hand: `chat.loft.Loft.yml` plus its companion `generated-sources.json`, from the tagged commit. FriendlyHub's builder has nothing but those files, which is why the manifest's app source is `type: git` pinned to the tag.

A manual `workflow_dispatch` run (no tag) builds the same artifacts as a rolling **prerelease**, skipping the strict AppStream validation gate. It is useful for a preview build without cutting a real version.

## Usage

```sh
# Launch the hub (manager window)
loft

# Open a service directly
loft --service=whatsapp
loft --service=messenger
loft --service=slack
loft --service=telegram
loft --service=element
loft --service=talk

# Start minimized to tray
loft --service=whatsapp --minimized

# All of the above route to the same running instance if Loft is already open
```

## How It Works

Loft is one Electron app that hosts every installed service in-process — no separate daemon per service, and no external Chrome to launch:

1. **Hub window** — a Svelte-based manager UI for adding/removing services and per-service/global settings
2. **A frameless window per running service** — its own titlebar (icon, name, zoom, close-to-tray) above a `WebContentsView` that renders the web app using Electron's bundled Chromium
3. **Sandboxed preloads** (one per service) — extract badge counts, intercept notifications, and strip page chrome; this replaces the browser-extension approach entirely, so self-hosted Element/NextCloud Talk instances work with no extra setup
4. **A single tray icon** (SNI or native GNOME panel) covering every running service, and a hand-rolled D-Bus client that talks directly to `org.freedesktop.Notifications`
5. **GNOME Shell / KWin integration** — bypasses focus-stealing prevention and hides minimized Loft windows from alt-tab, overview, and dock/taskbar

Each service gets its own isolated session (login, cookies, storage) and a `.desktop` launcher; the whole app exposes one D-Bus interface (`chat.loft.Loft`) with per-service control objects.

## License

This project is licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE) for details.
