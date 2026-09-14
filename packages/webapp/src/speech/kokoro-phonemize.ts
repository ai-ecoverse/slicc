export type EspeakPhonemize = (text: string, espeakLang: string) => Promise<string[]>;

export const KOKORO_PREFIX_ESPEAK: Readonly<Record<string, string>> = Object.freeze({
  e: 'es',
  f: 'fr-fr',
  i: 'it',
  h: 'hi',
  p: 'pt-br',
});

export function espeakVoiceForKokoroVoice(voiceId: string): string | null {
  return KOKORO_PREFIX_ESPEAK[voiceId[0]] ?? null;
}

export const KOKORO_PREFIX_ESPEAK_ENGLISH: Readonly<Record<string, string>> = Object.freeze({
  a: 'en-us',
  b: 'en-gb',
});

export function englishEspeakVoiceForKokoroVoice(voiceId: string): string | null {
  return KOKORO_PREFIX_ESPEAK_ENGLISH[voiceId[0]] ?? null;
}

export function isUnusablePhonemizerError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /Invalid language identifier/i.test(message) && /Should be one of:\s*\.?\s*$/i.test(message)
  );
}

const PUNCT = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_SPLIT = new RegExp(
  `(\\s*[${PUNCT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`,
  'g'
);

interface TextPart {
  punct: boolean;
  text: string;
}

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

export function applyKokoroPhonemeFixups(phonemes: string): string {
  return phonemes
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/(?<=[a-zɹrː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z')
    .trim();
}

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
