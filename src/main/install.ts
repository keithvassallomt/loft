import { existsSync, rmSync } from 'node:fs';
import type { ServiceKind } from './registry';
import type { LoftConfig } from './config';
import { removeServiceLauncher } from './desktop';
import type { ServiceInstance } from './instances';
import { partitionDir } from './paths';

type Env = NodeJS.ProcessEnv;

// TEMPORARY (Task 6 → replaced in Task 10): install.ts still deals in kinds, but
// removeServiceLauncher now wants an instance (Task 6). Fake up a bare-kind instance
// (account #1: id = kind id, brand icon) so this file compiles until Task 10 makes
// install.ts instance-aware for real.
const asInstance = (d: ServiceKind): ServiceInstance =>
  ({ ...d, kind: d.id, dbusSegment: d.displayName.replace(/\s+/g, ''), icon: 'brand' });

export function removePartitionData(id: string, env: Env = process.env): void {
  const dir = partitionDir(id, env);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Idempotent: mark the service configured and set a custom URL if given. New services are
 *  launcher-less by default (spec 09 Q2 / 09c-3) — a per-service .desktop is opt-in from the
 *  service's settings, so Add no longer writes one. */
export function addService(def: ServiceKind, cfg: LoftConfig, opts: { customUrl?: string } = {}): void {
  cfg.services[def.id] = { ...cfg.services[def.id] };
  if (opts.customUrl !== undefined) cfg.services[def.id].customUrl = opts.customUrl;
}

export function removeService(
  def: ServiceKind,
  cfg: LoftConfig,
  deleteData: boolean,
  env: Env = process.env,
): void {
  removeServiceLauncher(asInstance(def), env);
  delete cfg.services[def.id];
  if (deleteData) removePartitionData(def.id, env);
}
