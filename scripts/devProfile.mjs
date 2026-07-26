#!/usr/bin/env node
/**
 * Run the working-tree build against the profile of the INSTALLED FLATPAK, so dev sessions
 * inherit real logins instead of asking for a QR scan every time — and without building and
 * installing a Flatpak to test a one-line change.
 *
 * Loft locates everything through two env vars (src/main/paths.ts), and `app.setPath` puts
 * Electron's userData — which is where `persist:<id>` partitions live — under XDG_DATA_HOME
 * too (src/main/index.ts). So pointing those two at the Flatpak's sandbox home is the whole
 * mechanism; nothing in the app needs a dev branch.
 *
 *   Flatpak config : ~/.var/app/chat.loft.Loft/config/loft/config.json
 *   Flatpak data   : ~/.var/app/chat.loft.Loft/data/loft/{Partitions,icons,avatars}
 *
 * Two modes, because pointing a dev build at 1.7 GB of real logins is not risk-free:
 *
 *   clone (default)  Copy-on-write snapshot into ~/.local/share/loft-devprofile, then run
 *                    against that. On btrfs/XFS the reflink is near-instant and costs almost
 *                    no disk until the copies diverge. The real profile is never opened, so a
 *                    dev bug cannot corrupt it and dev can run WHILE the Flatpak is running.
 *                    Logins are inherited once; `--refresh` re-snapshots.
 *
 *   --live           Open the Flatpak's own profile directly. Changes persist both ways —
 *                    which is the point when testing a config migration, and the hazard the
 *                    rest of the time. Refuses to start while the Flatpak is running (two
 *                    Chromium processes on one profile corrupts it) and snapshots config.json
 *                    to config.json.predev.bak first.
 *
 * Usage (args after `--` are forwarded to Electron):
 *   npm run dev                          # clone mode
 *   npm run dev -- --service=whatsapp    # ... straight into a service, e.g. for a spike
 *   npm run dev:refresh                  # re-snapshot from the Flatpak, then run
 *   npm run dev:live                     # against the real profile
 */
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const APP_ID = 'chat.loft.Loft';
const REAL_FLATPAK_HOME = join(homedir(), '.var', 'app', APP_ID);
/** Test seam: point the source elsewhere to exercise the clone against a synthetic profile. */
const FLATPAK_HOME = process.env.LOFT_FLATPAK_HOME || REAL_FLATPAK_HOME;
/** The "is it running" guards protect the REAL profile; an overridden source is not it. */
const USING_REAL_FLATPAK = FLATPAK_HOME === REAL_FLATPAK_HOME;
const CLONE_DIR = process.env.LOFT_DEV_PROFILE || join(homedir(), '.local', 'share', 'loft-devprofile');
/** Guards the rm -rf on --refresh: a profile dir must look like one before we delete it. */
const CLONE_MARKER = 'loft-devprofile';

const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1); };

/**
 * True when the packaged app is running. Uses `flatpak ps` rather than a process-name match,
 * which would also hit this script's own command line.
 */
function flatpakRunning() {
  const r = spawnSync('flatpak', ['ps', '--columns=application'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null; // flatpak absent or unhappy — caller decides
  return r.stdout.split('\n').some((line) => line.trim() === APP_ID);
}

function refuseIfRunning(why) {
  if (!USING_REAL_FLATPAK) return;
  const running = flatpakRunning();
  if (running === null) {
    console.warn(`  ! Could not ask flatpak whether ${APP_ID} is running — continuing.`);
    return;
  }
  if (running) die(`${APP_ID} is running. ${why}\n  Quit it (tray -> Quit Loft) and try again.`);
}

/** `cp -a --reflink=auto`: a COW clone on btrfs/XFS, a plain copy elsewhere. */
function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  const r = spawnSync('cp', ['-a', '--reflink=auto', `${src}/.`, dest], { stdio: 'inherit' });
  if (r.status !== 0) die(`Copy failed: ${src} -> ${dest}`);
}

function assertSafeCloneDir(dir) {
  if (!dir.startsWith(homedir()) || !basename(dir).includes(CLONE_MARKER)) {
    die(`Refusing to delete ${dir}: it must live under $HOME and be named *${CLONE_MARKER}*.`);
  }
}

function buildClone({ refresh }) {
  const ready = existsSync(join(CLONE_DIR, 'config', 'loft', 'config.json'));
  if (ready && !refresh) return;

  // A snapshot taken while the app is writing can tear its cookie/session databases — and a
  // torn snapshot means logging in again, which is the one thing this script exists to avoid.
  refuseIfRunning('Cloning a live profile can capture a torn session database.');

  if (refresh && existsSync(CLONE_DIR)) {
    assertSafeCloneDir(CLONE_DIR);
    console.log(`  Removing old clone: ${CLONE_DIR}`);
    rmSync(CLONE_DIR, { recursive: true, force: true });
  }

  console.log(`  Cloning Flatpak profile -> ${CLONE_DIR}  (reflink where supported)`);
  copyTree(join(FLATPAK_HOME, 'config', 'loft'), join(CLONE_DIR, 'config', 'loft'));
  copyTree(join(FLATPAK_HOME, 'data', 'loft'), join(CLONE_DIR, 'data', 'loft'));
  console.log('  Clone ready.');
}

function main() {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const refresh = argv.includes('--refresh');
  const dryRun = argv.includes('--dry-run');
  const OWN_FLAGS = ['--live', '--refresh', '--dry-run'];
  const electronArgs = argv.filter((a) => !OWN_FLAGS.includes(a));

  if (!existsSync(join(FLATPAK_HOME, 'config', 'loft', 'config.json'))) {
    die(`No Flatpak profile at ${FLATPAK_HOME}.\n  Install and launch ${APP_ID} at least once first.`);
  }

  let root;
  if (live) {
    refuseIfRunning('Two Chromium processes on one profile will corrupt it.');
    const cfg = join(FLATPAK_HOME, 'config', 'loft', 'config.json');
    copyFileSync(cfg, `${cfg}.predev.bak`);
    console.log(`  Backed up config.json -> ${cfg}.predev.bak`);
    root = FLATPAK_HOME;
  } else {
    buildClone({ refresh });
    root = CLONE_DIR;
  }

  const env = { ...process.env };
  env.XDG_CONFIG_HOME = join(root, 'config');
  env.XDG_DATA_HOME = join(root, 'data');
  env.XDG_CACHE_HOME = join(root, 'cache');
  mkdirSync(env.XDG_CACHE_HOME, { recursive: true });
  // VS Code's integrated terminal exports this, which makes `electron .` run as plain Node
  // and silently never start the app (see CLAUDE.md).
  delete env.ELECTRON_RUN_AS_NODE;

  // Safe, but not invisible: both processes request the well-known name chat.loft.Loft with
  // flags 0, so the dev one is QUEUED rather than refused — it silently does not own the bus
  // (its tray/GNOME-panel actions route to the Flatpak) and would inherit the name outright if
  // the Flatpak quits. Two tray icons is the visible symptom. Worth knowing before it puzzles.
  if (!live && flatpakRunning()) {
    console.warn(`  ! ${APP_ID} is also running. Expect two tray icons; the dev instance does not`);
    console.warn('    own the chat.loft.Loft D-Bus name, so tray/panel actions favour the Flatpak.');
  }

  console.log('');
  console.log(`  Loft dev  [${live ? 'LIVE — writes to the real Flatpak profile' : 'CLONE — real profile untouched'}]`);
  console.log(`    XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}`);
  console.log(`    XDG_DATA_HOME  =${env.XDG_DATA_HOME}`);
  if (electronArgs.length) console.log(`    args: ${electronArgs.join(' ')}`);
  console.log('');

  if (dryRun) { console.log('  --dry-run: profile prepared, Electron not launched.\n'); return; }

  const electron = join(REPO_ROOT, 'node_modules', '.bin', 'electron');
  const r = spawnSync(electron, ['.', ...electronArgs], { stdio: 'inherit', env, cwd: REPO_ROOT });
  process.exit(r.status ?? 1);
}

main();
