import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error - plain .mjs build script, no type declarations
import { changelogSection, releaseNotes } from '../scripts/changelogSection.mjs';

const root = resolve(__dirname, '..');
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const pkgVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version as string;

/**
 * The release workflow feeds this to action-gh-release as body_path. Without it the body
 * falls back to the git tag's annotation, which is how v1.0.1 shipped with terse
 * plain-text notes while v1.0.0 carried the full changelog entry.
 */
describe('changelogSection', () => {
  it('extracts a section without its heading, stopping at the next version', () => {
    const md = [
      '# Changelog', '',
      '## [2.0.0] - 2026-01-02', '', '### Fixed', '- the new thing', '',
      '## [1.0.0] - 2026-01-01', '', '### Added', '- the old thing', '',
    ].join('\n');

    expect(changelogSection(md, '2.0.0')).toBe('### Fixed\n- the new thing');
  });

  it('accepts a v-prefixed tag name', () => {
    const md = '## [1.2.3] - 2026-01-01\n\n- body\n';
    expect(changelogSection(md, 'v1.2.3')).toBe('- body');
  });

  it('reads the last section when nothing follows it', () => {
    const md = '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n- only entry\n';
    expect(changelogSection(md, '1.0.0')).toBe('- only entry');
  });

  it('does not match a different version that shares a prefix', () => {
    const md = '## [1.0.10] - 2026-01-02\n\n- ten\n\n## [1.0.1] - 2026-01-01\n\n- one\n';
    expect(changelogSection(md, '1.0.1')).toBe('- one');
  });

  // A release shipping empty notes is worse than a failed release: it is silent.
  it('throws for a version with no section', () => {
    expect(() => changelogSection('## [1.0.0] - 2026-01-01\n\n- x\n', '9.9.9')).toThrow(/no section/);
  });

  it('throws for a section with no content', () => {
    expect(() => changelogSection('## [1.0.0] - 2026-01-01\n\n## [0.9.0] - 2025-01-01\n\n- x\n', '1.0.0')).toThrow(/empty/);
  });

  // Guards the release itself: the version being shipped must have notes to ship.
  it('finds a section for the current package version', () => {
    expect(changelogSection(changelog, pkgVersion).length).toBeGreaterThan(0);
  });
});

/**
 * The installation footer (FriendlyHub badge, install line, Full Changelog link) used to be
 * pasted onto every release by hand — it was added manually to both v1.0.0 and v1.0.1. It
 * now ships automatically, appended to every tagged release's notes.
 */
describe('releaseNotes', () => {
  const footer = readFileSync(resolve(root, '.github/release-notes-footer.md'), 'utf8');

  it('appends the footer after the changelog section', () => {
    const md = '## [1.0.0] - 2026-01-01\n\n- the entry\n';

    const notes = releaseNotes(md, '1.0.0', '## Install\n\nbadge here\n');

    expect(notes).toBe('- the entry\n\n## Install\n\nbadge here');
  });

  it('still fails when the version has no section, rather than emitting a bare footer', () => {
    expect(() => releaseNotes('## [1.0.0] - 2026-01-01\n\n- x\n', '9.9.9', 'footer')).toThrow(/no section/);
  });

  // The footer file is what the workflow ships; if it were emptied or the badge dropped,
  // every future release would silently lose its install links.
  it('has a footer file carrying the FriendlyHub badge and changelog link', () => {
    expect(footer).toContain('https://friendlyhub.org/apps/chat.loft.Loft');
    expect(footer).toContain('## 📦 Installation');
    expect(footer).toContain('**Full Changelog**');
  });

  it('produces notes for the current version containing both parts', () => {
    const notes = releaseNotes(changelog, pkgVersion, footer);

    expect(notes).toContain('### Fixed');
    expect(notes).toContain('https://friendlyhub.org/apps/chat.loft.Loft');
    expect(notes.indexOf('### Fixed')).toBeLessThan(notes.indexOf('## 📦 Installation'));
  });
});
