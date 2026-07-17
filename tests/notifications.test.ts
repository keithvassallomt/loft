import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotifyParams, NotificationServer } from '../src/main/notifications/dbus';
import type { NotificationsDeps } from '../src/main/notifications';

// startNotifications talks to the real session bus (connectNotificationServer)
// and shells out to gsettings (watchSystemDnd) — neither is available/desired
// in a test run, so both are replaced with in-memory fakes. Everything else
// (the gate wiring, pending-map click routing, DND push plumbing) is real.
const connectNotificationServerMock = vi.fn();
vi.mock('../src/main/notifications/dbus', () => ({
  connectNotificationServer: (...args: unknown[]) => connectNotificationServerMock(...args),
}));

const watchSystemDndMock = vi.fn();
vi.mock('../src/main/notifications/systemDnd', () => ({
  watchSystemDnd: (...args: unknown[]) => watchSystemDndMock(...args),
}));

import { startNotifications } from '../src/main/notifications';

function makeFakeServer(): NotificationServer & { notifyCalls: NotifyParams[]; fireAction(id: number): void } {
  const notifyCalls: NotifyParams[] = [];
  let actionCb: ((id: number) => void) | undefined;
  let nextId = 1;
  return {
    notifyCalls,
    async notify(p: NotifyParams) {
      notifyCalls.push(p);
      return nextId++;
    },
    onActionDefault(cb: (id: number) => void) {
      actionCb = cb;
    },
    fireAction(id: number) {
      actionCb?.(id);
    },
  };
}

function makeDeps(): NotificationsDeps & {
  pushDndCalls: Array<[string, boolean]>;
  pushHiddenCalls: Array<[string, boolean]>;
  focusCalls: string[];
  navigateCalls: Array<[string, string]>;
} {
  const pushDndCalls: Array<[string, boolean]> = [];
  const pushHiddenCalls: Array<[string, boolean]> = [];
  const focusCalls: string[] = [];
  const navigateCalls: Array<[string, string]> = [];
  return {
    displayName: (id) => id,
    serviceIconPath: (id) => `/icons/${id}.png`,
    sessionFetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
    focusService: (id) => focusCalls.push(id),
    navigate: (id, url) => navigateCalls.push([id, url]),
    pushDnd: (id, v) => pushDndCalls.push([id, v]),
    pushHidden: (id, hidden) => pushHiddenCalls.push([id, hidden]),
    pushDndCalls,
    pushHiddenCalls,
    focusCalls,
    navigateCalls,
  };
}

beforeEach(() => {
  connectNotificationServerMock.mockReset();
  watchSystemDndMock.mockReset().mockReturnValue({ current: () => false, stop: () => {} });
});

describe('startNotifications', () => {
  it('close() stops the system-DND watcher', async () => {
    // Regression: the GNOME backend spawns `gsettings monitor` as a child process, and
    // watchSystemDnd returns the stopper that kills it — but nothing ever called it, so
    // every run leaked the child. Under Flatpak the leaked child keeps bwrap alive, so
    // the app's flatpak instance never exits; GNOME then treats Loft as still running and
    // ACTIVATES it instead of launching, and clicking the icon does nothing at all.
    const stop = vi.fn();
    watchSystemDndMock.mockReturnValue({ current: () => false, stop });
    connectNotificationServerMock.mockResolvedValue(makeFakeServer());

    const n = await startNotifications(makeDeps());
    expect(stop).not.toHaveBeenCalled();
    n.close();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('close() is idempotent and survives a watcher that never started', async () => {
    // watchSystemDnd is wrapped in try/catch (a missing gsettings must not kill startup),
    // so `watcher` can legitimately be undefined. close() must not throw on that path, and
    // must not double-kill on the normal one — both shutdown routes can fire.
    const stop = vi.fn();
    watchSystemDndMock.mockImplementation(() => { throw new Error('gsettings missing'); });
    connectNotificationServerMock.mockResolvedValue(makeFakeServer());
    const failed = await startNotifications(makeDeps());
    expect(() => { failed.close(); failed.close(); }).not.toThrow();

    watchSystemDndMock.mockReset().mockReturnValue({ current: () => false, stop });
    connectNotificationServerMock.mockResolvedValue(makeFakeServer());
    const ok = await startNotifications(makeDeps());
    ok.close();
    ok.close();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('suppresses handle() when the gate says no (per-service DND)', async () => {
    const server = makeFakeServer();
    connectNotificationServerMock.mockResolvedValue(server);
    const deps = makeDeps();
    const n = await startNotifications(deps);

    n.setServiceDnd('slack', true);
    await n.handle('slack', { title: 'Ann', body: 'hi' });

    expect(server.notifyCalls).toHaveLength(0);
  });

  it('delivers a notification and routes a click back through pending', async () => {
    const server = makeFakeServer();
    connectNotificationServerMock.mockResolvedValue(server);
    const deps = makeDeps();
    const n = await startNotifications(deps);

    await n.handle('messenger', { title: 'Ann', body: 'hi', href: '/t/123' });

    expect(server.notifyCalls).toEqual([
      { appName: 'messenger', appIcon: '/icons/messenger.png', summary: 'Ann', body: 'hi', imagePath: undefined },
    ]);

    server.fireAction(1); // the id returned by the fake server's first notify()
    expect(deps.focusCalls).toEqual(['messenger']);
    expect(deps.navigateCalls).toEqual([['messenger', '/t/123']]);
  });

  it('ignores action callbacks for ids it never sent (parity with sent_ids filtering)', async () => {
    const server = makeFakeServer();
    connectNotificationServerMock.mockResolvedValue(server);
    const deps = makeDeps();
    await startNotifications(deps);

    server.fireAction(999);
    expect(deps.focusCalls).toEqual([]);
  });

  it('setServiceDnd pushes the recomputed effectiveDnd for that service only', async () => {
    connectNotificationServerMock.mockResolvedValue(makeFakeServer());
    const deps = makeDeps();
    const n = await startNotifications(deps);

    n.registerService('whatsapp'); // makes 'whatsapp' a known id without touching its dnd
    n.setServiceDnd('slack', true);

    expect(deps.pushDndCalls).toContainEqual(['slack', true]);
    expect(deps.pushDndCalls.filter(([id]) => id === 'whatsapp')).toEqual([['whatsapp', false]]);
  });

  it('setGlobalDnd pushes effectiveDnd(true) to every known id', async () => {
    connectNotificationServerMock.mockResolvedValue(makeFakeServer());
    const deps = makeDeps();
    const n = await startNotifications(deps);

    n.registerService('whatsapp');
    n.registerService('slack');
    n.setGlobalDnd(true);

    expect(deps.pushDndCalls).toContainEqual(['whatsapp', true]);
    expect(deps.pushDndCalls).toContainEqual(['slack', true]);
  });

  it('pushes hidden=true unless the service is both focused and visible', async () => {
    connectNotificationServerMock.mockResolvedValue(makeFakeServer());
    const deps = makeDeps();
    const n = await startNotifications(deps);

    n.setVisible('slack', true);
    n.setFocused('slack', false);
    expect(deps.pushHiddenCalls.at(-1)).toEqual(['slack', true]); // visible but not focused → hidden

    n.setFocused('slack', true);
    expect(deps.pushHiddenCalls.at(-1)).toEqual(['slack', false]); // focused + visible → not hidden
  });

  it('setActive feeds recomputeHidden, not just the gate (mechanism 2)', async () => {
    // Regression: setActive must update BOTH gate.setActive (delivery gating, mechanism 1,
    // covered by notificationGate.test.ts) AND the local `active` map that recomputeHidden
    // reads (mechanism 2, which drives pushHidden -> the preload's document.hidden override
    // -> whether the web app fires its own new Notification()). A prior draft of this commit
    // called gate.setActive(id, v) but omitted active.set(id, v), so recomputeHidden kept
    // reading `active.get(id) ?? true` forever and a background tab's web app never stopped
    // suppressing its own notifications. No gate test can catch that, since gate.shouldNotify
    // reads a different map entirely.
    connectNotificationServerMock.mockResolvedValue(makeFakeServer());
    const deps = makeDeps();
    const n = await startNotifications(deps);

    n.setVisible('slack', true);
    n.setFocused('slack', true);
    expect(deps.pushHiddenCalls.at(-1)).toEqual(['slack', false]); // focused + visible, active defaults true

    n.setActive('slack', false);
    expect(deps.pushHiddenCalls.at(-1)).toEqual(['slack', true]); // looking at a different tab → hidden

    n.setActive('slack', true);
    expect(deps.pushHiddenCalls.at(-1)).toEqual(['slack', false]); // back to the active tab → not hidden

    // A service that setActive() is never called for at all must behave exactly as before
    // this feature existed: active defaults to true, so focused + visible alone is enough.
    n.setVisible('whatsapp', true);
    n.setFocused('whatsapp', true);
    expect(deps.pushHiddenCalls.at(-1)).toEqual(['whatsapp', false]);
  });

  it('degrades without throwing when the notification server is unreachable', async () => {
    connectNotificationServerMock.mockRejectedValue(new Error('no bus'));
    const deps = makeDeps();
    const n = await startNotifications(deps);

    await expect(n.handle('slack', { title: 'Ann', body: 'hi' })).resolves.toBeUndefined();
  });

  it('swallows+logs notify() failures in handle() without rejecting', async () => {
    const server = makeFakeServer();
    server.notify = vi.fn().mockRejectedValue(new Error('D-Bus hiccup'));
    connectNotificationServerMock.mockResolvedValue(server);
    const deps = makeDeps();
    const n = await startNotifications(deps);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await n.handle('slack', { title: 'Ann', body: 'hi' });

    expect(result).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith('notify failed:', expect.any(Error));
    consoleSpy.mockRestore();
  });
});
