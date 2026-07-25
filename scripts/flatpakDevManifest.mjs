#!/usr/bin/env node
/**
 * Generate the local-iteration Flatpak manifest from the submitted one.
 *
 * `chat.loft.Loft.yml` is uploaded to FriendlyHub verbatim, so its app source must be
 * `type: git` pinned to the release tag — FriendlyHub's builder has only the manifest and
 * its companion files, no checkout, so a `type: dir` source resolves to nothing there and
 * the build dies on `npm ci --offline` for want of a package-lock.json.
 *
 * That is useless for local work: a git source builds the *pushed tag*, never the working
 * tree, and Keith smoke-tests uncommitted changes on his real Flatpak install. So the dev
 * manifest is derived here — swapping only the marker-delimited app-source block for a
 * `type: dir` source — rather than hand-maintained as a second copy that would drift.
 *
 *   node scripts/flatpakDevManifest.mjs        # writes chat.loft.Loft.dev.yml (gitignored)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_SOURCE_START = '      # >>> app source (generated: scripts/flatpakDevManifest.mjs) >>>';
export const APP_SOURCE_END = '      # <<< app source <<<';

/** The working-tree source. `skip` keeps the copy small and forces a clean offline install. */
const DIR_SOURCE = [
  '      - type: dir',
  '        path: .',
  '        skip:',
  '          - .git',
  '          - build-dir',
  '          - .flatpak-repo',
  '          - target',
  '          - node_modules',
  '          - dist',
  '          - dist-electron',
].join('\n');

/**
 * Replace the manifest's app-source block with a working-tree `type: dir` source.
 * Idempotent: the markers survive the rewrite, so re-running is a no-op.
 */
export function toDevManifest(manifest) {
  const start = manifest.indexOf(APP_SOURCE_START);
  const end = manifest.indexOf(APP_SOURCE_END);
  if (start === -1 || end === -1)
    throw new Error(`chat.loft.Loft.yml is missing its app-source markers (${APP_SOURCE_START})`);

  return (
    manifest.slice(0, start) +
    APP_SOURCE_START + '\n' + DIR_SOURCE + '\n' +
    manifest.slice(end)
  );
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const src = resolve(root, 'chat.loft.Loft.yml');
  const out = resolve(root, 'chat.loft.Loft.dev.yml');
  writeFileSync(out, toDevManifest(readFileSync(src, 'utf8')));
  console.log(`wrote ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
