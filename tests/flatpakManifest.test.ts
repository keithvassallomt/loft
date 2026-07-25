import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error - plain .mjs build script, no type declarations
import { toDevManifest, APP_SOURCE_START, APP_SOURCE_END } from '../scripts/flatpakDevManifest.mjs';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const manifest = read('chat.loft.Loft.yml');
const pkgVersion = JSON.parse(read('package.json')).version as string;

/** Structural assertions read YAML, not the manifest's (extensive) prose comments. */
const yaml = (text: string) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/**
 * The repo-root manifest is submitted to FriendlyHub verbatim, so it must satisfy
 * FriendlyHub's submission contract (friendlyhub/submissions README):
 *
 *   "Reference your app's source code using `type: git` with a URL pointing to your
 *    upstream repository (not `type: dir`)"
 *   "Reference any companion source files by filename (e.g. "cargo-sources.json")"
 *
 * A `type: dir` source is invisible on FriendlyHub's builder — its build directory holds
 * only the manifest and its companion files, so the app tree is simply absent and the
 * first build command (`npm ci --offline`) dies with "can only install with an existing
 * package-lock.json". That is exactly how the 1.0.0 submission failed: CI never caught it
 * because CI runs flatpak-builder inside a full checkout, where `path: .` resolves.
 */
describe('FriendlyHub submission contract', () => {
  it('has no type: dir source', () => {
    expect(yaml(manifest)).not.toMatch(/type:\s*dir/);
  });

  it('sources the app from the upstream git repository', () => {
    expect(manifest).toMatch(/^\s+- type: git$/m);
    expect(manifest).toMatch(/^\s+url: https:\/\/github\.com\/keithvassallomt\/loft\.git$/m);
  });

  it('pins the git source to the release tag', () => {
    const tag = manifest.match(/^\s+tag: (\S+)$/m)?.[1];
    expect(tag).toBe(`v${pkgVersion}`);
  });

  it('agrees with the version FriendlyHub reads out of the metainfo', () => {
    // FriendlyHub derives the published version from the newest <release>. If that and the
    // manifest's tag disagree, the store ships one version's code labelled as another.
    const newestRelease = read('data/chat.loft.Loft.metainfo.xml').match(/<release version="([^"]+)"/)?.[1];
    expect(newestRelease).toBe(pkgVersion);
  });

  it('references companion source files by bare filename', () => {
    // Companion files land flat next to the manifest in the FriendlyHub build repo, so a
    // path-qualified reference (`flatpak/generated-sources.json`) does not resolve there.
    const companions = [...manifest.matchAll(/^\s+- ([\w.-]+\.json)$/gm)].map((m) => m[1]);
    expect(companions).toEqual(['generated-sources.json']);
    for (const file of companions) expect(() => read(file)).not.toThrow();
  });
});

/**
 * Local iteration still needs a working-tree build (Keith smoke-tests uncommitted changes on
 * his real Flatpak install), which `type: git` cannot give. The dev manifest is GENERATED
 * from the submitted one rather than hand-maintained, so the two cannot drift.
 */
describe('generated dev manifest', () => {
  const dev = toDevManifest(manifest);

  it('swaps the git source for the working tree', () => {
    expect(dev).toMatch(/^\s+- type: dir$/m);
    expect(dev).toMatch(/^\s+path: \.$/m);
    expect(yaml(dev)).not.toMatch(/type:\s*git/);
  });

  it('keeps host build artifacts out of the copied tree', () => {
    for (const skipped of ['.git', 'node_modules', 'dist', 'dist-electron', 'build-dir', '.flatpak-repo'])
      expect(dev).toMatch(new RegExp(`^\\s+- ${skipped.replace('.', '\\.')}$`, 'm'));
  });

  it('differs from the submitted manifest only inside the app-source block', () => {
    const outside = (text: string) => {
      const start = text.indexOf(APP_SOURCE_START);
      const end = text.indexOf(APP_SOURCE_END);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return text.slice(0, start) + text.slice(end + APP_SOURCE_END.length);
    };
    expect(outside(dev)).toBe(outside(manifest));
  });

  it('is idempotent', () => {
    expect(toDevManifest(dev)).toBe(dev);
  });
});
