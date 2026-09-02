/**
 * Frozen-session archive WRITER — the markdown renderer, the `/sessions`
 * index upsert/remove primitives, and the live-snapshot naming rules.
 *
 * Pulled down from `ui/session-freezer.ts` because two realms now write
 * archives: the page (a "New chat" freeze) and the kernel worker (a context
 * compaction snapshot, `scoops/live-session-snapshot.ts`). Both must produce
 * byte-compatible documents, so the renderer lives once, here, below the
 * `ui/` rung the worker bundle may not import. The freezer keeps everything
 * that is genuinely UI-driven — LLM enrichment, attachment persistence, the
 * pending/curation ledger — and calls in here for the format.
 *
 * `ArchiveVfs` is the structural subset both a page-side
 * `WritableVfsClient` and the worker-side `VirtualFS` satisfy.
 */

import { FsError } from '../fs/types.js';
import type { ChatMessage } from '../scoops/chat-types.js';
import { formatChatForClipboard } from './chat-markdown.js';
import {
  type FrozenSessionArchive,
  type FrozenSessionIndexEntry,
  SESSIONS_DIR,
  SESSIONS_INDEX_PATH,
} from './frozen-archive-format.js';

/** The filesystem surface an archive write needs; nothing more. */
export interface ArchiveVfs {
  readFile(path: string, options: { encoding: 'utf-8' }): Promise<string | Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  flush(): Promise<void>;
}

/** Markers for the embedded structured-data block. */
const SESSION_DATA_START = '<!-- slicc:session-data\n';
const SESSION_DATA_END = '\n-->';

/**
 * Filename prefix of a compaction snapshot of a running session. Like a
 * quick-freeze `pending-` draft, the name is provisional: the "New chat"
 * enrichment renames it to the canonical `<timestamp>-<slug>.md` form once
 * the session is over and a real title is known.
 */
export const LIVE_SNAPSHOT_PREFIX = 'live-';

/**
 * Whether a filename is provisional (a quick-freeze draft or a live
 * snapshot) and so safe to rename once the real title is known. Canonical
 * `<timestamp>-<slug>.md` names are final: the rail, deep links, and
 * snapshot lookups all key off them.
 */
export function isDraftArchiveFilename(filename: string): boolean {
  return filename.startsWith('pending-') || filename.startsWith(LIVE_SNAPSHOT_PREFIX);
}

/** Provisional filename for a cone's live snapshot. */
export function liveSnapshotFilename(coneFolder: string): string {
  return `${LIVE_SNAPSHOT_PREFIX}${slugify(coneFolder)}-${shortId()}.md`;
}

/** The (at most one) live snapshot a cone currently owns. */
export function findLiveSnapshotEntry(
  entries: readonly FrozenSessionIndexEntry[],
  coneFolder: string
): FrozenSessionIndexEntry | undefined {
  return entries.find((entry) => entry.live === true && (entry.cone ?? 'cone') === coneFolder);
}

/**
 * Short, unique-enough id used in provisional filenames. Pairs a base-36
 * timestamp with a few random characters so multiple writes within the
 * same millisecond still collide-free.
 */
export function shortId(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${time}-${rand}`;
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'session';
}

/** Title from the first user message, when no LLM title is available. */
export function heuristicTitle(messages: readonly ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser?.content) return 'untitled-session';
  const head = firstUser.content.trim().replace(/\s+/g, ' ');
  return head.length > 60 ? `${head.slice(0, 60)}…` : head || 'untitled-session';
}

/**
 * Strip ephemeral fields that should never survive into a frozen archive
 * (transient pointers held only for the live render). What's left is a
 * pure data shape suitable for JSON round-trip and re-render.
 */
export function stripEphemeral(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const out: ChatMessage = {
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    };
    if (m.attachments?.length) out.attachments = m.attachments;
    if (m.toolCalls?.length) {
      out.toolCalls = m.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
        ...(tc.result !== undefined ? { result: tc.result } : {}),
        ...(tc.isError ? { isError: tc.isError } : {}),
      }));
    }
    if (m.source) out.source = m.source;
    if (m.channel) out.channel = m.channel;
    return out;
  });
}

/**
 * Render the archive as markdown. The frontmatter carries scalar
 * metadata; an HTML-commented JSON block carries the full structured
 * message list (toolCalls, attachments, source, channel, timestamps)
 * so the read-only chat-panel view can render with the same fidelity
 * as a live scoop. The visible markdown body below is what the chat
 * panel's "copy chat history" long-press produces — that part stays
 * human-readable.
 */
export function formatArchiveAsMarkdown(archive: FrozenSessionArchive): string {
  const usageFrontmatter =
    (archive.cost ? `cost: ${JSON.stringify(archive.cost)}\n` : '') +
    (archive.models ? `models: ${JSON.stringify(archive.models)}\n` : '');
  // Cone provenance rides the archive too, so a rebuild from `/sessions/*.md`
  // (corrupt index) recovers it. The label is user text — quote it like the
  // title so newlines and quotes round-trip.
  const coneFrontmatter =
    (archive.cone ? `cone: ${archive.cone}\n` : '') +
    (archive.coneLabel ? `coneLabel: ${JSON.stringify(archive.coneLabel)}\n` : '') +
    // The memory opt-out has to survive an index rebuild too: `pendingEnrichment`
    // comes back from the `pending-` filename, so without this marker a rebuilt
    // entry would look like an ordinary pending freeze and the next catch-up
    // would extract memories from a chat archived with memory explicitly off.
    (archive.memorySkipped ? `memorySkipped: true\n` : '') +
    // Same reasoning for a live snapshot: a rebuild must not hand a running
    // session's transcript to the enrichment catch-up.
    (archive.live ? `live: true\n` : '');
  const header =
    `---\n` +
    `id: ${archive.id}\n` +
    `title: ${JSON.stringify(archive.title)}\n` +
    `frozenAt: ${archive.frozenAt}\n` +
    `createdAt: ${archive.createdAt}\n` +
    `updatedAt: ${archive.updatedAt}\n` +
    `messageCount: ${archive.messageCount}\n` +
    usageFrontmatter +
    coneFrontmatter +
    `---\n\n`;
  // Escape the only sequence that would prematurely close an HTML comment.
  const dataJson = JSON.stringify(stripEphemeral(archive.messages)).replace(/-->/g, '-- >');
  const dataBlock = `${SESSION_DATA_START}${dataJson}${SESSION_DATA_END}\n\n`;
  const title = `# ${archive.title}\n\n`;
  return header + dataBlock + title + formatChatForClipboard(archive.messages);
}

export async function ensureSessionsDir(vfs: ArchiveVfs): Promise<void> {
  try {
    await vfs.mkdir(SESSIONS_DIR, { recursive: true });
  } catch {
    // Already exists or unsupported — writeFile will surface the real error.
  }
}

/**
 * Read the index for a WRITER: a missing index is an empty list, a
 * malformed one too, but any other read fault propagates — silently
 * treating an EIO as "no entries" would rewrite the index without them.
 */
export async function readSessionsIndexForWrite(
  vfs: ArchiveVfs
): Promise<FrozenSessionIndexEntry[]> {
  try {
    const raw = await vfs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as FrozenSessionIndexEntry[]) : [];
  } catch (err) {
    if (err instanceof FsError && err.code !== 'ENOENT') throw err;
    return [];
  }
}

/**
 * Per-realm chain so index read-modify-writes from one realm run strictly
 * in arrival order. `.then(run, run)` keeps a failed write from poisoning
 * the chain for later callers; each caller still sees its own error.
 */
let indexWriteChain: Promise<void> = Promise.resolve();

export function serializeIndexWrite<T>(run: () => Promise<T>): Promise<T> {
  const next = indexWriteChain.then(run, run);
  indexWriteChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * Insert or replace one index row. The row moves to the head of the list
 * (newest first) and any other row with the same filename is dropped.
 */
export function upsertSessionsIndexEntry(
  vfs: ArchiveVfs,
  entry: FrozenSessionIndexEntry
): Promise<void> {
  return serializeIndexWrite(async () => {
    const existing = await readSessionsIndexForWrite(vfs);
    const updated = [entry, ...existing.filter((e) => e.filename !== entry.filename)];
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
  });
}

/**
 * Drop every index row matching `predicate`. Returns the removed rows so
 * the caller can delete their archives. A missing index removes nothing.
 */
export function removeSessionsIndexEntries(
  vfs: ArchiveVfs,
  predicate: (entry: FrozenSessionIndexEntry) => boolean
): Promise<FrozenSessionIndexEntry[]> {
  return serializeIndexWrite(async () => {
    const existing = await readSessionsIndexForWrite(vfs);
    const removed = existing.filter(predicate);
    if (removed.length === 0) return removed;
    const kept = existing.filter((entry) => !predicate(entry));
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(kept, null, 2));
    return removed;
  });
}

/**
 * Delete a cone's live snapshot — file and index row. The "erase" half of
 * "New chat": the user chose to keep nothing, so the compaction rounds'
 * transcript goes too. A snapshot that is already gone is not an error.
 */
export async function discardLiveSnapshot(vfs: ArchiveVfs, coneFolder: string): Promise<number> {
  const removed = await removeSessionsIndexEntries(
    vfs,
    (entry) => entry.live === true && (entry.cone ?? 'cone') === coneFolder
  );
  for (const entry of removed) {
    try {
      await vfs.rm(`${SESSIONS_DIR}/${entry.filename}`);
    } catch (err) {
      if (!(err instanceof FsError) || err.code !== 'ENOENT') throw err;
    }
  }
  if (removed.length > 0) await vfs.flush();
  return removed.length;
}
