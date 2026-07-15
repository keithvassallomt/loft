// org.freedesktop.portal.Background — the sanctioned way for a sandboxed app to
// ask for autostart. Verified live (Fedora 44, xdg-desktop-portal 1.22.1 +
// -gnome 50.0), interface version 2:
//   RequestBackground(in s parent_window, in a{sv} options, out o handle)
// The reply is NOT the return value: it arrives as Request.Response(u, a{sv}) on
// the returned handle path. results.autostart is what we actually GOT, which is
// authoritative over what we asked for.
import * as dbus from 'dbus-next';

const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const IFACE = 'org.freedesktop.portal.Background';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';

/** The flatpak manifest's `command:` plus the flag the autostart entry must carry. */
const COMMANDLINE = ['loft', '--minimized'];
const REASON = 'Loft opens your messaging services when you log in.';

/**
 * Leak guard for a Response that never arrives (portal killed/hung, buggy
 * implementation, etc.) — NOT a responsiveness deadline. The portal may be
 * showing an interactive permission dialog the user hasn't answered yet;
 * resolving `false` before that dialog is answered would misreport "denied"
 * while the user is still deciding. Callers invoke requestAutostart
 * fire-and-forget (`void syncAutostart(...)`), so a slow resolve costs
 * nothing — only an abandoned request costs anything (a leaked subscription).
 */
const RESPONSE_TIMEOUT_MS = 120_000;

export interface PortalDeps {
  /**
   * Resolves once the bus connection is actually up (i.e. once `uniqueName()`
   * is safe to call). Must be awaited before `uniqueName()` — the dbus-next
   * unique name isn't assigned until the async `Hello()` round-trip
   * completes. Never rejects.
   */
  ready(): Promise<void>;
  /** The bus's unique name, e.g. ":1.42". Only valid after `ready()` resolves. */
  uniqueName(): string;
  /** Invoke RequestBackground. Rejecting is fine — requestAutostart absorbs it. */
  call(handleToken: string, options: Record<string, unknown>): Promise<void>;
  /** Subscribe to Response on the request path. Must be called BEFORE call(). */
  onResponse(
    path: string,
    cb: (response: number, results: Record<string, unknown>) => void,
  ): { stop(): void };
}

/**
 * Where the portal will emit Response: the unique name with the leading ':'
 * dropped and '.' → '_'. Computed up front so we can subscribe before calling —
 * subscribing after the call can miss a fast reply.
 */
export function requestPath(uniqueName: string, handleToken: string): string {
  const sender = uniqueName.replace(/^:/, '').replace(/\./g, '_');
  return `/org/freedesktop/portal/desktop/request/${sender}/${handleToken}`;
}

/** Plain (un-Varianted) options, so they stay assertable in tests. */
export function backgroundOptions(enabled: boolean, handleToken: string): Record<string, unknown> {
  return { handle_token: handleToken, reason: REASON, autostart: enabled, commandline: COMMANDLINE };
}

let tokenSeq = 0;

/** Ask the portal to enable/disable autostart. Resolves to the GRANTED state; never rejects. */
export async function requestAutostart(enabled: boolean, deps: PortalDeps): Promise<boolean> {
  const handleToken = `loft_${process.pid}_${++tokenSeq}`;
  let sub: { stop(): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The executor below must never throw — it only captures its resolver, so
  // `settled` can only ever RESOLVE, never reject. Everything that can throw
  // (deps.ready/onResponse/call) runs afterwards, inside the try below, where
  // a throw is caught rather than becoming an unhandled rejection on a
  // promise nobody's attached a handler to yet.
  let resolveSettled!: (granted: boolean) => void;
  const settled = new Promise<boolean>((resolve) => {
    resolveSettled = resolve;
  });
  try {
    await deps.ready();
    sub = deps.onResponse(requestPath(deps.uniqueName(), handleToken), (response, results) => {
      // response: 0 ok, 1 cancelled, 2 other. Trust results.autostart, not our request.
      resolveSettled(response === 0 && results.autostart === true);
    });
    // Only reachable once onResponse has returned a live subscription — if it
    // threw, we're already in the catch below and this never fires, so we
    // never send RequestBackground (and pop an interactive dialog) without
    // anything listening for the answer.
    await deps.call(handleToken, backgroundOptions(enabled, handleToken));

    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), RESPONSE_TIMEOUT_MS);
      timer.unref?.();
    });
    return await Promise.race([settled, timedOut]);
  } catch (e) {
    console.debug('RequestBackground failed:', (e as Error)?.message ?? e);
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    sub?.stop();
  }
}

export function defaultPortalDeps(): PortalDeps {
  const bus = dbus.sessionBus();
  // dbus-next's MessageBus is an EventEmitter that emits 'error' on a broken
  // connection; with zero listeners Node re-throws it, which would take down
  // the whole main process over a background D-Bus hiccup. This bus is
  // memoized for the process lifetime (see sharedPortalDeps() in
  // autostart.ts), so attach the listener once, here, rather than at every
  // call site.
  bus.on('error', (err) => console.debug('portal session bus error:', (err as Error)?.message ?? err));
  const ready = new Promise<void>((resolve) => {
    if ((bus as unknown as { name: string | null }).name !== null) {
      resolve();
    } else {
      bus.once('connect', () => resolve());
    }
  });
  return {
    ready: () => ready,
    uniqueName: () => (bus as unknown as { name: string }).name,
    onResponse: (path, cb) => {
      // Defense in depth against Minor 5 (a spoofed Response): the sender=
      // clause below is the real security boundary — the message bus daemon
      // resolves it to the portal's current unique name and only routes
      // matching signals to us, and no client can forge the Sender header
      // (the daemon always overwrites it with the true sender). We also
      // re-check msg.sender locally once we know that unique name, so a
      // signal that somehow reached us without actually coming from the
      // portal is dropped rather than trusted.
      let portalSender: string | undefined;
      void bus.call(new dbus.Message({
        destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus', member: 'GetNameOwner', signature: 's', body: [PORTAL],
      })).then((reply) => {
        portalSender = (reply?.body as [string] | undefined)?.[0];
      }).catch(() => {});
      const handler = (msg: dbus.Message): void => {
        if (msg.path !== path || msg.interface !== REQUEST_IFACE || msg.member !== 'Response') return;
        if (portalSender !== undefined && msg.sender !== portalSender) return;
        const [response, results] = msg.body as [number, Record<string, dbus.Variant>];
        const plain: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(results ?? {})) plain[k] = v?.value;
        cb(response, plain);
      };
      const match =
        `type='signal',interface='${REQUEST_IFACE}',member='Response',path='${path}',sender='${PORTAL}'`;
      void bus.call(new dbus.Message({
        destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [match],
      })).catch(() => {});
      bus.on('message', handler);
      return {
        stop: () => {
          bus.off('message', handler);
          void bus.call(new dbus.Message({
            destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
            interface: 'org.freedesktop.DBus', member: 'RemoveMatch', signature: 's', body: [match],
          })).catch(() => {});
        },
      };
    },
    call: async (handleToken, options) => {
      const body: Record<string, dbus.Variant> = {
        handle_token: new dbus.Variant('s', options.handle_token as string),
        reason: new dbus.Variant('s', options.reason as string),
        autostart: new dbus.Variant('b', options.autostart as boolean),
        commandline: new dbus.Variant('as', options.commandline as string[]),
      };
      await bus.call(new dbus.Message({
        destination: PORTAL, path: PORTAL_PATH, interface: IFACE, member: 'RequestBackground',
        signature: 'sa{sv}', body: ['', body],
      }));
    },
  };
}
