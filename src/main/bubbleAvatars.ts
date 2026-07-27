import { join } from 'node:path';
import { bubblesDir } from './paths';

type Env = NodeJS.ProcessEnv;

export function bubbleAvatarPath(id: string, env: Env = process.env): string {
  return join(bubblesDir(env), `${id}.png`);
}

export interface BubbleAvatarDeps {
  /** Fetched through the SERVICE's own partition session, so authenticated avatars work —
   *  the mechanism notifications already use for Element and Talk. */
  fetch(url: string): Promise<{ ok: boolean; status?: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  write(path: string, bytes: Buffer): void;
  remove(path: string): void;
  /** Normalise format and size (nativeImage in production; identity in tests). */
  toPng(bytes: Buffer): Buffer;
  /**
   * Why an avatar we DID have a url for never arrived. Not called when there was no url at
   * all, which is the ordinary no-avatar case and not a failure.
   *
   * Every path here used to return a bare `false`, so a missing avatar left no trace in the
   * log, the config or the filesystem — and the five causes (no url, HTTP error, truncated
   * body, undecodable format, thrown request) are indistinguishable on screen: all five draw
   * initials.
   */
  onFail?(reason: string): void;
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
  const fail = (reason: string): false => { deps.onFail?.(reason); return false; };
  try {
    // Already inlined by the preload — a blob url that could only be read inside the page
    // (Telegram serves nothing else). No fetch to do; decode and write.
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      if (comma < 0) return fail('malformed data: url');
      const raw = Buffer.from(url.slice(comma + 1), 'base64');
      if (raw.length < MIN_IMAGE_BYTES) return fail(`data: url decoded to ${raw.length} bytes`);
      const png = deps.toPng(raw);
      if (png.length === 0) return fail(`could not decode ${raw.length} inlined bytes`);
      deps.write(bubbleAvatarPath(id, env), png);
      return true;
    }
    const res = await deps.fetch(url);
    if (!res.ok) return fail(`HTTP ${res.status ?? '?'} from ${url}`);
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.length < MIN_IMAGE_BYTES) return fail(`response too small (${raw.length} bytes) from ${url}`);
    const png = deps.toPng(raw);
    // Undecodable — better no file than a broken one. nativeImage reads PNG and JPEG, so a
    // WebP, AVIF or SVG avatar lands here having downloaded perfectly.
    if (png.length === 0) return fail(`could not decode ${raw.length} bytes from ${url}`);
    deps.write(bubbleAvatarPath(id, env), png);
    return true;
  } catch (e) {
    return fail(`${(e as Error).message} — ${url}`);
  }
}

export function deleteBubbleAvatar(
  id: string, deps: Pick<BubbleAvatarDeps, 'remove'>, env: Env = process.env,
): void {
  try { deps.remove(bubbleAvatarPath(id, env)); } catch { /* already gone */ }
}
