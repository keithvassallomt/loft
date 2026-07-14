import { spawn, execFileSync } from 'node:child_process';
import * as dbus from 'dbus-next';
import { isGnome, isKde } from '../trayBackend';

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

/** GNOME: gsettings show-banners → DND is the negation (banners off = DND on). */
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
  if (isGnome(env)) return gnomeDeps();
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
