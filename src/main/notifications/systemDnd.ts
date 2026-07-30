import { spawn, execFileSync } from 'node:child_process';
import * as dbus from 'dbus-next';
import { isGnome, isKde } from '../trayBackend';
import { isFlatpak } from '../desktop';

const SCHEMA = 'org.gnome.desktop.notifications';
const KEY = 'show-banners';

const HELPER_NAME = 'chat.loft.ShellHelper';
const HELPER_PATH = '/chat/loft/ShellHelper';
const HELPER_DND_PROP = 'SystemDnd';

const NOTIFY_NAME = 'org.freedesktop.Notifications';
const NOTIFY_PATH = '/org/freedesktop/Notifications';
const NOTIFY_DND_PROP = 'Inhibited';

/** Extract the show-banners boolean from `gsettings get`/`monitor` output; null if unparseable. */
export function parseShowBanners(text: string): boolean | null {
  const t = text.trim();
  if (/(^|:\s*)true$/.test(t) || t === 'true') return true;
  if (/(^|:\s*)false$/.test(t) || t === 'false') return false;
  return null;
}

export interface SystemDndDeps {
  /** Best-effort synchronous DND snapshot; null if not yet known (async backends). */
  current(): boolean | null;
  /** Fires on the initial value (possibly async) AND every change. Returns a stopper. */
  watch(onChange: (dnd: boolean) => void): { stop(): void };
}

export interface SystemDndWatcher { current(): boolean; stop(): void }

/**
 * GNOME: gsettings show-banners → DND is the negation (banners off = DND on).
 *
 * Used for UNSANDBOXED GNOME only. `gsettings` cannot work inside the Flatpak — the sandbox
 * has no route to the host's dconf, and (re-verified 2026-07-30, xdg-desktop-portal 1.22.1 /
 * xdg-desktop-portal-gnome 50.0) the XDG Settings portal still exposes no
 * `org.gnome.desktop.notifications` namespace. Worse than merely failing: the schema IS
 * present in the org.freedesktop.Platform runtime, so the sandboxed read succeeds and returns
 * the schema default `show-banners=true` — a confident, wrong "DND is off". That is why the
 * Flatpak routes to shellHelperDeps() instead of here; see selectSystemDndBackend.
 * Do NOT "fix" the sandbox case by reintroducing flatpak-spawn --host.
 */
function gnomeDeps(): SystemDndDeps {
  const read = (): boolean | null => {
    try {
      const b = parseShowBanners(execFileSync('gsettings', ['get', SCHEMA, KEY], { encoding: 'utf8' }));
      return b === null ? null : !b;
    } catch {
      return null;
    }
  };
  return {
    current: read,
    watch(onChange) {
      let child: ReturnType<typeof spawn> | null = null;
      try {
        child = spawn('gsettings', ['monitor', SCHEMA, KEY]);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          for (const line of chunk.split('\n')) {
            const b = parseShowBanners(line);
            if (b !== null) onChange(!b);
          }
        });
        child.on('error', () => {});
      } catch { /* gsettings missing */ }
      return { stop: () => child?.kill() };
    },
  };
}

/** One live view of a boolean DND property. `read` rejects if the owner can't answer. */
export interface HelperDndSource {
  read(): Promise<boolean>;
  /** Subscribe to pushed changes; returns an unsubscriber. */
  subscribe(cb: (v: boolean) => void): () => void;
  /** Release the underlying bus connection. Must be safe to call once, on every path. */
  close(): void;
}

export type HelperConnect = () => Promise<HelperDndSource>;

/**
 * Track a boolean DND property over D-Bus: read it, then follow its PropertiesChanged.
 *
 * Shared by both property-backed backends — the Shell helper's `SystemDnd` and the notification
 * server's `Inhibited` — because they differ only in which name/property they point at. Keeping
 * one implementation means the teardown and stop()-races-setup handling is written and tested
 * once; the two used to be separate copies and only one of them released its bus connection.
 *
 * Degrades to "unknown" (null), never to a confident "off". `label` only names the backend in
 * the debug line, so a silent unknown is diagnosable.
 */
function propertyDeps(connect: HelperConnect, label: string): SystemDndDeps {
  let cached: boolean | null = null;
  return {
    current: () => cached,
    watch(onChange) {
      let stopped = false;
      let cleanup = () => {};
      void (async () => {
        let source: HelperDndSource | undefined;
        try {
          source = await connect();
          const s = source;
          const emit = (v: boolean) => { cached = v; if (!stopped) onChange(v); };
          // Read before subscribing, so the first value the caller sees is the current state
          // rather than whichever change happened to land first. A failing read is tolerated
          // and does NOT cost us the change stream: a server may be mid-startup, and this is
          // long-standing behaviour of the Inhibited backend. Nothing is reported until the
          // owner actually says something.
          try {
            emit(await s.read());
          } catch (e) {
            console.debug(`${label} DND property unreadable:`, (e as Error)?.message ?? e);
          }
          const unsubscribe = s.subscribe(emit);
          cleanup = () => {
            try { unsubscribe(); } catch { /* ignore */ }
            try { s.close(); } catch { /* ignore */ }
          };
          if (stopped) cleanup(); // stop() fired during async setup — tear down what we just built
        } catch (e) {
          // Nothing to follow: no such name, or subscribing failed. Close whatever connect()
          // opened — a leaked session-bus connection under Flatpak keeps the instance alive,
          // and for a desktop with no such property this is the COMMON path, not a rare one.
          try { source?.close(); } catch { /* ignore */ }
          console.debug(`${label} system-DND watch unavailable:`, (e as Error)?.message ?? e);
        }
      })();
      return { stop: () => { stopped = true; cleanup(); } };
    },
  };
}

/**
 * GNOME under Flatpak: the Loft Shell helper's `SystemDnd` property.
 *
 * The only mechanism that reaches the host's DND state from inside the sandbox, and it needs no
 * new permission: the helper is an extension running INSIDE gnome-shell — unsandboxed, with
 * plain Gio.Settings access to org.gnome.desktop.notifications — and Loft already holds
 * `--talk-name=chat.loft.ShellHelper` to drive FocusWindow/HideWindow and the panel menu.
 *
 * A user who declined the extension, or whose EGO-installed helper predates the property, gets
 * "unknown" — the previous behaviour, never a wrong answer.
 */
export function shellHelperDeps(connect: HelperConnect = connectShellHelperDnd): SystemDndDeps {
  return propertyDeps(connect, 'GNOME Shell helper');
}

/**
 * Every other desktop: the `Inhibited` property on org.freedesktop.Notifications. DND is
 * Inhibited directly — no negation, unlike GNOME's show-banners.
 *
 * Not gated on KDE any more, though Plasma is the only server this has been verified against.
 * Probing costs nothing: org.freedesktop.Notifications is already talk-granted (Loft sends its
 * notifications there), and a server without the property answers a clean "No such property",
 * which lands as unknown. So any daemon implementing the inhibition extension works for free
 * rather than being excluded by a desktop allowlist. GNOME is deliberately NOT routed here:
 * gnome-shell implements no properties at all on that interface (measured — GetAll returns {}).
 */
export function inhibitedDeps(connect: HelperConnect = connectInhibitedDnd): SystemDndDeps {
  return propertyDeps(connect, 'org.freedesktop.Notifications Inhibited');
}

/**
 * Live wiring for the property backends: one boolean property on the session bus.
 *
 * Both callers happen to use a bus name that doubles as the interface name, so there is no
 * separate iface argument. The connection is owned here and released by `close()` — including on
 * the failure path, since a name that does not exist is a normal outcome, not an exception.
 */
export async function connectPropertyDnd(
  name: string,
  path: string,
  prop: string,
): Promise<HelperDndSource> {
  const bus = dbus.sessionBus();
  try {
    const obj = await bus.getProxyObject(name, path);
    const props = obj.getInterface('org.freedesktop.DBus.Properties') as unknown as {
      Get(iface: string, prop: string): Promise<{ value: unknown }>;
      on(ev: 'PropertiesChanged', cb: (iface: string, changed: Record<string, { value: unknown }>) => void): void;
      off?(ev: 'PropertiesChanged', cb: (...a: unknown[]) => void): void;
    };
    return {
      read: async () => Boolean((await props.Get(name, prop)).value),
      subscribe: (cb) => {
        const handler = (iface: string, changed: Record<string, { value: unknown }>) => {
          if (iface !== name) return;
          const c = changed[prop];
          if (c) cb(Boolean(c.value));
        };
        props.on('PropertiesChanged', handler);
        return () => { try { props.off?.('PropertiesChanged', handler as never); } catch { /* ignore */ } };
      },
      close: () => { try { bus.disconnect(); } catch { /* ignore */ } },
    };
  } catch (e) {
    try { bus.disconnect(); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * The helper's SystemDnd property. `name`/`path` are parameters only so a probe can point this
 * at a stand-in helper under another bus name — the real extension owns chat.loft.ShellHelper,
 * and gnome-shell cannot be restarted to load a modified one without ending the session.
 * Production always uses the defaults.
 */
export const connectShellHelperDnd = (
  name: string = HELPER_NAME,
  path: string = HELPER_PATH,
): Promise<HelperDndSource> => connectPropertyDnd(name, path, HELPER_DND_PROP);

/** The notification server's own Inhibited property. */
export const connectInhibitedDnd = (): Promise<HelperDndSource> =>
  connectPropertyDnd(NOTIFY_NAME, NOTIFY_PATH, NOTIFY_DND_PROP);

export type SystemDndBackend = 'freedesktop-inhibited' | 'gnome-gsettings' | 'gnome-shell-helper';

/**
 * Which DND backend this desktop gets. Split out from defaultSystemDndDeps so the routing is
 * testable without a live bus — the backends themselves each need one.
 *
 * Only GNOME is special-cased, and only because its notification server exposes no properties
 * to read. It then splits on the sandbox: unsandboxed keeps gsettings (proven, needs no
 * extension), while under Flatpak gsettings cannot work and does not even fail loudly — it
 * returns the schema default, a confident wrong "DND off" (see gnomeDeps) — so it routes to the
 * Shell helper, which sits outside the sandbox and is already reachable. That is also the only
 * GNOME path spawning no `gsettings monitor` child, itself once an unstartable-app bug.
 *
 * Everything else, including KDE and an unset desktop, tries `Inhibited`. There is deliberately
 * no "unsupported desktop" case: the probe is free and self-limiting (see inhibitedDeps), so a
 * daemon that implements it is picked up without Loft having to know the desktop's name.
 */
export function selectSystemDndBackend(env: NodeJS.ProcessEnv): SystemDndBackend {
  if (isGnome(env) && !isKde(env)) return isFlatpak(env) ? 'gnome-shell-helper' : 'gnome-gsettings';
  return 'freedesktop-inhibited';
}

/** Build the DND backend for the current desktop. */
export function defaultSystemDndDeps(env: NodeJS.ProcessEnv): SystemDndDeps {
  switch (selectSystemDndBackend(env)) {
    case 'gnome-gsettings': return gnomeDeps();
    case 'gnome-shell-helper': return shellHelperDeps();
    case 'freedesktop-inhibited': return inhibitedDeps();
  }
}

export function watchSystemDnd(
  onChange: (dnd: boolean) => void,
  deps: SystemDndDeps = defaultSystemDndDeps(process.env),
): SystemDndWatcher {
  let dnd = deps.current() ?? false;
  const w = deps.watch((next) => {
    if (next !== dnd) { dnd = next; onChange(next); }
  });
  return { current: () => dnd, stop: () => w.stop() };
}
