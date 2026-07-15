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

export interface PortalDeps {
  /** The bus's unique name, e.g. ":1.42". */
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
  try {
    const settled = new Promise<boolean>((resolve) => {
      sub = deps.onResponse(requestPath(deps.uniqueName(), handleToken), (response, results) => {
        // response: 0 ok, 1 cancelled, 2 other. Trust results.autostart, not our request.
        resolve(response === 0 && results.autostart === true);
      });
    });
    await deps.call(handleToken, backgroundOptions(enabled, handleToken));
    return await settled;
  } catch (e) {
    console.debug('RequestBackground failed:', (e as Error)?.message ?? e);
    return false;
  } finally {
    sub?.stop();
  }
}

export function defaultPortalDeps(): PortalDeps {
  const bus = dbus.sessionBus();
  return {
    uniqueName: () => (bus as unknown as { name: string }).name,
    onResponse: (path, cb) => {
      const handler = (msg: dbus.Message): void => {
        if (msg.path !== path || msg.interface !== REQUEST_IFACE || msg.member !== 'Response') return;
        const [response, results] = msg.body as [number, Record<string, dbus.Variant>];
        const plain: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(results ?? {})) plain[k] = v?.value;
        cb(response, plain);
      };
      const match = `type='signal',interface='${REQUEST_IFACE}',member='Response',path='${path}'`;
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
