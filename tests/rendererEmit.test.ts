import { describe, it, expect } from 'vitest';
import esbuild from 'esbuild';
import { RENDERER_BUNDLES, BUNDLE_OPTIONS, bundleRenderer } from '../scripts/bundleRenderer.mjs';

/**
 * The five renderer entry points are loaded by their index.html as `<script src="...">`
 * (three as type="module", titlebar and recovery as classic scripts). Whatever builds them
 * must therefore emit something a browser can execute directly.
 *
 * They used to be emitted by the main `tsc -p tsconfig.json`, which quietly made the whole
 * app's module format load-bearing for them: a file with no top-level import/export is a
 * SCRIPT to TypeScript and emits bare, so they were only ever browser-safe by accident.
 * Moving tsconfig to module=node16 turned all five into CommonJS modules whose emit opens
 * with `Object.defineProperty(exports, "__esModule", ...)` — `exports` is undefined in a
 * page, so each died on line 2 and Loft came up with an empty rail and a window stuck on
 * the loading cursor (2026-07-25).
 *
 * esbuild now builds them, which removes that coupling entirely. This test is what keeps
 * it removed: it runs the REAL bundle configuration (imported, not restated, so the guard
 * cannot drift from the build) and asserts the output is browser-executable.
 *
 * It fails if someone switches the bundle format to cjs, or routes these files back
 * through a tsc invocation that emits CommonJS.
 */
describe('browser renderer scripts', () => {
  // One build for all five, in memory — nothing is written to dist.
  const built = bundleRenderer({ write: false }).then((results) =>
    results.map((r, i) => ({
      entry: RENDERER_BUNDLES[i].entry,
      js: r.outputFiles.filter((f) => f.path.endsWith('.js')).map((f) => f.text).join(''),
    })),
  );

  it('builds every entry listed in RENDERER_BUNDLES', async () => {
    expect((await built).length).toBe(5);
  });

  it.each(RENDERER_BUNDLES.map((b) => b.entry))('%s is browser-executable', async (entry) => {
    const out = (await built).find((b) => b.entry === entry);
    expect(out, `${entry} produced no bundle`).toBeDefined();
    expect(out!.js, `${entry} produced empty JS`).not.toBe('');

    // The exact prologue that broke these in a browser.
    expect(out!.js).not.toContain('Object.defineProperty(exports');
    // Any reference to the CommonJS globals is equally fatal in a page.
    expect(out!.js).not.toMatch(/\bexports\b/);
    expect(out!.js).not.toMatch(/\bmodule\.exports\b/);
    expect(out!.js).not.toMatch(/\brequire\s*\(/);
  });

  // Bare ESM would break titlebar.js and recovery.js, which their index.html loads as
  // classic <script> rather than <script type="module">.
  it.each(RENDERER_BUNDLES.map((b) => b.entry))('%s does not emit bare ESM syntax', async (entry) => {
    const out = (await built).find((b) => b.entry === entry);
    expect(out!.js).not.toMatch(/^\s*export\s/m);
    expect(out!.js).not.toMatch(/^\s*import\s+[^(]/m);
  });

  /**
   * The assertions above cannot fail today whatever BUNDLE_OPTIONS.format says: all five
   * entries are currently import/export-free, so esbuild emits near-identical output for
   * iife, cjs and esm alike. Verified — flipping the format to cjs or esm leaves every one
   * of them green. On their own they are a smoke test, not a guard.
   *
   * This is the guard. It puts a module-shaped fixture (a top-level export, which is
   * exactly what bundling these files now permits) through the REAL BUNDLE_OPTIONS, where
   * the format does change the output:
   *
   *   cjs  -> `exports.x = ...`          ReferenceError in a page
   *   esm  -> `export { x }`             SyntaxError in a classic <script>
   *   iife -> wrapped, neither           correct
   *
   * So this fails the moment someone changes the format, including before any real entry
   * has grown its first import.
   */
  it('keeps module-shaped input browser-executable (fails if the format changes)', async () => {
    const result = await esbuild.build({
      ...BUNDLE_OPTIONS,
      write: false,
      stdin: { contents: 'export const marker = 1;\nconsole.log(marker);', loader: 'ts' },
    });
    const js = result.outputFiles.map((f) => f.text).join('');

    expect(js).toContain('marker');
    expect(js).not.toMatch(/\bexports\b/);
    expect(js).not.toMatch(/^\s*export\s/m);
    expect(js).not.toMatch(/^\s*import\s+[^(]/m);
  });
});
