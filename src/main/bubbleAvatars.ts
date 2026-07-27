import { join } from 'node:path';
import { bubblesDir } from './paths';

type Env = NodeJS.ProcessEnv;

export function bubbleAvatarPath(id: string, env: Env = process.env): string {
  return join(bubblesDir(env), `${id}.png`);
}

export interface BubbleAvatarDeps {
  /** Fetched through the SERVICE's own partition session, so authenticated avatars work —
   *  the mechanism notifications already use for Element and Talk. */
  fetch(url: string): Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;
  write(path: string, bytes: Buffer): void;
  remove(path: string): void;
  /** Normalise format and size (nativeImage in production; identity in tests). */
  toPng(bytes: Buffer): Buffer;
}

/** Below this a response is an error page or a tracking pixel, not an avatar. Same threshold
 *  notifications/avatars.ts already applies. */
const MIN_IMAGE_BYTES = 100;

/**
 * Download and persist a bubble's avatar. Returns whether a file now exists.
 *
 * Persisted rather than fetched on demand, for two reasons. A bubble must render while its
 * service is ASLEEP, when there is no page to ask. And these URLs expire — WhatsApp's carry
 * signed `stp=` parameters, Slack's a size suffix and a hash — so storing the URL would give
 * a bubble that works today and 404s next week.
 *
 * Failure is ordinary here, not exceptional: every Slack channel has no avatar at all. No
 * file is written, `loft://bubble/<id>` 404s, and the rail's existing `img.onerror` handler
 * draws initials. That is the designed path, which is why this returns a boolean rather than
 * throwing.
 */
export async function saveBubbleAvatar(
  id: string, url: string | undefined, deps: BubbleAvatarDeps, env: Env = process.env,
): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await deps.fetch(url);
    if (!res.ok) return false;
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.length < MIN_IMAGE_BYTES) return false;
    const png = deps.toPng(raw);
    if (png.length === 0) return false; // undecodable — better no file than a broken one
    deps.write(bubbleAvatarPath(id, env), png);
    return true;
  } catch {
    return false;
  }
}

export function deleteBubbleAvatar(
  id: string, deps: Pick<BubbleAvatarDeps, 'remove'>, env: Env = process.env,
): void {
  try { deps.remove(bubbleAvatarPath(id, env)); } catch { /* already gone */ }
}
