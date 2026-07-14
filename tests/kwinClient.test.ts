import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: Array<{ member: string; path: string; interface: string; body?: unknown[] }> = [];
let failCall = false;

vi.mock('dbus-next', () => {
  class Message {
    member!: string; path!: string; interface!: string; body?: unknown[];
    constructor(o: Record<string, unknown>) { Object.assign(this, o); }
  }
  const bus = {
    call: vi.fn((msg: Message) => {
      sent.push({ member: msg.member, path: msg.path, interface: msg.interface, body: msg.body });
      if (failCall) return Promise.reject(new Error('no kwin'));
      if (msg.member === 'loadScript') return Promise.resolve({ body: [7] });
      return Promise.resolve({ body: [] });
    }),
  };
  return { sessionBus: () => bus, Message };
});

import { createKwinClient } from '../src/main/kde/kwin';

beforeEach(() => { sent.length = 0; failCall = false; });

describe('createKwinClient', () => {
  it('runs unloadScript → loadScript → run(/Scripting/Script<id>) → unloadScript', async () => {
    await createKwinClient().focusWindow('Messenger');
    const members = sent.map((m) => m.member);
    expect(members).toEqual(['unloadScript', 'loadScript', 'run', 'unloadScript']);
    const run = sent.find((m) => m.member === 'run')!;
    expect(run.path).toBe('/Scripting/Script7');
    expect(run.interface).toBe('org.kde.kwin.Script');
    const load = sent.find((m) => m.member === 'loadScript')!;
    expect(load.body?.[1]).toBe('loft-show'); // plugin name for focus
  });

  it('hideWindow uses the loft-hide plugin', async () => {
    await createKwinClient().hideWindow('Messenger');
    const load = sent.find((m) => m.member === 'loadScript')!;
    expect(load.body?.[1]).toBe('loft-hide');
  });

  it('never throws when the bus call fails', async () => {
    failCall = true;
    await expect(createKwinClient().focusWindow('X')).resolves.toBeUndefined();
  });
});
