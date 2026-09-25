import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOLLOWER_PROMPT_SILENCE_MS,
  FollowerPromptWatch,
} from '../../../src/ui/wc/follower-prompt-watch.js';

describe('FollowerPromptWatch', () => {
  let onSilence: ReturnType<typeof vi.fn<() => void>>;
  let watch: FollowerPromptWatch;

  beforeEach(() => {
    vi.useFakeTimers();
    onSilence = vi.fn<() => void>();
    watch = new FollowerPromptWatch({ onSilence });
  });
  afterEach(() => {
    watch.dispose();
    vi.useRealTimers();
  });

  it('stays quiet until a prompt is sent', () => {
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('hints once when a sent prompt meets total silence', () => {
    watch.noteSent();
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS - 1);
    expect(onSilence).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSilence).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 3);
    expect(onSilence).toHaveBeenCalledTimes(1); // one hint per send, never a drumbeat
  });

  it('any leader reaction before the deadline disarms it', () => {
    // A status frame or agent event — including one from a turn the prompt is
    // queued behind — proves the leader is alive; the queue explains the wait.
    watch.noteSent();
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS - 1);
    watch.noteLeaderActivity();
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('a second send restarts the wait instead of stacking hints', () => {
    watch.noteSent();
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS / 2);
    watch.noteSent();
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS - 1);
    expect(onSilence).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSilence).toHaveBeenCalledTimes(1);
  });

  it('dispose() cancels a pending hint', () => {
    watch.noteSent();
    watch.dispose();
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('honors a custom silence window', () => {
    const custom = new FollowerPromptWatch({ onSilence, silenceMs: 1_000 });
    custom.noteSent();
    vi.advanceTimersByTime(1_000);
    expect(onSilence).toHaveBeenCalledTimes(1);
  });
});
