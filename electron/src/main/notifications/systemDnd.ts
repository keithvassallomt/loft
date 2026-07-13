import { spawn, execFileSync } from 'node:child_process';

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
  getInitial(): string | null;
  spawnMonitor(onLine: (line: string) => void): { kill(): void };
}

export interface SystemDndWatcher { current(): boolean; stop(): void }

// Stage 4.5 (KDE): system-DND detection is GNOME-only today (gsettings show-banners).
// KDE/Plasma has its own notification-inhibition (Do Not Disturb) mechanism — add a
// `kdeDeps()` alongside gnomeDeps() and select it on Plasma so OS-level DND gates Loft
// notifications there too. Per-service DND + the focus-gate already work on KDE; only
// this system-wide auto-detect is missing. Confirm the exact Plasma D-Bus interface at
// implementation (spec §13 open item), when there is a KDE test environment.
function gnomeDeps(): SystemDndDeps {
  return {
    getInitial() {
      try {
        return execFileSync('gsettings', ['get', SCHEMA, KEY], { encoding: 'utf8' });
      } catch {
        return null;
      }
    },
    spawnMonitor(onLine) {
      let child: ReturnType<typeof spawn> | null = null;
      try {
        child = spawn('gsettings', ['monitor', SCHEMA, KEY]);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          for (const line of chunk.split('\n')) if (line.trim()) onLine(line);
        });
        child.on('error', () => {});
      } catch { /* gsettings missing */ }
      return { kill: () => child?.kill() };
    },
  };
}

export function watchSystemDnd(
  onChange: (dnd: boolean) => void,
  deps: SystemDndDeps = gnomeDeps(),
): SystemDndWatcher {
  const banners = parseShowBanners(deps.getInitial() ?? '');
  let dnd = banners === null ? false : !banners; // no reading → assume notifications allowed

  const monitor = deps.spawnMonitor((line) => {
    const b = parseShowBanners(line);
    if (b === null) return;
    const next = !b;
    if (next !== dnd) { dnd = next; onChange(dnd); }
  });

  return { current: () => dnd, stop: () => monitor.kill() };
}
