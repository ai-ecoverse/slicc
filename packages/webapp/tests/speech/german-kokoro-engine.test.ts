import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGermanKokoroInputs,
  GERMAN_KOKORO_MODEL_ID,
  GERMAN_KOKORO_SAMPLE_RATE,
  GERMAN_KOKORO_VOICE,
  type GermanVoiceMatrix,
  germanKokoroIfReady,
  germanKokoroLoadState,
  germanKokoroStaged,
  getGermanKokoro,
  parseGermanVoiceMatrix,
  resetGermanKokoroForTests,
  setGermanKokoroDepsForTests,
  splitGermanSentences,
} from '../../src/speech/german-kokoro-engine.js';

/** A tiny (rows × 1 × 256) style matrix where row r is filled with value r. */
function fakeVoice(rows: number): GermanVoiceMatrix {
  const data = new Float32Array(rows * 256);
  for (let r = 0; r < rows; r++) data.fill(r, r * 256, r * 256 + 256);
  return { data, rows };
}

afterEach(() => resetGermanKokoroForTests());

describe('GERMAN_KOKORO_VOICE metadata', () => {
  it('is the single on-device German voice', () => {
    expect(GERMAN_KOKORO_VOICE).toEqual({
      id: 'martin',
      name: 'Martin',
      lang: 'de-DE',
      onDevice: true,
      gender: 'Male',
    });
    expect(GERMAN_KOKORO_MODEL_ID).toBe('Godelaune/Kokoro-82M-ONNX-German-Martin');
    expect(GERMAN_KOKORO_SAMPLE_RATE).toBe(24000);
  });
});

describe('buildGermanKokoroInputs', () => {
  it('brackets tokens with the pad id and slices the style row at len(ids)', () => {
    const inputs = buildGermanKokoroInputs([5, 6, 7], fakeVoice(510), 1.125);
    expect(Array.from(inputs.tokenIds, (n) => Number(n))).toEqual([0, 5, 6, 7, 0]);
    expect(inputs.tokenDims).toEqual([1, 5]);
    // style row index = len(ids) = 3 → row filled with 3.
    expect(inputs.style.length).toBe(256);
    expect(inputs.style.every((v) => v === 3)).toBe(true);
    expect(inputs.styleDims).toEqual([1, 256]);
    expect(Array.from(inputs.speed)).toEqual([1.125]);
    expect(inputs.speedDims).toEqual([1]);
  });

  it('clamps ids so the style index stays inside the matrix', () => {
    const ids = Array.from({ length: 600 }, () => 43);
    const inputs = buildGermanKokoroInputs(ids, fakeVoice(510), 1);
    // 510 rows → max style index 509 → 509 ids + 2 brackets.
    expect(inputs.tokenDims).toEqual([1, 511]);
    expect(inputs.style.every((v) => v === 509)).toBe(true);
  });
});

describe('splitGermanSentences', () => {
  it('splits on sentence enders and newlines, dropping tiny fragments', () => {
    expect(splitGermanSentences('Hallo Welt. Wie geht es dir?\nGut!')).toEqual([
      'Hallo Welt.',
      'Wie geht es dir?',
      'Gut!',
    ]);
  });

  it('returns the whole text when there is no boundary', () => {
    expect(splitGermanSentences('Guten Morgen')).toEqual(['Guten Morgen']);
  });
});

describe('parseGermanVoiceMatrix', () => {
  it('rejects a matrix whose last dim is not the style width', () => {
    const bad = new Uint8Array(10); // not an npz at all
    expect(() => parseGermanVoiceMatrix(bad)).toThrow();
  });
});

describe('germanKokoroStaged', () => {
  it('is false (and re-probes) when the npz is missing', async () => {
    const readVfs = vi.fn(async () => {
      throw new Error('ENOENT: voices-martin.npz');
    });
    setGermanKokoroDepsForTests({ readVfs });
    expect(await germanKokoroStaged()).toBe(false);
    expect(await germanKokoroStaged()).toBe(false);
    expect(readVfs).toHaveBeenCalledTimes(2); // not memoized while missing
  });
});

describe('getGermanKokoro (mocked ORT)', () => {
  it('loads, builds feeds, and returns the waveform @ 24kHz', async () => {
    const voice = fakeVoice(510);
    const run = vi.fn(async (feeds: Record<string, { dims: readonly number[] }>) => {
      // Assert the engine wired the canonical feed names + dims.
      expect(Object.keys(feeds).sort()).toEqual(['input_ids', 'speed', 'style']);
      return { waveform: { data: Float32Array.from([0.1, -0.1, 0.2]) } };
    });
    class FakeTensor {
      constructor(
        public type: string,
        public data: unknown,
        public dims: readonly number[]
      ) {}
    }
    const ort = {
      InferenceSession: { create: vi.fn(async () => ({ run })) },
      Tensor: FakeTensor as unknown as new (
        t: string,
        d: unknown,
        dm: readonly number[]
      ) => unknown,
      env: { wasm: {} },
    };
    setGermanKokoroDepsForTests({
      readVfs: async (path: string) =>
        path.endsWith('.npz') ? encodeVoiceNpz(voice) : new Uint8Array([1, 2, 3]),
      loadOrt: async () => ort,
      getPhonemize: async () => async () => ['halˈoː'],
    });
    expect(germanKokoroLoadState()).toBe('idle');
    const tts = await getGermanKokoro();
    expect(germanKokoroLoadState()).toBe('ready');
    expect(germanKokoroIfReady()).toBe(tts);
    const chunk = await tts.synthesize('Hallo');
    expect(chunk.sampleRate).toBe(GERMAN_KOKORO_SAMPLE_RATE);
    expect(Array.from(chunk.audio)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(-0.1, 5),
      expect.closeTo(0.2, 5),
    ]);
    expect(run).toHaveBeenCalledOnce();
  });
});

/** Encode a `GermanVoiceMatrix` back into a STORED npz so the engine's npz
 *  parse path runs end-to-end against a real buffer. */
function encodeVoiceNpz(voice: GermanVoiceMatrix): Uint8Array {
  const shape = `(${voice.rows}, 1, 256)`;
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': ${shape}, }`;
  const pre = 10 + header.length + 1;
  header += ' '.repeat((64 - (pre % 64)) % 64) + '\n';
  const hb = new TextEncoder().encode(header);
  const npy = new Uint8Array(10 + hb.length + voice.data.byteLength);
  npy.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59], 0);
  npy[6] = 1;
  new DataView(npy.buffer).setUint16(8, hb.length, true);
  npy.set(hb, 10);
  npy.set(new Uint8Array(voice.data.buffer.slice(0)), 10 + hb.length);
  const name = new TextEncoder().encode('martin.npy');
  const zip = new Uint8Array(30 + name.length + npy.length);
  const v = new DataView(zip.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint32(18, npy.length, true);
  v.setUint32(22, npy.length, true);
  v.setUint16(26, name.length, true);
  zip.set(name, 30);
  zip.set(npy, 30 + name.length);
  return zip;
}
