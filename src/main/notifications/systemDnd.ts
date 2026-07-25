import { spawn, execFileSync } from 'node:child_process';
import * as dbus from 'dbus-next';
import { isGnome, isKde } from '../trayBackend';
import { isFlatpak } from '../desktop';

const SCHEMA = 'org.gnome.desktop.notifications';
const KEY = 'show-banners';

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
 * KNOWN LIMITATION — inert under Flatpak. A modern Flatpak sandbox has no route to the host's
 * dconf: no dconf grant here, and current flatpak dropped the dconf bridge, so `gsettings`
 * inside the sandbox reads only the empty in-sandbox schema defaults (show-banners defaults to
 * true, which masks the failure as "DND never on"). The XDG Settings portal — which the
 * live-theme feature uses successfully for `org.freedesktop.appearance` (see ../appearance.ts)
 * — is the only mechanism that reaches the host, but it exposes a curated namespace set that
 * does NOT include `org.gnome.desktop.notifications`, so there is no portal read to switch to.
 * Left as-is on purpose: GNOME Shell suppresses the banner for anything Loft sends over
 * org.freedesktop.Notifications while DND is on regardless, so the gap is largely cosmetic
 * (the in-page sound gate, and message-tray entries), and Loft's own global DND is the
 * substitute. Do NOT "fix" this by reintroducing flatpak-spawn --host. See CLAUDE.md §9.
 * Unpackaged/dev runs are unsandboxed and work fine, which is why this only bites the Flatpak.
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

const NOOP_DEPS: SystemDndDeps = { current: () => null, watch: () => ({ stop: () => {} }) };

/** Pick the DND backend for the current desktop (KDE → Plasma, GNOME → gsettings, else none). */
export function defaultSystemDndDeps(env: NodeJS.ProcessEnv): SystemDndDeps {
  if (isKde(env)) return kdeDeps();
  // GNOME-under-Flatpak gets the no-op, not gnomeDeps(): the sandboxed gsettings read can
  // only ever return the empty in-sandbox schema default (see the KNOWN LIMITATION above),
  // so the backend is inert there — but its `gsettings monitor` child is not free. Node
  // does not reap it, and a survivor holds bwrap open, leaving the flatpak instance alive
  // and the app unstartable (GNOME activates the corpse instead of launching). Killing it
  // at exit is no longer an option: the session-end handler has ~21ms under Flatpak and
  // does nothing but exit (shutdown.ts). So don't start it. NOOP_DEPS.current() returns
  // null — "unknown" — which is honest, where the sandboxed read would claim "DND off".
  if (isGnome(env)) return isFlatpak(env) ? NOOP_DEPS : gnomeDeps();
  return NOOP_DEPS;
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
