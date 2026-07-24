import { describe, it, expect, vi } from 'vitest';

// M2: defaultPortalDeps() memoizes a real dbus-next session bus for the process
// lifetime; an unhandled 'error' event on an EventEmitter throws and would kill
// the whole main process. Mock dbus-next with a real EventEmitter so we can prove
// a listener is attached — vi.hoisted() so the factory below (which vi.mock
// relocates above these imports) can safely reference it.
const dbusMock = vi.hoisted(() => {
  const { EventEmitter } = require('node:events');
  class FakeBus extends EventEmitter {
    name: string | null = ':1.99'; // non-null: skip the 'connect' wait in ready()
  }
  const instances: InstanceType<typeof FakeBus>[] = [];
  return {
    instances,
    sessionBus: () => {
      const b = new FakeBus();
      instances.push(b);
      return b;
    },
  };
});

vi.mock('dbus-next', () => ({
  sessionBus: dbusMock.sessionBus,
  Message: class Message { constructor(opts: Record<string, unknown>) { Object.assign(this, opts); } },
  Variant: class Variant { constructor(public sig: string, public val: unknown) {} },
}));

import {
  requestPath, backgroundOptions, requestAutostart, defaultPortalDeps, type PortalDeps,
} from '../src/main/portal/background';

/** Fake portal: records the call, then fires whatever Response we tell it to. */
function fake(
  opts: {
    response?: number;
    granted?: boolean;
    throws?: boolean;
    onResponseThrows?: boolean;
    neverResponds?: boolean;
  } = {},
) {
  const calls: Array<{ token: string; options: Record<string, unknown> }> = [];
  let cb: ((r: number, res: Record<string, unknown>) => void) | undefined;
  let subscribed: string | undefined;
  let stopped = false;
  const deps: PortalDeps = {
    ready: () => Promise.resolve(),
    uniqueName: () => ':1.42',
    onResponse: (path, f) => {
      if (opts.onResponseThrows) throw new Error('subscription failed');
      subscribed = path;
      cb = f;
      return { stop: () => { stopped = true; } };
    },
    call: async (token, options) => {
      calls.push({ token, options });
      if (opts.throws) throw new Error('portal unavailable');
      if (opts.neverResponds) return; // the real portal can just... never reply.
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

  // Critical 2 / Important 4: onResponse throwing must not become an
  // unhandled rejection, and must not let RequestBackground fire without
  // anything listening for the answer.
  it('never rejects and never calls deps.call when onResponse throws', async () => {
    const f = fake({ onResponseThrows: true });
    await expect(requestAutostart(true, f.deps)).resolves.toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  // Important 3: a Response that never arrives must not hang forever or
  // leak the subscription — it resolves false once the leak-guard timeout
  // fires, and sub.stop() must have run.
  it('resolves false and stops the subscription when the Response never arrives', async () => {
    vi.useFakeTimers();
    try {
      const f = fake({ neverResponds: true });
      const pending = requestAutostart(true, f.deps);
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(pending).resolves.toBe(false);
      expect(f.stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Critical 1: uniqueName() is only safe to read after ready() resolves —
  // dbus-next's bus.name is null until the async Hello() round-trip
  // completes. This fake throws if read too early.
  it('awaits deps.ready() before reading deps.uniqueName()', async () => {
    let readyResolved = false;
    const deps: PortalDeps = {
      ready: () =>
        new Promise((resolve) => {
          queueMicrotask(() => {
            readyResolved = true;
            resolve();
          });
        }),
      uniqueName: () => {
        if (!readyResolved) throw new Error('uniqueName() read before ready() resolved');
        return ':1.42';
      },
      onResponse: (_path, cb) => {
        queueMicrotask(() => cb(0, { autostart: true }));
        return { stop: () => {} };
      },
      call: async () => {},
    };
    await expect(requestAutostart(true, deps)).resolves.toBe(true);
  });
});

describe('defaultPortalDeps', () => {
  // M2: dbus-next's MessageBus is an EventEmitter; emitting 'error' with zero
  // listeners makes Node re-throw it synchronously, which would crash the whole
  // Electron main process over a routine async bus hiccup. defaultPortalDeps()
  // must attach a listener so that can't happen.
  it('attaches an error listener to the session bus (an unhandled bus error cannot crash the process)', () => {
    defaultPortalDeps();
    const bus = dbusMock.instances.at(-1)!;
    expect(bus.listenerCount('error')).toBeGreaterThan(0);
    expect(() => bus.emit('error', new Error('boom'))).not.toThrow();
  });
});
