import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOLLOWER_PROMPT_SILENCE_MS,
  FollowerPromptWatch,
  PROMPT_RECEIVED_SILENCE_NOTE,
  PROMPT_RECEIVED_SILENCE_NOTE_SIDE_PANEL,
  PROMPT_SILENCE_NOTE,
  PROMPT_SILENCE_NOTE_SIDE_PANEL,
  promptRejectedNote,
  promptSilenceNote,
} from '../../../src/ui/wc/follower-prompt-watch.js';

describe('FollowerPromptWatch', () => {
  let onSilence: ReturnType<typeof vi.fn<(unitId: string, received: boolean) => void>>;
  let onRejected: ReturnType<typeof vi.fn<(unitId: string | null, error?: string) => void>>;
  let watch: FollowerPromptWatch;

  beforeEach(() => {
    vi.useFakeTimers();
    onSilence = vi.fn<(unitId: string, received: boolean) => void>();
    onRejected = vi.fn<(unitId: string | null, error?: string) => void>();
    watch = new FollowerPromptWatch({ onSilence, onRejected });
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
    watch.noteSent('cone_1', 'm1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS - 1);
    expect(onSilence).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSilence).toHaveBeenCalledWith('cone_1', false);
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 3);
    expect(onSilence).toHaveBeenCalledTimes(1);
  });

  it('any unit-less leader reaction before the deadline disarms it', () => {
    watch.noteSent('cone_1', 'm1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS - 1);
    watch.noteLeaderActivity();
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('a status frame for the addressed unit disarms it', () => {
    watch.noteSent('cone_1', 'm1');
    watch.noteLeaderActivity('cone_1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('a status frame for ANOTHER unit is not a reaction to this prompt', () => {
    watch.noteSent('cone_1', 'm1');
    watch.noteLeaderActivity('cone_2');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS);
    expect(onSilence).toHaveBeenCalledWith('cone_1', false);
  });

  it('a second send restarts the wait for the newly addressed unit', () => {
    watch.noteSent('cone_1', 'm1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS / 2);
    watch.noteSent('cone_2', 'm2');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS - 1);
    expect(onSilence).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSilence).toHaveBeenCalledTimes(1);
    expect(onSilence).toHaveBeenCalledWith('cone_2', false);
  });

  it('an echo of the prompt keeps it armed but marks it received', () => {
    watch.noteSent('cone_1', 'm1');
    watch.noteReceived('cone_1', 'm1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS);
    expect(onSilence).toHaveBeenCalledTimes(1);
    expect(onSilence).toHaveBeenCalledWith('cone_1', true);
  });

  it('an echo for ANOTHER unit does not mark this prompt received', () => {
    watch.noteSent('cone_1', 'm1');
    watch.noteReceived('cone_2', 'm1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS);
    expect(onSilence).toHaveBeenCalledWith('cone_1', false);
  });

  it('a late echo for an older message does not mark the watched one received', () => {
    watch.noteSent('cone_1', 'm1');
    watch.noteSent('cone_1', 'm2');
    watch.noteReceived('cone_1', 'm1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS);
    expect(onSilence).toHaveBeenCalledWith('cone_1', false);
  });

  it('a new send forgets the previous prompt was received', () => {
    watch.noteSent('cone_1', 'm1');
    watch.noteReceived('cone_1', 'm1');
    watch.noteSent('cone_1', 'm2');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS);
    expect(onSilence).toHaveBeenCalledWith('cone_1', false);
  });

  it('an echo with nothing armed arms nothing', () => {
    watch.noteReceived('cone_1', 'm1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('an accepted ack keeps it armed and marks it received', () => {
    watch.noteSent('cone_1', 'm1');
    watch.noteAck({ messageId: 'm1', scoopJid: 'cone_1', state: 'accepted' });
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS);
    expect(onSilence).toHaveBeenCalledTimes(1);
    expect(onSilence).toHaveBeenCalledWith('cone_1', true);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it('an accepted ack followed by real activity posts nothing', () => {
    watch.noteSent('cone_1', 'm1');
    watch.noteAck({ messageId: 'm1', scoopJid: 'cone_1', state: 'accepted' });
    watch.noteLeaderActivity('cone_1');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('an accepted ack with nothing armed arms nothing', () => {
    watch.noteAck({ messageId: 'm1', scoopJid: 'cone_1', state: 'accepted' });
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('an accepted ack for ANOTHER unit leaves this prompt armed', () => {
    watch.noteSent('cone_1', 'm1');
    watch.noteAck({ messageId: 'm1', scoopJid: 'cone_2', state: 'accepted' });
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS);
    expect(onSilence).toHaveBeenCalledWith('cone_1', false);
  });

  it('a late accepted ack for an older message leaves the watched prompt unmarked', () => {
    watch.noteSent('cone_1', 'm1');
    watch.noteSent('cone_1', 'm2');
    watch.noteAck({ messageId: 'm1', scoopJid: 'cone_1', state: 'accepted' });
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS);
    expect(onSilence).toHaveBeenCalledWith('cone_1', false);
  });

  it('a rejected ack disarms it and reports the named unit and error', () => {
    watch.noteSent('cone_1', 'm1');
    watch.noteAck({ messageId: 'm1', scoopJid: 'cone_1', state: 'rejected', error: 'kernel gone' });
    expect(onRejected).toHaveBeenCalledWith('cone_1', 'kernel gone');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('a late rejected ack for an older message does not disarm the watched prompt', () => {
    watch.noteSent('cone_1', 'm1');
    watch.noteSent('cone_1', 'm2');
    watch.noteAck({ messageId: 'm1', scoopJid: 'cone_1', state: 'rejected', error: 'stale' });
    expect(onRejected).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS);
    expect(onSilence).toHaveBeenCalledWith('cone_1', false);
  });

  it('a rejected ack that names no unit is reported against the armed one', () => {
    watch.noteSent('cone_1', 'm1');
    watch.noteAck({ messageId: 'm1', scoopJid: '', state: 'rejected', error: 'nothing selected' });
    expect(onRejected).toHaveBeenCalledWith('cone_1', 'nothing selected');
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('a unit-less rejected ack with nothing armed reports no unit', () => {
    watch.noteAck({ messageId: 'm9', scoopJid: '', state: 'rejected' });
    expect(onRejected).toHaveBeenCalledWith(null, undefined);
  });

  it('picks the silence note by echo and by mount', () => {
    expect(promptSilenceNote(false, false)).toBe(PROMPT_SILENCE_NOTE);
    expect(promptSilenceNote(false, true)).toBe(PROMPT_SILENCE_NOTE_SIDE_PANEL);
    expect(promptSilenceNote(true, false)).toBe(PROMPT_RECEIVED_SILENCE_NOTE);
    expect(promptSilenceNote(true, true)).toBe(PROMPT_RECEIVED_SILENCE_NOTE_SIDE_PANEL);

    expect(PROMPT_SILENCE_NOTE_SIDE_PANEL).toContain('Bring leader to front');
    expect(PROMPT_RECEIVED_SILENCE_NOTE_SIDE_PANEL).toContain('Bring leader to front');
  });

  it('the rejected note carries the leader error when there is one', () => {
    expect(promptRejectedNote('kernel gone')).toContain('kernel gone');
    expect(promptRejectedNote(undefined)).toBe(promptRejectedNote('  '));
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
    watch.followAgentEvents(second);
    expect(first.subscribed).toBe(0);
    expect(second.subscribed).toBe(1);

    watch.noteSent('cone_1', 'm1');
    second.emit();
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();

    watch.dispose();
    expect(second.subscribed).toBe(0);
  });

  it('dispose() cancels a pending hint', () => {
    watch.noteSent('cone_1', 'm1');
    watch.dispose();
    vi.advanceTimersByTime(FOLLOWER_PROMPT_SILENCE_MS * 2);
    expect(onSilence).not.toHaveBeenCalled();
  });

  it('honors a custom silence window', () => {
    const custom = new FollowerPromptWatch({ onSilence, silenceMs: 1_000 });
    custom.noteSent('cone_1', 'm1');
    vi.advanceTimersByTime(1_000);
    expect(onSilence).toHaveBeenCalledTimes(1);
  });
});
