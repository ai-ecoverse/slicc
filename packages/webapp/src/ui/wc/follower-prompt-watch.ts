/**
 * Notices a follower prompt the leader never reacts to.
 *
 * A leader at tray protocol 10 or later acks each follower prompt
 * (`user_message_ack`) once its agent took or refused it. An older leader
 * sends no ack: its main thread echoes the message straight back, but whether
 * its agent ever picks it up only shows as later status frames and agent
 * events. When the leader is still booting, or is a background tab Chrome has
 * deprioritized (on macOS a hidden tab's renderer runs at the lowest scheduler
 * priority, so a busy machine can starve it for minutes), none of those arrive.
 * The prompt then sits in the queued pile with no reply and no explanation.
 *
 * The rule is deliberately narrow: after a send, ANY reaction from the leader
 * disarms the watch: an `accepted` ack, an agent event, a biscotto
 * review-state frame, or a status frame. A prompt queued behind a visibly
 * running turn therefore never trips it; only total silence does. The leader's
 * echo of the prompt does NOT disarm it: it only proves the leader's page got
 * the text, so it changes what the note says, not whether it is posted.
 *
 * It is scoped to the addressed unit where the wire allows: a frame that names
 * ANOTHER unit does not disarm it, and the mount posts the note only while that
 * unit is on screen (otherwise it would land in the wrong thread). Agent events
 * carry no unit, so they disarm unconditionally. Every gap in the scoping errs
 * towards a missing note, never towards a wrong one.
 */

/** How long a sent prompt may go without any reaction before the hint. */
export const FOLLOWER_PROMPT_SILENCE_MS = 30_000;

/** The note a follower adds when the leader has not even echoed its prompt. */
export const PROMPT_SILENCE_NOTE =
  '_The leader is not responding yet. It may still be starting, or be slowed down while its tab is in the background. This message will run once the leader catches up._';

/** The side-panel variant: there the pinned leader tab is one click away. */
export const PROMPT_SILENCE_NOTE_SIDE_PANEL =
  '_The SLICC tab is not responding yet. It may still be starting, or Chrome may be slowing it down in the background. **Bring leader to front** in the avatar menu usually lets it catch up._';

/** The leader echoed the prompt, but its agent never started on it. */
export const PROMPT_RECEIVED_SILENCE_NOTE =
  '_The leader got this message, but its agent has not started on it yet. It may still be starting, or be slowed down while its tab is in the background._';

/** The side-panel variant of {@link PROMPT_RECEIVED_SILENCE_NOTE}. */
export const PROMPT_RECEIVED_SILENCE_NOTE_SIDE_PANEL =
  '_The SLICC tab got this message, but its agent has not started on it yet. **Bring leader to front** in the avatar menu usually lets it catch up._';

/** The note for a prompt the leader received but could not start. */
export function promptRejectedNote(error: string | undefined): string {
  const reason = error?.trim();
  return reason
    ? `_The leader got that message but could not start it — ${reason}_`
    : '_The leader got that message but could not start it._';
}

/** The silence note for one mount: whether the prompt was echoed, and where it runs. */
export function promptSilenceNote(received: boolean, sidePanel: boolean): string {
  if (received) {
    return sidePanel ? PROMPT_RECEIVED_SILENCE_NOTE_SIDE_PANEL : PROMPT_RECEIVED_SILENCE_NOTE;
  }
  return sidePanel ? PROMPT_SILENCE_NOTE_SIDE_PANEL : PROMPT_SILENCE_NOTE;
}

/** The fields of a `user_message_ack` the watch acts on. */
export interface FollowerPromptAck {
  scoopJid: string;
  state: 'accepted' | 'rejected';
  error?: string;
}

export interface FollowerPromptWatchDeps {
  /**
   * Called once per armed period, after `silenceMs` without a reaction.
   * `received` is whether the leader echoed the prompt in the meantime.
   */
  onSilence(unitId: string, received: boolean): void;
  /**
   * The leader refused a prompt. `unitId` is the unit the ack names, else the
   * unit the watch was armed for; `null` when neither is known.
   */
  onRejected?(unitId: string | null, error: string | undefined): void;
  silenceMs?: number;
}

export class FollowerPromptWatch {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #unitId: string | null = null;
  #received = false;
  #detachAgentEvents: (() => void) | null = null;

  constructor(private readonly deps: FollowerPromptWatchDeps) {}

  /** A prompt for `unitId` left this follower: expect the leader to react. */
  noteSent(unitId: string): void {
    this.#clear();
    this.#unitId = unitId;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.deps.onSilence(unitId, this.#received);
    }, this.deps.silenceMs ?? FOLLOWER_PROMPT_SILENCE_MS);
  }

  /**
   * The leader echoed this follower's own prompt: its page has it. Keeps the
   * watch armed; an echo for another unit is not about this prompt.
   */
  noteReceived(unitId?: string | null): void {
    if (!this.#timer) return;
    if (unitId && this.#unitId && unitId !== this.#unitId) return;
    this.#received = true;
  }

  /**
   * The leader acked one of this follower's prompts. `accepted` is a reaction
   * like any other; `rejected` also disarms, and is reported so the mount can
   * say why the prompt went nowhere.
   */
  noteAck(ack: FollowerPromptAck): void {
    const named = ack.scoopJid.length > 0 ? ack.scoopJid : null;
    if (ack.state === 'accepted') {
      this.noteLeaderActivity(named);
      return;
    }
    const unitId = named ?? this.#unitId;
    this.noteLeaderActivity(named);
    this.deps.onRejected?.(unitId, ack.error);
  }

  /**
   * The leader showed a sign of life (or the channel dropped): stop waiting.
   * A frame that names a unit other than the addressed one is not a reaction
   * to this prompt; one that names none always counts.
   */
  noteLeaderActivity(unitId?: string | null): void {
    if (unitId && this.#unitId && unitId !== this.#unitId) return;
    this.#clear();
  }

  /**
   * Treat `agent`'s events as leader activity. A follower gets a NEW handle on
   * every (re)connect, so this replaces the previous subscription.
   */
  followAgentEvents(agent: { onEvent(listener: () => void): () => void }): void {
    this.#detachAgentEvents?.();
    this.#detachAgentEvents = agent.onEvent(() => this.noteLeaderActivity());
  }

  dispose(): void {
    this.#clear();
    this.#detachAgentEvents?.();
    this.#detachAgentEvents = null;
  }

  #clear(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#unitId = null;
    this.#received = false;
  }
}
