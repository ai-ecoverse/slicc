import type { PendingHandoff } from '../../../chrome-extension/src/messages.js';

function compareByReceivedAt(a: PendingHandoff, b: PendingHandoff): number {
  return a.receivedAt.localeCompare(b.receivedAt);
}

export class StandaloneHandoffWatcher {
  private readonly onPendingHandoffsChange?: (handoffs: PendingHandoff[]) => void;
  private readonly pendingByHandoffId = new Map<string, PendingHandoff>();

  constructor(options: { onPendingHandoffsChange?: (handoffs: PendingHandoff[]) => void }) {
    this.onPendingHandoffsChange = options.onPendingHandoffsChange;
  }

  injectHandoff(payload: PendingHandoff['payload'], sourceUrl = 'local'): string {
    const handoffId = `injected-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.pendingByHandoffId.set(handoffId, {
      handoffId,
      sourceUrl,
      payload,
      receivedAt: new Date().toISOString(),
    });
    this.emitChange();
    return handoffId;
  }

  clearHandoff(handoffId: string): { handoff: PendingHandoff | null; targetIds: string[] } {
    const handoff = this.pendingByHandoffId.get(handoffId) ?? null;
    this.pendingByHandoffId.delete(handoffId);
    if (handoff) this.emitChange();
    return { handoff, targetIds: [] };
  }

  private emitChange(): void {
    this.onPendingHandoffsChange?.([...this.pendingByHandoffId.values()].sort(compareByReceivedAt));
  }
}
