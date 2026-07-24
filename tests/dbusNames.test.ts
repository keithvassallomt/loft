import { describe, it, expect, vi } from 'vitest';
import { dbusName } from '../src/main/dbus/names';
import { objectPathFor, createExportRegistry } from '../src/main/dbus/loftService';
import type { ServiceInstance } from '../src/main/instances';

describe('dbusName', () => {
  it('strips all whitespace (matches extension.js displayName.replace(/\\s+/g,""))', () => {
    expect(dbusName('WhatsApp')).toBe('WhatsApp');
    expect(dbusName('NextCloud Talk')).toBe('NextCloudTalk');
    expect(dbusName('Facebook  Messenger')).toBe('FacebookMessenger');
  });
});

describe('per-instance object paths', () => {
  it('keeps the documented paths for the first account of a kind', () => {
    expect(objectPathFor('WhatsApp')).toBe('/chat/loft/WhatsApp');
    expect(objectPathFor('NextCloudTalk')).toBe('/chat/loft/NextCloudTalk');
  });

  it('gives a second account its own path', () => {
    expect(objectPathFor('WhatsApp2')).toBe('/chat/loft/WhatsApp2');
  });
});

/** Only `id` and `dbusSegment` matter to the registry; the rest is filler to satisfy
 *  the type. */
function fakeInstance(id: string, dbusSegment: string): ServiceInstance {
  return {
    id,
    kind: id,
    displayName: id,
    dbusSegment,
    icon: 'brand',
    url: 'https://example.invalid/',
    selfHosted: false,
    origins: [],
  };
}

describe('createExportRegistry', () => {
  it('exports then unexports the same instance', () => {
    const sink = { export: vi.fn(), unexport: vi.fn() };
    const registry = createExportRegistry(sink);
    const a = fakeInstance('a', 'A');

    registry.exportInstance(a, () => 'objA');
    expect(sink.export).toHaveBeenCalledTimes(1);
    expect(sink.export).toHaveBeenCalledWith('/chat/loft/A', 'objA');

    registry.unexportInstance(a);
    expect(sink.unexport).toHaveBeenCalledTimes(1);
    expect(sink.unexport).toHaveBeenCalledWith('/chat/loft/A', 'objA');
  });

  it('refuses a duplicate path and does not let unexporting the loser evict the winner', () => {
    // Only reachable via a hand-edited config: segments are unique by construction, but
    // nothing stops two ids from being edited to derive the same one.
    const sink = { export: vi.fn(), unexport: vi.fn() };
    const registry = createExportRegistry(sink);
    const a = fakeInstance('a', 'SHARED');
    const b = fakeInstance('b', 'SHARED');

    registry.exportInstance(a, () => 'objA');
    registry.exportInstance(b, () => 'objB');
    expect(sink.export).toHaveBeenCalledTimes(1);
    expect(sink.export).toHaveBeenCalledWith('/chat/loft/SHARED', 'objA');

    // This is the regression: removing the account that lost the export race must not
    // tear down the account that actually holds the live D-Bus object.
    registry.unexportInstance(b);
    expect(sink.unexport).not.toHaveBeenCalled();

    registry.unexportInstance(a);
    expect(sink.unexport).toHaveBeenCalledTimes(1);
    expect(sink.unexport).toHaveBeenCalledWith('/chat/loft/SHARED', 'objA');
  });

  it('no-ops when unexporting an instance that was never exported', () => {
    const sink = { export: vi.fn(), unexport: vi.fn() };
    const registry = createExportRegistry(sink);

    registry.unexportInstance(fakeInstance('ghost', 'Ghost'));
    expect(sink.unexport).not.toHaveBeenCalled();
  });
});
