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
      { id: 'af_heart', name: 'Heart', lang: 'en-US', onDevice: true, gender: 'Female' },
      { id: 'am_adam', name: 'Adam', lang: 'en-US', onDevice: true, gender: 'Male' },
      { id: 'bm_george', name: 'George', lang: 'en-GB', onDevice: true, gender: 'Male' },
    ]);
  });

  it('maps each id prefix to its real BCP-47 language when metadata is sparse', () => {
    expect(toKokoroVoiceInfos({ bf_alice: {} })).toEqual([
      { id: 'bf_alice', name: 'bf_alice', lang: 'en-GB', onDevice: true },
    ]);
    expect(toKokoroVoiceInfos({ ef_dora: {} })).toEqual([
      { id: 'ef_dora', name: 'ef_dora', lang: 'es-ES', onDevice: true },
    ]);
    expect(toKokoroVoiceInfos({ ff_siwis: {} })).toEqual([
      { id: 'ff_siwis', name: 'ff_siwis', lang: 'fr-FR', onDevice: true },
    ]);
    expect(toKokoroVoiceInfos({ if_sara: {} })).toEqual([
      { id: 'if_sara', name: 'if_sara', lang: 'it-IT', onDevice: true },
    ]);
    expect(toKokoroVoiceInfos({ hf_alpha: {} })).toEqual([
      { id: 'hf_alpha', name: 'hf_alpha', lang: 'hi-IN', onDevice: true },
    ]);
    expect(toKokoroVoiceInfos({ pf_dora: {} })).toEqual([
      { id: 'pf_dora', name: 'pf_dora', lang: 'pt-BR', onDevice: true },
    ]);
  });

  it('marks Japanese and Mandarin voices as Web-Speech-only (not on-device)', () => {
    expect(toKokoroVoiceInfos({ jf_alpha: { gender: 'Female' } })).toEqual([
      { id: 'jf_alpha', name: 'jf_alpha', lang: 'ja-JP', onDevice: false, gender: 'Female' },
    ]);
    expect(toKokoroVoiceInfos({ zm_yunjian: { gender: 'Male' } })).toEqual([
      { id: 'zm_yunjian', name: 'zm_yunjian', lang: 'zh-CN', onDevice: false, gender: 'Male' },
    ]);
  });

  it('defaults an unknown/unmapped prefix with no reported language to onDevice:false', () => {
    // Future community voices with prefixes we don't map must NOT route to
    // Kokoro: we keep en-US as a display fallback but mark them Web-Speech-only.
    expect(toKokoroVoiceInfos({ xf_unknown: {} })).toEqual([
      { id: 'xf_unknown', name: 'xf_unknown', lang: 'en-US', onDevice: false },
    ]);
    // A reported language still wins (and is trusted for on-device routing).
    expect(toKokoroVoiceInfos({ xf_unknown: { language: 'es-ES' } })).toEqual([
      { id: 'xf_unknown', name: 'xf_unknown', lang: 'es-ES', onDevice: true },
    ]);
  });

  it('prefers a reported language over the id prefix, normalizing its casing', () => {
    expect(toKokoroVoiceInfos({ pf_dora: { language: 'pt-br' } })).toEqual([
      { id: 'pf_dora', name: 'pf_dora', lang: 'pt-BR', onDevice: true },
    ]);
    expect(toKokoroVoiceInfos({ ef_dora: { language: 'es' } })).toEqual([
      { id: 'ef_dora', name: 'ef_dora', lang: 'es', onDevice: true },
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
