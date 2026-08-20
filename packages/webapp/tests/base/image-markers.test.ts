import { describe, expect, it } from 'vitest';
import { classifyImageMarkers, splitToolResultImages } from '../../src/base/image-markers.js';

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

describe('classifyImageMarkers', () => {
  it('classifies a well-formed supported marker as an image', () => {
    expect(classifyImageMarkers(`x ${png('AAAA')}`)).toEqual([
      {
        kind: 'image',
        marker: png('AAAA'),
        index: 2,
        parsed: { mimeType: 'image/png', data: 'AAAA', dataUrl: 'data:image/png;base64,AAAA' },
      },
    ]);
  });

  it('classifies a real payload in an unsupported MIME type as unsupported', () => {
    const [found] = classifyImageMarkers('<img:data:image/bmp;base64,AAAA>');
    expect(found.kind).toBe('unsupported');
    expect(found.parsed?.mimeType).toBe('image/bmp');
  });

  it('classifies marker-shaped prose and sliced payloads as inert (#2217)', () => {
    expect(classifyImageMarkers('<img:data:image/...>').map((m) => m.kind)).toEqual(['inert']);
    expect(classifyImageMarkers(png('not*base64')).map((m) => m.kind)).toEqual(['inert']);
    // A base64 run whose length is 1 mod 4 cannot decode — a mid-payload slice.
    expect(classifyImageMarkers(png('AAAAA')).map((m) => m.kind)).toEqual(['inert']);
  });

  it('normalizes wrapped base64 so a line-wrapped marker still decodes', () => {
    const [found] = classifyImageMarkers(png('AA\nAA'));
    expect(found.kind).toBe('image');
    expect(found.parsed?.data).toBe('AAAA');
  });
});
