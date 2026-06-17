/**
 * Per-session dictation priming: when a turn was submitted via push-to-talk,
 * the message text the model sees carries AI-only markers so it tolerates
 * phonetic/transcription noise and produces speech-friendly replies — without
 * polluting the user-visible transcript.
 *
 * Two markers, always appended at the END of the dictated text:
 *  - 🎙️ (microphone) — on EVERY dictated message; the per-message hint.
 *  - ◁ … ▷ — wraps the one-time priming note, sent only on the FIRST
 *    dictated turn of a session.
 *
 * The marked text is what gets stored AND sent to the agent (so replay /
 * compaction keeps the context). The UI strips markers at render time —
 * `userMessageEl` is the only place that calls `stripDictationMarkers`.
 *
 * The per-session "first message" flag lives in this module; the new-session
 * flow calls `resetDictationPriming()` so a fresh session re-arms the note.
 */

/** The one-time priming note wrapped in ◁ … ▷ on the first dictated turn. */
const PRIMING_NOTE =
  '◁This message has been sent through text to speech, consider possible ' +
  'phonetic alternatives and transcription errors. Future dictated messages ' +
  'will have the 🎙️ emoji appended. Your responses to dictated messages ' +
  'will be read out loud, avoid urls, acronyms, numbers, formatting▷';

/** Microphone glyph optionally followed by the VS16 variation selector. */
const MIC_RE = /\uD83C\uDF99\uFE0F?/g;
/** Any ◁ … ▷ region (non-greedy, multi-line tolerant). */
const NOTE_RE = /\u25C1[\s\S]*?\u25B7/g;

let firstPending = true;

/**
 * Append the dictation markers to `text`. The first dictated message of a
 * session also carries the priming note; subsequent ones get only 🎙️.
 * Pure — no state read or write happens here; callers drive the "is first?"
 * decision via `consumeDictationFirst()` so this stays unit-testable.
 */
export function applyDictationMarkers(text: string, isFirst: boolean): string {
  const base = text.endsWith(' ') ? text : `${text} `;
  return isFirst ? `${base}\uD83C\uDF99\uFE0F${PRIMING_NOTE}` : `${base}\uD83C\uDF99\uFE0F`;
}

/**
 * Remove every dictation marker — any ◁ … ▷ span and any 🎙️ glyph — and
 * trim trailing whitespace. Defensive: a message that is only markers
 * yields the empty string.
 */
export function stripDictationMarkers(text: string): string {
  return text
    .replace(NOTE_RE, '')
    .replace(MIC_RE, '')
    .replace(/[ \t]+$/g, '')
    .trimEnd();
}

/**
 * One-shot "is this the first dictated turn?" check for the session. Returns
 * true ONCE per session (until the next reset); every later dictated turn
 * gets false. Callers feed the result to `applyDictationMarkers`.
 */
export function consumeDictationFirst(): boolean {
  if (!firstPending) return false;
  firstPending = false;
  return true;
}

/**
 * Re-arm the first-dictated-message flag. Called from the new-session flow
 * (and the test setup) so a fresh session sends the priming note again on
 * its first dictated turn.
 */
export function resetDictationPriming(): void {
  firstPending = true;
}
