import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, lstatSync,
  readlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error - plain .mjs build script, no type declarations
import { isUnclonablePartition, UNCLONABLE_KINDS } from '../scripts/devProfile.mjs';

const root = resolve(__dirname, '..');
const script = resolve(root, 'scripts/devProfile.mjs');

/**
 * `npm run dev` clones the installed Flatpak's profile so a dev session inherits real logins.
 * For a cookie-authenticated service (Slack, Messenger, Talk) that is exactly what it sounds
 * like: a copy of a login.
 *
 * For WhatsApp and Element it is not. Their `Partitions/<id>` directory holds a Signal/Olm
 * DEVICE IDENTITY whose state advances with every message — ratchet chain indices, group
 * sender-key counters, app-state-sync hashes. Copying it does not produce a second login, it
 * produces a second copy of ONE device, and the two halves fork the moment either receives a
 * message. The damage is not confined to the clone: whichever half receives a message ACKs it
 * and the server drops it for the other (messages silently missing), and messages the stale
 * half sends are rejected by every recipient, including the user's own phone.
 *
 * Measured on a real account, 2026-08-03: the clone at ~/.local/share/loft-devprofile carried
 * byte-identical WhatsApp credentials to the Flatpak profile and had been run against them on
 * six separate days. Symptoms were missing group messages, polls no recipient ever saw, and a
 * linked-device entry the server had stopped counting as active.
 *
 * So the clone must skip these partitions and let the dev instance link its OWN device.
 */
describe('isUnclonablePartition', () => {
  it('excludes the bare kind id (instance 1)', () => {
    expect(isUnclonablePartition('whatsapp')).toBe(true);
    expect(isUnclonablePartition('element')).toBe(true);
  });

  it('excludes later instances of the same kind', () => {
    // registry.ts: instance 1 keeps the bare kind id, later ones are `<kind>-<N>`.
    expect(isUnclonablePartition('whatsapp-2')).toBe(true);
    expect(isUnclonablePartition('element-13')).toBe(true);
  });

  it('clones cookie-authenticated services, which have no per-message crypto state', () => {
    for (const id of ['slack', 'messenger', 'talk', 'telegram', 'slack-2']) {
      expect(isUnclonablePartition(id)).toBe(false);
    }
  });

  it('does not match a kind that merely shares a prefix', () => {
    expect(isUnclonablePartition('whatsappx')).toBe(false);
    expect(isUnclonablePartition('elementary')).toBe(false);
  });

  it('names both Signal-protocol kinds', () => {
    expect([...UNCLONABLE_KINDS].sort()).toEqual(['element', 'whatsapp']);
  });
});

describe('devProfile clone', () => {
  let dir: string;
  let flatpakHome: string;
  let cloneDir: string;

  const partition = (rootDir: string, id: string, marker: string) => {
    const p = join(rootDir, 'data', 'loft', 'Partitions', id);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'Cookies'), marker);
  };

  const clonedPartitions = () => {
    const base = join(cloneDir, 'data', 'loft', 'Partitions');
    return ['whatsapp', 'whatsapp-2', 'element', 'slack', 'messenger'].filter((id) =>
      existsSync(join(base, id)),
    );
  };

  /** --dry-run prepares the profile and stops short of spawning Electron. */
  const runDev = (...args: string[]) => {
    const r = spawnSync(process.execPath, [script, '--dry-run', ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LOFT_FLATPAK_HOME: flatpakHome,
        LOFT_DEV_PROFILE: cloneDir,
      },
    });
    if (r.status !== 0) throw new Error(`devProfile exited ${r.status}\n${r.stdout}\n${r.stderr}`);
    return `${r.stdout}${r.stderr}`;
  };

  beforeEach(() => {
    // Under $HOME, not tmpdir: assertSafeCloneDir refuses to rm -rf anything outside it, and
    // that guard is the point — a test must not be the reason it gets relaxed.
    dir = mkdtempSync(join(homedir(), '.loft-devprofile-test-'));
    flatpakHome = join(dir, 'flatpak');
    // Must also contain the marker, for the same guard.
    cloneDir = join(dir, 'loft-devprofile');

    mkdirSync(join(flatpakHome, 'config', 'loft'), { recursive: true });
    writeFileSync(join(flatpakHome, 'config', 'loft', 'config.json'), '{"services":{}}');
    mkdirSync(join(flatpakHome, 'data', 'loft', 'icons'), { recursive: true });
    writeFileSync(join(flatpakHome, 'data', 'loft', 'icons', 'whatsapp.png'), 'png');
    // A real data/loft is not all directories: Preferences/Local State/DIPS sit at the top
    // level, as do Chromium's Singleton* symlinks — and SingletonLock's target never exists.
    writeFileSync(join(flatpakHome, 'data', 'loft', 'Preferences'), 'prefs');
    symlinkSync('thor.vassallo.cloud-2', join(flatpakHome, 'data', 'loft', 'SingletonLock'));
    for (const id of ['whatsapp', 'whatsapp-2', 'element', 'slack', 'messenger']) {
      partition(flatpakHome, id, `flatpak:${id}`);
    }
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('does not copy a Signal-protocol partition into the clone', () => {
    runDev();
    expect(clonedPartitions()).toEqual(['slack', 'messenger']);
  });

  it('still copies config and non-partition data', () => {
    runDev();
    expect(existsSync(join(cloneDir, 'config', 'loft', 'config.json'))).toBe(true);
    expect(existsSync(join(cloneDir, 'data', 'loft', 'icons', 'whatsapp.png'))).toBe(true);
  });

  it('copies top-level files and dangling symlinks, not just directories', () => {
    runDev();
    const data = join(cloneDir, 'data', 'loft');
    expect(readFileSync(join(data, 'Preferences'), 'utf8')).toBe('prefs');
    // Preserved as a link, not chased: its target does not exist, and -a must not dereference.
    expect(lstatSync(join(data, 'SingletonLock')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(data, 'SingletonLock'))).toBe('thor.vassallo.cloud-2');
  });

  it('says which partitions it skipped and why a QR scan is expected', () => {
    const out = runDev();
    expect(out).toMatch(/whatsapp/);
    expect(out).toMatch(/element/);
  });

  it('keeps the dev instance own linked device across --refresh', () => {
    runDev();
    // Stand in for a QR scan performed inside the dev instance.
    partition(cloneDir, 'whatsapp', 'dev-own-device');
    // And something the refresh SHOULD replace.
    writeFileSync(join(cloneDir, 'data', 'loft', 'icons', 'whatsapp.png'), 'stale');

    runDev('--refresh');

    const devWa = join(cloneDir, 'data', 'loft', 'Partitions', 'whatsapp', 'Cookies');
    expect(existsSync(devWa)).toBe(true);
    expect(readFileSync(devWa, 'utf8')).toBe('dev-own-device');
    expect(readFileSync(join(cloneDir, 'data', 'loft', 'icons', 'whatsapp.png'), 'utf8')).toBe('png');
  });

  it('never adopts the Flatpak device on --refresh when the clone has none', () => {
    runDev();
    runDev('--refresh');
    expect(clonedPartitions()).toEqual(['slack', 'messenger']);
  });

  /**
   * The clone that exposed this bug already exists on disk, and buildClone returns early for a
   * clone that is already ready — so skipping the copy is not enough on its own.
   */
  describe('a clone built before the rule existed', () => {
    /** What the old script left behind: a full copy, including the real device. */
    const buildPreFixClone = () => {
      mkdirSync(join(cloneDir, 'config', 'loft'), { recursive: true });
      writeFileSync(join(cloneDir, 'config', 'loft', 'config.json'), '{"services":{}}');
      for (const id of ['whatsapp', 'element', 'slack']) partition(cloneDir, id, `inherited:${id}`);
    };

    it('evicts the inherited device partitions on the next run', () => {
      buildPreFixClone();
      runDev();
      expect(clonedPartitions()).toEqual(['slack']); // untouched: buildClone saw a ready clone
    });

    it('says what it removed and why', () => {
      buildPreFixClone();
      const out = runDev();
      expect(out).toMatch(/Removed inherited device partitions/);
    });

    it('evicts before --refresh can preserve them', () => {
      buildPreFixClone();
      runDev('--refresh');
      expect(clonedPartitions()).toEqual(['slack', 'messenger']);
    });

    it('evicts only once, never a device the dev instance scanned for itself', () => {
      buildPreFixClone();
      runDev();
      partition(cloneDir, 'whatsapp', 'dev-own-device');

      const out = runDev();

      const devWa = join(cloneDir, 'data', 'loft', 'Partitions', 'whatsapp', 'Cookies');
      expect(readFileSync(devWa, 'utf8')).toBe('dev-own-device');
      expect(out).not.toMatch(/Removed inherited device partitions/);
    });
  });
});
