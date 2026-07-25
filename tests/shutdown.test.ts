import { describe, it, expect, vi } from 'vitest';
import { createSignalShutdown } from '../src/main/shutdown';

// Why this handler must do NOTHING but exit — measured at a real GNOME logout,
// 2026-07-25, on the Flatpak build:
//
//   19:34:33.174909  systemd: Stopping app-flatpak-chat.loft.Loft-<id>.scope...
//   19:34:33.196155  [FATAL:dbus/bus.cc:1245] D-Bus connection was disconnected. Aborting.
//   19:34:33.859032  systemd: Stopping dbus-broker.service - D-Bus User Message Bus...
//
// 21ms of budget, not the ~940ms an earlier fix assumed. That earlier number timed
// dbus-broker, which is the bus a deb/rpm build talks to. A Flatpak build never touches
// dbus-broker: it talks to xdg-dbus-proxy, and the proxy is a member of the app's OWN
// systemd scope, so `systemctl stop` SIGTERMs the proxy and the app together. The proxy
// has no teardown work and exits in ~20ms, taking the app's bus with it; Chromium aborts
// (SIGTRAP, coredump, "Electron crashed" at next login) the instant it notices.
//
// You cannot win a 21ms race against an abort raised on another thread. So the handler
// does not try: it exits first and does no work at all, which is correct under ANY budget.
// Anything that used to run here has moved to while-the-app-is-alive (see configFlush.ts).
describe('createSignalShutdown', () => {
  it('exits immediately and does no other work', () => {
    // `persist` is the dependency the old contract ran before exiting. It is deliberately
    // still passed here: this assertion is the regression guard against putting any work —
    // a config write, a D-Bus close, a child reap — back on the session-end path.
    const deps = { exit: vi.fn(), persist: vi.fn() };

    createSignalShutdown(deps)();

    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it('exits synchronously, not on a later tick', () => {
    let exited = false;
    createSignalShutdown({ exit: () => { exited = true; } })();
    // A deferred exit would hand the remaining ~21ms to the event loop, which is exactly
    // how the process ends up alive when the bus proxy dies.
    expect(exited).toBe(true);
  });

  it('runs at most once even if the signal fires repeatedly', () => {
    const exit = vi.fn();
    const handler = createSignalShutdown({ exit });

    handler();
    handler();
    handler();

    expect(exit).toHaveBeenCalledTimes(1);
  });
});
