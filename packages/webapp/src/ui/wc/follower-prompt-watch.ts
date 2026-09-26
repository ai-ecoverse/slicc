export const FOLLOWER_PROMPT_SILENCE_MS = 30_000;

export const PROMPT_SILENCE_NOTE =
  '_The leader is not responding yet. It may still be starting, or be slowed down while its tab is in the background. This message will run once the leader catches up._';

export const PROMPT_SILENCE_NOTE_SIDE_PANEL =
  '_The SLICC tab is not responding yet. It may still be starting, or Chrome may be slowing it down in the background. **Bring leader to front** in the avatar menu usually lets it catch up._';

export const PROMPT_RECEIVED_SILENCE_NOTE =
  '_The leader got this message, but its agent has not started on it yet. It may still be starting, or be slowed down while its tab is in the background._';

export const PROMPT_RECEIVED_SILENCE_NOTE_SIDE_PANEL =
  '_The SLICC tab got this message, but its agent has not started on it yet. **Bring leader to front** in the avatar menu usually lets it catch up._';

export function promptRejectedNote(error: string | undefined): string {
  const reason = error?.trim();
  return reason
    ? `_The leader got that message but could not start it — ${reason}_`
    : '_The leader got that message but could not start it._';
}

export function promptSilenceNote(received: boolean, sidePanel: boolean): string {
  if (received) {
    return sidePanel ? PROMPT_RECEIVED_SILENCE_NOTE_SIDE_PANEL : PROMPT_RECEIVED_SILENCE_NOTE;
  }
  return sidePanel ? PROMPT_SILENCE_NOTE_SIDE_PANEL : PROMPT_SILENCE_NOTE;
}

export interface FollowerPromptAck {
  messageId: string;
  scoopJid: string;
  state: 'accepted' | 'rejected';
  error?: string;
}

export interface FollowerPromptWatchDeps {
  onSilence(unitId: string, received: boolean): void;

  onRejected?(unitId: string | null, error: string | undefined): void;
  silenceMs?: number;
}

export class FollowerPromptWatch {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #unitId: string | null = null;
  #messageId: string | null = null;
  #received = false;
  #detachAgentEvents: (() => void) | null = null;

  constructor(private readonly deps: FollowerPromptWatchDeps) {}

  noteSent(unitId: string, messageId: string): void {
    this.#clear();
    this.#unitId = unitId;
    this.#messageId = messageId;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.deps.onSilence(unitId, this.#received);
    }, this.deps.silenceMs ?? FOLLOWER_PROMPT_SILENCE_MS);
  }

  noteReceived(unitId?: string | null, messageId?: string | null): void {
    if (!this.#timer) return;
    if (unitId && this.#unitId && unitId !== this.#unitId) return;
    if (messageId && this.#messageId && messageId !== this.#messageId) return;
    this.#received = true;
  }

  noteAck(ack: FollowerPromptAck): void {
    if (this.#messageId && ack.messageId !== this.#messageId) return;
    const named = ack.scoopJid.length > 0 ? ack.scoopJid : null;
    if (ack.state === 'accepted') {
      this.noteReceived(named, ack.messageId);
      return;
    }
    const unitId = named ?? this.#unitId;
    this.noteLeaderActivity(named);
    this.deps.onRejected?.(unitId, ack.error);
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
    this.#messageId = null;
    this.#received = false;
  }
}
