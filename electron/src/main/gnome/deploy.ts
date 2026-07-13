import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

// Distinct UUID from the production (Rust) Loft helper (`loft-shell-helper@loft.chat`)
// so the Electron rewrite's helper installs alongside it and never clobbers it.
const UUID = 'loft-shell-helper-next@loft.chat';

export function helperVersion(metadataJson: string): number[] {
  try {
    const v = JSON.parse(metadataJson)?.['version-name'];
    if (typeof v !== 'string') return [];
    return v.split('.').map((p) => Number.parseInt(p, 10)).filter((n) => Number.isInteger(n));
  } catch { return []; }
}

/** Numeric lexicographic compare (Rust Vec<u32> Ord): element-wise, then length. */
export function compareVersions(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -1, y = b[i] ?? -1; // shorter-equal-prefix is smaller
    if (x !== y) return x - y;
  }
  return 0;
}

export interface DeployDeps {
  dataHome: string;        // $XDG_DATA_HOME or ~/.local/share
  resourcesDir: string;    // where copy-assets staged the helper (dist/assets)
  runGnomeExtensionsEnable(): void; // best-effort `gnome-extensions enable <UUID>`
}

/** Deploy the bundled helper if missing or strictly newer than installed. Returns true iff (re)written. */
export function deployGnomeExtension(deps: DeployDeps): boolean {
  const extSrc = join(deps.resourcesDir, 'gnome-shell-extension');
  const extDir = join(deps.dataHome, 'gnome-shell', 'extensions', UUID);

  const bundled = helperVersion(readFileSync(join(extSrc, 'metadata.json'), 'utf8'));
  const installedMetaPath = join(extDir, 'metadata.json');
  if (existsSync(installedMetaPath)) {
    const installed = helperVersion(readFileSync(installedMetaPath, 'utf8'));
    if (compareVersions(installed, bundled) >= 0) return false; // up-to-date / newer EGO build
  }

  mkdirSync(join(extDir, 'icons'), { recursive: true });
  copyFileSync(join(extSrc, 'metadata.json'), join(extDir, 'metadata.json'));
  copyFileSync(join(extSrc, 'extension.js'), join(extDir, 'extension.js'));
  copyFileSync(join(extSrc, 'icons', 'show-window-symbolic.svg'), join(extDir, 'icons', 'show-window-symbolic.svg'));
  copyFileSync(join(extSrc, 'icons', 'hide-window-symbolic.svg'), join(extDir, 'icons', 'hide-window-symbolic.svg'));

  // Combined panel icon is a themed St.Icon({icon_name:'loft-symbolic'}) → install it
  // into the icon theme (port of ensure_combined_icon, src/desktop.rs:612-621).
  const iconThemeDir = join(deps.dataHome, 'icons', 'hicolor', 'scalable', 'apps');
  mkdirSync(iconThemeDir, { recursive: true });
  copyFileSync(join(deps.resourcesDir, 'loft-symbolic.svg'), join(iconThemeDir, 'loft-symbolic.svg'));

  deps.runGnomeExtensionsEnable();
  return true;
}
