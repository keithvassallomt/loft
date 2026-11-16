/**
 * Chromium features Loft turns on that the bundled Chromium leaves off.
 *
 * XdgFileTransferPortal: lets a file dragged in from the desktop reach a web app inside the
 * Flatpak. The drag source (Nautilus, Dolphin, ...) offers two things: the file's real path,
 * and a key for the file-transfer portal. The sandbox cannot read the real path unless Loft
 * holds a filesystem grant covering it, and it deliberately holds none. The key, though,
 * resolves through org.freedesktop.portal.Documents to a /run/user/<uid>/doc/... copy the
 * sandbox CAN read.
 *
 * Chromium 150 (Electron 43) fetches that key and then throws it away, because the code that
 * resolves it sits behind this feature and the feature is off by default there. The page is
 * handed the unreadable host path instead: a zero-size File with no file-system entry, which
 * Slack reports as "a type of file not supported by Slack" (measured 2026-11-16, Hyprland +
 * Nautilus, dropping from ~/Downloads). The attach button was never affected, because the
 * file chooser goes through a portal of its own.
 *
 * Upstream switched it on by default in Chromium 151 (chromium/src d6053371a1, 2026-06-24),
 * so this entry can be dropped once Electron ships 151 or later. It is harmless outside a
 * sandbox: for an unsandboxed caller the portal simply returns the original paths.
 */
export const LOFT_ENABLED_FEATURES: readonly string[] = ['XdgFileTransferPortal'];

/** Adds `add` to a comma-separated --enable-features value, keeping whatever was there. */
export function mergeFeatureList(existing: string, add: readonly string[]): string {
  const features = existing.split(',').map((f) => f.trim()).filter(Boolean);
  for (const f of add) if (!features.includes(f)) features.push(f);
  return features.join(',');
}

/** The slice of Electron's `app.commandLine` this needs. */
export interface FeatureCommandLine {
  getSwitchValue(name: string): string;
  appendSwitch(name: string, value?: string): void;
}

/**
 * Must run before the app's `ready` event: Chromium reads its feature list once, at startup.
 * Merges rather than overwrites, because appending a switch that is already present replaces
 * its value, which would silently discard an --enable-features passed on the command line.
 */
export function enableChromiumFeatures(
  commandLine: FeatureCommandLine,
  features: readonly string[] = LOFT_ENABLED_FEATURES,
): void {
  commandLine.appendSwitch('enable-features', mergeFeatureList(commandLine.getSwitchValue('enable-features'), features));
}
