import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type EspeakFactory,
  resetEspeakForTests,
  setEspeakFactoryLoaderForTests,
} from '../../src/speech/espeak-phonemizer.js';

// Stand-in for kokoro-js' TextSplitterStream. If the non-English path used it
// with one push+close, this fake would flush the whole input as one chunk.
class FakeTextSplitterStream {
  private buffer = '';
  private chunks: string[] = [];
  private closed = false;
  push(...texts: string[]): void {
    for (const t of texts) {
      this.buffer += t;
    }
  }
  close(): void {
    this.closed = true;
    const tail = this.buffer.trim();
    if (tail) this.chunks.push(tail);
    this.buffer = '';
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string, void, void> {
    while (this.chunks.length) yield this.chunks.shift() as string;
    if (!this.closed) throw new Error('iterated before close');
  }
}

const fakeTts = {
  voices: {
    af_heart: { name: 'Heart', language: 'en-us', gender: 'Female' },
    ef_dora: { name: 'Dora', language: 'es', gender: 'Female' },
  },
  tokenizer: vi.fn((text: string, _o: { truncation: boolean }) => ({
    input_ids: { dims: [1, text.length], data: new Int32Array() } as never,
  })),
  generate: vi.fn(async () => ({ audio: new Float32Array([1]), sampling_rate: 24000 })),
  generate_from_ids: vi.fn(async () => ({ audio: new Float32Array([2]), sampling_rate: 24000 })),
  async *stream() {
    yield { text: '', phonemes: '', audio: { audio: new Float32Array([1]), sampling_rate: 24000 } };
  },
};

vi.mock('../../src/speech/transformers-env.js', () => ({
  configureTransformersEnv: vi.fn(),
  assertLocalModelPresent: vi.fn(async () => undefined),
  ensureOrtWasmPaths: vi.fn(async () => undefined),
}));
vi.mock('@huggingface/transformers', () => ({
  env: { backends: { onnx: { wasm: {} } } },
  AutoConfig: { from_pretrained: vi.fn(async () => ({ model_type: 'whisper' })) },
}));
vi.mock('kokoro-js', () => ({
  KokoroTTS: { from_pretrained: vi.fn(async () => fakeTts) },
  TextSplitterStream: FakeTextSplitterStream,
}));

const { getKokoro, resetKokoroForTests, splitKokoroStreamText } = await import(
  '../../src/speech/kokoro-engine.js'
);

/** espeak factory returning a fixed phoneme string per call. */
function stubEspeak(out: string): Array<{ arguments: string[] }> {
  const calls: Array<{ arguments: string[] }> = [];
  const factory: EspeakFactory = async (opts) => {
    calls.push({ arguments: opts.arguments });
    return { FS: { readFile: () => out } };
  };
  setEspeakFactoryLoaderForTests(async () => ({ factory }));
  return calls;
}

describe('kokoro non-English wrapper synth path', () => {
  afterEach(() => {
    resetKokoroForTests();
    resetEspeakForTests();
    vi.clearAllMocks();
  });

  it('routes a Spanish voice through espeak + generate_from_ids (not native generate)', async () => {
    stubEspeak('ˈola');
    const tts = await getKokoro();
    const chunk = await tts.synthesize('Hola', { voice: 'ef_dora' });
    expect(fakeTts.generate_from_ids).toHaveBeenCalledTimes(1);
    expect(fakeTts.generate).not.toHaveBeenCalled();
    expect(fakeTts.tokenizer).toHaveBeenCalledWith('ˈola', { truncation: true });
    expect(Array.from(chunk.audio)).toEqual([2]);
    expect(chunk.sampleRate).toBe(24000);
  });

  it('keeps an English voice on kokoro-js native generate', async () => {
    const tts = await getKokoro();
    const chunk = await tts.synthesize('Hello', { voice: 'af_heart' });
    expect(fakeTts.generate).toHaveBeenCalledTimes(1);
    expect(fakeTts.generate_from_ids).not.toHaveBeenCalled();
    expect(Array.from(chunk.audio)).toEqual([1]);
  });

  it('streams a Spanish reply sentence-by-sentence via the espeak path', async () => {
    const calls = stubEspeak('x');
    const tts = await getKokoro();
    const chunks: Array<{ audio: Float32Array }> = [];
    for await (const c of tts.synthesizeStream('Hola. Adios. Tercero?', { voice: 'ef_dora' })) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(3);
    expect(fakeTts.generate_from_ids).toHaveBeenCalledTimes(3);
    expect(calls.map((c) => c.arguments.at(-1))).toEqual(['Hola', 'Adios', 'Tercero']);
    expect(fakeTts.tokenizer.mock.calls.map(([text]) => text)).toEqual(['x.', 'x.', 'x?']);
  });

  it('splits non-English stream text on sentence and paragraph boundaries', () => {
    expect(splitKokoroStreamText('Uno. Dos!\n\nTres?')).toEqual(['Uno.', 'Dos!', 'Tres?']);
    expect(splitKokoroStreamText('alpha|beta|gamma', /\|/)).toEqual(['alpha', 'beta', 'gamma']);
  });
});
