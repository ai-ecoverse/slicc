/**
 * Notices a follower prompt the leader never reacts to.
 *
 * A follower's send has no acknowledgement: the leader's main thread echoes
 * the message straight back, but whether its agent ever picks it up only shows
 * as later status frames and agent events. When the leader is still booting,
 * or is a background tab Chrome has deprioritized (on macOS a hidden tab's
 * renderer runs at the lowest scheduler priority, so a busy machine can starve
 * it for minutes), none of those arrive. The prompt then sits in the queued
 * pile with no reply and no explanation.
 *
 * The rule is deliberately narrow: after a send, ANY reaction from the leader
 * disarms the watch: an agent event, a biscotto review-state frame, or a status
 * frame. A prompt queued behind a visibly running turn therefore never trips
 * it; only total silence does.
 *
 * It is scoped to the addressed unit where the wire allows: a status frame that
 * names ANOTHER unit does not disarm it, and the mount posts the note only while
 * that unit is on screen (otherwise it would land in the wrong thread). Agent
 * events carry no unit, so they disarm unconditionally. Every gap in the scoping
 * errs towards a missing note, never towards a wrong one.
 */

/** How long a sent prompt may go without any reaction before the hint. */
export const FOLLOWER_PROMPT_SILENCE_MS = 30_000;

/** The note a follower adds to its thread when a prompt meets silence. */
export const PROMPT_SILENCE_NOTE =
  '_The leader has not picked this up yet. It may still be starting, or be slowed down while its tab is in the background. It will run once the leader catches up._';

/** The side-panel variant: there the pinned leader tab is one click away. */
export const PROMPT_SILENCE_NOTE_SIDE_PANEL =
  '_The SLICC tab has not picked this up yet. It may still be starting, or Chrome may be slowing it down in the background. **Bring leader to front** in the avatar menu usually lets it catch up._';

export interface FollowerPromptWatchDeps {
  /** Called once per armed period, after `silenceMs` without a reaction. */
  onSilence(unitId: string): void;
  silenceMs?: number;
}

export class FollowerPromptWatch {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #unitId: string | null = null;
  #detachAgentEvents: (() => void) | null = null;

  constructor(private readonly deps: FollowerPromptWatchDeps) {}

  /** A prompt for `unitId` left this follower: expect the leader to react. */
  noteSent(unitId: string): void {
    this.#clear();
    this.#unitId = unitId;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.deps.onSilence(unitId);
    }, this.deps.silenceMs ?? FOLLOWER_PROMPT_SILENCE_MS);
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
  }
}
