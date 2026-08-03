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
 *                    Logins are inherited once; `--refresh` re-snapshots. WhatsApp's and
 *                    Element's partitions are deliberately NOT inherited — see UNCLONABLE_KINDS.
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
import { existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
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

/**
 * Service kinds whose partition must never be cloned.
 *
 * For a cookie-authenticated service (Slack, Messenger, Talk, Telegram) a `Partitions/<id>`
 * directory really is a copy of a login, and copying it is what this script is for.
 *
 * WhatsApp and Element are not that. Their partition holds a Signal/Olm DEVICE IDENTITY whose
 * state advances with every single message — Double-Ratchet chain indices, group sender-key
 * counters, app-state-sync hashes, consumed one-time keys. Copying it yields a second copy of
 * ONE device, not a second device, and the two halves fork the moment either sends or receives.
 *
 * The fork is NOT contained in the clone, which is what makes this worse than it looks:
 *   - whichever half receives a message ACKs it and the server drops it for the other, so
 *     messages go silently missing from the real install;
 *   - the stale half then encrypts with counters the recipients have already seen, so what it
 *     sends is discarded by every recipient — including the sender's own phone;
 *   - app-state sync diverges, and the server stops counting the device as active.
 * Running them sequentially is no safer than running them at once: the damage is to shared
 * server- and peer-side state, not to the files.
 *
 * Measured against a real account on 2026-08-03: the clone carried byte-identical WhatsApp
 * credentials to the Flatpak profile and had been run against them on six separate days.
 *
 * So the dev instance links its OWN device instead — one QR scan, kept across `--refresh`.
 */
const UNCLONABLE_KINDS = new Set(['whatsapp', 'element']);

/**
 * True for a partition directory belonging to an unclonable kind.
 *
 * registry.ts: instance 1 of a kind keeps the bare kind id (`whatsapp`), later instances are
 * `<kind>-<N>` (`whatsapp-2`) — so match the id exactly or up to a `-`, never by prefix alone,
 * or an unrelated kind whose name starts the same would be skipped too.
 */
function isUnclonablePartition(id) {
  const kind = id.includes('-') ? id.slice(0, id.indexOf('-')) : id;
  return UNCLONABLE_KINDS.has(kind);
}

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

const cp = (args, src, dest) => {
  const r = spawnSync('cp', ['-a', '--reflink=auto', ...args], { stdio: 'inherit' });
  if (r.status !== 0) die(`Copy failed: ${src} -> ${dest}`);
};

/** Copy the CONTENTS of directory `src` into `dest`. COW on btrfs/XFS, a plain copy elsewhere. */
function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  cp([`${src}/.`, dest], src, dest);
}

/**
 * Copy one directory entry to an exact destination path.
 *
 * `data/loft` is not all directories — it holds Preferences, Local State, DIPS and Chromium's
 * Singleton* symlinks at the top level, so the entry walk cannot assume `copyTree`.
 */
function copyEntry(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  cp([src, dest], src, dest);
}

function assertSafeCloneDir(dir) {
  if (!dir.startsWith(homedir()) || !basename(dir).includes(CLONE_MARKER)) {
    die(`Refusing to delete ${dir}: it must live under $HOME and be named *${CLONE_MARKER}*.`);
  }
}

const partitionsIn = (root) => join(root, 'data', 'loft', 'Partitions');

/** Partition ids present under a profile root, or [] if it has none yet. */
function listPartitions(root) {
  const dir = partitionsIn(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * Copy `<srcRoot>/data/loft` into `<destRoot>/data/loft`, leaving unclonable partitions behind.
 * Returns the ids it skipped.
 *
 * Done as "everything except Partitions, then the clonable partitions one by one" rather than
 * copy-then-delete, because copy-then-delete would put a duplicate WhatsApp device on disk —
 * briefly, but a crash between the two steps leaves it there for the next run to pick up.
 */
function copyProfileData(srcRoot, destRoot) {
  const src = join(srcRoot, 'data', 'loft');
  const dest = join(destRoot, 'data', 'loft');
  mkdirSync(dest, { recursive: true });

  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'Partitions') continue;
    copyEntry(join(src, entry.name), join(dest, entry.name));
  }

  const skipped = [];
  for (const id of listPartitions(srcRoot)) {
    if (isUnclonablePartition(id)) { skipped.push(id); continue; }
    copyEntry(join(partitionsIn(srcRoot), id), join(partitionsIn(destRoot), id));
  }
  return skipped;
}

/**
 * Move the clone's own unclonable partitions out of the way so `--refresh` can delete
 * everything else, and hand back a function that puts them back.
 *
 * They are the dev instance's own linked devices — scanned once, into the clone. A refresh
 * exists to pick up new logins from the Flatpak, not to cost a QR scan for the devices the
 * clone already owns (and must not inherit from the Flatpak instead).
 */
function stashOwnDevices() {
  const stash = `${CLONE_DIR}.devices`;
  assertSafeCloneDir(stash); // shares the clone's basename, so the marker check still holds
  rmSync(stash, { recursive: true, force: true });

  const kept = listPartitions(CLONE_DIR).filter(isUnclonablePartition);
  for (const id of kept) {
    mkdirSync(stash, { recursive: true });
    renameSync(join(partitionsIn(CLONE_DIR), id), join(stash, id));
  }

  return () => {
    for (const id of kept) {
      const dest = join(partitionsIn(CLONE_DIR), id);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(join(stash, id), dest);
    }
    rmSync(stash, { recursive: true, force: true });
    return kept;
  };
}

/**
 * Stamped into the clone once it is known to hold no inherited device identity.
 *
 * A clone built before UNCLONABLE_KINDS existed still has the real install's WhatsApp/Element
 * partition sitting in it, and `buildClone` returns early for a clone that is already ready —
 * so without this, the very machine the bug was found on would keep running the duplicate
 * device on the next `npm run dev`. The stamp keeps that a ONE-TIME migration: an unstamped
 * clone gets those partitions evicted, a stamped one never does, so a device the dev instance
 * scanned for itself is never mistaken for an inherited one.
 */
const CLONE_STAMP = '.loft-devprofile-no-shared-devices';

/**
 * Remove device partitions a pre-fix clone inherited. Returns what it removed.
 *
 * Runs BEFORE buildClone: on `--refresh`, stashOwnDevices would otherwise carefully preserve
 * the inherited device across the re-snapshot, which is the opposite of the point.
 */
function evictInheritedDevices() {
  if (!existsSync(CLONE_DIR) || existsSync(join(CLONE_DIR, CLONE_STAMP))) return [];
  assertSafeCloneDir(CLONE_DIR);
  const inherited = listPartitions(CLONE_DIR).filter(isUnclonablePartition);
  for (const id of inherited) {
    rmSync(join(partitionsIn(CLONE_DIR), id), { recursive: true, force: true });
  }
  return inherited;
}

function buildClone({ refresh }) {
  const ready = existsSync(join(CLONE_DIR, 'config', 'loft', 'config.json'));
  if (ready && !refresh) return;

  // A snapshot taken while the app is writing can tear its cookie/session databases — and a
  // torn snapshot means logging in again, which is the one thing this script exists to avoid.
  refuseIfRunning('Cloning a live profile can capture a torn session database.');

  let restoreOwnDevices = () => [];
  if (refresh && existsSync(CLONE_DIR)) {
    assertSafeCloneDir(CLONE_DIR);
    restoreOwnDevices = stashOwnDevices();
    console.log(`  Removing old clone: ${CLONE_DIR}`);
    rmSync(CLONE_DIR, { recursive: true, force: true });
  }

  console.log(`  Cloning Flatpak profile -> ${CLONE_DIR}  (reflink where supported)`);
  copyTree(join(FLATPAK_HOME, 'config', 'loft'), join(CLONE_DIR, 'config', 'loft'));
  const skipped = copyProfileData(FLATPAK_HOME, CLONE_DIR);
  const restored = restoreOwnDevices();
  console.log('  Clone ready.');

  const stillNeeded = skipped.filter((id) => !restored.includes(id));
  if (skipped.length) {
    console.log('');
    console.log(`  Not cloned: ${skipped.join(', ')}`);
    console.log('    These partitions are Signal/Olm device identities, not logins. Two copies of');
    console.log('    one device fork its ratchet state and break the REAL install: messages go');
    console.log('    missing and what you send is dropped by every recipient.');
    if (restored.length) console.log(`    Kept the dev instance's own device for: ${restored.join(', ')}`);
    if (stillNeeded.length) console.log(`    Expect a fresh QR scan / login for: ${stillNeeded.join(', ')}`);
  }
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
    const evicted = evictInheritedDevices();
    buildClone({ refresh });
    writeFileSync(join(CLONE_DIR, CLONE_STAMP), 'This clone shares no device identity with the real profile.\n');
    if (evicted.length) {
      console.warn('');
      console.warn(`  ! Removed inherited device partitions from the clone: ${evicted.join(', ')}`);
      console.warn('    They were copies of the REAL install\'s Signal/Olm device. Running them here');
      console.warn('    forked its ratchet state — the cause of missing messages and undelivered');
      console.warn('    sends in the real install. Link the dev instance\'s own device instead.');
    }
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

export { isUnclonablePartition, UNCLONABLE_KINDS };

// Only when run as a script. Importing this module (tests do) must not clone or spawn Electron.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
