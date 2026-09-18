import { describe, expect, it } from 'vitest';
import { MINIMAL_JPEG } from '../../src/computers/encode-frame.js';
import {
  coerceComputerFrameBytes,
  DECODABLE_PNG,
  sniffFrameMime,
} from '../../src/computers/frame-bytes.js';

describe('coerceComputerFrameBytes', () => {
  it('copies an offset view out of a larger buffer', () => {
    const padded = new Uint8Array(DECODABLE_PNG.byteLength + 8);
    padded.fill(0xaa);
    padded.set(DECODABLE_PNG, 4);
    const view = padded.subarray(4, 4 + DECODABLE_PNG.byteLength);
    expect(view.byteOffset).toBe(4);
    const copy = coerceComputerFrameBytes(view);
    expect(copy.byteOffset).toBe(0);
    expect(copy.byteLength).toBe(DECODABLE_PNG.byteLength);
    expect(copy).toEqual(DECODABLE_PNG);
    expect(copy.buffer).not.toBe(view.buffer);
  });

  it('rebuilds JSON-cloned Uint8Array objects', () => {
    const cloned = JSON.parse(JSON.stringify(DECODABLE_PNG)) as Record<string, number>;
    expect(cloned instanceof Uint8Array).toBe(false);
    expect(coerceComputerFrameBytes(cloned)).toEqual(DECODABLE_PNG);
  });

  it('does not stack-overflow on a JSON-cloned frame past the argument-spread limit', () => {
    const rec: Record<string, number> = {};
    const len = 200_000;
    for (let i = 0; i < len; i++) rec[i] = i & 0xff;
    const copy = coerceComputerFrameBytes(rec);
    expect(copy.byteLength).toBe(len);
    expect(copy[0]).toBe(0);
    expect(copy[len - 1]).toBe((len - 1) & 0xff);
  });
});

describe('sniffFrameMime', () => {
  it('recognizes PNG and JPEG magic', () => {
    expect(sniffFrameMime(DECODABLE_PNG)).toBe('image/png');
    expect(sniffFrameMime(MINIMAL_JPEG)).toBe('image/jpeg');
    expect(sniffFrameMime(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
