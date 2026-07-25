import * as dbus from 'dbus-next';

// The freedesktop cross-desktop appearance setting, read over the XDG Settings portal
// (org.freedesktop.portal.Settings). We use the portal rather than the GNOME color-scheme
// gsetting on purpose: under Flatpak the sandbox has NO dconf access (the manifest grants
// --talk-name=org.freedesktop.portal.Desktop but not dconf), so `gsettings` would read an
// empty sandbox store, while the portal is reachable and cross-desktop (KDE implements it
// too). This is the same signal GTK4/Qt6 apps follow.
const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const SETTINGS_IFACE = 'org.freedesktop.portal.Settings';
const NS = 'org.freedesktop.appearance';
const KEY = 'color-scheme';

/** Peel dbus Variant wrappers off a value until a primitive remains; null if it never is a
 *  number. ReadOne() returns a single `<u>` variant, older Read() a double-wrapped `<<u>>`,
 *  and the SettingChanged signal a `<u>` — one recursive unwrap covers all three. */
function unwrapNumber(v: unknown): number | null {
  let cur = v;
  for (let i = 0; i < 4 && cur !== null && typeof cur === 'object' && 'value' in (cur as object); i++) {
    cur = (cur as { value: unknown }).value;
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
}

/**
 * The org.freedesktop.appearance `color-scheme` value → is-dark, or null when it isn't a
 * scheme we recognise (so callers can leave the current theme untouched).
 *
 * The enum: 0 = no preference, 1 = prefer dark, 2 = prefer light. Only 1 is dark; 0 (no
 * preference) resolves to LIGHT, exactly as the CSS `prefers-color-scheme` media feature
 * does — and GNOME's basic Appearance toggle only ever emits 0 (Default) or 1 (Dark), so
 * the light case a user actually reaches is 0, not 2.
 *
 * Accepts a raw number or a dbus Variant (possibly double-wrapped) so the D-Bus reply and
 * the SettingChanged signal payload both go straight in.
 */
export function colorSchemeToDark(value: unknown): boolean | null {
  const n = unwrapNumber(value);
  if (n === 1) return true;
  if (n === 0 || n === 2) return false;
  return null;
}

export interface AppearanceDeps {
  /** Best-effort synchronous snapshot; null when not yet known (the portal is async). */
  current(): boolean | null;
  /** Fires on the initial value (async) AND every change. Returns a stopper. */
  watch(onChange: (dark: boolean) => void): { stop(): void };
}

export interface AppearanceWatcher {
  /** Last known preference; false until the portal has answered. */
  current(): boolean;
  stop(): void;
}

/** Watch the desktop's light/dark preference over the XDG Settings portal. */
function portalDeps(): AppearanceDeps {
  return {
    current: () => null, // async only — the value arrives via watch()'s initial ReadOne
    watch(onChange) {
      let stopped = false;
      let cleanup = () => {};
      void (async () => {
        try {
          const bus = dbus.sessionBus();
          const obj = await bus.getProxyObject(PORTAL_NAME, PORTAL_PATH);
          const settings = obj.getInterface(SETTINGS_IFACE) as unknown as {
            ReadOne(ns: string, key: string): Promise<unknown>;
            Read(ns: string, key: string): Promise<unknown>;
            on(ev: 'SettingChanged', cb: (ns: string, key: string, value: unknown) => void): void;
            off?(ev: 'SettingChanged', cb: (...a: unknown[]) => void): void;
          };
          const emit = (raw: unknown) => {
            const dark = colorSchemeToDark(raw);
            if (dark !== null && !stopped) onChange(dark);
          };
          // ReadOne is the modern one-key method; fall back to Read (whole namespace, and a
          // double-wrapped value) on portals too old to advertise it.
          try { emit(await settings.ReadOne(NS, KEY)); }
          catch { try { emit(await settings.Read(NS, KEY)); } catch { /* namespace unknown */ } }
          const handler = (ns: string, key: string, value: unknown) => {
            if (ns === NS && key === KEY) emit(value);
          };
          settings.on('SettingChanged', handler);
          cleanup = () => { try { settings.off?.('SettingChanged', handler as never); } catch { /* ignore */ } };
          if (stopped) cleanup(); // stop() fired during async setup — drop the listener now
        } catch (e) {
          console.debug('Appearance (color-scheme) watch unavailable:', (e as Error)?.message ?? e);
        }
      })();
      return { stop: () => { stopped = true; cleanup(); } };
    },
  };
}

export function defaultAppearanceDeps(): AppearanceDeps {
  return portalDeps();
}

/**
 * Follow the desktop's light/dark preference. `onChange` fires with the first known value
 * (once the portal answers) and on every genuine change; identical repeats are swallowed.
 *
 * There is no synchronous seed — the portal is async — so `current()` reports false until the
 * first answer, and callers must treat "not yet fired" as "leave the theme as Chromium set
 * it at startup" (which is already correct on open; only live changes are missed).
 */
export function watchAppearance(
  onChange: (dark: boolean) => void,
  deps: AppearanceDeps = defaultAppearanceDeps(),
): AppearanceWatcher {
  let dark: boolean | null = deps.current();
  const w = deps.watch((next) => {
    if (next !== dark) { dark = next; onChange(next); }
  });
  return { current: () => dark ?? false, stop: () => w.stop() };
}
