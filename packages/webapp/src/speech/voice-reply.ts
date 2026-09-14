import { createLogger } from '../base/logger.js';
import { parseReplyLang, stripReplyLangMarker } from './dictation-priming.js';
import { hasVoiceForLang, speak, speechTextFromMarkdown } from './speak.js';

const log = createLogger('speech:voice-reply');

let pendingCount = 0;

export function markVoiceSubmission(): void {
  pendingCount++;
}

export function consumeVoiceSubmission(): boolean {
  if (pendingCount <= 0) return false;
  pendingCount--;
  return true;
}

export function resetVoiceSubmissionForTests(): void {
  pendingCount = 0;
}

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
