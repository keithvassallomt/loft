import type { LoftConfig } from './config';

/**
 * v2 (spec 09 §8): the per-service `.desktop` launcher became opt-in.
 * Bump this only alongside a new one-shot step in migrateConfig.
 */
export const CONFIG_VERSION = 2;

/**
 * One-shot migration to v2, mutating cfg in place.
 *
 * Before v2 every installed service got a launcher unconditionally, and nothing
 * recorded that. From v2 `launcher` is opt-in and defaults to false — so without
 * this step, the first run of the new version would sweep away the six .desktop
 * files an existing user already has.
 *
 * The flag is inferred from what is on disk rather than defaulted, matching how
 * isAutostartEnabled() judges autostart by reading the entry back instead of
 * trusting a stored flag. Nobody's launchers vanish; nobody gets new ones.
 *
 * @param hasLauncher  Does a launcher exist on disk for this service id?
 * @returns changed — whether cfg was modified and needs saving.
 */
export function migrateConfig(
  cfg: LoftConfig,
  hasLauncher: (id: string) => boolean,
): { changed: boolean } {
  if ((cfg.configVersion ?? 1) >= CONFIG_VERSION) return { changed: false };
  for (const [id, svc] of Object.entries(cfg.services)) {
    if (svc.launcher === undefined) svc.launcher = hasLauncher(id);
  }
  cfg.configVersion = CONFIG_VERSION;
  return { changed: true };
}
