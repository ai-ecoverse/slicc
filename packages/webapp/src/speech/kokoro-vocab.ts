/**
 * The canonical Kokoro phoneme vocabulary + tokenizer — the PURE token layer
 * the German on-device engine (`german-kokoro-engine.ts`) feeds into the ONNX
 * session.
 *
 * The community German model (`Godelaune/Kokoro-82M-ONNX-German-Martin`) ships
 * a bare `kokoro-martin.onnx` + `voices-martin.npz` with NO HF `tokenizer.json`
 * — its Python reference (`kokoro-onnx`) tokenizes against the SAME 178-token
 * vocabulary every Kokoro checkpoint shares (hexgrad/Kokoro-82M `config.json`
 * `vocab`, `n_token: 178`). The English `kokoro-js` path resolves the identical
 * map from its bundled `tokenizer.json`, so this is the standalone twin of that
 * lookup for the runtimes that drive the ONNX session directly.
 *
 * The map is intentionally SPARSE (ids 0/7/8/26-30/… are unused in the trained
 * vocab); `0` is the pad/BOS/EOS token the engine brackets the id sequence with
 * (`[0, ...ids, 0]`) and is therefore never produced by `tokenizeKokoroPhonemes`.
 * Phoneme characters absent from the map are dropped — exactly what `kokoro-onnx`
 * does — so an unmappable espeak artifact can't shift every following token id.
 */

/** Total token count the Kokoro text encoder is trained against (`n_token`). */
export const KOKORO_N_TOKEN = 178;

/**
 * Phoneme character → token id. Verbatim from hexgrad/Kokoro-82M `config.json`
 * (`vocab`) — the canonical source every Kokoro variant, incl. the German ONNX
 * model, tokenizes against. Frozen so callers can't mutate the shared table.
 */
export const KOKORO_VOCAB: Readonly<Record<string, number>> = Object.freeze({
  ';': 1,
  ':': 2,
  ',': 3,
  '.': 4,
  '!': 5,
  '?': 6,
  '—': 9,
  '…': 10,
  '"': 11,
  '(': 12,
  ')': 13,
  '\u201C': 14,
  '\u201D': 15,
  ' ': 16,
  '\u0303': 17,
  ʣ: 18,
  ʥ: 19,
  ʦ: 20,
  ʨ: 21,
  ᵝ: 22,
  '\uAB67': 23,
  A: 24,
  I: 25,
  O: 31,
  Q: 33,
  S: 35,
  T: 36,
  W: 39,
  Y: 41,
  ᵊ: 42,
  a: 43,
  b: 44,
  c: 45,
  d: 46,
  e: 47,
  f: 48,
  h: 50,
  i: 51,
  j: 52,
  k: 53,
  l: 54,
  m: 55,
  n: 56,
  o: 57,
  p: 58,
  q: 59,
  r: 60,
  s: 61,
  t: 62,
  u: 63,
  v: 64,
  w: 65,
  x: 66,
  y: 67,
  z: 68,
  ɑ: 69,
  ɐ: 70,
  ɒ: 71,
  æ: 72,
  β: 75,
  ɔ: 76,
  ɕ: 77,
  ç: 78,
  ɖ: 80,
  ð: 81,
  ʤ: 82,
  ə: 83,
  ɚ: 85,
  ɛ: 86,
  ɜ: 87,
  ɟ: 90,
  ɡ: 92,
  ɥ: 99,
  ɨ: 101,
  ɪ: 102,
  ʝ: 103,
  ɯ: 110,
  ɰ: 111,
  ŋ: 112,
  ɳ: 113,
  ɲ: 114,
  ɴ: 115,
  ø: 116,
  ɸ: 118,
  θ: 119,
  œ: 120,
  ɹ: 123,
  ɾ: 125,
  ɻ: 126,
  ʁ: 128,
  ɽ: 129,
  ʂ: 130,
  ʃ: 131,
  ʈ: 132,
  ʧ: 133,
  ʊ: 135,
  ʋ: 136,
  ʌ: 138,
  ɣ: 139,
  ɤ: 140,
  χ: 142,
  ʎ: 143,
  ʒ: 147,
  ʔ: 148,
  ˈ: 156,
  ˌ: 157,
  ː: 158,
  ʰ: 162,
  ʲ: 164,
  '↓': 169,
  '→': 171,
  '↗': 172,
  '↘': 173,
  ᵻ: 177,
});

/**
 * Tokenize a phoneme string into Kokoro token ids (pure). Maps each character
 * through `KOKORO_VOCAB`, silently dropping characters the vocab does not carry
 * (mirrors `kokoro-onnx`). The returned ids do NOT include the bracketing pad
 * token — the engine wraps them as `[0, ...ids, 0]` before inference.
 */
export function tokenizeKokoroPhonemes(phonemes: string): number[] {
  const ids: number[] = [];
  for (const ch of phonemes) {
    const id = KOKORO_VOCAB[ch];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}
