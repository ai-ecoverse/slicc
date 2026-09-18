import type { AgentMessage } from '../../core/index.js';
import type { ChatMessage, CompactionMarkerState } from '../../scoops/chat-types.js';
import type {
  ConversationAttachmentOverlay,
  ConversationEntry,
  ConversationMarker,
  WorkUnitConversationRecord,
} from './types.js';
import { isReadableRecord } from './types.js';

const RESTORABLE_STATES: ReadonlySet<CompactionMarkerState> = new Set<CompactionMarkerState>([
  'summarized',
  'fallback',
]);

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
  const prefix = record.projectionPrefix ?? [];
  const messages = toAgentMessages(record);
  if (messages.length === 0) return interleaveMarkers([...prefix], record.markers);
  const { agentMessagesToChatMessages } = await import('../../scoops/agent-message-to-chat.js');
  const derived = applyAttachmentOverlays(
    agentMessagesToChatMessages(messages, options),
    record.attachments
  );
  return interleaveMarkers([...prefix, ...derived], record.markers);
}

export function applyAttachmentOverlays(
  rows: ChatMessage[],
  overlays: readonly ConversationAttachmentOverlay[] | undefined
): ChatMessage[] {
  if (!overlays?.length) return rows;
  const pending = [...overlays].sort((a, b) => a.timestamp - b.timestamp);
  const used = new Set<number>();
  return rows.map((row) => {
    if (row.role !== 'user' || row.attachments?.length) return row;
    const body = row.content.trim();
    const at = pending.findIndex((o, i) => !used.has(i) && o.body.trim() === body);
    if (at < 0) return row;
    used.add(at);
    return { ...row, attachments: pending[at].attachments };
  });
}

export function interleaveMarkers(
  messages: ChatMessage[],
  markers: readonly ConversationMarker[] | undefined
): ChatMessage[] {
  const live = (markers ?? []).filter(
    (m) => m.kind !== 'compaction' || RESTORABLE_STATES.has(m.compaction.state)
  );
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

function messageTime(message: ChatMessage): number {
  const raw: unknown = message.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

function markerRow(marker: ConversationMarker): ChatMessage {
  if (marker.kind === 'error') {
    return {
      id: marker.id,
      role: 'assistant',
      content: marker.text,
      timestamp: marker.timestamp,
      error: true,
    };
  }
  return {
    id: marker.id,
    role: 'assistant',
    content: '',
    timestamp: marker.timestamp,
    compaction: marker.compaction,
  };
}

export function toTranscriptText(record: WorkUnitConversationRecord | null): string {
  if (!isReadableRecord(record) || record === null) return '';
  const lines: string[] = [];
  for (const message of record.projectionPrefix ?? []) {
    const text = typeof message.content === 'string' ? message.content.trim() : '';
    if (text.length > 0) lines.push(`${message.role}: ${text}`);
  }
  for (const entry of record.entries) {
    const label = transcriptLabel(entry);
    if (!label) continue;
    const text = 'text' in entry ? entry.text.trim() : '';
    if (text.length === 0) continue;
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n');
}

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

export function conversationLength(record: WorkUnitConversationRecord | null): number {
  if (!isReadableRecord(record) || record === null) return 0;
  const prefix = record.projectionPrefix?.length ?? 0;
  return prefix + record.entries.filter((e) => e.kind !== 'tool-call').length;
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
