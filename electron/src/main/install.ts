import { existsSync, rmSync } from 'node:fs';
import type { ServiceDef } from './registry';
import type { LoftConfig } from './config';
import { writeServiceLauncher, removeServiceLauncher } from './desktop';
import { partitionDir } from './paths';

type Env = NodeJS.ProcessEnv;

export function removePartitionData(id: string, env: Env = process.env): void {
  const dir = partitionDir(id, env);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Idempotent: mark the service configured, set a custom URL if given, write its launcher. */
export function addService(
  def: ServiceDef,
  cfg: LoftConfig,
  opts: { env?: Env; execPath?: string; iconSourceDir: string; customUrl?: string },
): void {
  cfg.services[def.id] = { ...cfg.services[def.id] };
  if (opts.customUrl !== undefined) cfg.services[def.id].customUrl = opts.customUrl;
  writeServiceLauncher(def, { env: opts.env, execPath: opts.execPath, iconSourceDir: opts.iconSourceDir });
}

export function removeService(
  def: ServiceDef,
  cfg: LoftConfig,
  deleteData: boolean,
  env: Env = process.env,
): void {
  removeServiceLauncher(def, env);
  delete cfg.services[def.id];
  if (deleteData) removePartitionData(def.id, env);
}
