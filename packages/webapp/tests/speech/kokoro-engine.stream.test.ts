import { afterEach, describe, expect, it, vi } from 'vitest';

// Faithful-enough stand-in for kokoro-js' TextSplitterStream: its async
// iterator BLOCKS until `close()` is called (the real contract). The bug this
// suite guards is that kokoro-js' `stream(string)` shorthand builds one of
// these and never closes it, so `synthesizeStream` (and `speak()`) hang after
// the final sentence. Our fix drives + closes the splitter ourselves.
const splitters: FakeTextSplitterStream[] = [];

class FakeTextSplitterStream {
  _buffer = '';
  _sentences: string[] = [];
  _resolver: (() => void) | null = null;
  _closed = false;
  closeCalls = 0;
  constructor() {
    splitters.push(this);
  }
  push(...texts: string[]): void {
    for (const t of texts) this._buffer += t;
    this._process();
  }
  close(): void {
    this.closeCalls++;
    this._closed = true;
    const tail = this._buffer.trim();
    if (tail) this._sentences.push(tail);
    this._buffer = '';
    this._resolve();
  }
  _resolve(): void {
    if (this._resolver) {
      this._resolver();
      this._resolver = null;
    }
  }
  _process(): void {
    const re = /(.*?[.!?]+)(\s+)/g;
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this._buffer)) !== null) {
      const s = m[1].trim();
      if (s) this._sentences.push(s);
      lastEnd = re.lastIndex;
    }
    this._buffer = this._buffer.slice(lastEnd);
    if (this._sentences.length) this._resolve();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string, void, void> {
    for (;;) {
      if (this._sentences.length > 0) {
        yield this._sentences.shift() as string;
      } else if (this._closed) {
        break;
      } else {
        await new Promise<void>((r) => {
          this._resolver = r;
        });
      }
    }
  }
}

const fakeTts = {
  voices: { af_heart: { name: 'Heart', language: 'en-us', gender: 'Female' } },
  generate: vi.fn(async () => ({ audio: new Float32Array([0]), sampling_rate: 24000 })),
  async *stream(input: FakeTextSplitterStream) {
    // If `input` was never closed this for-await hangs forever — that is the
    // exact leak the fix removes by closing the splitter at the call site.
    for await (const sentence of input) {
      yield {
        text: sentence,
        phonemes: '',
        audio: { audio: new Float32Array([0]), sampling_rate: 24000 },
      };
    }
  },
};

vi.mock('../../src/speech/transformers-env.js', () => ({
  configureTransformersEnv: vi.fn(),
  assertLocalModelPresent: vi.fn(async () => undefined),
  ensureOrtWasmPaths: vi.fn(async () => ({})),
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

async function drain(text: string, opts?: { splitPattern?: RegExp }) {
  const tts = await getKokoro();
  const chunks: Array<{ audio: Float32Array; sampleRate: number }> = [];
  for await (const chunk of tts.synthesizeStream(text, opts)) chunks.push(chunk);
  return chunks;
}

describe('kokoro synthesizeStream termination', () => {
  afterEach(() => {
    resetKokoroForTests();
    splitters.length = 0;
    vi.clearAllMocks();
  });

  it('completes (does not hang) and yields every sentence of a multi-sentence string', async () => {
    const chunks = await drain('One sentence. Two sentence. Three sentence.');
    expect(chunks).toHaveLength(3);
    expect(splitters).toHaveLength(1);
    expect(splitters[0].closeCalls).toBe(1);
    expect(splitters[0]._closed).toBe(true);
  });

  it('completes for a single-sentence string (the leak affected even one sentence)', async () => {
    const chunks = await drain('Just one sentence here.');
    expect(chunks).toHaveLength(1);
    expect(splitters[0].closeCalls).toBe(1);
  });

  it('drives + closes the splitter when a splitPattern is provided', async () => {
    const chunks = await drain('alpha|beta|gamma', { splitPattern: /\|/ });
    expect(chunks.length).toBeGreaterThan(0);
    expect(splitters[0].closeCalls).toBe(1);
    expect(splitters[0]._closed).toBe(true);
  });
});
