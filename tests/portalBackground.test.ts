import { describe, it, expect, vi } from 'vitest';
import {
  requestPath, backgroundOptions, requestAutostart, type PortalDeps,
} from '../src/main/portal/background';

/** Fake portal: records the call, then fires whatever Response we tell it to. */
function fake(opts: { response?: number; granted?: boolean; throws?: boolean } = {}) {
  const calls: Array<{ token: string; options: Record<string, unknown> }> = [];
  let cb: ((r: number, res: Record<string, unknown>) => void) | undefined;
  let subscribed: string | undefined;
  let stopped = false;
  const deps: PortalDeps = {
    uniqueName: () => ':1.42',
    onResponse: (path, f) => { subscribed = path; cb = f; return { stop: () => { stopped = true; } }; },
    call: async (token, options) => {
      calls.push({ token, options });
      if (opts.throws) throw new Error('portal unavailable');
      // The real portal replies on the Request path, asynchronously.
      queueMicrotask(() => cb?.(opts.response ?? 0, { autostart: opts.granted ?? true }));
    },
  };
  return { deps, calls, get subscribed() { return subscribed; }, get stopped() { return stopped; } };
}

describe('requestPath', () => {
  it('strips the leading colon and replaces dots', () => {
    expect(requestPath(':1.42', 'tok')).toBe('/org/freedesktop/portal/desktop/request/1_42/tok');
  });
});

describe('backgroundOptions', () => {
  it('carries the exact contract the portal expects', () => {
    const o = backgroundOptions(true, 'tok');
    expect(o.autostart).toBe(true);
    expect(o.commandline).toEqual(['loft', '--minimized']);
    expect(o.reason).toBe('Loft opens your messaging services when you log in.');
    expect(o.handle_token).toBe('tok');
  });
  it('passes autostart:false through for disable', () => {
    expect(backgroundOptions(false, 'tok').autostart).toBe(false);
  });
});

describe('requestAutostart', () => {
  it('resolves true when granted', async () => {
    const f = fake({ response: 0, granted: true });
    await expect(requestAutostart(true, f.deps)).resolves.toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].options.autostart).toBe(true);
  });

  // The portal decides, not us: asking for autostart does not mean getting it.
  it('resolves FALSE when the portal succeeds but denies autostart', async () => {
    const f = fake({ response: 0, granted: false });
    await expect(requestAutostart(true, f.deps)).resolves.toBe(false);
  });

  it('resolves false when the user cancels', async () => {
    const f = fake({ response: 1, granted: true });
    await expect(requestAutostart(true, f.deps)).resolves.toBe(false);
  });

  it('never rejects when the bus throws', async () => {
    const f = fake({ throws: true });
    await expect(requestAutostart(true, f.deps)).resolves.toBe(false);
  });

  it('subscribes to the response path BEFORE calling, and unsubscribes after', async () => {
    const f = fake({ response: 0, granted: true });
    await requestAutostart(true, f.deps);
    expect(f.subscribed).toMatch(/^\/org\/freedesktop\/portal\/desktop\/request\/1_42\//);
    expect(f.stopped).toBe(true);
  });

  it('uses a fresh handle_token per call', async () => {
    const f = fake();
    await requestAutostart(true, f.deps);
    await requestAutostart(true, f.deps);
    expect(f.calls[0].token).not.toBe(f.calls[1].token);
  });
});
