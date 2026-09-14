import type { CompactionState, CompactionStateDetail } from '../core/context-compaction.js';
import type { ChatCompactionMarker, CompactionMarkerState } from './chat-types.js';

const MARKER_STATE: Record<Exclude<CompactionState, 'extracting-memory'>, CompactionMarkerState> = {
  summarizing: 'summarizing',
  fallback: 'fallback',
  cancelled: 'discarded',

  idle: 'summarized',
};

export type CompactionRowAction =
  | { kind: 'open'; messageId: string; marker: ChatCompactionMarker }
  | { kind: 'settle'; messageId: string; marker: ChatCompactionMarker }
  | { kind: 'retract'; messageId: string };

interface SettledRow {
  messageId: string;
  roundId: string;
}

export class CompactionRowTracker {
  private readonly open = new Map<string, string>();

  private readonly settled = new Map<string, SettledRow>();

  constructor(private readonly mintId: (unitId: string) => string) {}

  apply(
    unitId: string,
    state: CompactionState,
    detail: CompactionStateDetail,
    rowId?: string
  ): CompactionRowAction | null {
    if (state === 'extracting-memory') return null;
    const existing = this.open.get(unitId) ?? this.lateRetraction(unitId, state, detail) ?? rowId;

    if (state !== 'summarizing' && !existing) return null;
    if (state !== 'summarizing') {
      this.open.delete(unitId);
      this.settled.delete(unitId);
    }
    const messageId = existing ?? this.mintId(unitId);
    if (state === 'summarizing') this.open.set(unitId, messageId);

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
