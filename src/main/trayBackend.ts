export type TrayBackend = 'auto' | 'gnome-panel' | 'sni';

/** True when XDG_CURRENT_DESKTOP contains a colon-separated token equal (case-insensitive) to GNOME. */
export function isGnome(env: NodeJS.ProcessEnv): boolean {
  const desktop = env.XDG_CURRENT_DESKTOP ?? '';
  return desktop.split(':').some((d) => d.toLowerCase() === 'gnome');
}

/** True when XDG_CURRENT_DESKTOP contains a colon-separated token equal (case-insensitive) to KDE. */
export function isKde(env: NodeJS.ProcessEnv): boolean {
  const desktop = env.XDG_CURRENT_DESKTOP ?? '';
  return desktop.split(':').some((d) => d.toLowerCase() === 'kde');
}

/** Port of Rust `TrayBackend::resolve()`: auto → gnome-panel on GNOME, else sni. */
export function resolveTrayBackend(
  value: TrayBackend | undefined,
  env: NodeJS.ProcessEnv,
): 'gnome-panel' | 'sni' {
  if (value === 'gnome-panel' || value === 'sni') return value;
  return isGnome(env) ? 'gnome-panel' : 'sni';
}
