import { describe, it, expect, vi } from 'vitest';
import {
  avatarCacheKey, parseDataUri, isFresh, resolveAvatar, AVATAR_TTL_MS,
} from '../src/main/notifications/avatars';

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function fakeDeps(over: Partial<Parameters<typeof resolveAvatar>[1]> = {}) {
  return {
    fetch: vi.fn(async (_url: string) => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(200).buffer })),
    statMtimeMs: vi.fn(() => null),
    writeFile: vi.fn(),
    now: () => 1_000_000,
    ...over,
  };
}

describe('avatar pure helpers', () => {
  it('cache key is stable and hashes long data URIs by prefix', () => {
    expect(avatarCacheKey('https://x/a.png')).toBe(avatarCacheKey('https://x/a.png'));
    const long = 'data:image/png;base64,' + 'A'.repeat(5000);
    const long2 = 'data:image/png;base64,' + 'A'.repeat(200 - 'data:image/png;base64,'.length) + 'B'.repeat(5000);
    // First 200 chars identical → same key despite different tails.
    expect(avatarCacheKey(long)).toBe(avatarCacheKey(long2));
  });
  it('parses data URIs and rejects malformed ones', () => {
    expect(parseDataUri(PNG_1x1)?.length).toBeGreaterThan(0);
    expect(parseDataUri('data:image/png;base64')).toBeNull(); // no comma
    expect(parseDataUri('https://x')).toBeNull();
  });
  it('freshness respects the TTL', () => {
    expect(isFresh(1000, 1000 + AVATAR_TTL_MS - 1, AVATAR_TTL_MS)).toBe(true);
    expect(isFresh(1000, 1000 + AVATAR_TTL_MS + 1, AVATAR_TTL_MS)).toBe(false);
  });
});

describe('resolveAvatar', () => {
  it('returns undefined for empty / blob / relative', async () => {
    const d = fakeDeps();
    expect(await resolveAvatar(undefined, d)).toBeUndefined();
    expect(await resolveAvatar('', d)).toBeUndefined();
    expect(await resolveAvatar('blob:https://x/abc', d)).toBeUndefined();
    expect(await resolveAvatar('/avatar/x/64', d)).toBeUndefined();
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it('decodes and caches a data URI without fetching', async () => {
    const d = fakeDeps();
    const p = await resolveAvatar(PNG_1x1, d, '/cache');
    expect(p).toMatch(/^\/cache\/loft-avatar-/);
    expect(d.writeFile).toHaveBeenCalledOnce();
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it('fetches and caches an http URL, rejecting tiny responses', async () => {
    const ok = fakeDeps();
    expect(await resolveAvatar('https://x/a.png', ok, '/cache')).toMatch(/^\/cache\//);
    expect(ok.fetch).toHaveBeenCalledOnce();

    const tiny = fakeDeps({ fetch: vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(10).buffer })) });
    expect(await resolveAvatar('https://x/a.png', tiny, '/cache')).toBeUndefined();

    const bad = fakeDeps({ fetch: vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new Uint8Array(0).buffer })) });
    expect(await resolveAvatar('https://x/a.png', bad, '/cache')).toBeUndefined();
  });
  it('reuses a fresh cache file without fetching', async () => {
    const d = fakeDeps({ statMtimeMs: vi.fn(() => 1_000_000 - 1000) });
    const p = await resolveAvatar('https://x/a.png', d, '/cache');
    expect(p).toMatch(/^\/cache\//);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.writeFile).not.toHaveBeenCalled();
  });
});
