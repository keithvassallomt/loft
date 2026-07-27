import { describe, it, expect, vi } from 'vitest';
import {
  bubbleAvatarPath, saveBubbleAvatar, deleteBubbleAvatar, type BubbleAvatarDeps,
} from '../src/main/bubbleAvatars';
import { bubblesDir } from '../src/main/paths';

const env = { XDG_DATA_HOME: '/data' } as NodeJS.ProcessEnv;
const png = Buffer.alloc(300, 7);

function deps(over: Partial<BubbleAvatarDeps> = {}): BubbleAvatarDeps & {
  written: Array<{ path: string; bytes: Buffer }>;
} {
  const written: Array<{ path: string; bytes: Buffer }> = [];
  return {
    fetch: vi.fn(async () => ({ ok: true, arrayBuffer: async () => png.buffer as ArrayBuffer })),
    write: (path: string, bytes: Buffer) => { written.push({ path, bytes }); },
    remove: vi.fn(),
    toPng: (b: Buffer) => b,
    written,
    ...over,
  };
}

describe('paths', () => {
  it('puts bubble avatars beside the other per-id images', () => {
    expect(bubblesDir(env)).toBe('/data/loft/bubbles');
    expect(bubbleAvatarPath('whatsapp-abc123', env)).toBe('/data/loft/bubbles/whatsapp-abc123.png');
  });
});

describe('saveBubbleAvatar', () => {
  it('fetches, converts and writes', async () => {
    const d = deps();
    expect(await saveBubbleAvatar('b1', 'https://x/a.jpg', d, env)).toBe(true);
    expect(d.written[0].path).toBe('/data/loft/bubbles/b1.png');
    expect(d.fetch).toHaveBeenCalledWith('https://x/a.jpg');
  });

  it('reports false and writes nothing when there is no url', async () => {
    const d = deps();
    expect(await saveBubbleAvatar('b1', undefined, d, env)).toBe(false);
    expect(d.written).toHaveLength(0);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('reports false on a failed fetch — every Slack channel lands here', async () => {
    const d = deps({ fetch: vi.fn(async () => ({ ok: false, arrayBuffer: async () => png.buffer as ArrayBuffer })) });
    expect(await saveBubbleAvatar('b1', 'https://x/a.jpg', d, env)).toBe(false);
    expect(d.written).toHaveLength(0);
  });

  it('reports false rather than throwing when the fetch rejects', async () => {
    const d = deps({ fetch: vi.fn(async () => { throw new Error('offline'); }) });
    expect(await saveBubbleAvatar('b1', 'https://x/a.jpg', d, env)).toBe(false);
  });

  it('rejects a response too small to be an image', async () => {
    const tiny = Buffer.alloc(10);
    const d = deps({ fetch: vi.fn(async () => ({ ok: true, arrayBuffer: async () => tiny.buffer as ArrayBuffer })) });
    expect(await saveBubbleAvatar('b1', 'https://x/a.jpg', d, env)).toBe(false);
  });

  it('reports false when decoding yields nothing, rather than writing an empty file', async () => {
    const d = deps({ toPng: () => Buffer.alloc(0) });
    expect(await saveBubbleAvatar('b1', 'https://x/a.jpg', d, env)).toBe(false);
    expect(d.written).toHaveLength(0);
  });

  it('reports false rather than throwing when the write fails', async () => {
    const d = deps({ write: () => { throw new Error('read-only fs'); } });
    expect(await saveBubbleAvatar('b1', 'https://x/a.jpg', d, env)).toBe(false);
  });
});

describe('deleteBubbleAvatar', () => {
  it('removes the file for a bubble', () => {
    const d = deps();
    deleteBubbleAvatar('b1', d, env);
    expect(d.remove).toHaveBeenCalledWith('/data/loft/bubbles/b1.png');
  });
  it('does not throw when the file is already gone', () => {
    const d = deps({ remove: () => { throw new Error('ENOENT'); } });
    expect(() => deleteBubbleAvatar('b1', d, env)).not.toThrow();
  });
});

/**
 * Every failure path returned a bare `false`, so an avatar that never arrived left no trace
 * anywhere — which is exactly why Element's took a round trip of guessing to narrow down.
 * A dropped avatar is ORDINARY (every Slack channel has none), but it should still say why.
 */
describe('saveBubbleAvatar failure reporting', () => {
  const reasons = async (over: Partial<BubbleAvatarDeps>, url?: string): Promise<string[]> => {
    const seen: string[] = [];
    await saveBubbleAvatar('b1', url, deps({ ...over, onFail: (r) => seen.push(r) }), env);
    return seen;
  };

  it('names an HTTP failure, with the status', async () => {
    const got = await reasons(
      { fetch: async () => ({ ok: false, status: 401, arrayBuffer: async () => png.buffer as ArrayBuffer }) },
      'https://matrix.example.org/_matrix/media/v3/thumbnail/x',
    );
    expect(got[0]).toContain('401');
  });

  it('distinguishes a too-small response from an undecodable one', async () => {
    const tiny = Buffer.alloc(20, 1);
    expect((await reasons(
      { fetch: async () => ({ ok: true, arrayBuffer: async () => tiny.buffer as ArrayBuffer }) },
      'https://x/a.jpg',
    ))[0]).toMatch(/small|20/);

    // What a WebP or an SVG does: fetched fine, nativeImage cannot decode it.
    expect((await reasons({ toPng: () => Buffer.alloc(0) }, 'https://x/a.webp'))[0])
      .toMatch(/decod/i);
  });

  it('reports a thrown fetch rather than swallowing it', async () => {
    const got = await reasons(
      { fetch: async () => { throw new Error('net::ERR_CERT_AUTHORITY_INVALID'); } },
      'https://x/a.jpg',
    );
    expect(got[0]).toContain('ERR_CERT_AUTHORITY_INVALID');
  });

  it('says nothing at all when there was simply no avatar — the designed path', async () => {
    expect(await reasons({}, undefined)).toEqual([]);
  });

  it('says nothing on success', async () => {
    expect(await reasons({}, 'https://x/a.jpg')).toEqual([]);
  });
});
