import { describe, it, expect } from 'vitest';
import { enableChromiumFeatures, mergeFeatureList, LOFT_ENABLED_FEATURES } from '../src/main/chromiumFeatures';

function fakeCommandLine(initial?: string) {
  const switches = new Map<string, string>();
  if (initial !== undefined) switches.set('enable-features', initial);
  return {
    switches,
    getSwitchValue: (name: string) => switches.get(name) ?? '',
    appendSwitch: (name: string, value = '') => { switches.set(name, value); },
  };
}

describe('mergeFeatureList', () => {
  it('starts a list from nothing', () => {
    expect(mergeFeatureList('', ['A'])).toBe('A');
  });
  it('keeps existing features and appends new ones', () => {
    expect(mergeFeatureList('X,Y', ['A'])).toBe('X,Y,A');
  });
  it('does not duplicate a feature already present', () => {
    expect(mergeFeatureList('A,X', ['A'])).toBe('A,X');
  });
  it('tolerates stray whitespace and empty entries', () => {
    expect(mergeFeatureList(' X ,,Y,', ['A'])).toBe('X,Y,A');
  });
});

describe('enableChromiumFeatures', () => {
  it('turns on the file-transfer portal so dropped files are readable inside the Flatpak', () => {
    expect(LOFT_ENABLED_FEATURES).toContain('XdgFileTransferPortal');
    const cl = fakeCommandLine();
    enableChromiumFeatures(cl);
    expect(cl.switches.get('enable-features')).toBe('XdgFileTransferPortal');
  });
  it('preserves an --enable-features passed on the command line', () => {
    const cl = fakeCommandLine('WebRtcPipeWireCamera');
    enableChromiumFeatures(cl);
    expect(cl.switches.get('enable-features')).toBe('WebRtcPipeWireCamera,XdgFileTransferPortal');
  });
});
