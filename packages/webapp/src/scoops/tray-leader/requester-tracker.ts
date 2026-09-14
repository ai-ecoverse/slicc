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

  handleFollowerRemoved(bootstrapId: string): void {
    if (this.origin?.kind === 'follower' && this.origin.bootstrapId === bootstrapId) {
      this.origin = null;
    }
  }
}
