import { existsSync, rmSync } from 'node:fs';
import type { ServiceKind } from './registry';
import type { LoftConfig } from './config';
import { removeServiceLauncher } from './desktop';
import { partitionDir } from './paths';

type Env = NodeJS.ProcessEnv;

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
  removeServiceLauncher(def, env);
  delete cfg.services[def.id];
  if (deleteData) removePartitionData(def.id, env);
}
