import { describe, it, expect } from 'vitest';
import { WATCHER_BACKOFF_SECONDS, nextBackoff } from '../src/main/tray/watcher';

describe('watcher backoff', () => {
  it('follows the ksni-proven schedule then holds at the max', () => {
    expect(WATCHER_BACKOFF_SECONDS).toEqual([0, 2, 4, 8, 16]);
    expect([0, 1, 2, 3, 4, 5].map(nextBackoff)).toEqual([0, 2, 4, 8, 16, 16]);
  });
});
