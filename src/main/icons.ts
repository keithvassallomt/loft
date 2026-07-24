import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND_ICON, CUSTOM_ICON } from './instances';

/** Where the generated variant PNGs live, relative to the bundled icons dir. */
const VARIANTS_SUBDIR = 'variants';

/**
 * Group `<kind>-<colour>.png` filenames into kind → sorted colour keys.
 *
 * Split on the FIRST hyphen: no registry kind id contains one, so everything after it is
 * the colour. Pure so the scan can be tested without a filesystem.
 */
export function parseVariantFiles(files: string[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const f of files) {
    if (!f.endsWith('.png')) continue;
    const base = f.slice(0, -'.png'.length);
    const at = base.indexOf('-');
    if (at <= 0 || at === base.length - 1) continue;
    const kind = base.slice(0, at);
    (map[kind] ??= []).push(base.slice(at + 1));
  }
  for (const k of Object.keys(map)) map[k].sort();
  return map;
}

/**
 * Read the variant index off disk once at startup. A missing directory is not an error —
 * it means this build shipped no variants, and every instance simply keeps the brand icon.
 */
export function scanVariants(assetsDir: string): Record<string, string[]> {
  try {
    return parseVariantFiles(readdirSync(join(assetsDir, VARIANTS_SUBDIR)));
  } catch {
    return {};
  }
}

export function variantLabel(colour: string): string {
  return colour.charAt(0).toUpperCase() + colour.slice(1);
}

/** The colour to give a new instance: first one no sibling has, cycling when all are taken. */
export function pickVariantFor(used: string[], available: string[]): string | undefined {
  if (available.length === 0) return undefined;
  const taken = new Set(used);
  return available.find((c) => !taken.has(c)) ?? available[used.length % available.length];
}

export function variantPngPath(assetsDir: string, kind: string, colour: string): string {
  return join(assetsDir, VARIANTS_SUBDIR, `${kind}-${colour}.png`);
}

export interface IconLookup {
  /** ~/.local/share/loft/icons — where deployed per-instance PNGs live. */
  iconsDir: string;
  /** dist/assets/icons — the bundled brand PNGs and the variants subdir. */
  assetsDir: string;
  id: string;
  kind?: string;
  icon?: string;
}

/**
 * Every path that could serve this icon, best first. Callers take the first that exists.
 *
 * The chain is what keeps a failed or missing copy showing the right logo rather than a
 * blank: a second instance has no bundled `<id>.png` to fall back to, so without the kind
 * step its rail icon would simply be broken. The last entry is the pre-instance behaviour
 * and is what still serves `loft://icon/loft` and the not-yet-added kinds in the gallery.
 */
export function iconCandidates(l: IconLookup): string[] {
  const out = [join(l.iconsDir, `${l.id}.png`)];
  if (l.kind) {
    if (l.icon && l.icon !== BRAND_ICON && l.icon !== CUSTOM_ICON) {
      out.push(variantPngPath(l.assetsDir, l.kind, l.icon));
    }
    out.push(join(l.assetsDir, `${l.kind}.png`));
  }
  const last = join(l.assetsDir, `${l.id}.png`);
  if (!out.includes(last)) out.push(last);
  return out;
}
