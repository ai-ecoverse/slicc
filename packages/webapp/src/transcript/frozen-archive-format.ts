/**
 * Frozen-session archive format — pure schema, index reader, and markdown
 * parser. Lives at the transcript layer so lower-layer consumers (transcript
 * export, cost command) can read the index and parse archives without
 * back-edging into `ui/session-freezer.ts` and dragging its LLM /
 * icon / cone-memory / clipboard imports along with them.
 *
 * The writer (`writeFrozenArchive`, `formatArchiveAsMarkdown`) still lives
 * in `ui/session-freezer.ts` because writing an archive is part of the
 * UI-driven "New session" flow; only the read/parse surface is pulled
 * down here.
 */

import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { ChatMessage } from '../scoops/chat-types.js';

/** Where session archives and the index live. */
export const SESSIONS_DIR = '/sessions';
export const SESSIONS_INDEX_PATH = '/sessions/index.json';

export interface FrozenSessionCost {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface FrozenSessionModel {
  model: string;
  cost: number;
  turns: number;
  tokens: number;
}

export interface FrozenSessionIndexEntry {
  /** Filename within /sessions/, e.g. "2026-05-13T19-30-00Z-fix-build.json". */
  filename: string;
  /** Human-readable title from the LLM, or a heuristic fallback. */
  title: string;
  /** ISO timestamp when the freeze happened. */
  frozenAt: string;
  /** Count of messages in the frozen session. */
  messageCount: number;
  /** Aggregate cone cost at freeze time. Absent when usage metadata is unavailable. */
  cost?: FrozenSessionCost;
  /** Per-model cone usage at freeze time, sorted by cost descending. */
  models?: FrozenSessionModel[];
  /**
   * Stable opaque identifier for the frozen session. Generated with
   * `crypto.randomUUID()` before the quick filename is assigned and
   * retained through title and filename rewrites. Legacy entries without
   * this field continue to use `filename` as their lookup key.
   */
  sessionId?: string;
  /**
   * Lucide icon name for the freezer rail card (LLM-picked from the title,
   * best-effort). Absent on quick-frozen / legacy entries — the rail's lazy
   * enrichment backfills it; the card falls back to its snowflake.
   */
  icon?: string;
  /**
   * Quick-freeze marker. When true, the archive was written with a
   * heuristic title under a synthetic `pending-<short-id>.md` filename
   * and still needs the two LLM calls (memory extraction + title) to
   * finish. Boot-time enrichment picks these up and rewrites the title
   * + renames the file to the canonical `<timestamp>-<slug>.md` form.
   */
  pendingEnrichment?: boolean;
  /**
   * Agentic-memory marker. Set when the archive is written before its curator
   * pass starts, then removed only after that pass succeeds. A later boot
   * recovers surviving entries through the bounded legacy enrichment call — it
   * never re-runs the curator, which has no working timeout.
   */
  memoryPending?: true;
  /**
   * The user chose to freeze this chat WITHOUT any memory extraction — now
   * or later (a dropped cone, #2272). The title/icon catch-up still runs;
   * the memory half of the legacy enrichment is skipped for good.
   */
  memorySkipped?: true;
  /**
   * Number of boot-time catch-up attempts already started for either pending
   * marker. Persisted before the LLM call; entries at the retry cap are skipped.
   */
  pendingAttemptCount?: number;
  /**
   * Set to `true` when the `captureCompleteSnapshot` hook failed during
   * freeze. The Markdown archive is still present; only the full sanitized
   * transcript bundle was not produced.
   */
  completeSnapshotUnavailable?: true;
  /**
   * Storage folder of the root unit whose chat this archive froze
   * (`cone` for the primary, `cone-<slug>` for an extra cone — #2272).
   * Archives written before the field existed carry no value and are
   * treated as the primary cone's.
   */
  cone?: string;
  /**
   * Human label of that cone at freeze time (the rail chip's
   * `assistantLabel`). Only written for extra cones — the primary's
   * `sliccy` would be noise on every card. Cosmetic: the freezer falls
   * back to the folder when it is absent.
   */
  coneLabel?: string;
}

export interface FrozenSessionArchive {
  id: string;
  title: string;
  frozenAt: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  messages: ChatMessage[];
  cost?: FrozenSessionCost;
  models?: FrozenSessionModel[];
  /** Folder of the cone this archive froze — see {@link FrozenSessionIndexEntry.cone}. */
  cone?: string;
  /** Label of that cone — see {@link FrozenSessionIndexEntry.coneLabel}. */
  coneLabel?: string;
}

/**
 * Read the sessions index (or empty array if missing/malformed). Typed
 * as `LocalVfsClient` (read-only surface) so panel-side callers can pass
 * either a page-side `VirtualFS` or a worker-RPC-backed `RemoteVfsClient`
 * (under `slicc_opfs_vfs=opfs`).
 */
export async function readSessionsIndex(vfs: LocalVfsClient): Promise<FrozenSessionIndexEntry[]> {
  try {
    const raw = await vfs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as FrozenSessionIndexEntry[]) : [];
  } catch {
    return [];
  }
}

/** Path to the archive markdown for a given index entry. */
export function frozenSessionPath(entry: FrozenSessionIndexEntry): string {
  return `${SESSIONS_DIR}/${entry.filename}`;
}

/**
 * Parse a frozen-session markdown archive (produced by `formatArchiveAsMarkdown`)
 * back into the structured shape the chat-panel renders.
 *
 * Modern archives carry a `<!-- slicc:session-data ... -->` block right
 * after the frontmatter — that JSON contains the original `ChatMessage[]`
 * with `toolCalls`, `attachments`, `source`, `channel`, and timestamps
 * intact, so read-only display matches a live scoop. The visible
 * markdown body below the data block is preserved for human readers.
 *
 * Archives without the data block (older runs, or imports from elsewhere)
 * fall back to a heading-based text parser that recovers user/assistant
 * roles only — tool calls become flat text under the assistant message.
 */
export function parseFrozenArchive(
  markdown: string
): Pick<FrozenSessionArchive, 'title' | 'messages' | 'cost' | 'models' | 'cone' | 'coneLabel'> {
  let body = markdown;
  let title = 'Untitled';
  const meta: Pick<FrozenSessionArchive, 'cost' | 'models' | 'cone' | 'coneLabel'> = {};

  // 1. Strip YAML-style frontmatter and pull out the title.
  //    The writer emits `title: ${JSON.stringify(value)}`, which means
  //    quoted titles can contain `\"` and `\\` escapes (e.g. a title
  //    like `Debug "Auth" bug`). Parse the value as JSON when it starts
  //    with a quote so embedded escapes round-trip cleanly; fall back
  //    to a raw read for unquoted scalars.
  const fmMatch = body.match(/^---\n([\s\S]*?)\n---\n+/);
  if (fmMatch) {
    body = body.slice(fmMatch[0].length);
    const cost = parseFrontmatterJson<FrozenSessionCost>(fmMatch[1], 'cost');
    const models = parseFrontmatterJson<FrozenSessionModel[]>(fmMatch[1], 'models');
    if (cost) meta.cost = cost;
    if (models) meta.models = models;
    // Provenance of the frozen chat (#2272). `cone` is a folder slug written
    // raw; `coneLabel` is user text written JSON-quoted like `title`.
    const cone = fmMatch[1].match(/^cone:\s*(.+?)\s*$/m)?.[1];
    if (cone) meta.cone = cone;
    const coneLabel = fmMatch[1].match(/^coneLabel:\s*(.+?)\s*$/m)?.[1];
    if (coneLabel) meta.coneLabel = decodeFrontmatterString(coneLabel);
    const titleLine = fmMatch[1].match(/^title:\s*(.+?)\s*$/m);
    if (titleLine) title = decodeFrontmatterString(titleLine[1]);
  }

  // 2. Prefer the embedded structured-data block when present —
  //    round-trip-rich rendering for tool calls, attachments, etc.
  const dataMatch = body.match(/<!-- slicc:session-data\n([\s\S]*?)\n-->\n*/);
  if (dataMatch) {
    try {
      const restored = dataMatch[1].replace(/-- >/g, '-->');
      const parsed = JSON.parse(restored);
      if (Array.isArray(parsed)) {
        return { title, messages: parsed as ChatMessage[], ...meta };
      }
    } catch {
      // Malformed block — fall through to text parser.
    }
    // Strip the block before the text parser sees it.
    body = body.replace(/<!-- slicc:session-data\n[\s\S]*?\n-->\n*/, '');
  }

  // 3. Drop the leading `# title` heading if present.
  body = body.replace(/^#\s+[^\n]*\n+/, '');

  return { title, messages: parseHeadingFallback(body), ...meta };
}

/**
 * Decode a frontmatter scalar the writer produced with `JSON.stringify`.
 * `JSON.parse` handles `\"`, `\\`, `\n`, `\uXXXX` — the same escapes
 * `JSON.stringify` emitted on the way in. Unquoted scalars (legacy
 * archives) are returned verbatim.
 */
function decodeFrontmatterString(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith('"')) return value;
  try {
    const decoded = JSON.parse(value);
    if (typeof decoded === 'string') return decoded;
  } catch {
    // Malformed quoted value — strip surrounding quotes as a last resort.
  }
  return value.replace(/^"|"$/g, '');
}

function parseFrontmatterJson<T>(frontmatter: string, key: string): T | undefined {
  const value = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(frontmatter)?.[1];
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Heading-based fallback parser. Splits on `## User` / `## Assistant`
 * boundaries; nested `### Tool:` blocks land in the prior message's
 * content verbatim.
 */
function parseHeadingFallback(body: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const headingRe = /^## (User|Assistant)\s*\n/gm;
  const heads: { role: 'user' | 'assistant'; start: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    heads.push({
      role: m[1] === 'User' ? 'user' : 'assistant',
      start: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].start : body.length;
    const content = body.slice(heads[i].bodyStart, end).trim();
    messages.push({
      id: `frozen-${i}`,
      role: heads[i].role,
      content,
      timestamp: 0,
    });
  }
  return messages;
}
