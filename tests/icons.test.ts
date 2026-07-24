import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  parseVariantFiles, variantLabel, pickVariantFor, iconCandidates, variantPngPath,
} from '../src/main/icons';

describe('parseVariantFiles', () => {
  it('groups PNGs by kind, sorted, ignoring the SVG sources', () => {
    const map = parseVariantFiles([
      'whatsapp-rose.png', 'whatsapp-sky.png', 'whatsapp-rose.svg',
      'slack-mint.png', 'palette.json',
    ]);
    expect(map).toEqual({ whatsapp: ['rose', 'sky'], slack: ['mint'] });
  });

  it('splits on the first hyphen — no kind id contains one', () => {
    expect(parseVariantFiles(['talk-pastel-rose.png'])).toEqual({ talk: ['pastel-rose'] });
  });

  it('ignores a name with no hyphen at all', () => {
    expect(parseVariantFiles(['loft.png'])).toEqual({});
  });
});

describe('variantLabel', () => {
  it('capitalises the colour key', () => {
    expect(variantLabel('rose')).toBe('Rose');
    expect(variantLabel('butter')).toBe('Butter');
  });
});

describe('pickVariantFor', () => {
  it('takes the first colour no sibling is using', () => {
    expect(pickVariantFor(['rose'], ['rose', 'sky', 'mint'])).toBe('sky');
  });

  it('cycles once every colour is taken rather than returning nothing', () => {
    expect(pickVariantFor(['rose', 'sky'], ['rose', 'sky'])).toBe('rose');
  });

  it('is undefined when the kind ships no variants', () => {
    expect(pickVariantFor([], [])).toBeUndefined();
  });
});

describe('iconCandidates', () => {
  const iconsDir = '/data/icons';
  const assetsDir = '/app/assets/icons';

  it('prefers the deployed instance icon, then the variant, then the brand', () => {
    expect(iconCandidates({ iconsDir, assetsDir, id: 'whatsapp-2', kind: 'whatsapp', icon: 'rose' }))
      .toEqual([
        join(iconsDir, 'whatsapp-2.png'),
        join(assetsDir, 'variants', 'whatsapp-rose.png'),
        join(assetsDir, 'whatsapp.png'),
        join(assetsDir, 'whatsapp-2.png'),
      ]);
  });

  it('skips the variant step for brand and custom icons', () => {
    expect(iconCandidates({ iconsDir, assetsDir, id: 'whatsapp', kind: 'whatsapp', icon: 'brand' }))
      .toEqual([join(iconsDir, 'whatsapp.png'), join(assetsDir, 'whatsapp.png')]);
    expect(iconCandidates({ iconsDir, assetsDir, id: 'whatsapp-2', kind: 'whatsapp', icon: 'custom' }))
      .toEqual([
        join(iconsDir, 'whatsapp-2.png'),
        join(assetsDir, 'whatsapp.png'),
        join(assetsDir, 'whatsapp-2.png'),
      ]);
  });

  it('still resolves a name that is no instance at all', () => {
    // loft://icon/loft and the not-yet-added kinds in the Add gallery come through here.
    expect(iconCandidates({ iconsDir, assetsDir, id: 'loft' }))
      .toEqual([join(iconsDir, 'loft.png'), join(assetsDir, 'loft.png')]);
  });
});

describe('variantPngPath', () => {
  it('names the generated asset', () => {
    expect(variantPngPath('/app/assets/icons', 'whatsapp', 'rose'))
      .toBe(join('/app/assets/icons', 'variants', 'whatsapp-rose.png'));
  });
});
