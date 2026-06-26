/**
 * The spoken-reply loop: a turn submitted by DICTATION (the composer's
 * push-to-talk) gets its assistant reply read aloud — typed turns stay
 * silent. "Speak to it, it speaks back."
 *
 * Tiny coordinator between two wiring points in `wc-live.ts`: the composer
 * submit listener marks a dictated submission; the chat controller's
 * turn-complete callback consumes the mark and speaks the reply (kokoro once
 * its chained download is ready, Web Speech until then — see `speak.ts`).
 */

import { createLogger } from '../core/logger.js';
import { parseReplyLang, stripReplyLangMarker } from './dictation-priming.js';
import { hasVoiceForLang, speak, speechTextFromMarkdown } from './speak.js';

const log = createLogger('speech:voice-reply');

// Tracked as a COUNT, not a boolean: queued dictated turns each call
// `markVoiceSubmission` before any of them complete, and EVERY turn's
// completion must balance its own `beginVoiceTurn` so the soundscape's
// voice-mode gate doesn't latch open and pin later typed turns audible.
let pendingCount = 0;

/** A dictated submission just went out — the next reply should be spoken. */
export function markVoiceSubmission(): void {
  pendingCount++;
}

/**
 * Whether the completing turn was voice-initiated. Decrements the pending
 * count when positive so N dictated submits → N true consumes → N matching
 * `endVoiceTurn` calls in the host (begins and ends stay balanced).
 */
export function consumeVoiceSubmission(): boolean {
  if (pendingCount <= 0) return false;
  pendingCount--;
  return true;
}

/** Test-only: reset the pending-submission count. */
export function resetVoiceSubmissionForTests(): void {
  pendingCount = 0;
}

/**
 * Read an assistant reply aloud (markdown reduced to speakable prose).
 * Best-effort: failures log and never disturb the chat flow.
 *
 * When the agent declared its reply language via the hidden `<!--lang:xx-->`
 * marker, the reply is spoken ONLY if some engine has a voice for that
 * language — otherwise it stays silent rather than read e.g. English prose in
 * the locale-default German voice. A reply with no marker speaks as before.
 */
export async function speakReplyMarkdown(
  markdown: string,
  speakFn: typeof speak = speak,
  hasVoiceFn: typeof hasVoiceForLang = hasVoiceForLang
): Promise<void> {
  const lang = parseReplyLang(markdown);
  if (lang && !(await hasVoiceFn(lang))) return;
  const text = speechTextFromMarkdown(stripReplyLangMarker(markdown));
  if (!text) return;
  try {
    await speakFn(lang ? { text, lang } : { text });
  } catch (err) {
    log.warn('spoken reply failed', err);
  }
}
