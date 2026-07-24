import { existsSync, rmSync } from 'node:fs';
import type { ServiceKind } from './registry';
import type { LoftConfig, ServiceConfig } from './config';
import {
  allocateInstanceId, allocateInstanceName, defaultInstanceName, instanceNumber,
  listInstances, resolveInstance, type ServiceInstance,
} from './instances';
import { pickVariantFor } from './icons';
import { removeServiceLauncher, deployInstanceIcon, removeInstanceIcon } from './desktop';
import { partitionDir } from './paths';

type Env = NodeJS.ProcessEnv;

export function removePartitionData(id: string, env: Env = process.env): void {
  const dir = partitionDir(id, env);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Install one account of a kind and return it.
 *
 * `kind` is stored even for the first instance, where it is derivable: an explicit field
 * is what makes a hand-read config say which app an id belongs to. `name` is stored only
 * when the derived default is already taken — leaving it absent keeps a future registry
 * rename propagating. `icon` is stored whenever it is not the brand, because an
 * auto-picked colour is not stable as siblings come and go.
 *
 * New accounts are launcher-less (spec 09 Q2 / 09c-3); a `.desktop` is opt-in from the
 * service's own settings.
 */
export function addInstance(
  kind: ServiceKind,
  cfg: LoftConfig,
  opts: { customUrl?: string; variants?: string[]; iconSourceDir: string; env?: Env },
): ServiceInstance {
  const id = allocateInstanceId(kind.id, cfg);
  const n = instanceNumber(id, kind.id);

  const entry: ServiceConfig = { kind: kind.id };
  if (opts.customUrl !== undefined) entry.customUrl = opts.customUrl;

  if (n > 1) {
    // Two accounts of a kind wearing the same logo are indistinguishable in the rail,
    // the tray and the app grid — so the second one gets a colour without being asked.
    const used = listInstances(cfg).filter((i) => i.kind === kind.id).map((i) => i.icon);
    const colour = pickVariantFor(used, opts.variants ?? []);
    if (colour) entry.icon = colour;
  }

  const name = allocateInstanceName(kind.displayName, n, cfg);
  if (name !== defaultInstanceName(kind.displayName, n)) entry.name = name;

  cfg.services[id] = entry;
  const inst = resolveInstance(id, cfg)!;
  deployInstanceIcon(inst, { env: opts.env, iconSourceDir: opts.iconSourceDir });
  return inst;
}

export function removeInstance(
  inst: ServiceInstance,
  cfg: LoftConfig,
  deleteData: boolean,
  env: Env = process.env,
): void {
  removeServiceLauncher(inst, env);
  removeInstanceIcon(inst.id, env);
  delete cfg.services[inst.id];
  if (deleteData) removePartitionData(inst.id, env);
}
