/**
 * Live session snapshot — the transcript a compaction round writes to
 * `/sessions` BEFORE it replaces older messages with a summary.
 *
 * A "New chat" freeze used to be the only time a cone's conversation reached
 * `/sessions`; everything a mid-session compaction summarized away was gone
 * for good. Now every round (threshold, overflow recovery, idle) appends to
 * one per-cone archive marked `live: true`, and the summary message carries
 * its path so the agent can read what the summary dropped.
 *
 * The archive ACCUMULATES: the agent's history after a round is
 * `[summary, ...kept tail]`, so the next round would re-present the tail.
 * `liveThrough` (the newest message timestamp already written) is the
 * cursor — only messages newer than it are appended (a same-millisecond
 * message is appended unless the archive already holds it), and the previous
 * round's summary (stamped after the snapshot) lands in the transcript as a
 * visible checkpoint.
 *
 * Every write here is ONE index transaction (`serializeIndexWrite`, a Web
 * Lock shared with the page-side freezer): the row is read, the archive is
 * read and rewritten, and the row is written back without another realm's
 * "New chat" interleaving. The caller's `stillValid` guard is consulted
 * inside that transaction, so a snapshot whose session was cleared while it
 * waited for the lock writes nothing instead of resurrecting the chat.
 *
 * Same document format as the freezer, via `transcript/frozen-archive-writer`
 * — the rail shows the snapshot like any archive, and "New chat" either
 * finishes it (save / skip reuse the entry) or deletes it (erase).
 *
 * Roots only: a scoop has no `/sessions` of its own to write.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createLogger } from '../base/logger.js';
import type { CompactionTrigger } from '../core/context-compaction.js';
import { FsError } from '../fs/types.js';
import {
  type FrozenSessionArchive,
  type FrozenSessionIndexEntry,
  parseFrozenArchive,
  SESSIONS_DIR,
} from '../transcript/frozen-archive-format.js';
import {
  type ArchiveVfs,
  ensureSessionsDir,
  findLiveSnapshotEntry,
  formatArchiveAsMarkdown,
  heuristicTitle,
  liveSnapshotFilename,
  readSessionsIndexForWrite,
  serializeIndexWrite,
  upsertSessionsIndexEntryUnlocked,
  writeSessionsIndexUnlocked,
} from '../transcript/frozen-archive-writer.js';
import { PRIMARY_CONE_FOLDER } from '../work-unit/record.js';
import { agentMessagesToChatMessages } from './agent-message-to-chat.js';
import type { ChatMessage } from './chat-types.js';

const log = createLogger('live-session-snapshot');

export interface SnapshotLiveSessionDeps {
  vfs: ArchiveVfs;
  /** Cone the conversation belongs to; `label` is recorded for extra cones only. */
  cone: { folder: string; label?: string };
  /** The agent's history as the model last saw it — pre-elision, pre-summary. */
  messages: readonly AgentMessage[];
  trigger: CompactionTrigger;
  /**
   * Consulted INSIDE the index transaction, right before anything is
   * written. `false` means the session this history belongs to is gone
   * (cleared or disposed while the snapshot waited): nothing is written and
   * the round gets no pointer.
   */
  stillValid?: () => boolean;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface LiveSessionSnapshotResult {
  /** VFS path of the archive, for the summary message's pointer. */
  transcriptPath: string;
  entry: FrozenSessionIndexEntry;
  /** Messages appended this round (0 when every message was already on disk). */
  appended: number;
}

/**
 * Write (or extend) the cone's live snapshot with everything in `messages`
 * that is not on disk yet. Returns `null` when `stillValid` said no. Throws
 * on a VFS fault — the compaction core catches and continues without a
 * pointer.
 */
export function snapshotLiveSession(
  deps: SnapshotLiveSessionDeps
): Promise<LiveSessionSnapshotResult | null> {
  const folder = deps.cone.folder || PRIMARY_CONE_FOLDER;
  // The projection is pure and can be expensive on a long history: do it
  // before taking the lock so the transaction itself stays short.
  const chat = agentMessagesToChatMessages(deps.messages, {
    source: deps.cone.label ?? folder,
  });
  return serializeIndexWrite(async () => {
    if (deps.stillValid && !deps.stillValid()) {
      log.info('Live session snapshot skipped: session gone before the write', {
        cone: folder,
        trigger: deps.trigger,
      });
      return null;
    }
    return writeSnapshot(deps, folder, chat);
  });
}

/** The transaction body: read the row and the archive, merge, write both. Lock held. */
async function writeSnapshot(
  deps: SnapshotLiveSessionDeps,
  folder: string,
  chat: ChatMessage[]
): Promise<LiveSessionSnapshotResult> {
  const now = deps.now ?? Date.now;
  const entries = await readSessionsIndexForWrite(deps.vfs);
  const existing = findLiveSnapshotEntry(entries, folder);
  const prior = existing ? await readSnapshotMessages(deps.vfs, existing) : null;
  // A live row whose archive vanished starts over from the full history:
  // its cursor would otherwise skip everything the lost file held.
  const cursor = prior === null ? 0 : (existing?.liveThrough ?? newestTimestamp(prior));
  const fresh = selectFresh(chat, prior ?? [], cursor);
  const merged = [...(prior ?? []), ...fresh];
  const liveThrough = Math.max(cursor, newestTimestamp(chat));

  const filename = existing?.filename ?? liveSnapshotFilename(folder);
  const frozenAt = existing?.frozenAt ?? new Date(now()).toISOString();
  const title = existing?.title ?? heuristicTitle(merged);
  const compactions = (existing?.compactions ?? 0) + 1;
  const provenance = {
    cone: folder,
    ...(folder !== PRIMARY_CONE_FOLDER && deps.cone.label ? { coneLabel: deps.cone.label } : {}),
  };
  const archive: FrozenSessionArchive = {
    id: existing?.sessionId ?? crypto.randomUUID(),
    title,
    frozenAt,
    createdAt: merged[0]?.timestamp || now(),
    updatedAt: now(),
    messageCount: merged.length,
    messages: merged,
    ...provenance,
    live: true,
    liveThrough,
    compactions,
  };
  const entry: FrozenSessionIndexEntry = {
    filename,
    sessionId: archive.id,
    title,
    frozenAt,
    messageCount: merged.length,
    ...provenance,
    ...(existing?.icon ? { icon: existing.icon } : {}),
    live: true,
    liveThrough,
    compactions,
  };

  await ensureSessionsDir(deps.vfs);
  await deps.vfs.writeFile(`${SESSIONS_DIR}/${filename}`, formatArchiveAsMarkdown(archive));
  await upsertSessionsIndexEntryUnlocked(deps.vfs, entry);
  await deps.vfs.flush();
  log.info('Live session snapshot written', {
    cone: folder,
    filename,
    trigger: deps.trigger,
    appended: fresh.length,
    total: merged.length,
    compactions,
  });
  return { transcriptPath: `${SESSIONS_DIR}/${filename}`, entry, appended: fresh.length };
}

/**
 * Turn a cone's live snapshot into an ordinary pending archive: the
 * session ended WITHOUT going through the freezer (a bare `clear-chat`), so
 * the transcript is complete as written and the boot catch-up may enrich
 * its title like any quick-freeze draft. Nothing to do when there is none.
 */
export function finalizeLiveSnapshot(vfs: ArchiveVfs, coneFolder: string): Promise<boolean> {
  const folder = coneFolder || PRIMARY_CONE_FOLDER;
  return serializeIndexWrite(async () => {
    const entries = await readSessionsIndexForWrite(vfs);
    const live = findLiveSnapshotEntry(entries, folder);
    if (!live) return false;
    const { live: _live, liveThrough: _through, ...rest } = live;
    const finalized: FrozenSessionIndexEntry = { ...rest, pendingEnrichment: true };
    await writeSessionsIndexUnlocked(
      vfs,
      entries.map((entry) => (entry === live ? finalized : entry))
    );
    await stripLiveFrontmatter(vfs, `${SESSIONS_DIR}/${live.filename}`);
    await vfs.flush();
    log.info('Live session snapshot finalized', { cone: folder, filename: live.filename });
    return true;
  });
}

/**
 * Delete a cone's live snapshot — file and row — inside one transaction.
 * The "erase" half of "New chat", run in the kernel so it is ordered with
 * the snapshot writer instead of racing it from the page.
 */
export function discardLiveSnapshot(vfs: ArchiveVfs, coneFolder: string): Promise<number> {
  const folder = coneFolder || PRIMARY_CONE_FOLDER;
  return serializeIndexWrite(async () => {
    const entries = await readSessionsIndexForWrite(vfs);
    const removed = entries.filter(
      (entry) => entry.live === true && (entry.cone ?? PRIMARY_CONE_FOLDER) === folder
    );
    if (removed.length === 0) return 0;
    await writeSessionsIndexUnlocked(
      vfs,
      entries.filter((entry) => !removed.includes(entry))
    );
    for (const entry of removed) {
      try {
        await vfs.rm(`${SESSIONS_DIR}/${entry.filename}`);
      } catch (err) {
        if (!(err instanceof FsError) || err.code !== 'ENOENT') throw err;
      }
    }
    await vfs.flush();
    log.info('Live session snapshot discarded', { cone: folder, removed: removed.length });
    return removed.length;
  });
}

/**
 * The messages not on disk yet. Everything newer than the cursor is new. A
 * message stamped EXACTLY at the cursor is ambiguous — a summary and a
 * queued prompt can share a millisecond — so it is new unless the archive
 * already holds a message with the same role, text and stamp.
 */
function selectFresh(chat: ChatMessage[], prior: ChatMessage[], cursor: number): ChatMessage[] {
  if (prior.length === 0) return chat;
  const atCursor = prior.filter((message) => message.timestamp === cursor);
  return chat.filter((message) => {
    if (message.timestamp > cursor) return true;
    if (message.timestamp < cursor) return false;
    return !atCursor.some(
      (written) => written.role === message.role && written.content === message.content
    );
  });
}

function newestTimestamp(messages: readonly ChatMessage[]): number {
  let newest = 0;
  for (const message of messages) if (message.timestamp > newest) newest = message.timestamp;
  return newest;
}

/** The archived messages, or `null` when the archive is missing or unreadable. */
async function readSnapshotMessages(
  vfs: ArchiveVfs,
  entry: FrozenSessionIndexEntry
): Promise<ChatMessage[] | null> {
  try {
    const raw = await vfs.readFile(`${SESSIONS_DIR}/${entry.filename}`, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return parseFrozenArchive(text).messages;
  } catch (err) {
    // The row survived without its file: rewrite the archive from the whole
    // history the agent still holds rather than continue from a cursor that
    // now points past messages nobody has.
    log.warn('Live snapshot archive unreadable; rewriting from the agent history', {
      filename: entry.filename,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Drop the live frontmatter lines so an index rebuild sees a finished archive. */
async function stripLiveFrontmatter(vfs: ArchiveVfs, path: string): Promise<void> {
  try {
    const raw = await vfs.readFile(path, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fmMatch) return;
    const stripped = fmMatch[1].replace(/^(live: true|liveThrough: \d+)\n?/gm, '');
    if (stripped === fmMatch[1]) return;
    await vfs.writeFile(path, `---\n${stripped}\n---\n${text.slice(fmMatch[0].length)}`);
  } catch (err) {
    if (err instanceof FsError && err.code === 'ENOENT') return;
    throw err;
  }
}
