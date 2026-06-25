import { describe, expect, it } from 'vitest';
import { encodePcmChunksToWav } from '../../src/speech/wav-encode.js';

/** Read a little-endian uint32 from a WAV header. */
function leU32(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0, true);
}
function leU16(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset + offset, 2).getUint16(0, true);
}
function ascii(buf: Uint8Array, offset: number, len: number): string {
  return new TextDecoder().decode(buf.subarray(offset, offset + len));
}

describe('encodePcmChunksToWav', () => {
  it('writes a valid RIFF/WAVE header for a single mono chunk', () => {
    const audio = new Float32Array([0, 1, -1, 0.5]);
    const wav = encodePcmChunksToWav([{ audio, sampleRate: 24000 }]);

    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(ascii(wav, 36, 4)).toBe('data');

    expect(leU16(wav, 20)).toBe(1); // PCM
    expect(leU16(wav, 22)).toBe(1); // mono
    expect(leU32(wav, 24)).toBe(24000); // sample rate
    expect(leU32(wav, 28)).toBe(24000 * 2); // byte rate (mono, 16-bit)
    expect(leU16(wav, 32)).toBe(2); // block align
    expect(leU16(wav, 34)).toBe(16); // bits per sample

    // 4 samples × 2 bytes = 8 bytes of PCM, total = 44 + 8.
    expect(leU32(wav, 40)).toBe(8);
    expect(leU32(wav, 4)).toBe(36 + 8);
    expect(wav.byteLength).toBe(44 + 8);
  });

  it('clamps Float32 samples to int16 with correct endianness', () => {
    const audio = new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2]);
    const wav = encodePcmChunksToWav([{ audio, sampleRate: 16000 }]);
    const view = new DataView(wav.buffer, wav.byteOffset + 44);

    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0x7fff); // +1 → max positive
    expect(view.getInt16(4, true)).toBe(-0x8000); // -1 → min negative
    expect(view.getInt16(6, true)).toBe(Math.round(0.5 * 0x7fff));
    expect(view.getInt16(8, true)).toBe(Math.round(-0.5 * 0x8000));
    // Values outside [-1, 1] saturate, not wrap.
    expect(view.getInt16(10, true)).toBe(0x7fff);
    expect(view.getInt16(12, true)).toBe(-0x8000);
  });

  it('concatenates multiple chunks sharing a sample rate', () => {
    const chunks = [
      { audio: new Float32Array([1, -1]), sampleRate: 22050 },
      { audio: new Float32Array([0.5, 0]), sampleRate: 22050 },
      { audio: new Float32Array([-0.5]), sampleRate: 22050 },
    ];
    const wav = encodePcmChunksToWav(chunks);

    // 5 samples × 2 bytes = 10 bytes of PCM data.
    expect(leU32(wav, 40)).toBe(10);
    expect(wav.byteLength).toBe(44 + 10);

    const view = new DataView(wav.buffer, wav.byteOffset + 44);
    expect(view.getInt16(0, true)).toBe(0x7fff);
    expect(view.getInt16(2, true)).toBe(-0x8000);
    expect(view.getInt16(4, true)).toBe(Math.round(0.5 * 0x7fff));
    expect(view.getInt16(6, true)).toBe(0);
    expect(view.getInt16(8, true)).toBe(Math.round(-0.5 * 0x8000));
  });

  it('throws when chunks is empty', () => {
    expect(() => encodePcmChunksToWav([])).toThrow(/at least one PCM chunk/);
  });

  it('throws when chunks disagree on sample rate', () => {
    expect(() =>
      encodePcmChunksToWav([
        { audio: new Float32Array([0]), sampleRate: 16000 },
        { audio: new Float32Array([0]), sampleRate: 24000 },
      ])
    ).toThrow(/mixed sample rates/);
  });

  it('throws on a non-positive sample rate', () => {
    expect(() => encodePcmChunksToWav([{ audio: new Float32Array([0]), sampleRate: 0 }])).toThrow(
      /invalid sample rate/
    );
  });
});
