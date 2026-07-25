#!/usr/bin/env node
/**
 * Extract one version's section from CHANGELOG.md, for use as GitHub release notes.
 *
 * Without this the release body falls back to whatever the git tag's annotation says,
 * which is how v1.0.1 shipped with terse plain-text notes while v1.0.0 had the full
 * changelog entry — same project, two different-looking releases. Reading the changelog
 * means the release notes and the changelog cannot disagree.
 *
 *   node scripts/changelogSection.mjs 1.0.1            # -> stdout
 *   node scripts/changelogSection.mjs v1.0.1           # leading v is accepted
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    console.error('usage: changelogSection.mjs <version>');
    process.exit(1);
  }
  try {
    process.stdout.write(changelogSection(readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8'), version) + '\n');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
