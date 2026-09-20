import type { WorkUnitChatMessage, WorkUnitId } from '../../work-unit/client/types.js';

export const LOCAL_SEND_CONFIRMATION_WINDOW_MS = 60_000;

interface Entry {
  scoopJid: WorkUnitId | null;
  message: WorkUnitChatMessage;
  readonly sentAt: number;

  undelivered?: boolean;
}

export class LocalSendLedger {
  private readonly entries = new Map<string, Entry>();

  owns(messageId: string): boolean {
    return this.entries.has(messageId);
  }

  isUndelivered(messageId: string): boolean {
    return this.entries.get(messageId)?.undelivered === true;
  }

  record(message: WorkUnitChatMessage, scoopJid: WorkUnitId | null, now = Date.now()): void {
    this.entries.set(message.id, { scoopJid, message, sentAt: now });
  }

  flagUndelivered(messageId: string): void {
    const entry = this.entries.get(messageId);
    if (!entry) return;
    entry.undelivered = true;
  }

  removeAll(): void {
    this.entries.clear();
  }

  reconcile(
    snapshot: readonly WorkUnitChatMessage[],
    scoopJid: WorkUnitId,
    now = Date.now()
  ): readonly WorkUnitChatMessage[] {
    return this.merge(snapshot, scoopJid, now, true);
  }

  withUnconfirmed(
    snapshot: readonly WorkUnitChatMessage[],
    scoopJid: WorkUnitId,
    now = Date.now()
  ): readonly WorkUnitChatMessage[] {
    return this.merge(snapshot, scoopJid, now, false);
  }

  private merge(
    snapshot: readonly WorkUnitChatMessage[],
    scoopJid: WorkUnitId,
    now: number,
    confirm: boolean
  ): readonly WorkUnitChatMessage[] {
    if (this.entries.size === 0) return snapshot;
    const present = new Set(snapshot.map((message) => message.id));
    const missing: Entry[] = [];
    for (const [id, entry] of this.entries) {
      if (now - entry.sentAt > LOCAL_SEND_CONFIRMATION_WINDOW_MS) {
        this.entries.delete(id);
        continue;
      }
      if (entry.scoopJid !== null && entry.scoopJid !== scoopJid) continue;
      if (present.has(id)) {
        if (confirm) this.entries.delete(id);
        continue;
      }
      if (confirm && entry.scoopJid === null) entry.scoopJid = scoopJid;
      missing.push(entry);
    }
    if (missing.length === 0) return snapshot;
    return [
      ...snapshot,
      ...missing.sort((a, b) => a.sentAt - b.sentAt).map((entry) => entry.message),
    ];
  }
}
