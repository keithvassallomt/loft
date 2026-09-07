import { existsSync, renameSync, writeFileSync, readFileSync, statSync, chmodSync } from 'node:fs';
import {
  LoftConfig, defaultConfig, saveConfig, loadConfigResult, cleanupConfigTemps,
  backupConfigPath, corruptConfigPath,
} from './config';

/**
 * How the live config came to be. The first four mirror ConfigLoadResult; 'not-loaded' is
 * this process deliberately never having looked (a second Loft instance, which routes its
 * argv to the primary and exits — see the single-instance lock in index.ts).
 */
export type ConfigStatus = 'loaded' | 'missing' | 'recovered' | 'error' | 'not-loaded';

/**
 * The one way the app reaches config.json.
 *
 * It exists because the invariant it enforces cannot be enforced call-site by call-site:
 * **a failure to READ an existing config must never become writable default state.** There
 * are ~30 `save()` callers (window bounds flush, DND, rail order, grid edits, migration,
 * launcher reconciliation, per-service settings, quit), and one of them forgetting to check
 * a flag is enough to overwrite every setting the user has. So the check lives here, once:
 * when the config could not be read, `save()` does nothing at all.
 *
 * The failure this comes from: loadConfig used to swallow every error and return
 * `{services:{}}`, indistinguishable from a first run. A single unreadable read then had
 * its defaults committed by the next debounced window-move flush, replacing every service,
 * every per-service setting and the whole top level with `{"services":{}}` — permanent loss
 * out of a possibly transient failure.
 */
export interface ConfigStore {
  /** The live config. Mutated in place by the app; written only through save(). */
  readonly config: LoftConfig;
  readonly status: ConfigStatus;
  /** False when the config on disk could not be read. save() is inert while false. */
  readonly writable: boolean;
  /** Why the load failed ('error'), or what the backup rescued us from ('recovered'). */
  readonly error?: Error;
  /** Persist the live config atomically. A no-op — never a throw — when not writable. */
  save(): void;
  /**
   * Give up on an unreadable config and carry on with a writable empty one, setting the
   * unusable file aside first.
   *
   * The read-only state this leaves is deliberately permanent for the session — but
   * without this, it is permanent for every session after it too: the only way out was to
   * find the file in a terminal, which is not a remedy an app can offer a user. Never
   * called on its own initiative; it exists so the user can be *asked* (index.ts).
   *
   * Setting the file aside is the precondition, not a courtesy: it is the only copy of
   * whatever went wrong, and being writable again means the very next save would rename
   * a fresh config over it. So a failure to move it leaves the store read-only and
   * returns false — never "we could not preserve it, so we destroyed it".
   *
   * @returns ok — whether the store is now writable — and where the old file was kept,
   *          which the caller shows the user so the evidence is findable, not just safe.
   */
  startFresh(): { ok: boolean; keptAs?: string };
}

export interface StoreLog {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const consoleLog: StoreLog = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

/**
 * A store for a process that must not touch shared config at all: the second instance,
 * which has already lost the single-instance lock. It gets a default config so the module
 * graph still evaluates, and a save() that can never reach disk.
 */
export function notLoadedStore(): ConfigStore {
  return {
    config: defaultConfig(),
    status: 'not-loaded',
    writable: false,
    save() { /* never */ },
    // A secondary instance has no business writing config even after a user says so —
    // it never read one, so it has nothing to set aside and nothing to start fresh from.
    startFresh: () => ({ ok: false }),
  };
}

/**
 * Refresh `config.json.bak` from the exact bytes that just parsed successfully.
 *
 * Deliberately fed the FILE's bytes and not `JSON.stringify(store.config)`: the backup's
 * whole job is to hold something that was verified to be readable settings on disk. Feeding
 * it in-memory state would let the very bug this guards against — an emptied config in
 * memory — propagate into the copy meant to survive it. That is also why nothing on the
 * save path writes the backup, and why a default or fallback config never can.
 */
function promoteBackup(backupPath: string, text: string, log: StoreLog): void {
  try {
    if (existsSync(backupPath) && readFileSync(backupPath, 'utf8') === text) return;
    // Same atomic dance as saveConfig, minus the parse: write beside, then rename.
    const tmp = `${backupPath}.${process.pid}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, backupPath);
  } catch (err) {
    log.warn(`Could not refresh the config backup at ${backupPath}: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * Where to put an unusable config so it is out of the way but not gone.
 *
 * `.corrupt` first, and a timestamped sibling if that name is taken: a second failure must
 * not overwrite the evidence from the first, which is the one file that can still be
 * mined for the settings the user is about to lose.
 */
function setAsideTarget(path: string, now: Date): string {
  const first = corruptConfigPath(path);
  if (!existsSync(first)) return first;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  return `${first}.${stamp}`;
}

/**
 * Open the config, with recovery. Call this only from the primary instance, and only after
 * the single-instance lock is held.
 */
export function openConfigStore(path: string, log: StoreLog = consoleLog): ConfigStore {
  const backupPath = backupConfigPath(path);
  const result = loadConfigResult(path, backupPath);

  let writable: boolean;
  let config: LoftConfig;
  let error: Error | undefined;
  /** Mode of the file a recovery replaced, so the repair does not loosen it. */
  let repairMode: number | undefined;

  switch (result.status) {
    case 'loaded':
      config = result.config;
      writable = true;
      promoteBackup(backupPath, result.text, log);
      break;

    case 'missing':
      // No primary AND no backup: a genuine first run. Writable, and NOTHING is backed up —
      // a freshly generated default must never be able to become the known-good copy.
      config = result.config;
      writable = true;
      log.log(`No config at ${path} — starting with defaults (first run).`);
      break;

    case 'recovered': {
      config = result.config;
      writable = true;
      error = result.originalError;
      log.error(
        `Could not read ${path}: ${result.originalError.message}. ` +
        `Recovered your settings from ${backupPath}.`,
      );
      // Keep the unreadable file rather than letting the repair write over it: it is the
      // only evidence of what went wrong, and it may still hold settings the backup predates.
      // Its mode is carried across by hand: the repair below creates a NEW file, and
      // saveConfig can only copy a mode from a path that still exists.
      try {
        if (existsSync(path)) {
          repairMode = statSync(path).mode & 0o777;
          renameSync(path, corruptConfigPath(path));
          log.warn(`The unreadable config was kept as ${corruptConfigPath(path)}.`);
        }
      } catch (err) {
        log.warn(`Could not set aside the unreadable config: ${(err as Error)?.message ?? err}`);
      }
      break;
    }

    case 'error':
      // The one state that is NOT writable. Loft still starts — an unreadable config should
      // not be an unstartable app — but it starts read-only, so the file that could not be
      // read is still there, untouched, for the user to fix or restore.
      config = defaultConfig();
      writable = false;
      error = result.error;
      log.error(
        `Could not read ${path}: ${result.error.message}. ` +
        (result.backupMissing
          ? `There is no backup at ${backupPath} either. `
          : `The backup at ${backupPath} could not be used either. `) +
        `Loft has started with default settings and will NOT save any changes, ` +
        `so nothing on disk is overwritten. Fix or move that file and restart Loft.`,
      );
      break;
  }

  // Sweep temp files a killed save left behind. After the load, so it can never race the
  // read, and only for our own naming (see cleanupConfigTemps).
  if (writable) {
    for (const f of cleanupConfigTemps(path)) log.log(`Removed abandoned config temp file ${f}`);
  }

  // `status` and `writable` are getters over the locals above, not fixed properties:
  // startFresh() moves both, and ~30 call sites hold this one object.
  let status: ConfigStatus = result.status;

  // Repair the primary from the backup right away, so the next launch is an ordinary
  // 'loaded' rather than another recovery.
  const store: ConfigStore = {
    config,
    get status() { return status; },
    get writable() { return writable; },
    error,
    save(): void {
      if (!writable) return;
      saveConfig(path, config);
    },
    startFresh(): { ok: boolean; keptAs?: string } {
      if (writable) return { ok: true };

      let keptAs: string | undefined;
      try {
        // Gone already (a race, or the read failed on something other than the file
        // itself): there is nothing to preserve, so nothing blocks starting fresh.
        if (existsSync(path)) {
          keptAs = setAsideTarget(path, new Date());
          renameSync(path, keptAs);
          log.warn(`The unreadable config was kept as ${keptAs}.`);
        }
      } catch (err) {
        // Read-only stays read-only. Becoming writable now would let the next save
        // rename a fresh config over the only copy of what went wrong.
        log.error(
          `Could not set aside ${path}: ${(err as Error)?.message ?? err}. ` +
          `Loft is still not saving changes.`,
        );
        return { ok: false };
      }

      writable = true;
      status = 'missing';
      log.warn(`Starting fresh: ${path} will be written from defaults.`);
      // Sweep now rather than at open: this is the first moment writing here is allowed.
      for (const f of cleanupConfigTemps(path)) log.log(`Removed abandoned config temp file ${f}`);
      return { ok: true, keptAs };
    },
  };
  if (result.status === 'recovered') {
    try {
      store.save();
      if (repairMode !== undefined) chmodSync(path, repairMode);
    } catch (err) {
      log.error(`Could not write the recovered config back to ${path}: ${(err as Error)?.message ?? err}`);
    }
  }
  return store;
}
