import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { helperVersion, compareVersions, deployGnomeExtension } from '../src/main/gnome/deploy';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('helperVersion + compareVersions', () => {
  it('parses version-name like the Rust helper_version', () => {
    expect(helperVersion('{"version-name":"1.4"}')).toEqual([1, 4]);
    expect(helperVersion('{"version-name":"2"}')).toEqual([2]);
    expect(helperVersion('{}')).toEqual([]);
    expect(helperVersion('not json')).toEqual([]);
  });
  it('compares numerically per segment, not as strings', () => {
    expect(compareVersions([1, 10], [1, 2]) > 0).toBe(true);   // 1.10 > 1.2
    expect(compareVersions([1, 2], [1, 2]) === 0).toBe(true);
    expect(compareVersions([1, 2], [1, 2, 0]) < 0).toBe(true); // shorter-equal-prefix is smaller
    expect(compareVersions([], [1]) < 0).toBe(true);
  });
});

describe('deployGnomeExtension', () => {
  let dataHome: string, resourcesDir: string;
  const makeResources = (): string => {
    const r = mkdtempSync(join(tmpdir(), 'loft-res-'));
    const ext = join(r, 'gnome-shell-extension', 'icons');
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(r, 'gnome-shell-extension', 'metadata.json'), '{"version-name":"1.4"}');
    writeFileSync(join(r, 'gnome-shell-extension', 'extension.js'), '// v1.4');
    writeFileSync(join(ext, 'show-window-symbolic.svg'), '<svg/>');
    writeFileSync(join(ext, 'hide-window-symbolic.svg'), '<svg/>');
    writeFileSync(join(r, 'loft-symbolic.svg'), '<svg/>');
    return r;
  };
  beforeEach(() => { dataHome = mkdtempSync(join(tmpdir(), 'loft-data-')); resourcesDir = makeResources(); });
  afterEach(() => { rmSync(dataHome, { recursive: true, force: true }); rmSync(resourcesDir, { recursive: true, force: true }); });

  const run = () => { let enabled = false;
    const wrote = deployGnomeExtension({ dataHome, resourcesDir, runGnomeExtensionsEnable: () => { enabled = true; } });
    return { wrote, enabled };
  };

  it('deploys when missing (returns true, enables, writes all files + symbolic icon)', () => {
    const { wrote, enabled } = run();
    expect(wrote).toBe(true);
    expect(enabled).toBe(true);
    const extDir = join(dataHome, 'gnome-shell/extensions/loft-shell-helper-next@loft.chat');
    expect(existsSync(join(extDir, 'extension.js'))).toBe(true);
    expect(existsSync(join(extDir, 'icons/show-window-symbolic.svg'))).toBe(true);
    expect(existsSync(join(dataHome, 'icons/hicolor/scalable/apps/loft-symbolic.svg'))).toBe(true);
  });

  it('no-ops when installed version >= bundled (returns false)', () => {
    run();
    writeFileSync(
      join(dataHome, 'gnome-shell/extensions/loft-shell-helper-next@loft.chat/metadata.json'),
      '{"version-name":"1.4"}',
    );
    expect(run().wrote).toBe(false);
  });

  it('never downgrades a newer EGO build', () => {
    run();
    writeFileSync(
      join(dataHome, 'gnome-shell/extensions/loft-shell-helper-next@loft.chat/metadata.json'),
      '{"version-name":"1.9"}',
    );
    expect(run().wrote).toBe(false);
  });

  it('redeploys when installed is older', () => {
    const extDir = join(dataHome, 'gnome-shell/extensions/loft-shell-helper-next@loft.chat');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'metadata.json'), '{"version-name":"1.3"}');
    expect(run().wrote).toBe(true);
    expect(readFileSync(join(extDir, 'extension.js'), 'utf8')).toBe('// v1.4');
  });
});
