import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getKind, KINDS } from './registry';
import type { LoftConfig } from './config';
import { defaultInstanceName, instanceNumber } from './instances';
import { partitionsRoot } from './paths';

type Env = NodeJS.ProcessEnv;

/**
 * A session partition on disk that no config entry claims — an account Loft is still
 * logged into but no longer lists.
 */
export interface AdoptCandidate {
  /** The partition directory name, which IS the instance id (see the File Layout note). */
  id: string;
  kind: string;
  /** What the service would be called once adopted; what the prompt lists. */
  displayName: string;
  /** This kind cannot load without a server address, and the partition may not name one. */
  serverRequired: boolean;
}

/**
 * Which partitions look like a real logged-in session rather than a husk.
 *
 * Electron creates `persist:<id>` the moment a view is constructed, so the directory
 * existing proves nothing; these two are written only once a page has actually stored
 * something. Requiring one keeps a service the user removed *without* deleting its data
 * out of the list when nothing was ever signed in — though a genuinely logged-in removed
 * service WILL still appear, which is precisely why adoption is offered and never done
 * unasked.
 */
const SESSION_EVIDENCE = ['Cookies', 'Local Storage'];

function looksLoggedIn(dir: string): boolean {
  return SESSION_EVIDENCE.some((f) => existsSync(join(dir, f)));
}

/** The kind a partition directory belongs to, or undefined if it names none. */
function kindOfPartition(id: string): string | undefined {
  const kind = id.includes('-') ? id.slice(0, id.indexOf('-')) : id;
  if (!getKind(kind)) return undefined;
  // instanceNumber rejects `whatsapp-1` and `whatsapp-x` — ids Loft never allocates, so a
  // directory wearing one is not ours to resurrect.
  return instanceNumber(id, kind) > 0 ? kind : undefined;
}

/**
 * Session partitions with no config entry, in the order the rail would show them.
 *
 * This exists because `config.json` is the ONLY record of which services exist, while the
 * logins themselves live in `Partitions/` and survive anything that happens to the config.
 * Both times Loft has lost a config, every partition was still sitting there intact — so
 * the difference between "your settings are gone" and "your settings are back" is this
 * scan plus a prompt.
 *
 * Returns candidates, never actions: nothing here writes, and the caller must ask first.
 * A partition can be unclaimed because the config was lost, and it can equally be
 * unclaimed because the user removed a service and chose to keep its login data — and
 * from disk alone those two are indistinguishable.
 */
export function findAdoptable(cfg: LoftConfig, env: Env = process.env): AdoptCandidate[] {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = readdirSync(partitionsRoot(env), { withFileTypes: true });
  } catch {
    // No Partitions directory at all: a first run, and nothing to offer.
    return [];
  }

  const out: AdoptCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (cfg.services[id] !== undefined) continue;
    const kind = kindOfPartition(id);
    if (!kind) continue;
    if (!looksLoggedIn(join(partitionsRoot(env), id))) continue;

    const def = getKind(kind)!;
    out.push({
      id,
      kind,
      displayName: defaultInstanceName(def.displayName, instanceNumber(id, kind)),
      serverRequired: def.serverRequired === true,
    });
  }

  // Registry order, then account number — the same order a fresh install would list them
  // in, so an adopted rail looks like one that was built by hand.
  const rank = new Map(KINDS.map((k, i) => [k.id, i]));
  return out.sort((a, b) =>
    (rank.get(a.kind)! - rank.get(b.kind)!) ||
    (instanceNumber(a.id, a.kind) - instanceNumber(b.id, b.kind)));
}

/**
 * The server address a self-hosted account was using, recovered from its own cookies.
 *
 * Only `serverRequired` kinds need this, and only because their `customUrl` lives nowhere
 * but the config that was just lost: a NextCloud Talk with no server address loads the
 * registry's `https://example.invalid/` placeholder, so adopting one without this gives
 * the user a broken tile instead of their account.
 *
 * The heuristic is deliberately narrow. Cookie hosts are ranked by how many cookies they
 * set and ties broken by specificity, because a NextCloud sets a pile of cookies on
 * exactly one host while an OIDC hop or a CDN leaves one or two elsewhere. It is a guess,
 * so it is only ever used to prefill a field the user can see and correct.
 *
 * @param hosts  cookie host_keys for the partition, as Electron reports them (a leading
 *               dot means "and subdomains", and is not part of the host).
 */
export function serverUrlFromCookieHosts(hosts: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const raw of hosts) {
    const host = raw.replace(/^\./, '').trim().toLowerCase();
    // localhost is legal here; an IP or a bare label is not worth guessing from.
    if (!host || (!host.includes('.') && host !== 'localhost')) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  const best = [...counts.entries()].sort((a, b) =>
    (b[1] - a[1]) || (b[0].split('.').length - a[0].split('.').length) || a[0].localeCompare(b[0]))[0][0];
  return `https://${best}`;
}
