/**
 * Tracks where the most recent user message came from: the leader's own UI or
 * a connected follower. Interactive flows that need a human (delegated OAuth
 * popups, teleport destination selection) consult this to route the
 * interaction to the browser the user is actually looking at.
 */

export type LastUserMessageOrigin =
  | { kind: 'leader'; at: number }
  | { kind: 'follower'; bootstrapId: string; runtimeId?: string; at: number };

export class RequesterTracker {
  private origin: LastUserMessageOrigin | null = null;

  noteFollowerUserMessage(bootstrapId: string, runtimeId?: string): void {
    this.origin = { kind: 'follower', bootstrapId, runtimeId, at: Date.now() };
  }

  noteLeaderUserMessage(): void {
    this.origin = { kind: 'leader', at: Date.now() };
  }

  get(): LastUserMessageOrigin | null {
    return this.origin;
  }

  /**
   * A disconnected follower can no longer host an interaction; fail toward
   * "no known origin" so callers fall back to their local/default path.
   */
  handleFollowerRemoved(bootstrapId: string): void {
    if (this.origin?.kind === 'follower' && this.origin.bootstrapId === bootstrapId) {
      this.origin = null;
    }
  }
}
