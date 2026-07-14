import * as dbus from 'dbus-next';

const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const PORTAL_IFACE = 'org.freedesktop.portal.Background';

export interface ServiceBadge { displayName: string; badge: number; }

/** Port of format_aggregate (background_status.rs:179-209). */
export function formatAggregate(services: ReadonlyArray<ServiceBadge>): string {
  const count = services.length;
  if (count === 0) return '';
  const unread = services.filter((x) => x.badge > 0);
  if (unread.length === 0) return count === 1 ? '1 service running' : `${count} services running`;
  if (unread.length === 1) return `${unread[0].displayName}: ${unread[0].badge} unread`;
  const total = unread.reduce((n, x) => n + x.badge, 0);
  const parts = unread.map((x) => `${x.displayName} ${x.badge}`).join(', ');
  return `${total} unread (${parts})`;
}

let bus: dbus.MessageBus | undefined;
export async function setBackgroundStatus(message: string): Promise<void> {
  try {
    bus ??= dbus.sessionBus();
    const msg = new dbus.Message({
      destination: PORTAL, path: PORTAL_PATH, interface: PORTAL_IFACE, member: 'SetStatus',
      signature: 'a{sv}', body: [{ message: new dbus.Variant('s', message) }],
    });
    await bus.call(msg);
  } catch (e) {
    console.debug('SetStatus (Background portal) failed:', (e as Error)?.message ?? e);
  }
}

export function startBackgroundStatus(deps: { collect(): ReadonlyArray<ServiceBadge> }): { refresh(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const refresh = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void setBackgroundStatus(formatAggregate(deps.collect())); }, 500);
  };
  return { refresh };
}
