import { describe, it, expect, vi } from 'vitest';
import { createSessionEndHandlers } from '../src/main/gnome/sessionClient';

/**
 * Why this exists at all — measured, not assumed (see src/main/shutdown.ts for the full
 * write-up). At a Flatpak logout, systemd stops the app's scope, which SIGTERMs the app
 * AND its xdg-dbus-proxy together; the proxy exits in ~16ms, and Chromium aborts
 * (LOG(FATAL), dbus/bus.cc) the instant its D-Bus connection drops while the process is
 * alive. A reproduction harness modelling that topology showed exiting-on-SIGTERM is a
 * coin flip at the real gap and NEVER wins when the bus dies simultaneously — but that the
 * very same app.exit(0) is clean when it has ~940ms.
 *
 * So the fix is not to exit faster, it is to be told earlier. gnome-session runs its
 * EndSession exchange with registered clients and only then exits — 3.5ms before the app
 * scopes are stopped — so a registered client hears about the logout while the bus is
 * still healthy and has a real budget to leave in.
 *
 * These handlers are the part of that worth testing without a live session bus.
 */
describe('createSessionEndHandlers', () => {
  it('answers QueryEndSession without quitting — the logout can still be cancelled', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();

    await createSessionEndHandlers({ respond, exit }).onQueryEndSession();

    expect(respond).toHaveBeenCalledWith(true, '');
    expect(exit).not.toHaveBeenCalled();
  });

  it('answers EndSession BEFORE exiting', async () => {
    const calls: string[] = [];
    const handlers = createSessionEndHandlers({
      respond: async () => { calls.push('respond'); },
      exit: () => { calls.push('exit'); },
    });

    await handlers.onEndSession();

    // Exiting first would leave gnome-session waiting on us for its full timeout,
    // which is a visibly slower logout for the user.
    expect(calls).toEqual(['respond', 'exit']);
  });

  it('exits even when the response fails', async () => {
    const exit = vi.fn();
    const handlers = createSessionEndHandlers({
      respond: async () => { throw new Error('bus already gone'); },
      exit,
    });

    await expect(handlers.onEndSession()).resolves.toBeUndefined();
    // Not exiting here would drop us back into the unwinnable SIGTERM race.
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits immediately on Stop', async () => {
    const exit = vi.fn();

    await createSessionEndHandlers({ respond: vi.fn(), exit }).onStop();

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits at most once across repeated signals', async () => {
    const exit = vi.fn();
    const handlers = createSessionEndHandlers({ respond: vi.fn().mockResolvedValue(undefined), exit });

    await handlers.onEndSession();
    await handlers.onEndSession();
    await handlers.onStop();

    expect(exit).toHaveBeenCalledTimes(1);
  });
});
