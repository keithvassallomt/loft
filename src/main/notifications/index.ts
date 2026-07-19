import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NotificationGate } from './gate';
import { resolveAvatar, avatarCacheDir, type AvatarDeps } from './avatars';
import { connectNotificationServer, type NotificationServer } from './dbus';
import { watchSystemDnd, type SystemDndWatcher } from './systemDnd';

export interface NotifyPayload {
  title: string;
  body: string;
  icon?: string;
  href?: string;
  /** Token identifying the page-side Notification object, so its own click handler can be
   *  replayed. Absent for the DOM-scraped services, which route by href instead. */
  notifyId?: number;
  /** The page life that minted `notifyId`; sent back so a pre-reload id cannot misroute. */
  epoch?: string;
}

export interface NotificationsDeps {
  displayName(id: string): string;
  serviceIconPath(id: string): string;
  sessionFetch(id: string, url: string): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  focusService(id: string): void;
  navigate(id: string, url: string): void;
  /** Replay the click into the page's own notification handler. */
  click(id: string, notifyId: number, epoch: string): void;
  pushDnd(id: string, effectiveDnd: boolean): void;
  pushHidden(id: string, hidden: boolean): void;
}

export interface Notifications {
  handle(id: string, p: NotifyPayload): Promise<void>;
  setServiceDnd(id: string, v: boolean): void;
  setGlobalDnd(v: boolean): void;
  setFocused(id: string, v: boolean): void;
  setVisible(id: string, v: boolean): void;
  /** For a shared host: is this the selected tab? Detached services are always active. */
  setActive(id: string, v: boolean): void;
  registerService(id: string): void;
  /** Release OS resources held by the watcher (the GNOME backend's `gsettings monitor`
   *  child). Must be called on every exit path; safe to call more than once. */
  close(): void;
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
  const active = new Map<string, boolean>();

  let server: NotificationServer | undefined;
  try {
    server = await connectNotificationServer();
  } catch (err) {
    console.error('Failed to connect to org.freedesktop.Notifications; notifications disabled:', err);
  }

  // Clicking a banner older than this does nothing rather than routing — the same trade the
  // page-side registry makes. Without a cap this grows for the whole process lifetime.
  const PENDING_CAP = 200;

  const pending = new Map<number, { id: string; href?: string; notifyId?: number; epoch?: string }>();
  server?.onActionDefault((notifId) => {
    const m = pending.get(notifId);
    if (!m) return;
    pending.delete(notifId);
    deps.focusService(m.id);
    // Focus first: an app's own handler commonly calls window.focus() and should not race
    // ours. A notifyId means the page owns the routing; href is the DOM-scrape path.
    if (m.notifyId !== undefined && m.epoch !== undefined) deps.click(m.id, m.notifyId, m.epoch);
    else if (m.href) deps.navigate(m.id, m.href);
  });

  const pushDndToAll = (): void => {
    for (const id of knownIds) deps.pushDnd(id, gate.effectiveDnd(id));
  };

  // The page is told it's "hidden" whenever it isn't focused+visible, so web apps
  // that gate `new Notification()` on document.hidden still fire while unfocused
  // (main gates delivery; the preload's sound gate gates the in-page ding).
  const recomputeHidden = (id: string): void => {
    const isFocused = focused.get(id) ?? false;
    const isVisible = visible.get(id) ?? false;
    const isActive = active.get(id) ?? true; // detached services have no tab to be behind
    // Deliberately not `!visible`: an unfocused-but-visible service is told it's hidden
    // so web apps that gate new Notification() on document.hidden still fire. An
    // unselected tab is hidden for the same reason.
    deps.pushHidden(id, !(isFocused && isVisible && isActive));
  };

  // Declared out here, not inside the try: close() has to be able to stop it. The GNOME
  // backend spawns a `gsettings monitor` child, and leaving it running outlives the app —
  // under Flatpak that child keeps bwrap alive, so the flatpak instance never exits, GNOME
  // still thinks Loft is running, and clicking its icon activates a corpse instead of
  // launching. Stays undefined when the watcher throws (missing gsettings must not kill
  // startup), so close() has to tolerate that.
  let systemDndWatcher: SystemDndWatcher | undefined;
  try {
    systemDndWatcher = watchSystemDnd((dnd) => {
      gate.setSystemDnd(dnd);
      pushDndToAll();
    });
    gate.setSystemDnd(systemDndWatcher.current());
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
        pending.set(notifId, { id, href: p.href, notifyId: p.notifyId, epoch: p.epoch });
        // Map iterates in insertion order, so the first key is the oldest.
        while (pending.size > PENDING_CAP) {
          const oldest: number | undefined = pending.keys().next().value;
          if (oldest === undefined) break;
          pending.delete(oldest);
        }
      } catch (err) {
        console.error('notify failed:', err);
      }
    },

    setServiceDnd(id, v) {
      knownIds.add(id);
      gate.setServiceDnd(id, v);
      deps.pushDnd(id, gate.effectiveDnd(id));
    },

    setGlobalDnd(v) {
      gate.setGlobalDnd(v);
      pushDndToAll();
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

    setActive(id, v) {
      knownIds.add(id);
      active.set(id, v);
      gate.setActive(id, v);
      recomputeHidden(id);
    },

    registerService(id) {
      knownIds.add(id);
      deps.pushDnd(id, gate.effectiveDnd(id));
      recomputeHidden(id);
    },

    close() {
      systemDndWatcher?.stop();
      systemDndWatcher = undefined; // idempotent: both shutdown routes can fire
    },
  };
}
