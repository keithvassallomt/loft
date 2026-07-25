import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The five renderer entry points that each index.html loads as a PLAIN <script src="...">
 * (verified by grepping the src= attributes out of every renderer index.html). They are
 * not bundled and not ES modules — they run in the page's global scope.
 *
 * That is why they are deliberately import/export-free: a file with no top-level
 * import/export is a SCRIPT to TypeScript, so tsc emits it bare. Add an import to one, or
 * change tsconfig's `module` to node16/nodenext, and tsc instead emits a CommonJS module
 * prologue — `Object.defineProperty(exports, "__esModule", { value: true })`. `exports`
 * does not exist in a browser, so the script dies on line 2 with a ReferenceError and the
 * whole view comes up blank.
 *
 * That happened for real (2026-07-25): moving tsconfig to module/moduleResolution "node16"
 * to clear a deprecation broke all five at once. The visible symptom was an empty rail and
 * a Loft window stuck showing the loading cursor — nothing in the journal, no failing test,
 * because tests/ is excluded from tsc and svelte-check only covers the Svelte hub. This
 * test is the guard that was missing.
 */
const BROWSER_SCRIPTS = [
  'src/renderer/rail/rail.ts',
  'src/renderer/grid/grid.ts',
  'src/renderer/gridOverlay/overlay.ts',
  'src/renderer/titlebar/titlebar.ts',
  'src/renderer/recovery/recovery.ts',
];

/** Compile one file with the project's REAL tsconfig and return the emitted JS. */
function emitWithProjectConfig(entry: string): string {
  const configPath = resolve(ROOT, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(read.error, `could not read ${configPath}`).toBeUndefined();

  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT);
  const options: ts.CompilerOptions = { ...parsed.options, outDir: undefined, noEmit: false, declaration: false, sourceMap: false };

  const entryPath = resolve(ROOT, entry);
  const program = ts.createProgram([entryPath], options);

  // Emit ONLY the entry. These scripts type-reference main-process modules (railModel,
  // config, …) for their shared types, so those get pulled into the program — and an
  // emit(undefined, …) would hand us their output too. Those files are genuine CommonJS
  // modules whose `exports` is entirely correct, so folding them in here would fail the
  // assertion below for the wrong reason.
  const sourceFile = program.getSourceFile(entryPath);
  expect(sourceFile, `${entry} is not in the program`).toBeDefined();

  let output = '';
  program.emit(sourceFile, (fileName, text) => {
    if (fileName.endsWith('.js')) output += text;
  });
  return output;
}

describe('browser renderer scripts', () => {
  it.each(BROWSER_SCRIPTS)('%s emits as a bare script, not a CommonJS module', (entry) => {
    const js = emitWithProjectConfig(entry);

    expect(js, `${entry} produced no JS`).not.toBe('');
    // The exact prologue that breaks these in a browser.
    expect(js).not.toContain('Object.defineProperty(exports');
    // Any reference to the CommonJS globals is equally fatal in a plain <script>.
    expect(js).not.toMatch(/\bexports\b/);
    expect(js).not.toMatch(/\brequire\s*\(/);
  });
});
