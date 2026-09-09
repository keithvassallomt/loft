import { describe, it, expect, vi } from 'vitest';
import {
  buildHints, buildNotifyArgs, createNotificationServer, type NotificationServerDeps,
} from '../src/main/notifications/dbus';

describe('buildHints', () => {
  it('always includes desktop-entry, adds image-path only when present', () => {
    const bare = buildHints({ desktopEntry: 'chat.loft.Loft' });
    expect(Object.keys(bare)).toEqual(['desktop-entry']);
    const withImg = buildHints({ desktopEntry: 'chat.loft.Loft', imagePath: '/a/b.png' });
    expect(Object.keys(withImg).sort()).toEqual(['desktop-entry', 'image-path']);
  });
});

describe('buildNotifyArgs', () => {
  it('matches the notifications.rs Notify shape', () => {
    const hints = buildHints({ desktopEntry: 'chat.loft.Loft' });
    const args = buildNotifyArgs({ appName: 'WhatsApp', appIcon: '/i/wa.png', summary: 'Ann', body: 'hi', hints });
    expect(args[0]).toBe('WhatsApp');   // app_name
    expect(args[1]).toBe(0);            // replaces_id
    expect(args[2]).toBe('/i/wa.png');  // app_icon
    expect(args[3]).toBe('Ann');        // summary
    expect(args[4]).toBe('hi');         // body
    expect(args[5]).toEqual(['default', 'Open']); // actions
    expect(args[6]).toBe(hints);        // hints
    expect(args[7]).toBe(-1);           // expire_timeout
  });
});

describe('createNotificationServer', () => {
  interface FakeIface {
    Notify: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    handlers: Record<string, Array<(...a: never[]) => void>>;
  }

  const makeIface = (): FakeIface => {
    const handlers: Record<string, Array<(...a: never[]) => void>> = {};
    return {
      handlers,
      Notify: vi.fn().mockResolvedValue(7),
      on: vi.fn((ev: string, cb: (...a: never[]) => void) => {
        (handlers[ev] ??= []).push(cb);
      }),
    };
  };

  interface Harness {
    deps: NotificationServerDeps;
    bind: ReturnType<typeof vi.fn>;
    /** Fire NameOwnerChanged as the bus would. */
    owner(name: string, next: string): void;
    /** Run every timer the state machine has armed, oldest first. */
    runTimers(): void;
    logs: string[];
  }

  const harness = (bind: ReturnType<typeof vi.fn>): Harness => {
    const owners: Array<(name: string, next: string) => void> = [];
    let timers: Array<() => void> = [];
    const logs: string[] = [];
    return {
      bind,
      logs,
      owner: (name, next) => { for (const cb of owners) cb(name, next); },
      runTimers: () => { const due = timers; timers = []; for (const fn of due) fn(); },
      deps: {
        bind,
        onNameOwnerChanged: (cb) => { owners.push(cb); },
        setTimer: (fn) => { timers.push(fn); return timers.length; },
        clearTimer: () => {},
        log: (msg) => { logs.push(msg); },
      },
    };
  };

  it('binds on the first attempt when the server is already there', async () => {
    const iface = makeIface();
    const h = harness(vi.fn().mockResolvedValue(iface));
    const server = createNotificationServer(h.deps);

    await expect(server.notify({ appName: 'a', appIcon: '', summary: 's', body: 'b' })).resolves.toBe(7);
    expect(h.bind).toHaveBeenCalledTimes(1);
  });

  // The regression this whole module exists for: the notification server is not yet on the
  // bus when Loft starts. The old one-shot connect gave up here and dropped every
  // notification for the rest of the session.
  it('keeps retrying after the first bind fails, and works once the server appears', async () => {
    const iface = makeIface();
    const bind = vi.fn()
      .mockRejectedValueOnce(new Error('unit is masked'))
      .mockResolvedValue(iface);
    const h = harness(bind);
    const server = createNotificationServer(h.deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(bind).toHaveBeenCalledTimes(1);

    h.runTimers();                       // backoff fires
    await Promise.resolve();
    await Promise.resolve();

    await expect(server.notify({ appName: 'a', appIcon: '', summary: 's', body: 'b' })).resolves.toBe(7);
    expect(bind).toHaveBeenCalledTimes(2);
  });

  it('binds the moment the server takes the name, without waiting out the backoff', async () => {
    const iface = makeIface();
    const bind = vi.fn().mockRejectedValueOnce(new Error('no owner')).mockResolvedValue(iface);
    const h = harness(bind);
    createNotificationServer(h.deps);
    await Promise.resolve();
    await Promise.resolve();

    h.owner('org.freedesktop.Notifications', ':1.42');
    await Promise.resolve();
    await Promise.resolve();

    expect(bind).toHaveBeenCalledTimes(2);
    expect(h.logs.some((l) => l.includes('after 1 failed attempt'))).toBe(true);
  });

  it('ignores ownership changes for other names', async () => {
    const bind = vi.fn().mockRejectedValue(new Error('no owner'));
    const h = harness(bind);
    createNotificationServer(h.deps);
    await Promise.resolve();
    await Promise.resolve();

    h.owner('org.kde.StatusNotifierWatcher', ':1.9');
    await Promise.resolve();
    expect(bind).toHaveBeenCalledTimes(1);
  });

  // Rebinding an established proxy would leave the old proxy's ActionInvoked listener
  // attached, so every banner click would route twice.
  it('never rebinds once bound, so a click routes exactly once', async () => {
    const iface = makeIface();
    const h = harness(vi.fn().mockResolvedValue(iface));
    const server = createNotificationServer(h.deps);
    const clicks: number[] = [];
    server.onActionDefault((id) => clicks.push(id));
    await server.notify({ appName: 'a', appIcon: '', summary: 's', body: 'b' });

    h.owner('org.freedesktop.Notifications', ':1.99'); // server restarted
    await Promise.resolve();
    await Promise.resolve();
    expect(h.bind).toHaveBeenCalledTimes(1);

    for (const cb of iface.handlers.ActionInvoked) (cb as (id: number, a: string) => void)(7, 'default');
    expect(clicks).toEqual([7]);
  });

  it('routes only the default action', async () => {
    const iface = makeIface();
    const h = harness(vi.fn().mockResolvedValue(iface));
    const server = createNotificationServer(h.deps);
    const clicks: number[] = [];
    server.onActionDefault((id) => clicks.push(id));
    await server.notify({ appName: 'a', appIcon: '', summary: 's', body: 'b' });

    for (const cb of iface.handlers.ActionInvoked) (cb as (id: number, a: string) => void)(7, 'other');
    expect(clicks).toEqual([]);
  });

  it('rejects (rather than hanging) while no server is reachable', async () => {
    const h = harness(vi.fn().mockRejectedValue(new Error('no owner')));
    const server = createNotificationServer(h.deps);
    await expect(server.notify({ appName: 'a', appIcon: '', summary: 's', body: 'b' }))
      .rejects.toThrow('org.freedesktop.Notifications is not available');
  });
});
