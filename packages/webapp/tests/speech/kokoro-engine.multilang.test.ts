import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type EspeakFactory,
  setEspeakFactoryLoaderForTests,
} from '../../src/speech/espeak-phonemizer.js';

// Minimal sentence-splitting stand-in for kokoro-js' TextSplitterStream.
class FakeTextSplitterStream {
  private sentences: string[] = [];
  private closed = false;
  push(...texts: string[]): void {
    for (const t of texts) {
      for (const s of t.split(/(?<=[.!?])\s+/)) if (s.trim()) this.sentences.push(s.trim());
    }
  }
  close(): void {
    this.closed = true;
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string, void, void> {
    while (this.sentences.length) yield this.sentences.shift() as string;
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
}));
vi.mock('@huggingface/transformers', () => ({
  env: { backends: { onnx: { wasm: {} } } },
  AutoConfig: { from_pretrained: vi.fn(async () => ({ model_type: 'whisper' })) },
}));
vi.mock('kokoro-js', () => ({
  KokoroTTS: { from_pretrained: vi.fn(async () => fakeTts) },
  TextSplitterStream: FakeTextSplitterStream,
}));

const { getKokoro, resetKokoroForTests } = await import('../../src/speech/kokoro-engine.js');

/** espeak factory returning a fixed phoneme string per call. */
function stubEspeak(out: string): void {
  const factory: EspeakFactory = async () => ({ FS: { readFile: () => out } });
  setEspeakFactoryLoaderForTests(async () => ({ factory }));
}

describe('kokoro non-English wrapper synth path', () => {
  afterEach(() => {
    resetKokoroForTests();
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
    stubEspeak('x');
    const tts = await getKokoro();
    const chunks: Array<{ audio: Float32Array }> = [];
    for await (const c of tts.synthesizeStream('Hola. Adios.', { voice: 'ef_dora' })) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(2);
    expect(fakeTts.generate_from_ids).toHaveBeenCalledTimes(2);
  });
});
