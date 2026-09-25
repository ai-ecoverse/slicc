import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOLLOWER_PROMPT_SILENCE_MS,
  FollowerPromptWatch,
} from '../../../src/ui/wc/follower-prompt-watch.js';

describe('FollowerPromptWatch', () => {
  let onSilence: ReturnType<typeof vi.fn<(unitId: string) => void>>;
  let watch: FollowerPromptWatch;

  beforeEach(() => {
    vi.useFakeTimers();
    onSilence = vi.fn<(unitId: string) => void>();
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

  it('hints once, naming the addressed unit, when a sent prompt meets total silence', () => {
    watch.noteSent('cone_1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS - 1);
    expect(onSilence).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSilence).toHaveBeenCalledWith('cone_1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 3);
    expect(onSilence).toHaveBeenCalledTimes(1); // one hint per send, never a drumbeat
  });

  it('any unit-less leader reaction before the deadline disarms it', () => {
    // An agent event or a review-state frame — including one from a turn the
    // prompt is queued behind — proves the leader is alive.
    watch.noteSent('cone_1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS - 1);
    watch.noteLeaderActivity();
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('a status frame for the addressed unit disarms it', () => {
    watch.noteSent('cone_1');
    watch.noteLeaderActivity('cone_1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('a status frame for ANOTHER unit is not a reaction to this prompt', () => {
    watch.noteSent('cone_1');
    watch.noteLeaderActivity('cone_2');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS);
    expect(onSilence).toHaveBeenCalledWith('cone_1');
  });

  it('a second send restarts the wait for the newly addressed unit', () => {
    watch.noteSent('cone_1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS / 2);
    watch.noteSent('cone_2');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS - 1);
    expect(onSilence).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSilence).toHaveBeenCalledTimes(1);
    expect(onSilence).toHaveBeenCalledWith('cone_2');
  });

  it('followAgentEvents re-points at each new handle and dispose() detaches', () => {
    const makeAgent = () => {
      const listeners = new Set<() => void>();
      return {
        onEvent: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        emit: () => {
          for (const listener of listeners) listener();
        },
        get subscribed() {
          return listeners.size;
        },
      };
    };
    const first = makeAgent();
    const second = makeAgent();
    watch.followAgentEvents(first);
    watch.followAgentEvents(second); // a reconnect hands over a NEW handle
    expect(first.subscribed).toBe(0);
    expect(second.subscribed).toBe(1);

    watch.noteSent('cone_1');
    second.emit();
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();

    watch.dispose();
    expect(second.subscribed).toBe(0);
  });

  it('dispose() cancels a pending hint', () => {
    watch.noteSent('cone_1');
    watch.dispose();
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('honors a custom silence window', () => {
    const custom = new FollowerPromptWatch({ onSilence, silenceMs: 1_000 });
    custom.noteSent('cone_1');
    vi.advanceTimersByTime(1_000);
    expect(onSilence).toHaveBeenCalledTimes(1);
  });
});
