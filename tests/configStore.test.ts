import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfigStore, notLoadedStore, type StoreLog } from '../src/main/configStore';
import { saveConfig, loadConfig, backupConfigPath, corruptConfigPath } from '../src/main/config';
import { migrateConfig } from '../src/main/migrate';
import { createDebouncedFlush } from '../src/main/configFlush';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loft-store-'));
  path = join(dir, 'config.json');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const silent: StoreLog = { log() {}, warn() {}, error() {} };

const POPULATED = {
  services: {
    whatsapp: { autoOpen: 'login', dnd: true, badgesEnabled: false },
    slack: {
      autoOpen: 'launch',
      detached: true,
      launcher: true,
      window: { x: 100, y: 100, width: 1200, height: 800, zoom: 1.1 },
    },
    messenger: { name: 'Personal', icon: 'rose' },
  },
  globalDnd: true,
  trayBackend: 'sni',
  reopenDetached: false,
  railOrder: ['slack', 'whatsapp', 'messenger'],
  configVersion: 2,
} as const;

const writePrimary = (v: unknown = POPULATED) =>
  writeFileSync(path, typeof v === 'string' ? v : JSON.stringify(v, null, 2), 'utf8');

describe('config store — first run', () => {
  it('starts writable with defaults and creates the file on the first save', () => {
    const store = openConfigStore(path, silent);
    expect(store.status).toBe('missing');
    expect(store.writable).toBe(true);
    store.config.services.slack = { dnd: true };
    store.save();
    expect(loadConfig(path).services.slack).toEqual({ dnd: true });
  });

  it('does not make a backup out of a freshly generated default', () => {
    const store = openConfigStore(path, silent);
    store.save();
    expect(existsSync(backupConfigPath(path))).toBe(false);
  });
});

describe('config store — a config it could read', () => {
  it('loads every field and is writable', () => {
    writePrimary();
    const store = openConfigStore(path, silent);
    expect(store.status).toBe('loaded');
    expect(store.writable).toBe(true);
    expect(store.config).toEqual(POPULATED);
  });

  it('promotes the bytes it just parsed to the backup', () => {
    writePrimary();
    openConfigStore(path, silent);
    expect(JSON.parse(readFileSync(backupConfigPath(path), 'utf8'))).toEqual(POPULATED);
  });

  it('round-trips every field through a save', () => {
    writePrimary();
    const store = openConfigStore(path, silent);
    store.save();
    expect(loadConfig(path)).toEqual(POPULATED);
  });
});

describe('config store — a config it could NOT read', () => {
  // The invariant, stated as a test: a failed read never becomes writable default state.
  it('is not writable after malformed JSON', () => {
    writePrimary('{ "services": { "slack');
    const store = openConfigStore(path, silent);
    expect(store.status).toBe('error');
    expect(store.writable).toBe(false);
    expect(store.error).toBeInstanceOf(Error);
  });

  it('is not writable after a permissions failure', () => {
    if (process.getuid?.() === 0) return;
    writePrimary();
    // The backup must not rescue us here: this is about the read failing, and a first-ever
    // launch onto an unreadable file has no backup either.
    chmodSync(path, 0o000);
    try {
      const store = openConfigStore(path, silent);
      expect(store.status).toBe('error');
      expect(store.writable).toBe(false);
    } finally { chmodSync(path, 0o600); }
  });

  it('save() is inert — the unreadable file is left exactly as it was', () => {
    const raw = '{ "services": { "slack';
    writePrimary(raw);
    const store = openConfigStore(path, silent);
    store.config.services.whatsapp = {};
    store.save();
    store.save();
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });

  it('a window-bounds flush cannot overwrite it', () => {
    const raw = '{ truncated';
    writePrimary(raw);
    const store = openConfigStore(path, silent);
    // Exactly the wiring index.ts uses for resize/move — the path that committed the
    // defaults in the original incident.
    const flush = createDebouncedFlush({ save: () => store.save(), delayMs: 0 });
    flush.schedule();
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(readFileSync(path, 'utf8')).toBe(raw);
      resolve();
    }, 20));
  });

  it('a migration cannot overwrite it', () => {
    const raw = '{ truncated';
    writePrimary(raw);
    const store = openConfigStore(path, silent);
    // migrateConfig itself is pure-ish (it mutates the object it is given); what must hold
    // is that its result can never reach the file.
    migrateConfig(store.config, () => true);
    store.save();
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });

  it('a grid prune cannot overwrite it', () => {
    const raw = '{ truncated';
    writePrimary(raw);
    const store = openConfigStore(path, silent);
    store.config.grid = null;
    store.save();
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });

  it('leaves the valid backup alone', () => {
    writePrimary('{ truncated');
    writeFileSync(backupConfigPath(path), '{ also broken', 'utf8');
    openConfigStore(path, silent);
    expect(readFileSync(backupConfigPath(path), 'utf8')).toBe('{ also broken');
  });

  it('says so, loudly', () => {
    const errors: string[] = [];
    writePrimary('{ truncated');
    openConfigStore(path, { log() {}, warn() {}, error: (m) => errors.push(m) });
    expect(errors.join('\n')).toMatch(/will NOT save/);
  });
});

describe('config store — recovery from the backup', () => {
  it('recovers the full config and repairs the primary', () => {
    writePrimary('{ truncated');
    writeFileSync(backupConfigPath(path), JSON.stringify(POPULATED), 'utf8');
    const store = openConfigStore(path, silent);
    expect(store.status).toBe('recovered');
    expect(store.writable).toBe(true);
    expect(store.config).toEqual(POPULATED);
    expect(loadConfig(path)).toEqual(POPULATED);
  });

  it('keeps the unreadable file rather than writing over it', () => {
    writePrimary('{ truncated');
    writeFileSync(backupConfigPath(path), JSON.stringify(POPULATED), 'utf8');
    openConfigStore(path, silent);
    expect(readFileSync(corruptConfigPath(path), 'utf8')).toBe('{ truncated');
  });

  it('does not let the recovered write clobber the backup it came from', () => {
    writePrimary('{ truncated');
    writeFileSync(backupConfigPath(path), JSON.stringify(POPULATED), 'utf8');
    const store = openConfigStore(path, silent);
    store.config.services = {};
    store.save();
    expect(JSON.parse(readFileSync(backupConfigPath(path), 'utf8'))).toEqual(POPULATED);
  });

  it('surfaces the recovery instead of doing it invisibly', () => {
    const errors: string[] = [];
    writePrimary('{ truncated');
    writeFileSync(backupConfigPath(path), JSON.stringify(POPULATED), 'utf8');
    openConfigStore(path, { log() {}, warn() {}, error: (m) => errors.push(m) });
    expect(errors.join('\n')).toMatch(/Recovered/);
  });

  it('the next launch is an ordinary load', () => {
    writePrimary('{ truncated');
    writeFileSync(backupConfigPath(path), JSON.stringify(POPULATED), 'utf8');
    openConfigStore(path, silent);
    const second = openConfigStore(path, silent);
    expect(second.status).toBe('loaded');
    expect(second.config).toEqual(POPULATED);
  });
});

describe('config store — a secondary instance', () => {
  // It has already lost the single-instance lock; it must route its argv to the primary
  // and exit without ever reading or writing the shared file.
  it('reads nothing and writes nothing', () => {
    writePrimary();
    const before = readFileSync(path, 'utf8');
    const store = notLoadedStore();
    expect(store.status).toBe('not-loaded');
    expect(store.writable).toBe(false);
    expect(store.config).toEqual({ services: {} });
    store.config.services.slack = { dnd: true };
    store.save();
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(backupConfigPath(path))).toBe(false);
  });
});

describe('config store — migration stays non-destructive', () => {
  it('still migrates a valid v1 config', () => {
    writeFileSync(path, JSON.stringify({ services: { slack: {}, whatsapp: {} } }), 'utf8');
    const store = openConfigStore(path, silent);
    const { changed } = migrateConfig(store.config, (id) => id === 'slack');
    expect(changed).toBe(true);
    store.save();
    const after = loadConfig(path);
    expect(after.configVersion).toBe(2);
    expect(after.services.slack.launcher).toBe(true);
    expect(after.services.whatsapp.launcher).toBe(false);
  });

  it('keeps the pre-migration config recoverable from the backup', () => {
    const v1 = { services: { slack: { dnd: true } } };
    writeFileSync(path, JSON.stringify(v1), 'utf8');
    const store = openConfigStore(path, silent);
    migrateConfig(store.config, () => true);
    store.save();
    expect(JSON.parse(readFileSync(backupConfigPath(path), 'utf8'))).toEqual(v1);
  });
});

describe('config store — an empty config file', () => {
  // The signature of a write killed after truncating and before writing: exactly what the
  // pre-1.0.3 non-atomic save did at a Flatpak logout.
  it('is named as empty, not as a JSON parse failure', () => {
    writePrimary('');
    const store = openConfigStore(path, silent);
    expect(store.status).toBe('error');
    expect(store.error?.message).toMatch(/empty \(0 bytes\)/);
    expect(store.error?.message).not.toMatch(/JSON/);
  });

  it('treats whitespace-only the same way', () => {
    writePrimary('\n  \n');
    expect(openConfigStore(path, silent).error?.message).toMatch(/whitespace/);
  });

  it('still recovers from the backup when there is one', () => {
    writePrimary(POPULATED);
    openConfigStore(path, silent);          // promotes the backup
    writePrimary('');                        // then the file is emptied
    const store = openConfigStore(path, silent);
    expect(store.status).toBe('recovered');
    expect(Object.keys(store.config.services)).toEqual(['whatsapp', 'slack', 'messenger']);
  });

  it('says whether a backup existed at all', () => {
    const said: string[] = [];
    const log: StoreLog = { log() {}, warn() {}, error: (m) => said.push(m) };
    writePrimary('');
    openConfigStore(path, log);
    expect(said.join('\n')).toContain('no backup');
  });
});

describe('config store — starting fresh after an unreadable config', () => {
  it('sets the file aside, becomes writable, and saves', () => {
    writePrimary('');
    const store = openConfigStore(path, silent);
    expect(store.writable).toBe(false);

    const { ok, keptAs } = store.startFresh();
    expect(ok).toBe(true);
    expect(keptAs).toBe(corruptConfigPath(path));
    expect(existsSync(corruptConfigPath(path))).toBe(true);
    expect(store.writable).toBe(true);
    expect(store.status).toBe('missing');

    store.config.services.slack = { kind: 'slack' };
    store.save();
    expect(loadConfig(path).services.slack).toEqual({ kind: 'slack' });
  });

  it('keeps the original bytes, not a rewrite of them', () => {
    writePrimary('{ "services": broken');
    const store = openConfigStore(path, silent);
    store.startFresh();
    expect(readFileSync(corruptConfigPath(path), 'utf8')).toBe('{ "services": broken');
  });

  it('does not overwrite evidence from an earlier failure', () => {
    writeFileSync(corruptConfigPath(path), 'the first one', 'utf8');
    writePrimary('');
    const store = openConfigStore(path, silent);
    const { keptAs } = store.startFresh();
    expect(keptAs).not.toBe(corruptConfigPath(path));
    expect(readFileSync(corruptConfigPath(path), 'utf8')).toBe('the first one');
    expect(readFileSync(keptAs!, 'utf8')).toBe('');
  });

  it('stays read-only when the file cannot be moved', () => {
    writePrimary('');
    const store = openConfigStore(path, silent);
    chmodSync(dir, 0o555);                  // no rename out of this directory
    try {
      const { ok } = store.startFresh();
      expect(ok).toBe(false);
      expect(store.writable).toBe(false);
      store.config.services.slack = { kind: 'slack' };
      store.save();
      expect(readFileSync(path, 'utf8')).toBe('');   // untouched
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it('is a no-op on a store that was already writable', () => {
    writePrimary(POPULATED);
    const store = openConfigStore(path, silent);
    expect(store.startFresh()).toEqual({ ok: true });
    expect(existsSync(corruptConfigPath(path))).toBe(false);
    expect(store.config.services.whatsapp).toBeDefined();
  });

  it('a secondary instance can never start fresh', () => {
    expect(notLoadedStore().startFresh()).toEqual({ ok: false });
  });
});
