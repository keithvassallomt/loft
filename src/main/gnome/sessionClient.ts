// dbus-next API used here is verified against node_modules/dbus-next@0.10.2:
// `bus.getProxyObject`, `obj.getInterface`, proxy interfaces are EventEmitters for signals.
import * as dbus from 'dbus-next';

const SM_NAME = 'org.gnome.SessionManager';
const SM_PATH = '/org/gnome/SessionManager';
const CLIENT_PRIVATE = 'org.gnome.SessionManager.ClientPrivate';

/**
 * Leave the session the moment gnome-session says it is ending, rather than racing SIGTERM.
 *
 * The problem this solves, measured rather than assumed (full write-up in ../shutdown.ts):
 * at a Flatpak logout, systemd stops the app's scope, SIGTERMing the app and its
 * xdg-dbus-proxy together. The proxy has no teardown work and exits in ~16ms, and Chromium
 * calls LOG(FATAL) (dbus/bus.cc:1245) the instant its D-Bus connection drops while the
 * process is still alive — SIGTRAP, coredump, "Electron crashed" at the next login.
 *
 * A reproduction harness modelling that exact topology (SIGTERM and bus death in the same
 * instant) showed the previous approach — exit as fast as possible on SIGTERM — is not a
 * fix but a coin flip: it NEVER survived when the bus died simultaneously, and won roughly
 * two times in five at the real ~15ms gap. The identical app.exit(0) is reliably clean
 * given ~940ms. The budget was the whole problem, so the fix has to buy budget.
 *
 * gnome-session provides exactly that. It runs its EndSession exchange with registered
 * clients and only exits afterwards — 3.5ms before it stops the app scopes, and with the
 * session bus still healthy throughout. Registering makes us a client of that exchange, so
 * we hear "the session is ending" while a clean exit is still possible.
 *
 * GNOME-only by nature. Other desktops keep the SIGTERM fast-exit in index.ts, which is
 * still worth having: it is free, and it wins some of the time.
 */
export interface SessionEndDeps {
  /** Reply to gnome-session: `EndSessionResponse(isOk, reason)`. */
  respond(isOk: boolean, reason: string): Promise<void> | void;
  /** Terminate the process (app.exit(0) in production). */
  exit(): void;
}

export interface SessionEndHandlers {
  onQueryEndSession(): Promise<void>;
  onEndSession(): Promise<void>;
  onStop(): Promise<void>;
}

/**
 * The decision logic, split out so it is testable without a live session bus.
 *
 * QueryEndSession is the "may we?" phase and can still be cancelled, so it answers yes and
 * stays alive. EndSession is the commitment: answer first — exiting before the reply is
 * flushed leaves gnome-session waiting on us for its whole timeout, i.e. a visibly slower
 * logout — then go. A failed reply must never stop the exit, or we fall back into the
 * SIGTERM race the whole mechanism exists to avoid.
 */
export function createSessionEndHandlers(deps: SessionEndDeps): SessionEndHandlers {
  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    deps.exit();
  };
  const reply = async (): Promise<void> => {
    try {
      await deps.respond(true, '');
    } catch (e) {
      console.error('EndSessionResponse failed:', (e as Error)?.message ?? e);
    }
  };

  return {
    onQueryEndSession: reply,
    onEndSession: async () => { await reply(); exitOnce(); },
    onStop: async () => { exitOnce(); },
  };
}

/**
 * Register with gnome-session and wire the handlers up. Best-effort: a desktop without
 * org.gnome.SessionManager, or a refused registration, must never stop Loft starting —
 * it just means we fall back to the SIGTERM path.
 *
 * Returns an unregister function, or undefined if registration did not happen.
 */
export async function registerSessionClient(
  onExit: () => void,
  appId = 'chat.loft.Loft',
): Promise<(() => Promise<void>) | undefined> {
  try {
    const bus = dbus.sessionBus();
    const smObj = await bus.getProxyObject(SM_NAME, SM_PATH);
    const sm = smObj.getInterface(SM_NAME) as unknown as {
      RegisterClient(appId: string, startupId: string): Promise<string>;
      UnregisterClient(path: string): Promise<void>;
    };

    // DESKTOP_AUTOSTART_ID is what gnome-session hands an autostarted app to reclaim its
    // existing client registration; passing it through avoids registering twice. Absent
    // for a normal launch, where an empty startup id is correct.
    const startupId = process.env.DESKTOP_AUTOSTART_ID ?? '';
    const clientPath = await sm.RegisterClient(appId, startupId);

    const clientObj = await bus.getProxyObject(SM_NAME, clientPath);
    const priv = clientObj.getInterface(CLIENT_PRIVATE) as unknown as {
      EndSessionResponse(isOk: boolean, reason: string): Promise<void>;
      on(ev: 'QueryEndSession' | 'EndSession' | 'Stop' | 'CancelEndSession', cb: () => void): void;
    };

    const handlers = createSessionEndHandlers({
      respond: (isOk, reason) => priv.EndSessionResponse(isOk, reason),
      exit: () => {
        // Logged because this is the whole point of the mechanism: if a logout still
        // produces a crash, the journal has to say whether we got here at all.
        console.log('session end: gnome-session signalled logout, exiting cleanly');
        onExit();
      },
    });

    priv.on('QueryEndSession', () => { void handlers.onQueryEndSession(); });
    priv.on('EndSession', () => { void handlers.onEndSession(); });
    priv.on('Stop', () => { void handlers.onStop(); });

    console.log(`session end: registered with gnome-session at ${clientPath}`);
    return async () => { await sm.UnregisterClient(clientPath).catch(() => {}); };
  } catch (e) {
    console.debug('gnome-session client registration unavailable:', (e as Error)?.message ?? e);
    return undefined;
  }
}
