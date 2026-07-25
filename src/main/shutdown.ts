/**
 * Session-end fast-exit handler (see the wiring in index.ts).
 *
 * Measured at a real GNOME logout, 2026-07-25, on the Flatpak build:
 *
 *   19:34:33.174909  systemd: Stopping app-flatpak-chat.loft.Loft-<id>.scope...
 *   19:34:33.196155  [FATAL:dbus/bus.cc:1245] D-Bus connection was disconnected. Aborting.
 *   19:34:33.859032  systemd: Stopping dbus-broker.service - D-Bus User Message Bus...
 *
 * Chromium aborts (LOG(FATAL), SIGTRAP, coredump, "Electron crashed" at the next login)
 * the instant its D-Bus connection drops while the process is alive. The budget for
 * getting out first is 21ms.
 *
 * An earlier fix budgeted ~940ms, timing the gap to dbus-broker's teardown. That is the
 * right number for a deb/rpm build, which connects to dbus-broker directly. It is the
 * wrong number for Flatpak, and Flatpak is where the crash is: a sandboxed app never
 * touches dbus-broker, it talks to xdg-dbus-proxy — and the proxy is a member of the
 * app's OWN systemd scope:
 *
 *   CGroup: /user.slice/.../app-flatpak-chat.loft.Loft-<id>.scope
 *           |- bwrap --args 72 -- loft --minimized
 *           |- /usr/bin/xdg-dbus-proxy --args=74      <- the app's actual bus
 *           |- electron --minimized /app/main         <- the process that aborts
 *
 * `systemctl stop` SIGTERMs every process in the cgroup at once. The proxy has no teardown
 * work and exits in ~20ms, closing the app's bus socket with it. So the bus does not die
 * ~940ms after our SIGTERM — it dies *in the same signal delivery*, ~45x sooner.
 *
 * A 21ms race against an abort raised on another thread is not winnable, so this handler
 * does not enter it: it exits immediately and does no work at all, which is correct under
 * any budget. Everything that used to run here happens while the app is alive instead —
 * window bounds/zoom via configFlush.ts, every other config field already saved on change.
 *
 * If you are tempted to add "just one quick thing" before the exit: that is the exact
 * shape of the bug this replaced, and it will be invisible in dev (a non-Flatpak build
 * really does have ~940ms) and reappear at every logout on the shipped Flatpak.
 */
export interface ShutdownDeps {
  /** Terminate the process immediately (app.exit(0) in production). */
  exit(): void;
}

/** Returns a signal handler that exits, exactly once, doing nothing else. */
export function createSignalShutdown(deps: ShutdownDeps): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    deps.exit();
  };
}
