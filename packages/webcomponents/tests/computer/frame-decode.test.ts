/**
 * Chromium decode of a real PNG that went through the page computers
 * store. jsdom will fire `load` for any data URL, including the SOF0-only
 * stub JPEG that paints as a broken-image icon in the app — this file
 * is the actual `<img>` contract.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MINIMAL_JPEG } from '../../../webapp/src/computers/encode-frame.js';
import { DECODABLE_PNG } from '../../../webapp/src/computers/frame-bytes.js';
import { frameToDataUrl } from '../../../webapp/src/ui/computer-frame-url.js';
import {
  getComputersStore,
  resetComputersStoreForTests,
} from '../../../webapp/src/ui/computers-store.js';

function imgOutcome(src: string, attach = false): Promise<'load' | 'error'> {
  return new Promise((resolve) => {
    const img = document.createElement('img');
    img.alt = 'fake';
    img.addEventListener('load', () => resolve('load'), { once: true });
    img.addEventListener('error', () => resolve('error'), { once: true });
    img.src = src;
    if (attach) document.body.append(img);
  });
}

afterEach(() => {
  resetComputersStoreForTests();
  document.body.replaceChildren();
});

describe('computer frame data URL decode', () => {
  it('loads a real PNG that passed through the store as an offset view', async () => {
    resetComputersStoreForTests();
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
    expect(await imgOutcome(src, true)).toBe('load');
  });

  it('the SOF0-only stub JPEG fires error, not load', async () => {
    resetComputersStoreForTests();
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
    expect(await imgOutcome(src)).toBe('error');
  });
});
