/**
 * The canonical conversation record of one work unit (#2275).
 *
 * Today a single conversation is spread over three durable stores with
 * repair logic between them:
 *
 * | Store                  | Key                | Holds                          |
 * | ---------------------- | ------------------ | ------------------------------ |
 * | `agent-sessions`       | `<jid>`            | Pi's `AgentMessage[]`          |
 * | `browser-coding-agent` | `session-<folder>` | the chat panel's projection    |
 * | `slicc-groups`         | `chatJid`          | routed messages / licks        |
 *
 * None of them is authoritative, so every reader repairs against the
 * others — that is where the "only the last few messages after a reboot"
 * truncation came from.
 *
 * A {@link WorkUnitConversationRecord} is the one durable representation of
 * settled conversation state for a unit. Pi history, the UI projection, tray
 * snapshots, frozen archives and child-completion summaries are all
 * DERIVATIONS of it (`derive.ts`), never parallel writes.
 *
 * The record is append-only in the ordinary case: a turn adds entries with
 * ascending `seq` and never edits an existing one. Exactly one transition
 * rewrites it — compaction (and `clear-chat`) replaces the agent's history
 * wholesale, which `store.ts` detects as a prefix divergence and records as a
 * rewrite rather than silently interleaving two conversations.
 */

import type { LickChannel } from '../../base/lick-channels.js';
import type { AgentMessage } from '../../core/index.js';
import type { ChatMessage } from '../../scoops/chat-types.js';

/**
 * Schema version of a persisted record. Bumping it makes every older record
 * eligible for re-migration (`migration.ts`); readers of an unknown FUTURE
 * version fall back to the legacy stores rather than guessing.
 */
export const CONVERSATION_RECORD_VERSION = 1;

/**
 * The six shapes a settled conversation is made of. `tool-call` is the one
 * kind with no message of its own: Pi keeps tool calls INSIDE the assistant
 * message that issued them, so a tool-call entry is an addressable handle on
 * a block of its `assistantEntryId`, not a message the Pi derivation emits.
 */
export type ConversationEntryKind =
  | 'user'
  | 'assistant'
  | 'tool-call'
  | 'tool-result'
  | 'external-event'
  | 'child-result';

interface ConversationEntryBase {
  /** Stable within a record: `e<seq>`. */
  id: string;
  /** Append ordinal. Dense, ascending, gap-free. */
  seq: number;
  kind: ConversationEntryKind;
  /** Epoch ms, or 0 when the source message carried no timestamp. */
  timestamp: number;
}

/**
 * An entry that stands for one message. `message` is the verbatim Pi
 * message and is what makes the Pi derivation LOSSLESS — it is absent only
 * on a record migrated from the UI projection, which cannot reconstruct Pi
 * messages (see {@link ConversationOrigin}). `chat` is the verbatim chat
 * message for exactly that case, and absent otherwise.
 */
interface MessageEntryBase extends ConversationEntryBase {
  message?: AgentMessage;
  chat?: ChatMessage;
  /** Plain text of the message, always present — transcripts read this. */
  text: string;
}

/** Something the user typed. */
export interface UserConversationEntry extends MessageEntryBase {
  kind: 'user';
}

/** A lick: webhook, cron, fswatch, sprinkle, upgrade, session-reload. */
export interface ExternalEventConversationEntry extends MessageEntryBase {
  kind: 'external-event';
  channel: LickChannel;
}

/** A child unit reporting back — `scoop-notify`, `scoop-wait`, `scoop-idle`. */
export interface ChildResultConversationEntry extends MessageEntryBase {
  kind: 'child-result';
  channel: LickChannel;
}

/** One assistant message; its tool calls follow as `tool-call` entries. */
export interface AssistantConversationEntry extends MessageEntryBase {
  kind: 'assistant';
  model?: string;
}

/**
 * A tool call issued by {@link AssistantConversationEntry} `assistantEntryId`.
 * Carries no arguments: they live in the owning assistant message, and
 * duplicating a `write_file` payload here would double the record's size.
 */
export interface ToolCallConversationEntry extends ConversationEntryBase {
  kind: 'tool-call';
  toolCallId: string;
  name: string;
  assistantEntryId: string;
}

/** The result of a tool call, paired by `toolCallId`. */
export interface ToolResultConversationEntry extends MessageEntryBase {
  kind: 'tool-result';
  toolCallId: string;
  isError?: boolean;
}

export type ConversationEntry =
  | UserConversationEntry
  | ExternalEventConversationEntry
  | ChildResultConversationEntry
  | AssistantConversationEntry
  | ToolCallConversationEntry
  | ToolResultConversationEntry;

/**
 * Where a record's entries came from, which decides which derivation is
 * faithful:
 *
 * - `agent-history` — built from Pi's `AgentMessage[]`. Both the Pi and the
 *   UI derivation are exact.
 * - `ui-projection` — built from a `browser-coding-agent` chat session for a
 *   unit that had no Pi history left (an old profile, or one whose agent
 *   session was lost). The UI derivation is exact; the Pi derivation returns
 *   nothing, because inventing Pi messages from rendered chat would feed a
 *   fabricated history to the model.
 */
export type ConversationOrigin = 'agent-history' | 'ui-projection';

/** The legacy keys a record supersedes — kept so a rollback can find them. */
export interface LegacyConversationKeys {
  /** `agent-sessions` key: the unit's jid. */
  agentSessionId: string;
  /** `browser-coding-agent` key: `session-<folder>`. */
  chatSessionId: string;
}

/** One canonical conversation, keyed by work unit + workspace. */
export interface WorkUnitConversationRecord {
  /** `<workspaceId>::<workUnitId>` — see `key.ts`. */
  key: string;
  version: number;
  /** The unit's jid. */
  workUnitId: string;
  /** The unit's filesystem view — its workspace root. */
  workspaceId: string;
  /** Storage folder, for correlation with the legacy keys and with logs. */
  folder: string;
  origin: ConversationOrigin;
  entries: ConversationEntry[];
  createdAt: number;
  updatedAt: number;
  /** Which legacy store the record was first built from, if migrated. */
  migratedFrom?: 'agent-sessions' | 'browser-coding-agent';
  /**
   * How many times the history diverged from the stored prefix (compaction,
   * `clear-chat`). Diagnostics only — a steadily climbing count on a unit
   * that never compacts means two writers are fighting over one record.
   */
  rewrites?: number;
  legacyKeys: LegacyConversationKeys;
}

/** `true` when this reader understands the record's schema version. */
export function isReadableRecord(record: WorkUnitConversationRecord | null): boolean {
  return record !== null && record.version <= CONVERSATION_RECORD_VERSION;
}
