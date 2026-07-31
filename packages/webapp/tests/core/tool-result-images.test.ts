import { describe, expect, it } from 'vitest';
import { splitToolResultImages } from '../../src/core/tool-result-images.js';

const png = (data: string) => `<img:data:image/png;base64,${data}>`;

describe('splitToolResultImages', () => {
  it('splits a single image from surrounding text', () => {
    expect(splitToolResultImages(`before\n${png('AAAA')}\nafter`)).toEqual([
      { type: 'text', text: 'before\n' },
      {
        type: 'image',
        marker: png('AAAA'),
        mimeType: 'image/png',
        data: 'AAAA',
        dataUrl: 'data:image/png;base64,AAAA',
      },
      { type: 'text', text: '\nafter' },
    ]);
  });

  it('preserves multiple images and their intervening text in order', () => {
    const segments = splitToolResultImages(`${png('AAAA')}middle${png('BBBB')}`);
    expect(segments.map((segment) => segment.type)).toEqual(['image', 'text', 'image']);
    expect(segments[1]).toEqual({ type: 'text', text: 'middle' });
  });

  it('does not add empty text segments for leading or trailing images', () => {
    expect(splitToolResultImages(`${png('AAAA')}tail`).map((segment) => segment.type)).toEqual([
      'image',
      'text',
    ]);
    expect(splitToolResultImages(`head${png('AAAA')}`).map((segment) => segment.type)).toEqual([
      'text',
      'image',
    ]);
  });

  it('leaves malformed, partial, and unsupported markers as text', () => {
    const values = [
      '<img:data:image/png;base64,AAAA',
      '<img:data:image/png;base64,AAAA…>',
      '<img:data:image/png;base64,A>',
      '<img:data:image/svg+xml;base64,PHN2Zz4=>',
    ];
    for (const value of values) {
      expect(splitToolResultImages(value)).toEqual([{ type: 'text', text: value }]);
    }
  });

  it('keeps text-only and empty results unchanged', () => {
    expect(splitToolResultImages('plain text')).toEqual([{ type: 'text', text: 'plain text' }]);
    expect(splitToolResultImages('')).toEqual([{ type: 'text', text: '' }]);
  });
});
