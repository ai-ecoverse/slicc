import { describe, expect, it, vi } from 'vitest';
import {
  applyKokoroPhonemeFixups,
  espeakVoiceForKokoroVoice,
  KOKORO_PREFIX_ESPEAK,
  phonemizeForKokoro,
  splitOnPunctuation,
} from '../../src/speech/kokoro-phonemize.js';

describe('espeakVoiceForKokoroVoice', () => {
  it('maps the five on-device non-English prefixes to espeak codes', () => {
    expect(espeakVoiceForKokoroVoice('ef_dora')).toBe('es');
    expect(espeakVoiceForKokoroVoice('ff_siwis')).toBe('fr-fr');
    expect(espeakVoiceForKokoroVoice('if_sara')).toBe('it');
    expect(espeakVoiceForKokoroVoice('hf_alpha')).toBe('hi');
    expect(espeakVoiceForKokoroVoice('pf_dora')).toBe('pt-br');
  });

  it('returns null for English and the no-JS-G2P languages', () => {
    expect(espeakVoiceForKokoroVoice('af_heart')).toBeNull();
    expect(espeakVoiceForKokoroVoice('bm_george')).toBeNull();
    expect(espeakVoiceForKokoroVoice('jf_alpha')).toBeNull();
    expect(espeakVoiceForKokoroVoice('zf_xiaobei')).toBeNull();
    expect(espeakVoiceForKokoroVoice('qq_unknown')).toBeNull();
  });

  it('exposes exactly the five wrapper-path languages', () => {
    expect(Object.keys(KOKORO_PREFIX_ESPEAK).sort()).toEqual(['e', 'f', 'h', 'i', 'p']);
  });
});

describe('splitOnPunctuation', () => {
  it('keeps punctuation runs verbatim between phonemizable text', () => {
    expect(splitOnPunctuation('Hola, mundo!')).toEqual([
      { punct: false, text: 'Hola' },
      { punct: true, text: ', ' },
      { punct: false, text: 'mundo' },
      { punct: true, text: '!' },
    ]);
  });

  it('returns a single text part when there is no punctuation', () => {
    expect(splitOnPunctuation('bonjour')).toEqual([{ punct: false, text: 'bonjour' }]);
  });
});

describe('applyKokoroPhonemeFixups', () => {
  it('applies the universal espeak→kokoro vocab mappings', () => {
    expect(applyKokoroPhonemeFixups('rxɬʲ')).toBe('ɹklj');
  });

  it('normalizes the embedded kokoro pronunciation and trailing z', () => {
    expect(applyKokoroPhonemeFixups('kəkˈoːɹoʊ')).toBe('kˈoʊkəɹoʊ');
    expect(applyKokoroPhonemeFixups('foo z')).toBe('fooz');
  });
});

describe('phonemizeForKokoro', () => {
  it('phonemizes text runs in the given espeak language, keeping punctuation', async () => {
    const phonemize = vi.fn(async (text: string) => (text === 'Hola' ? ['ˈola'] : ['ˈmundo']));
    const out = await phonemizeForKokoro('Hola, mundo', 'es', phonemize);
    expect(phonemize).toHaveBeenCalledWith('Hola', 'es');
    expect(phonemize).toHaveBeenCalledWith('mundo', 'es');
    expect(out).toBe('ˈola, ˈmundo');
  });

  it('applies kokoro fixups to the joined espeak output', async () => {
    const phonemize = vi.fn(async () => ['xeˈro']); // x→k, r→ɹ
    expect(await phonemizeForKokoro('perro', 'es', phonemize)).toBe('keˈɹo');
  });

  it.each([
    ['ef_dora', 'es'],
    ['ff_siwis', 'fr-fr'],
    ['if_sara', 'it'],
    ['hf_alpha', 'hi'],
    ['pf_dora', 'pt-br'],
  ])('routes %s through espeak language %s', async (voiceId, espeakLang) => {
    const phonemize = vi.fn(async () => ['x']);
    const lang = espeakVoiceForKokoroVoice(voiceId);
    expect(lang).toBe(espeakLang);
    await phonemizeForKokoro('texto', lang as string, phonemize);
    expect(phonemize).toHaveBeenCalledWith('texto', espeakLang);
  });
});
