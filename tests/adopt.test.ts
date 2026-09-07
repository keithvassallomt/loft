import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAdoptable, serverUrlFromCookieHosts } from '../src/main/adopt';
import { partitionsRoot } from '../src/main/paths';
import type { LoftConfig } from '../src/main/config';

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A data home whose Partitions/ holds `ids`, each with a Cookies file unless said otherwise. */
function profile(ids: string[], opts: { husks?: string[] } = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'loft-adopt-'));
  tmps.push(home);
  const env = { XDG_DATA_HOME: home } as NodeJS.ProcessEnv;
  for (const id of ids) {
    const d = join(partitionsRoot(env), id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'Cookies'), 'sqlite-ish');
  }
  for (const id of opts.husks ?? []) {
    // Electron creates the directory the moment a view is built; nothing was ever stored.
    mkdirSync(join(partitionsRoot(env), id, 'GPUCache'), { recursive: true });
  }
  return env;
}

const empty: LoftConfig = { services: {} };

describe('findAdoptable', () => {
  it('finds a partition no config entry claims', () => {
    const env = profile(['whatsapp']);
    expect(findAdoptable(empty, env)).toEqual([
      { id: 'whatsapp', kind: 'whatsapp', displayName: 'WhatsApp', serverRequired: false },
    ]);
  });

  it('ignores partitions the config already lists', () => {
    const env = profile(['whatsapp', 'slack']);
    const cfg: LoftConfig = { services: { whatsapp: { kind: 'whatsapp' } } };
    expect(findAdoptable(cfg, env).map((c) => c.id)).toEqual(['slack']);
  });

  it('names later accounts of a kind the way the rail would', () => {
    const env = profile(['whatsapp-2']);
    const [c] = findAdoptable(empty, env);
    expect(c).toMatchObject({ id: 'whatsapp-2', kind: 'whatsapp', displayName: 'WhatsApp 2' });
  });

  it('flags a kind that cannot load without a server address', () => {
    const env = profile(['talk']);
    expect(findAdoptable(empty, env)[0].serverRequired).toBe(true);
  });

  it('skips a directory naming no known kind', () => {
    const env = profile(['whatsapp', 'signal', 'Cache']);
    expect(findAdoptable(empty, env).map((c) => c.id)).toEqual(['whatsapp']);
  });

  it('skips ids Loft would never allocate', () => {
    // `whatsapp-1` is not a legal id (instance 1 is the bare kind id) and `whatsapp-x`
    // is not an id at all — so neither is ours to resurrect.
    const env = profile(['whatsapp-1', 'whatsapp-x']);
    expect(findAdoptable(empty, env)).toEqual([]);
  });

  it('skips a partition nothing ever logged in to', () => {
    const env = profile(['slack'], { husks: ['telegram'] });
    expect(findAdoptable(empty, env).map((c) => c.id)).toEqual(['slack']);
  });

  it('accepts Local Storage as evidence too', () => {
    const env = profile([]);
    mkdirSync(join(partitionsRoot(env), 'element', 'Local Storage'), { recursive: true });
    expect(findAdoptable(empty, env).map((c) => c.id)).toEqual(['element']);
  });

  it('orders by registry, then by account number', () => {
    const env = profile(['talk', 'whatsapp-3', 'slack', 'whatsapp', 'whatsapp-2']);
    expect(findAdoptable(empty, env).map((c) => c.id))
      .toEqual(['whatsapp', 'whatsapp-2', 'whatsapp-3', 'slack', 'talk']);
  });

  it('returns nothing when there are no partitions at all', () => {
    const home = mkdtempSync(join(tmpdir(), 'loft-adopt-'));
    tmps.push(home);
    expect(findAdoptable(empty, { XDG_DATA_HOME: home } as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe('serverUrlFromCookieHosts', () => {
  it('recovers the server from a partition cookie host', () => {
    expect(serverUrlFromCookieHosts(['nc.example.com'])).toBe('https://nc.example.com');
  });

  it('strips the subdomain-wildcard dot', () => {
    expect(serverUrlFromCookieHosts(['.nc.example.com'])).toBe('https://nc.example.com');
  });

  it('prefers the host that set the most cookies', () => {
    // The NextCloud sets a pile; an OIDC hop on the way in sets one.
    const hosts = ['login.example.com', 'nc.example.com', 'nc.example.com', '.nc.example.com'];
    expect(serverUrlFromCookieHosts(hosts)).toBe('https://nc.example.com');
  });

  it('ignores hosts that are not worth guessing from', () => {
    expect(serverUrlFromCookieHosts(['', '   ', 'localhost4'])).toBeUndefined();
  });

  it('allows localhost, which is a real self-hosted answer', () => {
    expect(serverUrlFromCookieHosts(['localhost'])).toBe('https://localhost');
  });

  it('has no answer when there are no cookies', () => {
    expect(serverUrlFromCookieHosts([])).toBeUndefined();
  });
});
