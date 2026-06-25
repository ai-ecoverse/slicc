import { describe, expect, it } from 'vitest';
import {
  KOKORO_N_TOKEN,
  KOKORO_VOCAB,
  tokenizeKokoroPhonemes,
} from '../../src/speech/kokoro-vocab.js';

describe('KOKORO_VOCAB', () => {
  it('declares the trained token count', () => {
    expect(KOKORO_N_TOKEN).toBe(178);
  });

  it('matches the canonical hexgrad/Kokoro-82M anchor ids', () => {
    // Spot-check across the punctuation / latin / IPA / stress / arrow ranges.
    expect(KOKORO_VOCAB[';']).toBe(1);
    expect(KOKORO_VOCAB[' ']).toBe(16);
    expect(KOKORO_VOCAB['a']).toBe(43);
    expect(KOKORO_VOCAB['z']).toBe(68);
    expect(KOKORO_VOCAB['ə']).toBe(83);
    expect(KOKORO_VOCAB['ɹ']).toBe(123);
    expect(KOKORO_VOCAB['ˈ']).toBe(156);
    expect(KOKORO_VOCAB['ː']).toBe(158);
    expect(KOKORO_VOCAB['ᵻ']).toBe(177);
  });

  it('carries the combining tilde and the latin small letter turned r ids', () => {
    expect(KOKORO_VOCAB['\u0303']).toBe(17);
    expect(KOKORO_VOCAB['\uAB67']).toBe(23);
  });

  it('keeps every id within the trained range and pad 0 reserved', () => {
    const ids = Object.values(KOKORO_VOCAB);
    expect(Math.min(...ids)).toBeGreaterThan(0);
    expect(Math.max(...ids)).toBeLessThan(KOKORO_N_TOKEN);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  });
});

describe('tokenizeKokoroPhonemes', () => {
  it('maps each phoneme character to its id, preserving order', () => {
    // "ˈzɛɹ" → stress + z + ɛ + ɹ
    expect(tokenizeKokoroPhonemes('ˈzɛɹ')).toEqual([156, 68, 86, 123]);
  });

  it('drops characters absent from the vocab without shifting later ids', () => {
    // '€' and 'Ω' are not in the vocab; surrounding ids must be unaffected.
    expect(tokenizeKokoroPhonemes('a€zΩ.')).toEqual([43, 68, 4]);
  });

  it('never emits the pad/BOS/EOS token (0)', () => {
    expect(tokenizeKokoroPhonemes('halloˈʃøːn')).not.toContain(0);
  });

  it('returns an empty array for empty or fully-unmappable input', () => {
    expect(tokenizeKokoroPhonemes('')).toEqual([]);
    expect(tokenizeKokoroPhonemes('€Ω™')).toEqual([]);
  });

  it('tokenizes a combining-mark phoneme as its own id', () => {
    // base 'a' (43) + combining tilde (17)
    expect(tokenizeKokoroPhonemes('a\u0303')).toEqual([43, 17]);
  });
});
