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

  it('queued dictated submissions stack: N marks → N true consumes → none leak', () => {
    // Two dictated submits queued before either turn completes — the bool
    // version coalesced these and only consumed one, leaving the second
    // begin orphaned in the soundscape voice-turn gate.
    markVoiceSubmission();
    markVoiceSubmission();
    expect(consumeVoiceSubmission()).toBe(true);
    expect(consumeVoiceSubmission()).toBe(true);
    // Both consumed — a later typed turn must not speak.
    expect(consumeVoiceSubmission()).toBe(false);
  });

  it('consume never goes negative when called without a pending mark', () => {
    expect(consumeVoiceSubmission()).toBe(false);
    expect(consumeVoiceSubmission()).toBe(false);
    // A fresh mark still produces exactly one true consume.
    markVoiceSubmission();
    expect(consumeVoiceSubmission()).toBe(true);
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

  it('threads the declared language to speak() and strips the marker from prose', async () => {
    const speakFn = vi.fn().mockResolvedValue({ engine: 'webspeech' });
    const hasVoice = vi.fn().mockReturnValue(true);
    await speakReplyMarkdown('<!--lang:de-->**Hallo!** Alles klar.', speakFn as never, hasVoice);
    expect(hasVoice).toHaveBeenCalledWith('de');
    expect(speakFn).toHaveBeenCalledWith({ text: 'Hallo! Alles klar.', lang: 'de' });
  });

  it('stays silent when no voice can speak the declared language', async () => {
    const speakFn = vi.fn();
    const hasVoice = vi.fn().mockReturnValue(false);
    await speakReplyMarkdown('<!--lang:de-->Hallo Welt', speakFn as never, hasVoice);
    expect(hasVoice).toHaveBeenCalledWith('de');
    expect(speakFn).not.toHaveBeenCalled();
  });

  it('a reply with no marker speaks normally without consulting voice availability', async () => {
    const speakFn = vi.fn().mockResolvedValue({ engine: 'kokoro' });
    const hasVoice = vi.fn();
    await speakReplyMarkdown('Plain reply, no marker.', speakFn as never, hasVoice);
    expect(hasVoice).not.toHaveBeenCalled();
    expect(speakFn).toHaveBeenCalledWith({ text: 'Plain reply, no marker.' });
  });
});
