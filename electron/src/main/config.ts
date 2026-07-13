import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { TrayBackend } from './trayBackend';

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
  /** Per-service badge indicator toggle (tray/title); GetStatus() still reports the true count when false. */
  badgesEnabled?: boolean;
}

export interface LoftConfig {
  services: Record<string, ServiceConfig>;
  /** Global Do Not Disturb (mutes every service); persisted + reflected in the tray. */
  globalDnd?: boolean;
  /** Tray backend preference ('auto', 'gnome-panel', or 'sni'). */
  trayBackend?: TrayBackend;
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
    const trayBackend =
      parsed.trayBackend === 'gnome-panel' || parsed.trayBackend === 'sni' || parsed.trayBackend === 'auto'
        ? parsed.trayBackend
        : undefined;
    const base: LoftConfig = { services };
    if (parsed.globalDnd === true) base.globalDnd = true;
    if (trayBackend) base.trayBackend = trayBackend;
    return base;
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(path: string, cfg: LoftConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
}
