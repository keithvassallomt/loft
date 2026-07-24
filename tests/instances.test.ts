import { describe, it, expect } from 'vitest';
import {
  resolveInstance, listInstances, allocateInstanceId, allocateInstanceName,
  defaultInstanceName, instanceNumber, dbusSegmentFor, validateInstanceName, kindOf,
  nameErrorMessage,
} from '../src/main/instances';
import type { LoftConfig } from '../src/main/config';

const cfg = (services: LoftConfig['services']): LoftConfig => ({ services });

describe('kind resolution', () => {
  it('reads the kind from a legacy entry as its own id', () => {
    // Every pre-multi-account config looks like this. If this fallback ever stops
    // working, existing installs lose every service on upgrade.
    expect(kindOf('whatsapp', cfg({ whatsapp: {} }))).toBe('whatsapp');
  });

  it('reads an explicit kind when present', () => {
    expect(kindOf('whatsapp-2', cfg({ 'whatsapp-2': { kind: 'whatsapp' } }))).toBe('whatsapp');
  });

  it('resolves an instance to its kind\'s URL and its own id', () => {
    const inst = resolveInstance('whatsapp-2', cfg({ 'whatsapp-2': { kind: 'whatsapp' } }))!;
    expect(inst.id).toBe('whatsapp-2');
    expect(inst.kind).toBe('whatsapp');
    expect(inst.url).toBe('https://web.whatsapp.com/');
    expect(inst.displayName).toBe('WhatsApp 2');
  });

  it('is undefined for an entry naming no known kind', () => {
    expect(resolveInstance('nope', cfg({ nope: {} }))).toBeUndefined();
  });

  it('prefers the user\'s name over the default', () => {
    const inst = resolveInstance('whatsapp', cfg({ whatsapp: { name: 'Work' } }))!;
    expect(inst.displayName).toBe('Work');
  });

  it('lists only entries that resolve, in config order', () => {
    const list = listInstances(cfg({ slack: {}, bogus: {}, whatsapp: {} }));
    expect(list.map((i) => i.id)).toEqual(['slack', 'whatsapp']);
  });
});

describe('instance numbering', () => {
  it('numbers a bare kind id 1 and a suffixed one by its suffix', () => {
    expect(instanceNumber('whatsapp', 'whatsapp')).toBe(1);
    expect(instanceNumber('whatsapp-2', 'whatsapp')).toBe(2);
    expect(instanceNumber('whatsapp-10', 'whatsapp')).toBe(10);
  });

  it('returns 0 for an id that fits no scheme', () => {
    // Only reachable from a hand-edited config; dbusSegmentFor falls back for it.
    expect(instanceNumber('work', 'whatsapp')).toBe(0);
    expect(instanceNumber('whatsapp-x', 'whatsapp')).toBe(0);
    expect(instanceNumber('whatsapp-1', 'whatsapp')).toBe(0);
  });

  it('names instance 1 after the kind and later ones by number', () => {
    expect(defaultInstanceName('WhatsApp', 1)).toBe('WhatsApp');
    expect(defaultInstanceName('WhatsApp', 2)).toBe('WhatsApp 2');
  });
});

describe('id allocation', () => {
  it('gives the first instance the bare kind id', () => {
    expect(allocateInstanceId('whatsapp', cfg({}))).toBe('whatsapp');
  });

  it('gives the second -2 and fills gaps left by removals', () => {
    expect(allocateInstanceId('whatsapp', cfg({ whatsapp: {} }))).toBe('whatsapp-2');
    expect(allocateInstanceId('whatsapp', cfg({ whatsapp: {}, 'whatsapp-2': {} }))).toBe('whatsapp-3');
    expect(allocateInstanceId('whatsapp', cfg({ whatsapp: {}, 'whatsapp-3': {} }))).toBe('whatsapp-2');
  });

  it('reclaims the bare id when only the first instance was removed', () => {
    expect(allocateInstanceId('whatsapp', cfg({ 'whatsapp-2': { kind: 'whatsapp' } }))).toBe('whatsapp');
  });
});

describe('default names avoid collisions', () => {
  it('steps past a name the user already took', () => {
    // Without this a default could be born invalid, and the add would fail the very
    // uniqueness rule main is about to enforce.
    const c = cfg({ whatsapp: { name: 'WhatsApp 2' } });
    expect(allocateInstanceName('WhatsApp', 2, c)).toBe('WhatsApp 3');
  });

  it('returns the plain default when nothing collides', () => {
    expect(allocateInstanceName('WhatsApp', 2, cfg({ whatsapp: {} }))).toBe('WhatsApp 2');
  });
});

describe('D-Bus segments', () => {
  it('keeps today\'s paths byte-identical for existing installs', () => {
    const c = cfg({ whatsapp: {}, talk: {} });
    expect(dbusSegmentFor('whatsapp', c)).toBe('WhatsApp');
    expect(dbusSegmentFor('talk', c)).toBe('NextCloudTalk');
  });

  it('suffixes later instances by number', () => {
    expect(dbusSegmentFor('whatsapp-2', cfg({ 'whatsapp-2': { kind: 'whatsapp' } }))).toBe('WhatsApp2');
  });

  it('does not move when the service is renamed', () => {
    // The whole point of deriving from the kind's DEFAULT name: a rename must not
    // relocate a scriptable object path.
    const c = cfg({ 'whatsapp-2': { kind: 'whatsapp', name: 'Xogħol' } });
    expect(dbusSegmentFor('whatsapp-2', c)).toBe('WhatsApp2');
  });

  it('always yields a valid path segment, even for a hand-edited id', () => {
    const seg = dbusSegmentFor('my chat!', cfg({ 'my chat!': { kind: 'whatsapp' } }));
    expect(seg).toMatch(/^[A-Za-z0-9_]+$/);
  });
});

describe('name validation', () => {
  const c = cfg({ whatsapp: { name: 'Work' }, slack: {} });

  it('accepts a fresh name', () => {
    expect(validateInstanceName('Personal', 'slack', c)).toBeUndefined();
  });

  it('accepts the service keeping its own name', () => {
    expect(validateInstanceName('Work', 'whatsapp', c)).toBeUndefined();
  });

  it('rejects empty, whitespace-only and over-long names', () => {
    expect(validateInstanceName('', 'slack', c)).toBe('empty');
    expect(validateInstanceName('   ', 'slack', c)).toBe('empty');
    expect(validateInstanceName('x'.repeat(65), 'slack', c)).toBe('too-long');
  });

  it('rejects "Loft" in any case — it is the Loft window\'s own caption key', () => {
    expect(validateInstanceName('Loft', 'slack', c)).toBe('reserved');
    expect(validateInstanceName('loft', 'slack', c)).toBe('reserved');
  });

  it('rejects a duplicate regardless of case or surrounding space, including a default name', () => {
    // Window matching is by caption. Two services sharing one means Show/Hide reaches
    // whichever window matched first.
    expect(validateInstanceName(' work ', 'slack', c)).toBe('duplicate');
    expect(validateInstanceName('slack', 'whatsapp', c)).toBe('duplicate');
  });
});

describe('nameErrorMessage', () => {
  it('says what is wrong in the user\'s terms', () => {
    expect(nameErrorMessage('empty')).toBe('Enter a name.');
    expect(nameErrorMessage('too-long')).toBe('Use 64 characters or fewer.');
    expect(nameErrorMessage('duplicate')).toBe('Another service already uses that name.');
    expect(nameErrorMessage('reserved')).toBe('“Loft” is reserved for the main window.');
  });
});
