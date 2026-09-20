/**
 * The user messages THIS device sent that no leader snapshot has confirmed yet.
 *
 * A snapshot replaces a unit's buffer wholesale, and it describes the moment
 * the leader BUILT it, not the moment it arrives. A large thread's snapshot is
 * read asynchronously and delivered in chunks, so there is a real window —
 * switch to a busy cone and send straight away, or send across a reconnect —
 * in which a snapshot built before the prompt reached the leader lands after
 * the prompt was appended locally, and erases it. The message was delivered;
 * it just stopped being on the sender's own screen.
 *
 * The ledger holds each send until a snapshot contains it, and
 * {@link LocalSendLedger.reconcile} puts back the ones a snapshot is missing.
 * An entry also expires on its own: a prompt the leader never recorded must
 * not be re-asserted against every later snapshot for the rest of the session.
 *
 * Web counterpart of iOS `Sync/LocalSendLedger.swift` (#3302 / #3320).
 */

import type { WorkUnitChatMessage, WorkUnitId } from '../../work-unit/client/types.js';

/** How long an unconfirmed send outranks a snapshot that lacks it, in ms. */
export const LOCAL_SEND_CONFIRMATION_WINDOW_MS = 60_000;

interface Entry {
  /** `null` for a send made before any unit was selected — see {@link LocalSendLedger.record}. */
  scoopJid: WorkUnitId | null;
  message: WorkUnitChatMessage;
  readonly sentAt: number;
  /** Transport refused the frame. The entry is still held so a snapshot cannot drop it. */
  undelivered?: boolean;
}

export class LocalSendLedger {
  private readonly entries = new Map<string, Entry>();

  /** Whether `messageId` is a send this device still holds unconfirmed. */
  owns(messageId: string): boolean {
    return this.entries.has(messageId);
  }

  /** Whether the transport refused this still-held send. */
  isUndelivered(messageId: string): boolean {
    return this.entries.get(messageId)?.undelivered === true;
  }

  /**
   * `scoopJid` is `null` in the window after the channel opens and before
   * the first snapshot or roster names a unit: the composer already works,
   * and the leader delivers such a prompt to the unit it is displaying —
   * which is the unit its first snapshot describes. The entry is held
   * unscoped and adopted by the first snapshot to arrive.
   */
  record(message: WorkUnitChatMessage, scoopJid: WorkUnitId | null, now = Date.now()): void {
    this.entries.set(message.id, { scoopJid, message, sentAt: now });
  }

  /**
   * The transport refused this send. It stays in the ledger — the bubble
   * keeps its content — so a snapshot that puts it back cannot drop a
   * prompt this device still knows it typed.
   */
  flagUndelivered(messageId: string): void {
    const entry = this.entries.get(messageId);
    if (!entry) return;
    entry.undelivered = true;
  }

  removeAll(): void {
    this.entries.clear();
  }

  /**
   * `snapshot` for `scoopJid`, with this device's unconfirmed sends put
   * back. Sends the snapshot already contains are confirmed and dropped
   * from the ledger; expired ones are dropped without being re-applied.
   */
  reconcile(
    snapshot: readonly WorkUnitChatMessage[],
    scoopJid: WorkUnitId,
    now = Date.now()
  ): readonly WorkUnitChatMessage[] {
    return this.merge(snapshot, scoopJid, now, true);
  }

  /**
   * Snapshot plus missing sends, without treating the snapshot as confirmation.
   *
   * Used when seeding a subscriber from the local cache: that cache may
   * already include a previously overlaid send, and confirming against it
   * would drop the ledger entry so a later stale leader snapshot could
   * erase the bubble for real.
   */
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
