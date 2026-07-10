import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  zoom: number;
}

export interface ServiceConfig {
  customUrl?: string;
  window?: WindowState;
  openOnStartup?: boolean;
  /** Per-service Do Not Disturb; persisted + reflected in the tray menu (gating notifications is Stage 3b). */
  dnd?: boolean;
}

export interface LoftConfig {
  services: Record<string, ServiceConfig>;
}

export function defaultConfig(): LoftConfig {
  return { services: {} };
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'loft', 'config.json');
}

export function loadConfig(path: string): LoftConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LoftConfig>;
    const services =
      parsed.services && typeof parsed.services === 'object' && !Array.isArray(parsed.services)
        ? (parsed.services as Record<string, ServiceConfig>)
        : {};
    return { services };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(path: string, cfg: LoftConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
}
