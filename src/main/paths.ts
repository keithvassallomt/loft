import { join } from 'node:path';
import { homedir } from 'node:os';

type Env = NodeJS.ProcessEnv;

export function dataHome(env: Env = process.env): string {
  return env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share');
}

export function configHome(env: Env = process.env): string {
  return env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
}

export function applicationsDir(env: Env = process.env): string {
  return join(dataHome(env), 'applications');
}

export function loftDataDir(env: Env = process.env): string {
  return join(dataHome(env), 'loft');
}

export function iconsDir(env: Env = process.env): string {
  return join(loftDataDir(env), 'icons');
}

/** Per-bubble avatar PNGs, keyed by bubble id — the same shape as iconsDir. */
export function bubblesDir(env: Env = process.env): string {
  return join(loftDataDir(env), 'bubbles');
}

export function partitionDir(id: string, env: Env = process.env): string {
  return join(loftDataDir(env), 'Partitions', id);
}

export function autostartDir(env: Env = process.env): string {
  return join(configHome(env), 'autostart');
}
