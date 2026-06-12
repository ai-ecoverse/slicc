import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeVoiceSubmission,
  markVoiceSubmission,
  resetVoiceSubmissionForTests,
  speakReplyMarkdown,
} from '../../src/speech/voice-reply.js';

describe('voice-reply', () => {
  beforeEach(() => {
    resetVoiceSubmissionForTests();
  });

  it('mark/consume is a one-shot: only the turn after a dictation speaks', () => {
    expect(consumeVoiceSubmission()).toBe(false);
    markVoiceSubmission();
    expect(consumeVoiceSubmission()).toBe(true);
    // Consumed — the NEXT (typed) turn stays silent.
    expect(consumeVoiceSubmission()).toBe(false);
  });

  it('speaks the reply as reduced prose', async () => {
    const speakFn = vi.fn().mockResolvedValue({ engine: 'kokoro' });
    await speakReplyMarkdown('**Done!** I shipped the `hero` fix.', speakFn as never);
    expect(speakFn).toHaveBeenCalledWith({ text: 'Done! I shipped the hero fix.' });
  });

  it('skips replies with nothing speakable', async () => {
    const speakFn = vi.fn();
    await speakReplyMarkdown('```\ncode only\n```', speakFn as never);
    expect(speakFn).not.toHaveBeenCalled();
  });

  it('swallows synthesis failures (best-effort, never disturbs chat)', async () => {
    const speakFn = vi.fn().mockRejectedValue(new Error('no audio device'));
    await expect(speakReplyMarkdown('hello', speakFn as never)).resolves.toBeUndefined();
  });
});
