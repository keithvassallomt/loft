#!/usr/bin/env node
/**
 * Bundle the five browser renderer scripts with esbuild.
 *
 * These are the pages Loft draws itself — the rail, the grid chrome, the grid drop
 * overlay, the service titlebar, and the stuck-view recovery screen. Each is loaded by its
 * own index.html as `<script src="...">`, so the emitted file has to be something a
 * browser can execute directly.
 *
 * They used to be emitted by the main `tsc -p tsconfig.json` invocation, which made the
 * whole app's module format load-bearing for them: a file with no top-level import/export
 * is a SCRIPT to TypeScript and emits bare, but the moment tsconfig moved to
 * module=node16, impliedNodeFormat made every file a CommonJS module and the emit gained
 * `Object.defineProperty(exports, "__esModule", ...)`. `exports` does not exist in a
 * browser, so all five died on line 2 with a ReferenceError — an empty rail and a window
 * stuck on the loading cursor (2026-07-25).
 *
 * Bundling them here fixes that at the root rather than by pinning tsconfig to a
 * deprecated setting: esbuild always emits browser-executable output, so the app's tsc
 * module setting no longer reaches these files at all. It also lifts the rule that they
 * must stay import-free — a bundler resolves imports, so they can now use them.
 *
 * esbuild does NOT type-check. Types are still checked, by `tsc -p tsconfig.renderer.json
 * --noEmit` in the build; keep both steps.
 *
 * The entries and options are exported because tests/rendererEmit.test.ts runs this exact
 * configuration in memory to assert the output stays browser-safe. Import them there
 * rather than restating them, so the guard cannot drift from what actually ships.
 */
import esbuild from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every browser page Loft renders itself. Each is a plain <script> in its index.html. */
export const RENDERER_BUNDLES = [
  { entry: 'src/renderer/rail/rail.ts', outfile: 'dist/renderer/rail/rail.js' },
  { entry: 'src/renderer/grid/grid.ts', outfile: 'dist/renderer/grid/grid.js' },
  { entry: 'src/renderer/gridOverlay/overlay.ts', outfile: 'dist/renderer/gridOverlay/overlay.js' },
  { entry: 'src/renderer/titlebar/titlebar.ts', outfile: 'dist/renderer/titlebar/titlebar.js' },
  { entry: 'src/renderer/recovery/recovery.ts', outfile: 'dist/renderer/recovery/recovery.js' },
];

/**
 * `iife` is the deliberate choice, not `esm`: two of the five (titlebar, recovery) are
 * loaded as classic `<script>` rather than `<script type="module">`, and an IIFE is the
 * one format both tag styles execute. It also keeps each page's top-level declarations out
 * of the shared global scope, which nothing relies on — none of the five assigns to
 * window/globalThis, and no index.html uses inline handlers (both verified).
 *
 * `target` tracks tsconfig's ES2022 so the two toolchains agree on downlevelling.
 */
export const BUNDLE_OPTIONS = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
};

/**
 * Build every renderer bundle. Pass `write: false` to get the output back in memory
 * instead of on disk (what the test does).
 */
export async function bundleRenderer({ write = true } = {}) {
  return Promise.all(
    RENDERER_BUNDLES.map(({ entry, outfile }) =>
      esbuild.build({
        ...BUNDLE_OPTIONS,
        write,
        entryPoints: [resolve(ROOT, entry)],
        outfile: resolve(ROOT, outfile),
      }),
    ),
  );
}

// Only run when invoked as a script, so importing this from a test does not build.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bundleRenderer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
