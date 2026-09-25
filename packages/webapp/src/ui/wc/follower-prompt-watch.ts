export const FOLLOWER_PROMPT_SILENCE_MS = 30_000;

export const PROMPT_SILENCE_NOTE =
  '_The leader has not picked this up yet. It may still be starting, or be slowed down while its tab is in the background. It will run once the leader catches up._';

export const PROMPT_SILENCE_NOTE_SIDE_PANEL =
  '_The SLICC tab has not picked this up yet. It may still be starting, or Chrome may be slowing it down in the background. **Bring leader to front** in the avatar menu usually lets it catch up._';

export interface FollowerPromptWatchDeps {
  onSilence(unitId: string): void;
  silenceMs?: number;
}

export class FollowerPromptWatch {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #unitId: string | null = null;
  #detachAgentEvents: (() => void) | null = null;

  constructor(private readonly deps: FollowerPromptWatchDeps) {}

  noteSent(unitId: string): void {
    this.#clear();
    this.#unitId = unitId;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.deps.onSilence(unitId);
    }, this.deps.silenceMs ?? FOLLOWER_PROMPT_SILENCE_MS);
  }

  noteLeaderActivity(unitId?: string | null): void {
    if (unitId && this.#unitId && unitId !== this.#unitId) return;
    this.#clear();
  }

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
