/**
 * Language-aware phonemization for Kokoro's non-English on-device voices.
 *
 * kokoro-js@1.2.1 phonemizes everything as English: its module-private `m()`
 * picks `en-us` (voice prefix `a`) or `en` (everything else) and feeds the
 * English-only bundled `phonemizer`. There is no exported seam to patch, so for
 * es/fr/it/hi/pt we phonemize the text OURSELVES with the correct espeak
 * language (via the staged multilingual `espeak-ng` wasm — see
 * `espeak-phonemizer.ts`) and feed the result straight into kokoro-js's public
 * `tokenizer` + `generate_from_ids`, bypassing `m()`.
 *
 * This module is the PURE core (no wasm, no I/O): the prefix→espeak map, the
 * punctuation-preserving split + join, and kokoro-js's own phoneme fixups —
 * all unit-tested against an injected `EspeakPhonemize`. English (prefix
 * `a`/`b`) never reaches here; it keeps kokoro-js's native path.
 */

/** Phonemize one chunk of text in `espeakLang`, IPA lines (mirrors the
 *  `phonemizer` package's `phonemize` signature so either backend fits). */
export type EspeakPhonemize = (text: string, espeakLang: string) => Promise<string[]>;

/**
 * Kokoro voice-id prefix → espeak-ng voice identifier. Mirrors
 * hexgrad/kokoro's pipeline (`e`→es, `f`→fr-fr, `i`→it, `h`→hi, `p`→pt-br).
 * English (`a`/`b`) and the no-JS-G2P languages (`j`/`z`) are intentionally
 * absent — only these five route through the wrapper synth path.
 */
export const KOKORO_PREFIX_ESPEAK: Readonly<Record<string, string>> = Object.freeze({
  e: 'es',
  f: 'fr-fr',
  i: 'it',
  h: 'hi',
  p: 'pt-br',
});

/** The espeak voice for a kokoro voice id, or null when it is not one of the
 *  five wrapper-path languages (English / ja / zh / unknown). */
export function espeakVoiceForKokoroVoice(voiceId: string): string | null {
  return KOKORO_PREFIX_ESPEAK[voiceId[0]] ?? null;
}

/** The punctuation kokoro-js splits on before phonemizing — kept verbatim in
 *  the output so prosody/pauses survive (same set as kokoro-js' `m()`). */
const PUNCT = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_SPLIT = new RegExp(
  `(\\s*[${PUNCT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`,
  'g'
);

interface TextPart {
  /** True for a punctuation run (kept verbatim), false for phonemizable text. */
  punct: boolean;
  text: string;
}

/** Split into alternating phonemizable / punctuation parts (kokoro-js' splitter
 *  reproduced) so punctuation passes through untouched. */
export function splitOnPunctuation(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PUNCT_SPLIT)) {
    const run = match[0];
    const index = match.index ?? 0;
    if (cursor < index) parts.push({ punct: false, text: text.slice(cursor, index) });
    if (run.length > 0) parts.push({ punct: true, text: run });
    cursor = index + run.length;
  }
  if (cursor < text.length) parts.push({ punct: false, text: text.slice(cursor) });
  return parts;
}

/**
 * kokoro-js's universal phoneme fixups (the prefix-`!== "a"` subset). Maps the
 * espeak phonemes the Kokoro vocab does NOT carry onto the ones it expects
 * (`ʲ→j`, `r→ɹ`, `x→k`, `ɬ→l`), normalizes the embedded "kokoro" pronunciation,
 * fixes "…hundred" spacing and a trailing devoiced `z`. The English-only text
 * normalization and the `a`-only `nˈaɪnti→nˈaɪndi` tweak are deliberately NOT
 * applied — exactly what kokoro-js does for non-`a` voices.
 */
export function applyKokoroPhonemeFixups(phonemes: string): string {
  return phonemes
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z')
    .trim();
}

/**
 * Phonemize `text` for a non-English Kokoro voice: split off punctuation,
 * phonemize each text run in `espeakLang`, re-join with the punctuation
 * preserved, then apply kokoro-js's fixups. The returned IPA string is ready
 * for `tts.tokenizer(...)`. Pure given `phonemize` (mock it in tests).
 */
export async function phonemizeForKokoro(
  text: string,
  espeakLang: string,
  phonemize: EspeakPhonemize
): Promise<string> {
  const parts = splitOnPunctuation(text);
  const rendered = await Promise.all(
    parts.map(async (part) =>
      part.punct ? part.text : (await phonemize(part.text, espeakLang)).join(' ')
    )
  );
  return applyKokoroPhonemeFixups(rendered.join(''));
}
