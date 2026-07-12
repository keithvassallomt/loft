import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NotificationGate } from './gate';
import { resolveAvatar, avatarCacheDir, type AvatarDeps } from './avatars';
import { connectNotificationServer, type NotificationServer } from './dbus';
import { watchSystemDnd } from './systemDnd';

export interface NotifyPayload {
  title: string;
  body: string;
  icon?: string;
  href?: string;
}

export interface NotificationsDeps {
  displayName(id: string): string;
  serviceIconPath(id: string): string;
  sessionFetch(id: string, url: string): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  focusService(id: string): void;
  navigate(id: string, url: string): void;
  pushDnd(id: string, effectiveDnd: boolean): void;
  pushHidden(id: string, hidden: boolean): void;
}

export interface Notifications {
  handle(id: string, p: NotifyPayload): Promise<void>;
  setServiceDnd(id: string, v: boolean): void;
  setGlobalDnd(v: boolean): void;
  setFocused(id: string, v: boolean): void;
  setVisible(id: string, v: boolean): void;
  registerService(id: string): void;
}

/**
 * Wires the notification gate (DND + focus/visibility), the D-Bus delivery
 * server, and the GNOME system-DND watcher together. Port of the combined
 * responsibilities of notifications.rs + the daemon's DND plumbing.
 *
 * Connecting to the notification server and watching system DND each degrade
 * gracefully (log + continue with notifications disabled / system DND assumed
 * off) rather than crashing the app — a session bus or gsettings failure
 * should not take down the whole daemon.
 */
export async function startNotifications(deps: NotificationsDeps): Promise<Notifications> {
  const gate = new NotificationGate();
  const knownIds = new Set<string>();
  // The gate itself tracks focused/visible per id but doesn't expose read-back;
  // mirror them here so pushHidden can be recomputed from both at once.
  const focused = new Map<string, boolean>();
  const visible = new Map<string, boolean>();

  let server: NotificationServer | undefined;
  try {
    server = await connectNotificationServer();
  } catch (err) {
    console.error('Failed to connect to org.freedesktop.Notifications; notifications disabled:', err);
  }

  const pending = new Map<number, { id: string; href?: string }>();
  server?.onActionDefault((notifId) => {
    const m = pending.get(notifId);
    if (!m) return;
    pending.delete(notifId);
    deps.focusService(m.id);
    if (m.href) deps.navigate(m.id, m.href);
  });

  const pushDndToAll = (): void => {
    for (const id of knownIds) deps.pushDnd(id, gate.effectiveDnd(id));
  };

  const recomputeHidden = (id: string): void => {
    const isFocused = focused.get(id) ?? false;
    const isVisible = visible.get(id) ?? false;
    // During DND, tell the page it is NOT hidden so the web app treats the user as
    // present and suppresses its OWN notification behaviour — banner AND sound. Main
    // already drops delivery; this closes the in-page ding that delivery-gating alone
    // can't reach (the page plays its notification sound whenever it believes it's
    // hidden/unfocused, independent of the desktop notification we suppress).
    const hidden = gate.effectiveDnd(id) ? false : !(isFocused && isVisible);
    deps.pushHidden(id, hidden);
  };
  const recomputeHiddenAll = (): void => {
    for (const id of knownIds) recomputeHidden(id);
  };

  try {
    const watcher = watchSystemDnd((dnd) => {
      gate.setSystemDnd(dnd);
      pushDndToAll();
      recomputeHiddenAll();
    });
    gate.setSystemDnd(watcher.current());
  } catch (err) {
    console.error('Failed to watch system Do Not Disturb; assuming disabled:', err);
  }

  return {
    async handle(id, p) {
      knownIds.add(id);
      if (!gate.shouldNotify(id)) return;
      if (!server) return;

      const avatarDeps: AvatarDeps = {
        fetch: (u) => deps.sessionFetch(id, u),
        statMtimeMs: (path) => {
          try {
            return statSync(path).mtimeMs;
          } catch {
            return null;
          }
        },
        writeFile: (path, data) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, data);
        },
        now: () => Date.now(),
      };
      const imagePath = await resolveAvatar(p.icon, avatarDeps, avatarCacheDir());

      try {
        const notifId = await server.notify({
          appName: deps.displayName(id),
          appIcon: deps.serviceIconPath(id),
          summary: p.title,
          body: p.body,
          imagePath,
        });
        pending.set(notifId, { id, href: p.href });
      } catch (err) {
        console.error('notify failed:', err);
      }
    },

    setServiceDnd(id, v) {
      knownIds.add(id);
      gate.setServiceDnd(id, v);
      deps.pushDnd(id, gate.effectiveDnd(id));
      recomputeHidden(id);
    },

    setGlobalDnd(v) {
      gate.setGlobalDnd(v);
      pushDndToAll();
      recomputeHiddenAll();
    },

    setFocused(id, v) {
      knownIds.add(id);
      focused.set(id, v);
      gate.setFocused(id, v);
      recomputeHidden(id);
    },

    setVisible(id, v) {
      knownIds.add(id);
      visible.set(id, v);
      gate.setVisible(id, v);
      recomputeHidden(id);
    },

    registerService(id) {
      knownIds.add(id);
      deps.pushDnd(id, gate.effectiveDnd(id));
      recomputeHidden(id);
    },
  };
}
