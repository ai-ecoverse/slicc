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
import { speak, speechTextFromMarkdown } from './speak.js';

const log = createLogger('speech:voice-reply');

let pending = false;

/** A dictated submission just went out — the next reply should be spoken. */
export function markVoiceSubmission(): void {
  pending = true;
}

/** Whether the completing turn was voice-initiated (one-shot). */
export function consumeVoiceSubmission(): boolean {
  const wasPending = pending;
  pending = false;
  return wasPending;
}

/** Test-only: reset the one-shot flag. */
export function resetVoiceSubmissionForTests(): void {
  pending = false;
}

/**
 * Read an assistant reply aloud (markdown reduced to speakable prose).
 * Best-effort: failures log and never disturb the chat flow.
 */
export async function speakReplyMarkdown(
  markdown: string,
  speakFn: typeof speak = speak
): Promise<void> {
  const text = speechTextFromMarkdown(markdown);
  if (!text) return;
  try {
    await speakFn({ text });
  } catch (err) {
    log.warn('spoken reply failed', err);
  }
}
