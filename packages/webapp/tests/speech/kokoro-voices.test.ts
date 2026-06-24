import { describe, expect, it, vi } from 'vitest';
import {
  applyStyleTts2ConfigShim,
  injectStyleTts2Architectures,
  toKokoroVoiceInfos,
} from '../../src/speech/kokoro-engine.js';

describe('toKokoroVoiceInfos', () => {
  it('normalizes kokoro-js voice metadata into picker entries', () => {
    const infos = toKokoroVoiceInfos({
      af_heart: { name: 'Heart', language: 'en-us', gender: 'Female' },
      am_adam: { name: 'Adam', language: 'en-us', gender: 'Male' },
      bm_george: { name: 'George', language: 'en-gb', gender: 'Male' },
    });
    expect(infos).toEqual([
      { id: 'af_heart', name: 'Heart', lang: 'en-US', gender: 'Female' },
      { id: 'am_adam', name: 'Adam', lang: 'en-US', gender: 'Male' },
      { id: 'bm_george', name: 'George', lang: 'en-GB', gender: 'Male' },
    ]);
  });

  it('falls back to the id and the id-prefix language when metadata is sparse', () => {
    expect(toKokoroVoiceInfos({ bf_alice: {} })).toEqual([
      { id: 'bf_alice', name: 'bf_alice', lang: 'en-GB' },
    ]);
  });
});

describe('injectStyleTts2Architectures', () => {
  it('fills in the StyleTTS2 architecture for a kokoro config that omits it', () => {
    expect(injectStyleTts2Architectures({ model_type: 'style_text_to_speech_2' })).toEqual({
      model_type: 'style_text_to_speech_2',
      architectures: ['StyleTextToSpeech2Model'],
    });
    expect(
      injectStyleTts2Architectures({ model_type: 'style_text_to_speech_2', architectures: [] })
    ).toEqual({ model_type: 'style_text_to_speech_2', architectures: ['StyleTextToSpeech2Model'] });
  });

  it('leaves an already-declared architecture list untouched (idempotent)', () => {
    const cfg = { model_type: 'style_text_to_speech_2', architectures: ['Custom'] };
    expect(injectStyleTts2Architectures(cfg).architectures).toEqual(['Custom']);
    const once = injectStyleTts2Architectures({ model_type: 'style_text_to_speech_2' });
    expect(injectStyleTts2Architectures(once).architectures).toEqual(['StyleTextToSpeech2Model']);
  });

  it('is a no-op for other models (whisper) — no regression', () => {
    const whisper = { model_type: 'whisper', architectures: ['WhisperForConditionalGeneration'] };
    expect(injectStyleTts2Architectures(whisper).architectures).toEqual([
      'WhisperForConditionalGeneration',
    ]);
    expect(injectStyleTts2Architectures({ model_type: 'bert' }).architectures).toBeUndefined();
  });
});

describe('applyStyleTts2ConfigShim', () => {
  it('wraps AutoConfig.from_pretrained so loaded kokoro configs gain architectures', async () => {
    const from_pretrained = vi.fn(async () => ({ model_type: 'style_text_to_speech_2' }));
    const transformers = { AutoConfig: { from_pretrained } };
    applyStyleTts2ConfigShim(transformers);

    const cfg = (await transformers.AutoConfig.from_pretrained('onnx-community/Kokoro')) as {
      architectures?: string[];
    };
    expect(cfg.architectures).toEqual(['StyleTextToSpeech2Model']);
    expect(from_pretrained).toHaveBeenCalledTimes(1);
  });

  it('does not double-wrap when called twice (warmup race)', () => {
    const from_pretrained = vi.fn(async () => ({ model_type: 'whisper' }));
    const transformers = { AutoConfig: { from_pretrained } };
    applyStyleTts2ConfigShim(transformers);
    const afterFirst = transformers.AutoConfig.from_pretrained;
    applyStyleTts2ConfigShim(transformers);
    expect(transformers.AutoConfig.from_pretrained).toBe(afterFirst);
  });

  it('is best-effort when AutoConfig is missing or malformed', () => {
    expect(() => applyStyleTts2ConfigShim({})).not.toThrow();
    expect(() =>
      applyStyleTts2ConfigShim({ AutoConfig: { from_pretrained: undefined } })
    ).not.toThrow();
  });
});
