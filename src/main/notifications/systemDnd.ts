import { spawn, execFileSync } from 'node:child_process';
import * as dbus from 'dbus-next';
import { isGnome, isKde } from '../trayBackend';
import { isFlatpak } from '../desktop';

const SCHEMA = 'org.gnome.desktop.notifications';
const KEY = 'show-banners';

const HELPER_NAME = 'chat.loft.ShellHelper';
const HELPER_PATH = '/chat/loft/ShellHelper';
const HELPER_DND_PROP = 'SystemDnd';

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

/** KDE/Plasma: the Inhibited property on org.freedesktop.Notifications. DND = Inhibited directly. */
function kdeDeps(): SystemDndDeps {
  let cached: boolean | null = null;
  return {
    current: () => cached,
    watch(onChange) {
      let stopped = false;
      let cleanup = () => {};
      void (async () => {
        try {
          const bus = dbus.sessionBus();
          const obj = await bus.getProxyObject('org.freedesktop.Notifications', '/org/freedesktop/Notifications');
          const props = obj.getInterface('org.freedesktop.DBus.Properties') as unknown as {
            Get(iface: string, prop: string): Promise<{ value: unknown }>;
            on(ev: 'PropertiesChanged', cb: (iface: string, changed: Record<string, { value: unknown }>, invalidated: string[]) => void): void;
            off?(ev: 'PropertiesChanged', cb: (...a: unknown[]) => void): void;
          };
          const emit = (v: boolean) => { cached = v; if (!stopped) onChange(v); };
          try {
            const variant = await props.Get('org.freedesktop.Notifications', 'Inhibited');
            emit(Boolean(variant.value));
          } catch { /* property unavailable */ }
          const handler = (iface: string, changed: Record<string, { value: unknown }>) => {
            if (iface !== 'org.freedesktop.Notifications') return;
            const c = changed['Inhibited'];
            if (c) emit(Boolean(c.value));
          };
          props.on('PropertiesChanged', handler);
          cleanup = () => { try { props.off?.('PropertiesChanged', handler as never); } catch { /* ignore */ } };
          if (stopped) cleanup(); // stop() fired during async setup — remove the just-registered listener now
        } catch (e) {
          console.debug('KDE system-DND watch unavailable:', (e as Error)?.message ?? e);
        }
      })();
      return { stop: () => { stopped = true; cleanup(); } };
    },
  };
}

/** One live view of the helper's system-DND state. `read` rejects if the helper can't answer. */
export interface HelperDndSource {
  read(): Promise<boolean>;
  /** Subscribe to pushed changes; returns an unsubscriber. */
  subscribe(cb: (v: boolean) => void): () => void;
  /** Release the underlying bus connection. Must be safe to call once, on every path. */
  close(): void;
}

export type HelperConnect = () => Promise<HelperDndSource>;

/**
 * Read GNOME's system DND from the Loft Shell helper's `SystemDnd` property.
 *
 * This is the only mechanism that reaches the host's DND state from inside the Flatpak, and it
 * needs no new sandbox permission: the helper is an extension running INSIDE gnome-shell — so
 * unsandboxed, with plain Gio.Settings access to org.gnome.desktop.notifications — and Loft
 * already holds `--talk-name=chat.loft.ShellHelper` to drive FocusWindow/HideWindow and the
 * panel menu. Shaped exactly like kdeDeps: read a property, then follow PropertiesChanged.
 *
 * Degrades to "unknown" (null), never to a confident "off": a user who declined the extension,
 * or whose EGO-installed helper predates the property, gets today's behaviour rather than a
 * wrong answer.
 */
export function shellHelperDeps(connect: HelperConnect = connectShellHelperDnd): SystemDndDeps {
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
          const emit = (v: boolean) => { cached = v; if (!stopped) onChange(v); };
          // Read before subscribing, so the first value the caller sees is the current state
          // rather than whichever change happened to land first.
          emit(await source.read());
          const unsubscribe = source.subscribe(emit);
          const s = source;
          cleanup = () => {
            try { unsubscribe(); } catch { /* ignore */ }
            try { s.close(); } catch { /* ignore */ }
          };
          if (stopped) cleanup(); // stop() fired during async setup — tear down what we just built
        } catch (e) {
          // Includes the missing/old-helper case. Close whatever connect() managed to open:
          // a leaked session-bus connection under Flatpak keeps the instance alive, and this
          // is the COMMON path for an out-of-date helper, not a rare one.
          try { source?.close(); } catch { /* ignore */ }
          console.debug('GNOME Shell helper system-DND unavailable:', (e as Error)?.message ?? e);
        }
      })();
      return { stop: () => { stopped = true; cleanup(); } };
    },
  };
}

/**
 * Live wiring for shellHelperDeps: the helper's SystemDnd property over the session bus.
 *
 * `name`/`path` are parameters only so a probe can point this at a stand-in helper under
 * another bus name — the real extension owns chat.loft.ShellHelper, and gnome-shell cannot be
 * restarted to load a modified one without ending the session. Production always uses the
 * defaults.
 */
export async function connectShellHelperDnd(
  name: string = HELPER_NAME,
  path: string = HELPER_PATH,
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
      read: async () => Boolean((await props.Get(name, HELPER_DND_PROP)).value),
      subscribe: (cb) => {
        const handler = (iface: string, changed: Record<string, { value: unknown }>) => {
          if (iface !== name) return;
          const c = changed[HELPER_DND_PROP];
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

const NOOP_DEPS: SystemDndDeps = { current: () => null, watch: () => ({ stop: () => {} }) };

export type SystemDndBackend = 'kde' | 'gnome-gsettings' | 'gnome-shell-helper' | 'none';

/**
 * Which DND backend this desktop gets. Split out from defaultSystemDndDeps so the routing is
 * testable without a live bus — the backends themselves each need one.
 *
 * GNOME splits on the sandbox. Unsandboxed keeps gsettings: proven, and it needs no extension.
 * Under Flatpak gsettings cannot work and does not even fail loudly (it returns the schema
 * default, a confident wrong "DND off" — see gnomeDeps), so it routes to the Shell helper,
 * which is outside the sandbox and already reachable. It is also the only GNOME path that
 * spawns no `gsettings monitor` child, which under Flatpak was its own unstartable-app bug.
 */
export function selectSystemDndBackend(env: NodeJS.ProcessEnv): SystemDndBackend {
  if (isKde(env)) return 'kde'; // Inhibited rides org.freedesktop.Notifications: works sandboxed
  if (isGnome(env)) return isFlatpak(env) ? 'gnome-shell-helper' : 'gnome-gsettings';
  return 'none';
}

/** Build the DND backend for the current desktop. */
export function defaultSystemDndDeps(env: NodeJS.ProcessEnv): SystemDndDeps {
  switch (selectSystemDndBackend(env)) {
    case 'kde': return kdeDeps();
    case 'gnome-gsettings': return gnomeDeps();
    case 'gnome-shell-helper': return shellHelperDeps();
    default: return NOOP_DEPS;
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
