# Logout-crash harness

Reproduces the "Electron crashed" notice Loft showed at every GNOME login, **without
logging out**. Build this before changing anything in the session-end path.

## Why it exists

Two fixes for this bug shipped and neither worked, because both were validated against a
budget that does not exist on the Flatpak build. A deb/rpm build talks to `dbus-broker`,
which systemd stops ~940ms after the app's SIGTERM. A Flatpak build never touches
dbus-broker: it talks to `xdg-dbus-proxy`, which is a member of the app's **own systemd
scope**, so `systemctl stop` SIGTERMs the proxy and the app together and the proxy — having
no teardown work — exits in ~16ms. Chromium then calls `LOG(FATAL)` (`dbus/bus.cc:1245`)
the instant its D-Bus connection drops while the process is alive.

So the same code has a ~45x larger budget in dev than on the shipped app. This harness
models the Flatpak topology: it kills the bus in the *same* signal delivery as the app.

## Usage

    ./run.sh <mode> <ms to wait after SIGTERM before killing the bus>

Modes are in `main.js`: `none` (no handler), `fastexit` (SIGTERM -> app.exit(0)).
No window is ever created; it must stay safe to run inside a live session.

## Results (2026-07-25, Electron 43)

| mode     | bus delay | outcome |
|----------|-----------|---------|
| none     | 0ms       | SIGTRAP |
| fastexit | 0ms       | SIGTRAP, 3/3 |
| fastexit | 15ms      | SIGTRAP 2/3, clean 1/3 — **a coin flip** |
| fastexit | 940ms     | clean |

The conclusion that mattered: **exiting on SIGTERM cannot be made to work.** It never
survives a simultaneous bus death, and the real gap is ~16ms. The identical `app.exit(0)`
is reliably clean given ~940ms, so the fix had to buy budget rather than shave
microseconds — hence `src/main/gnome/sessionClient.ts`, which registers with
gnome-session and leaves during its EndSession exchange, while the bus is still healthy.

Also ruled out here, so nobody re-tries them:

- **Avoiding D-Bus in app code** (`nodbus` mode): Chromium opens a session-bus connection
  regardless. Still aborts.
- **Restoring `SIG_DFL` so the kernel kills us instantly**: `process.on(sig, h)` followed by
  `removeListener` does *not* reset the disposition — `/proc/<pid>/status` `SigCgt` is
  byte-identical with and without it (`0000000100014203`, SIGTERM still caught), because
  Chromium installed its handler in C++ and Node does not take it back.
