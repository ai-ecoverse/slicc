import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KokoroTts } from '../../src/speech/kokoro-engine.js';

// Controllable kokoro readiness — speak() consults kokoroIfReady() at call
// time, so swapping this holder drives the engine pick per test.
const kokoroHolder: { tts: KokoroTts | null } = { tts: null };
vi.mock('../../src/speech/kokoro-engine.js', () => ({
  kokoroIfReady: () => kokoroHolder.tts,
}));

const { pickSpeakEngine, speechTextFromMarkdown, speak, kokoroVoicesIfReady } = await import(
  '../../src/speech/speak.js'
);

function fakeKokoro(
  synthesize?: ReturnType<typeof vi.fn>
): KokoroTts & { synthesize: ReturnType<typeof vi.fn> } {
  return {
    synthesize:
      synthesize ??
      vi.fn().mockResolvedValue({ audio: new Float32Array([0, 0.5, -0.5]), sampleRate: 24000 }),
    voices: () => [
      { id: 'af_heart', name: 'Heart', lang: 'en-US' },
      { id: 'bm_george', name: 'George', lang: 'en-GB' },
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
  vi.unstubAllGlobals();
});

describe('pickSpeakEngine', () => {
  const ready = { ready: true, voiceIds: ['af_heart', 'bm_george'] };
  const notReady = { ready: false, voiceIds: [] };

  it('prefers kokoro whenever it is ready and nothing forces webspeech', () => {
    expect(pickSpeakEngine({}, ready)).toBe('kokoro');
    expect(pickSpeakEngine({ lang: 'en-US' }, ready)).toBe('kokoro');
    expect(pickSpeakEngine({}, notReady)).toBe('webspeech');
  });

  it('routes non-English languages to webspeech (kokoro is English-only)', () => {
    expect(pickSpeakEngine({ lang: 'de-DE' }, ready)).toBe('webspeech');
    expect(pickSpeakEngine({ lang: 'ja' }, ready)).toBe('webspeech');
  });

  it('an explicit voice picks its engine: kokoro ids → kokoro, names → webspeech', () => {
    expect(pickSpeakEngine({ voice: 'af_heart' }, ready)).toBe('kokoro');
    expect(pickSpeakEngine({ voice: 'Samantha' }, ready)).toBe('webspeech');
    // A kokoro id before the model is ready can't synthesize — webspeech.
    expect(pickSpeakEngine({ voice: 'af_heart' }, notReady)).toBe('webspeech');
    // An explicit kokoro voice overrides the language gate.
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

  it('caps runaway replies with an ellipsis on a word boundary', () => {
    const text = speechTextFromMarkdown(`${'word '.repeat(600)}end`);
    expect(text.length).toBeLessThanOrEqual(1501);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toMatch(/wor…$/);
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
    expect(tts.synthesize).toHaveBeenCalledWith('hello there', { voice: 'af_heart', speed: 1.1 });
    expect(started.length).toBe(1);
    expect(utterances.length).toBe(0);
  });

  it('falls back to webspeech when kokoro synthesis fails', async () => {
    const { utterances } = stubSpeechGlobals();
    kokoroHolder.tts = fakeKokoro(vi.fn().mockRejectedValue(new Error('phonemizer exploded')));

    const result = await speak({ text: 'resilient' });
    expect(result.engine).toBe('webspeech');
    expect(utterances[0]).toMatchObject({ text: 'resilient' });
  });

  it('exposes kokoro voices only once the engine is warm', () => {
    expect(kokoroVoicesIfReady()).toEqual([]);
    kokoroHolder.tts = fakeKokoro();
    expect(kokoroVoicesIfReady().map((v) => v.id)).toEqual(['af_heart', 'bm_george']);
  });
});
