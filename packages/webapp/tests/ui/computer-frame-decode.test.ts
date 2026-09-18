import { base64ToUint8 } from '@slicc/shared-ts';
import { afterEach, describe, expect, it } from 'vitest';
import { MINIMAL_JPEG } from '../../src/computers/encode-frame.js';
import { DECODABLE_PNG } from '../../src/computers/frame-bytes.js';
import { frameToDataUrl } from '../../src/ui/computer-frame-url.js';
import { getComputersStore, resetComputersStoreForTests } from '../../src/ui/computers-store.js';

afterEach(() => {
  resetComputersStoreForTests();
});

describe('computer frame store → data URL', () => {
  it('decodes a real PNG that passed through the store as an offset view', () => {
    const store = getComputersStore();
    const padded = new Uint8Array(DECODABLE_PNG.byteLength + 8);
    padded.fill(0x7e);
    padded.set(DECODABLE_PNG, 2);
    store.applyFrame({
      type: 'computer-frame',
      id: 'jsh:fake',
      seq: 1,
      mime: 'image/jpeg',
      width: 1,
      height: 1,
      bytes: padded.subarray(2, 2 + DECODABLE_PNG.byteLength),
    });
    const frame = store.lastFrame('jsh:fake');
    expect(frame).not.toBeNull();
    const src = frameToDataUrl(frame!);
    expect(src.startsWith('data:image/png;base64,')).toBe(true);
    const comma = src.indexOf(',');
    expect(base64ToUint8(src.slice(comma + 1))).toEqual(DECODABLE_PNG);
  });

  it('the SOF0-only stub JPEG is 17 bytes and is not a PNG', () => {
    const store = getComputersStore();
    store.applyFrame({
      type: 'computer-frame',
      id: 'jsh:fake',
      seq: 1,
      mime: 'image/jpeg',
      width: 1,
      height: 1,
      bytes: MINIMAL_JPEG,
    });
    const src = frameToDataUrl(store.lastFrame('jsh:fake')!);
    expect(src.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(MINIMAL_JPEG.byteLength).toBe(17);
  });
});
