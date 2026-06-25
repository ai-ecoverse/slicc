import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KokoroTts } from '../../src/speech/kokoro-engine.js';

// Controllable kokoro readiness — speak() consults kokoroIfReady() at call
// time, so swapping this holder drives the engine pick per test.
const kokoroHolder: { tts: KokoroTts | null } = { tts: null };
// Controllable engine lifecycle for the kokoroStatus()/kokoroWarmup() tests.
const stateHolder: { state: 'idle' | 'loading' | 'ready' | 'failed' } = { state: 'idle' };
const snapshotHolder: {
  snapshot: { loaded: number; total: number; etaSeconds: number | null } | null;
} = { snapshot: null };
const getKokoroMock = vi.fn(async () => kokoroHolder.tts as KokoroTts);
vi.mock('../../src/speech/kokoro-engine.js', () => ({
  kokoroIfReady: () => kokoroHolder.tts,
  kokoroLoadState: () => stateHolder.state,
  kokoroDownloadSnapshot: () => snapshotHolder.snapshot,
  getKokoro: getKokoroMock,
}));

// Stage-aware warmup bridges to the worker R10 staging routine; mock it so
// the warmup tests assert the stage-then-load ordering without a real channel.
const ensureSpeechAssetsMock = vi.fn(async () => undefined);
vi.mock('../../src/kernel/speech-assets-bridge.js', () => ({
  callEnsureSpeechAssets: ensureSpeechAssetsMock,
}));

const {
  pickSpeakEngine,
  speechTextFromMarkdown,
  speak,
  synthesizeToWav,
  kokoroVoicesIfReady,
  kokoroStatus,
  kokoroWarmup,
  setSpeakAssetsInstanceId,
  resetSpeakForTests,
} = await import('../../src/speech/speak.js');

type FakeKokoro = KokoroTts & {
  synthesize: ReturnType<typeof vi.fn>;
  synthesizeStream: ReturnType<typeof vi.fn>;
};

/** Build a fake kokoro engine; `streamChunks` is the sequence its stream
 *  yields (one yield per chunk), or a thrown error. Default is one chunk. */
function fakeKokoro(opts?: {
  synthesize?: ReturnType<typeof vi.fn>;
  streamChunks?: Array<{ audio: Float32Array; sampleRate: number }>;
  streamError?: Error;
  streamErrorAfter?: number;
}): FakeKokoro {
  const chunks = opts?.streamChunks ?? [
    { audio: new Float32Array([0, 0.5, -0.5]), sampleRate: 24000 },
  ];
  // `vi.fn(async function* () {...})` does not preserve generator semantics
  // — wrap a thunk that returns a fresh async iterator instead so the spy
  // records each call and `for await` iterates as expected.
  const makeIterator = async function* () {
    let i = 0;
    for (const c of chunks) {
      if (opts?.streamError && i === (opts.streamErrorAfter ?? 0)) {
        throw opts.streamError;
      }
      yield c;
      i++;
    }
    if (opts?.streamError && (opts.streamErrorAfter ?? 0) >= chunks.length) {
      throw opts.streamError;
    }
  };
  const synthesizeStream = vi.fn(() => makeIterator());
  return {
    synthesize:
      opts?.synthesize ??
      vi.fn().mockResolvedValue({ audio: new Float32Array([0, 0.5, -0.5]), sampleRate: 24000 }),
    synthesizeStream: synthesizeStream as never,
    voices: () => [
      { id: 'af_heart', name: 'Heart', lang: 'en-US', onDevice: true },
      { id: 'bm_george', name: 'George', lang: 'en-GB', onDevice: true },
      { id: 'ef_dora', name: 'Dora', lang: 'es-ES', onDevice: true },
      { id: 'jf_alpha', name: 'Alpha', lang: 'ja-JP', onDevice: false },
    ],
  };
}

/** Web Speech + AudioContext stubs for the playback paths. */
function stubSpeechGlobals() {
  const utterances: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      constructor(text: string) {
        const u: Record<string, unknown> = { text };
        utterances.push(u);
        return u;
      }
    }
  );
  vi.stubGlobal('speechSynthesis', {
    getVoices: () => [],
    speak: (u: { onend?: () => void }) => queueMicrotask(() => u.onend?.()),
  });
  const started: number[] = [];
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      destination = {};
      resume = vi.fn();
      createBuffer() {
        return { copyToChannel: vi.fn() };
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn() };
      }
      createBufferSource() {
        return {
          buffer: null,
          onended: null as null | (() => void),
          connect: vi.fn(),
          start() {
            started.push(1);
            queueMicrotask(() => this.onended?.());
          },
        };
      }
    }
  );
  return { utterances, started };
}

afterEach(() => {
  kokoroHolder.tts = null;
  stateHolder.state = 'idle';
  snapshotHolder.snapshot = null;
  getKokoroMock.mockClear();
  ensureSpeechAssetsMock.mockClear();
  ensureSpeechAssetsMock.mockResolvedValue(undefined);
  setSpeakAssetsInstanceId(undefined);
  resetSpeakForTests();
  vi.unstubAllGlobals();
});

describe('pickSpeakEngine', () => {
  const voices = [
    { id: 'af_heart', lang: 'en-US', onDevice: true },
    { id: 'bm_george', lang: 'en-GB', onDevice: true },
    { id: 'ef_dora', lang: 'es-ES', onDevice: true },
    { id: 'ff_siwis', lang: 'fr-FR', onDevice: true },
    { id: 'jf_alpha', lang: 'ja-JP', onDevice: false },
  ];
  // CLI/standalone realm: the espeak-ng phonemizer loads, so non-English
  // on-device synthesis is available.
  const ready = { ready: true, voices, nonEnglishOnDevice: true };
  // Extension float: MV3 CSP blocks the espeak-ng glue, so non-English falls
  // back to Web Speech.
  const extension = { ready: true, voices, nonEnglishOnDevice: false };
  const notReady = { ready: false, voices: [], nonEnglishOnDevice: true };

  it('prefers kokoro whenever it is ready and nothing forces webspeech', () => {
    expect(pickSpeakEngine({}, ready)).toBe('kokoro');
    expect(pickSpeakEngine({ lang: 'en-US' }, ready)).toBe('kokoro');
    expect(pickSpeakEngine({}, notReady)).toBe('webspeech');
  });

  it('routes es/fr/it/hi/pt to kokoro on-device (espeak-ng phonemizer)', () => {
    expect(pickSpeakEngine({ lang: 'es-ES' }, ready)).toBe('kokoro');
    expect(pickSpeakEngine({ lang: 'fr' }, ready)).toBe('kokoro');
  });

  it('keeps ja/zh and other languages on webspeech (no JS G2P / no voice)', () => {
    expect(pickSpeakEngine({ lang: 'ja' }, ready)).toBe('webspeech');
    expect(pickSpeakEngine({ lang: 'zh-CN' }, ready)).toBe('webspeech');
    expect(pickSpeakEngine({ lang: 'de-DE' }, ready)).toBe('webspeech');
  });

  it('gates non-English to webspeech in the extension float (CSP), English stays kokoro', () => {
    expect(pickSpeakEngine({ lang: 'es-ES' }, extension)).toBe('webspeech');
    expect(pickSpeakEngine({ lang: 'fr' }, extension)).toBe('webspeech');
    // English still synthesizes on-device there (kokoro-js bundles en_dict).
    expect(pickSpeakEngine({ lang: 'en-US' }, extension)).toBe('kokoro');
    expect(pickSpeakEngine({}, extension)).toBe('kokoro');
    // An explicit non-English kokoro voice also degrades to webspeech there.
    expect(pickSpeakEngine({ voice: 'ef_dora' }, extension)).toBe('webspeech');
    // …but an explicit English kokoro voice still routes on-device.
    expect(pickSpeakEngine({ voice: 'af_heart' }, extension)).toBe('kokoro');
  });

  it('an explicit voice picks its engine: kokoro ids → kokoro, names → webspeech', () => {
    expect(pickSpeakEngine({ voice: 'af_heart' }, ready)).toBe('kokoro');
    expect(pickSpeakEngine({ voice: 'ef_dora' }, ready)).toBe('kokoro');
    expect(pickSpeakEngine({ voice: 'Samantha' }, ready)).toBe('webspeech');
    // A kokoro voice with no JS G2P (ja/zh) is not synthesizable → webspeech.
    expect(pickSpeakEngine({ voice: 'jf_alpha' }, ready)).toBe('webspeech');
    // A kokoro id before the model is ready can't synthesize — webspeech.
    expect(pickSpeakEngine({ voice: 'af_heart' }, notReady)).toBe('webspeech');
    // An explicit (synthesizable) kokoro voice overrides the language hint.
    expect(pickSpeakEngine({ voice: 'af_heart', lang: 'de-DE' }, ready)).toBe('kokoro');
  });
});

describe('speechTextFromMarkdown', () => {
  it('drops code blocks, unwraps inline markup, strips structure markers', () => {
    const markdown = [
      '# Done!',
      '',
      'I updated the `hero` styles — see [the PR](https://x.test/pr).',
      '',
      '```ts',
      'const secret = 42;',
      '```',
      '',
      '- **warmer** palette',
      '> a quote',
      '![diagram](img.png)',
    ].join('\n');
    const text = speechTextFromMarkdown(markdown);
    expect(text).toBe(
      'Done! I updated the hero styles — see the PR. warmer palette a quote diagram'
    );
    expect(text).not.toContain('secret');
  });

  it('preserves long multi-paragraph replies (well past kokoro 510-token clamp)', () => {
    // ~3.5K characters — old 1500-char cap would have truncated this; now
    // streaming chunks the prose at the engine boundary so the reducer
    // passes a multi-paragraph reply through untouched (#1038).
    const long = `${'word '.repeat(700)}end`;
    const text = speechTextFromMarkdown(long);
    expect(text.endsWith('end')).toBe(true);
    expect(text).not.toContain('…');
    expect(text.length).toBeGreaterThan(3000);
  });

  it('caps truly runaway replies with an ellipsis on a word boundary', () => {
    // The cap is now a generous upper bound (20K chars) — only pathological
    // outputs trigger it. `word `.repeat(5000) → 25000 chars.
    const text = speechTextFromMarkdown(`${'word '.repeat(5000)}end`);
    expect(text.length).toBeLessThanOrEqual(20001);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toMatch(/wor…$/);
  });

  it('linearizes rich formatting in long replies — every type spoken or stripped', () => {
    const markdown = [
      '# Plan',
      '',
      'I will ship the **hero** redesign with an _accessible_ palette,',
      'documented in [the spec](https://x.test/spec) and tracked in `issue-42`.',
      '',
      '## Steps',
      '',
      '- Audit the existing tokens',
      '- Generate a new ramp',
      '- Roll out behind a flag',
      '',
      '> A measured rollout protects production.',
      '',
      '| Token | Before | After |',
      '| --- | --- | --- |',
      '| hero | red | warm |',
      '| body | gray | sand |',
      '',
      '```ts',
      'const SECRET = "do not read aloud";',
      '```',
      '',
      'Wrapping up.',
    ].join('\n');
    const text = speechTextFromMarkdown(markdown);
    expect(text).toContain('Plan');
    expect(text).toContain('hero');
    expect(text).toContain('accessible');
    expect(text).toContain('the spec');
    expect(text).toContain('issue-42');
    expect(text).toContain('Audit the existing tokens');
    expect(text).toContain('Roll out behind a flag');
    expect(text).toContain('A measured rollout protects production.');
    expect(text).toContain('Wrapping up.');
    // Table cells linearize into prose; pipes survive (they aren't markdown
    // tokens at the inline-grammar level the reducer normalizes).
    expect(text).toContain('hero');
    expect(text).toContain('warm');
    // No raw fence content, no markdown structural tokens.
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('```');
    expect(text).not.toContain('**');
    expect(text).not.toMatch(/^#/m);
    expect(text).not.toMatch(/^>/m);
  });

  it('returns empty for content with nothing speakable', () => {
    expect(speechTextFromMarkdown('```js\nonly code\n```')).toBe('');
  });

  it('drops shtml dips — fenced, tilde-fenced, and truncated mid-stream', () => {
    const dip = '<div class="sprinkle-action-card"><button onclick="post()">Go</button></div>';
    expect(speechTextFromMarkdown(`Here is a dip:\n\n\`\`\`shtml\n${dip}\n\`\`\`\n\nEnjoy!`)).toBe(
      'Here is a dip: Enjoy!'
    );
    expect(speechTextFromMarkdown(`Look:\n~~~shtml\n${dip}\n~~~\ndone`)).toBe('Look: done');
    // A reply cut off inside the fence must not leak the dip body into speech.
    expect(speechTextFromMarkdown(`Building it now:\n\`\`\`shtml\n${dip}\n<more`)).toBe(
      'Building it now:'
    );
  });

  it('keeps short inline code but drops long inline spans as code', () => {
    expect(speechTextFromMarkdown('tweak the `hero` token')).toBe('tweak the hero token');
    const long = '`const x = document.querySelectorAll(".hero").forEach((n) => n.remove())`';
    expect(speechTextFromMarkdown(`run ${long} now`)).toBe('run now');
  });
});

describe('speak', () => {
  it('speaks through webspeech while kokoro is cold', async () => {
    const { utterances } = stubSpeechGlobals();
    const result = await speak({ text: 'hello', lang: 'en-US', rate: 1.2 });
    expect(result.engine).toBe('webspeech');
    expect(utterances[0]).toMatchObject({ text: 'hello', lang: 'en-US', rate: 1.2 });
  });

  it('synthesizes through kokoro when ready, threading voice + rate as speed', async () => {
    const { utterances, started } = stubSpeechGlobals();
    const tts = fakeKokoro();
    kokoroHolder.tts = tts;

    const result = await speak({ text: 'hello there', voice: 'af_heart', rate: 1.1 });
    expect(result.engine).toBe('kokoro');
    expect(tts.synthesizeStream).toHaveBeenCalledWith('hello there', {
      voice: 'af_heart',
      speed: 1.1,
    });
    expect(started.length).toBe(1);
    expect(utterances.length).toBe(0);
  });

  it('plays every chunk of a multi-sentence kokoro stream in order (no truncation)', async () => {
    const { utterances, started } = stubSpeechGlobals();
    const chunks = [
      { audio: new Float32Array([0.1]), sampleRate: 24000 },
      { audio: new Float32Array([0.2]), sampleRate: 24000 },
      { audio: new Float32Array([0.3]), sampleRate: 24000 },
      { audio: new Float32Array([0.4]), sampleRate: 24000 },
    ];
    kokoroHolder.tts = fakeKokoro({ streamChunks: chunks });
    const result = await speak({ text: 'first. second. third. fourth.' });
    expect(result.engine).toBe('kokoro');
    // Sequential playback — one start() per chunk, in order, NOT capped at one.
    expect(started.length).toBe(chunks.length);
    expect(utterances.length).toBe(0);
  });

  it('falls back to webspeech when kokoro synthesis fails before any chunk plays', async () => {
    const { utterances } = stubSpeechGlobals();
    kokoroHolder.tts = fakeKokoro({ streamError: new Error('phonemizer exploded') });

    const result = await speak({ text: 'resilient' });
    expect(result.engine).toBe('webspeech');
    expect(utterances[0]).toMatchObject({ text: 'resilient' });
  });

  it('mid-stream failure stops playback rather than re-speaking through webspeech', async () => {
    const { utterances, started } = stubSpeechGlobals();
    kokoroHolder.tts = fakeKokoro({
      streamChunks: [
        { audio: new Float32Array([0.1]), sampleRate: 24000 },
        { audio: new Float32Array([0.2]), sampleRate: 24000 },
      ],
      streamError: new Error('chunk 2 exploded'),
      streamErrorAfter: 1,
    });
    const result = await speak({ text: 'first. second.' });
    expect(result.engine).toBe('kokoro');
    expect(started.length).toBe(1); // only chunk 1 played
    expect(utterances.length).toBe(0); // no webspeech replay
  });

  it('exposes kokoro voices only once the engine is warm', () => {
    expect(kokoroVoicesIfReady()).toEqual([]);
    kokoroHolder.tts = fakeKokoro();
    expect(kokoroVoicesIfReady().map((v) => v.id)).toEqual([
      'af_heart',
      'bm_george',
      'ef_dora',
      'jf_alpha',
    ]);
  });

  it('demotes non-English kokoro voices in the extension runtime voice list', () => {
    kokoroHolder.tts = fakeKokoro();
    vi.stubGlobal('chrome', { runtime: { id: 'ext-id' } });
    expect(kokoroVoicesIfReady()).toEqual([
      { id: 'af_heart', name: 'Heart', lang: 'en-US', onDevice: true },
      { id: 'bm_george', name: 'George', lang: 'en-GB', onDevice: true },
      { id: 'ef_dora', name: 'Dora', lang: 'es-ES', onDevice: false },
      { id: 'jf_alpha', name: 'Alpha', lang: 'ja-JP', onDevice: false },
    ]);
  });

  it('selects a language-matched kokoro voice for a non-English request (CLI realm)', async () => {
    const { started } = stubSpeechGlobals();
    const tts = fakeKokoro();
    kokoroHolder.tts = tts;

    // No explicit voice: es-ES must resolve to the Spanish kokoro voice, not
    // the English default, so the audio is actually spoken in Spanish.
    const result = await speak({ text: 'hola', lang: 'es-ES' });
    expect(result.engine).toBe('kokoro');
    expect(tts.synthesizeStream).toHaveBeenCalledWith('hola', { voice: 'ef_dora' });
    expect(started.length).toBe(1);
  });

  it('uses the kokoro default voice for English (no explicit voice id)', async () => {
    const { started } = stubSpeechGlobals();
    const tts = fakeKokoro();
    kokoroHolder.tts = tts;

    const result = await speak({ text: 'hello', lang: 'en-US' });
    expect(result.engine).toBe('kokoro');
    // English passes no voice → kokoro-js applies its built-in default.
    expect(tts.synthesizeStream).toHaveBeenCalledWith('hello', {});
    expect(started.length).toBe(1);
  });
});

describe('kokoroStatus', () => {
  it('reports the engine state without a snapshot', () => {
    stateHolder.state = 'idle';
    snapshotHolder.snapshot = null;
    expect(kokoroStatus()).toEqual({ state: 'idle' });
  });

  it('folds in the download snapshot while loading', () => {
    stateHolder.state = 'loading';
    snapshotHolder.snapshot = { loaded: 5, total: 10, etaSeconds: 3 };
    expect(kokoroStatus()).toEqual({ state: 'loading', loaded: 5, total: 10, etaSeconds: 3 });
  });
});

describe('kokoroWarmup', () => {
  it('stages the assets via the R10 bridge BEFORE loading kokoro', async () => {
    const order: string[] = [];
    setSpeakAssetsInstanceId('inst-7');
    ensureSpeechAssetsMock.mockImplementation(async () => {
      order.push('stage');
    });
    getKokoroMock.mockImplementation(async () => {
      order.push('load');
      return kokoroHolder.tts as KokoroTts;
    });

    const status = kokoroWarmup();
    expect(status).toEqual({ state: 'idle' }); // initial snapshot, returned synchronously
    // Let the fire-and-forget stage-then-load chain settle.
    await vi.waitFor(() => expect(order).toEqual(['stage', 'load']));
    expect(ensureSpeechAssetsMock).toHaveBeenCalledWith({ instanceId: 'inst-7' });
  });

  it('still loads kokoro when staging fails (already-present weights)', async () => {
    ensureSpeechAssetsMock.mockRejectedValue(new Error('offline'));

    kokoroWarmup();
    await vi.waitFor(() => expect(getKokoroMock).toHaveBeenCalledOnce());
  });

  it('swallows a load failure (surfaced via kokoroStatus state)', async () => {
    getKokoroMock.mockRejectedValue(new Error('run hf download'));

    // Must not reject the synchronous caller.
    expect(() => kokoroWarmup()).not.toThrow();
    await vi.waitFor(() => expect(getKokoroMock).toHaveBeenCalledOnce());
  });
});

describe('synthesizeToWav', () => {
  it('rejects when kokoro is not ready (the `say -o` path is kokoro-only)', async () => {
    kokoroHolder.tts = null;
    await expect(synthesizeToWav({ text: 'hello', lang: 'en-US' })).rejects.toThrow(/not ready/);
  });

  it('streams chunks through the encoder and returns a valid WAV buffer', async () => {
    kokoroHolder.tts = fakeKokoro({
      streamChunks: [
        { audio: new Float32Array([0, 0.5, -0.5]), sampleRate: 24000 },
        { audio: new Float32Array([1, -1]), sampleRate: 24000 },
      ],
    });

    const wav = await synthesizeToWav({ text: 'hi', lang: 'en-US', voice: 'af_heart', rate: 1.2 });

    expect(wav).toBeInstanceOf(Uint8Array);
    // RIFF/WAVE magic + a non-empty data chunk (5 samples × 2 bytes = 10).
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.subarray(8, 4 + 8))).toBe('WAVE');
    expect(wav.byteLength).toBe(44 + 10);
    // Voice + speed are forwarded into the kokoro stream call.
    const tts = kokoroHolder.tts as FakeKokoro;
    expect(tts.synthesizeStream).toHaveBeenCalledWith('hi', { voice: 'af_heart', speed: 1.2 });
  });

  it('throws when the kokoro stream yields no chunks', async () => {
    kokoroHolder.tts = fakeKokoro({ streamChunks: [] });
    await expect(synthesizeToWav({ text: ' ', lang: 'en-US' })).rejects.toThrow(/no audio/);
  });
});
