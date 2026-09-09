/**
 * Derivations of the canonical conversation record (#2275).
 *
 * Everything that used to be a parallel WRITE is a read of this module:
 * Pi's restore history, the chat panel's projection, transcript text for
 * tray snapshots and frozen archives, and the summary a child hands its
 * parent. There is one spine (`record.entries`) and four views of it.
 *
 * Every derivation is total: an empty or unreadable record derives to
 * nothing, which is the signal callers use to fall back to the legacy
 * stores (`session-persistence.ts`, `kernel/facade.ts`). A derivation never
 * throws on a record it does not understand.
 */

import type { AgentMessage } from '../../core/index.js';
import type { ChatMessage, CompactionMarkerState } from '../../scoops/chat-types.js';
import type { ConversationEntry, ConversationMarker, WorkUnitConversationRecord } from './types.js';
import { isReadableRecord } from './types.js';

/**
 * Marker states a reload may put back on the transcript: the two that mean the
 * round finished and kept something. See {@link interleaveMarkers}.
 */
const RESTORABLE_STATES: ReadonlySet<CompactionMarkerState> = new Set<CompactionMarkerState>([
  'summarized',
  'fallback',
]);

/**
 * Pi history. Lossless for an `agent-history` record: the verbatim messages
 * in append order, with `tool-call` entries skipped because Pi keeps tool
 * calls inside the assistant message that issued them.
 *
 * Empty for a `ui-projection` record BY DESIGN — a rendered transcript
 * cannot be turned back into a faithful Pi conversation, and feeding the
 * model a reconstruction would be worse than restoring from the legacy
 * store, which is exactly what an empty answer makes the caller do.
 */
export function toAgentMessages(record: WorkUnitConversationRecord | null): AgentMessage[] {
  if (!isReadableRecord(record) || record === null) return [];
  if (record.origin !== 'agent-history') return [];
  const out: AgentMessage[] = [];
  for (const entry of record.entries) {
    if (entry.kind === 'tool-call') continue;
    if (entry.message) out.push(entry.message);
  }
  return out;
}

/**
 * The chat panel's projection. For an `agent-history` record this runs the
 * existing `agentMessagesToChatMessages` translator over the derived Pi
 * history, so the projection the panel renders from the canonical record is
 * byte-for-byte the one it renders from live agent state — the reason the
 * translator's tests remain the contract for both. Lazy-imported to keep
 * pi-ai types out of every caller's eager closure.
 *
 * For a `ui-projection` record the stored chat messages ARE the projection.
 *
 * Either way the record's {@link ConversationMarker}s are folded back in
 * ({@link interleaveMarkers}) — they are transcript rows no message list can
 * carry, so this is the only place they can rejoin the thread.
 */
export async function toChatMessages(
  record: WorkUnitConversationRecord | null,
  options: { source?: string; idSeed?: () => string } = {}
): Promise<ChatMessage[]> {
  if (!isReadableRecord(record) || record === null) return [];
  if (record.origin === 'ui-projection') {
    const out: ChatMessage[] = [];
    for (const entry of record.entries) {
      if (entry.kind === 'tool-call') continue;
      if (entry.chat) out.push(entry.chat);
    }
    return interleaveMarkers(out, record.markers);
  }
  const messages = toAgentMessages(record);
  if (messages.length === 0) return [];
  const { agentMessagesToChatMessages } = await import('../../scoops/agent-message-to-chat.js');
  return interleaveMarkers(agentMessagesToChatMessages(messages, options), record.markers);
}

/**
 * Fold marker rows into a projected transcript, ordered by `timestamp`.
 *
 * A marker goes BEFORE the first message stamped later than it, and at the
 * end when there is none — the position a compaction seam belongs in, since
 * the round is recorded after the summary message it produced.
 *
 * Only a SETTLED seam is restored ({@link RESTORABLE_STATES}). A `discarded`
 * round must not be announced by a reload, and neither must an in-flight one:
 * the phase stream does not replay, so a `summarizing` marker left behind by a
 * tab that reloaded mid-round has nothing left to settle it and would breathe
 * "compacting history…" forever.
 *
 * Pure and total: no markers returns the input array itself.
 */
export function interleaveMarkers(
  messages: ChatMessage[],
  markers: readonly ConversationMarker[] | undefined
): ChatMessage[] {
  const live = (markers ?? []).filter((m) => RESTORABLE_STATES.has(m.compaction.state));
  if (live.length === 0) return messages;
  const sorted = [...live].sort((a, b) => a.timestamp - b.timestamp);
  const out: ChatMessage[] = [];
  let next = 0;
  for (const message of messages) {
    const at = messageTime(message);
    while (next < sorted.length && sorted[next].timestamp <= at) {
      out.push(markerRow(sorted[next++]));
    }
    out.push(message);
  }
  while (next < sorted.length) out.push(markerRow(sorted[next++]));
  return out;
}

/**
 * Epoch ms of a projected message, for comparison against a marker.
 *
 * The earliest `agent-sessions` writes stamped messages with ISO STRINGS and
 * those profiles are still out there, so a raw `<=` would compare a number
 * against a string and quietly answer `false` for every message. Anything
 * unstampable sorts BEFORE every marker, which puts the seams at the end of a
 * transcript that cannot place them — the honest fallback, since a compaction
 * is the most recent thing that happened to it.
 */
function messageTime(message: ChatMessage): number {
  const raw: unknown = message.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

/** A marker as the row the chat view renders (`messageEls` keys on `compaction`). */
function markerRow(marker: ConversationMarker): ChatMessage {
  return {
    id: marker.id,
    role: 'assistant',
    content: '',
    timestamp: marker.timestamp,
    compaction: marker.compaction,
  };
}

/**
 * Flat `user: … / assistant: …` transcript — what the scope-label tooltip,
 * tray snapshots and frozen archives read. Tool traffic is omitted: the
 * transcript is the conversation, not the trace.
 */
export function toTranscriptText(record: WorkUnitConversationRecord | null): string {
  if (!isReadableRecord(record) || record === null) return '';
  const lines: string[] = [];
  for (const entry of record.entries) {
    const label = transcriptLabel(entry);
    if (!label) continue;
    const text = 'text' in entry ? entry.text.trim() : '';
    if (text.length === 0) continue;
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n');
}

/**
 * The summary a finished child hands its parent: its last assistant text.
 * Empty when the child never answered — the caller then reports completion
 * without a body rather than inventing one.
 */
export function toChildResultSummary(record: WorkUnitConversationRecord | null): string {
  if (!isReadableRecord(record) || record === null) return '';
  for (let i = record.entries.length - 1; i >= 0; i--) {
    const entry = record.entries[i];
    if (entry.kind !== 'assistant') continue;
    const text = entry.text.trim();
    if (text.length > 0) return text;
  }
  return '';
}

/** How many messages (not entries) a record represents — tool calls excluded. */
export function conversationLength(record: WorkUnitConversationRecord | null): number {
  if (!isReadableRecord(record) || record === null) return 0;
  return record.entries.filter((e) => e.kind !== 'tool-call').length;
}

function transcriptLabel(entry: ConversationEntry): string | null {
  switch (entry.kind) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'external-event':
      return `event(${entry.channel})`;
    case 'child-result':
      return `child(${entry.channel})`;
    default:
      return null;
  }
}
