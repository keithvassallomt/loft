import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const AVATAR_TTL_MS = 3_600_000;

export function avatarCacheDir(dataHome?: string): string {
  const base = dataHome || process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'loft', 'avatars');
}

export function avatarCacheKey(input: string): string {
  const seed = input.startsWith('data:') ? input.slice(0, 200) : input;
  return createHash('sha1').update(seed).digest('hex');
}

/** Decode a `data:[mime];base64,<data>` URI to bytes; null if not a base64 data URI with a comma. */
export function parseDataUri(uri: string): Buffer | null {
  if (!uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  try {
    return Buffer.from(uri.slice(comma + 1), 'base64');
  } catch {
    return null;
  }
}

export function isFresh(mtimeMs: number, nowMs: number, ttlMs: number): boolean {
  return nowMs - mtimeMs < ttlMs;
}

export interface AvatarDeps {
  fetch(url: string): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  statMtimeMs(path: string): number | null;
  writeFile(path: string, data: Buffer): void;
  now(): number;
}

/** Resolve an icon reference to a cached local file path (or undefined). Port of notifications.rs. */
export async function resolveAvatar(
  icon: string | undefined,
  deps: AvatarDeps,
  cacheDir: string = avatarCacheDir(),
): Promise<string | undefined> {
  if (!icon) return undefined;

  const cachePath = join(cacheDir, `loft-avatar-${avatarCacheKey(icon)}`);
  const mtime = deps.statMtimeMs(cachePath);
  if (mtime !== null && isFresh(mtime, deps.now(), AVATAR_TTL_MS)) return cachePath;

  if (icon.startsWith('data:')) {
    const bytes = parseDataUri(icon);
    if (!bytes || bytes.length === 0) return undefined;
    deps.writeFile(cachePath, bytes);
    return cachePath;
  }

  if (icon.startsWith('http://') || icon.startsWith('https://')) {
    try {
      const res = await deps.fetch(icon);
      if (!res.ok) return undefined;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) return undefined; // too small to be an image (parity with notifications.rs)
      deps.writeFile(cachePath, buf);
      return cachePath;
    } catch {
      return undefined;
    }
  }

  return undefined; // blob: / relative — resolved in-page before reaching main
}
