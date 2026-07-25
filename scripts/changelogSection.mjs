#!/usr/bin/env node
/**
 * Build a GitHub release body: the version's CHANGELOG.md section, plus the standing
 * installation footer.
 *
 * Without this the release body falls back to whatever the git tag's annotation says,
 * which is how v1.0.1 shipped with terse plain-text notes while v1.0.0 had the full
 * changelog entry — same project, two different-looking releases. Reading the changelog
 * means the release notes and the changelog cannot disagree.
 *
 * The footer (FriendlyHub badge, install line, Full Changelog link) lives in
 * .github/release-notes-footer.md rather than in here, so it can be edited without
 * touching code. It used to be pasted onto every release by hand.
 *
 *   node scripts/changelogSection.mjs 1.0.1            # -> stdout
 *   node scripts/changelogSection.mjs v1.0.1           # leading v is accepted
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FOOTER_PATH = resolve(ROOT, '.github/release-notes-footer.md');

/**
 * Return the body of the `## [<version>] - <date>` section, without its heading.
 * Throws if the version has no section — a release must never silently ship empty notes.
 */
export function changelogSection(changelog, version) {
  const v = version.replace(/^v/, '');
  const lines = changelog.split('\n');
  // Match the heading for THIS version only. The date part varies, so it is not matched.
  const isHeadingFor = (l) => new RegExp(`^## \\[${v.replace(/\./g, '\\.')}\\]`).test(l);
  const isAnyVersionHeading = (l) => /^## \[/.test(l);

  const start = lines.findIndex(isHeadingFor);
  if (start === -1) throw new Error(`CHANGELOG.md has no section for version ${v}`);

  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isAnyVersionHeading);
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();

  if (!body) throw new Error(`CHANGELOG.md section for ${v} is empty`);
  return body;
}

/** The full release body: changelog section, then the standing footer. */
export function releaseNotes(changelog, version, footer) {
  return `${changelogSection(changelog, version)}\n\n${footer.trim()}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    console.error('usage: changelogSection.mjs <version>');
    process.exit(1);
  }
  try {
    // Both reads are allowed to throw: a release that quietly ships without its notes, or
    // without the install badge, is worse than one that fails loudly in CI.
    const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
    const footer = readFileSync(FOOTER_PATH, 'utf8');
    process.stdout.write(releaseNotes(changelog, version, footer) + '\n');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
