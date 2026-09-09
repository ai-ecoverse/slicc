/**
 * The compaction-row reducer: compaction PHASES in, transcript-row actions
 * out (#2843).
 *
 * One round produces one row. The opening phase (`summarizing`) mints it, a
 * terminal phase settles it in place, and a round that kept nothing retracts
 * it — including the LATE retraction only the idle timer produces, which
 * decides adoption after the compactor has already returned and so has to
 * name the round it is taking back.
 *
 * This lives at the `scoops/` layer because two consumers need the identical
 * verdict from the identical event stream: the panel renders the row
 * (`ui/offscreen-client.ts`) and the kernel persists it (`kernel/facade.ts`),
 * and a second opinion on either side would mean a transcript whose seams
 * change when you reload it.
 */

import type { CompactionState, CompactionStateDetail } from '../core/context-compaction.js';
import type { ChatCompactionMarker, CompactionMarkerState } from './chat-types.js';

/**
 * Compaction PHASE (what the round is doing) → marker STATE (what the row
 * says). `extracting-memory` is absent on purpose: it is a phase of a round
 * whose row is already up, and it changes nothing the row shows.
 */
const MARKER_STATE: Record<Exclude<CompactionState, 'extracting-memory'>, CompactionMarkerState> = {
  summarizing: 'summarizing',
  fallback: 'fallback',
  cancelled: 'discarded',
  // `idle` is the resting state the compactor reaches after a round it did
  // NOT abort — so for a row still open, the history really was summarized.
  idle: 'summarized',
};

/** What a phase does to the transcript. `null` means: nothing at all. */
export type CompactionRowAction =
  /** Add a row for a round that just started. */
  | { kind: 'open'; messageId: string; marker: ChatCompactionMarker }
  /** Update the row this round already owns. */
  | { kind: 'settle'; messageId: string; marker: ChatCompactionMarker }
  /** Take the row back: the round kept nothing. */
  | { kind: 'retract'; messageId: string };

interface SettledRow {
  messageId: string;
  roundId: string;
}

/**
 * Per-unit row bookkeeping for the compaction phase stream. Stateful but
 * pure — it touches no DOM, no store and no clock beyond the id factory it
 * is handed.
 */
export class CompactionRowTracker {
  /** Row of the round currently in flight, per unit. */
  private readonly open = new Map<string, string>();
  /**
   * Row a late `cancelled` is allowed to take back: one this unit already
   * settled, belonging to the SAME round as the retraction.
   *
   * Only the idle timer produces the `summarizing` → `idle` → `cancelled`
   * sequence. Matching on the round id keeps a discarded round that never
   * opened a row — nothing to summarize, so the compactor emitted nothing —
   * from retracting a previous round's honest row (#2843).
   */
  private readonly settled = new Map<string, SettledRow>();

  /** `mintId` is injectable so tests (and two floats) can be deterministic. */
  constructor(private readonly mintId: (unitId: string) => string) {}

  /** Decide what one phase does to `unitId`'s transcript. */
  apply(
    unitId: string,
    state: CompactionState,
    detail: CompactionStateDetail
  ): CompactionRowAction | null {
    if (state === 'extracting-memory') return null;
    const existing = this.open.get(unitId) ?? this.lateRetraction(unitId, state, detail);
    // A terminal phase with no open row is a round whose opening phase never
    // reached this consumer (it started before the tab attached, or against a
    // unit that was not selected). There is nothing to settle or retract.
    if (state !== 'summarizing' && !existing) return null;
    if (state !== 'summarizing') {
      this.open.delete(unitId);
      this.settled.delete(unitId);
    }
    const messageId = existing ?? this.mintId(unitId);
    if (state === 'summarizing') this.open.set(unitId, messageId);
    // A round that named itself keeps its settled row retractable: its own
    // adoption verdict has not arrived yet (see {@link settled}).
    if ((state === 'idle' || state === 'fallback') && detail.roundId) {
      this.settled.set(unitId, { messageId, roundId: detail.roundId });
    }
    if (state === 'cancelled') return { kind: 'retract', messageId };
    const marker: ChatCompactionMarker = {
      trigger: detail.trigger,
      state: MARKER_STATE[state],
      ...(detail.transcriptPath ? { transcriptPath: detail.transcriptPath } : {}),
    };
    return state === 'summarizing'
      ? { kind: 'open', messageId, marker }
      : { kind: 'settle', messageId, marker };
  }

  /** Forget a unit — it was dropped, or its transcript was cleared. */
  forget(unitId: string): void {
    this.open.delete(unitId);
    this.settled.delete(unitId);
  }

  private lateRetraction(
    unitId: string,
    state: CompactionState,
    detail: CompactionStateDetail
  ): string | undefined {
    if (state !== 'cancelled' || !detail.roundId) return undefined;
    const settled = this.settled.get(unitId);
    return settled?.roundId === detail.roundId ? settled.messageId : undefined;
  }
}
