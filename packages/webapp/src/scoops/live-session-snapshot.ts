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
 * cursor — only messages newer than it are appended, and the previous
 * round's summary (stamped after the snapshot) lands in the transcript as a
 * visible checkpoint.
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
  upsertSessionsIndexEntry,
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
 * that is not on disk yet. Throws on a VFS fault — the compaction core
 * catches and continues without a pointer.
 */
export async function snapshotLiveSession(
  deps: SnapshotLiveSessionDeps
): Promise<LiveSessionSnapshotResult> {
  const now = deps.now ?? Date.now;
  const folder = deps.cone.folder || PRIMARY_CONE_FOLDER;
  const chat = agentMessagesToChatMessages(deps.messages, {
    source: deps.cone.label ?? folder,
  });
  const entries = await readSessionsIndexForWrite(deps.vfs);
  const existing = findLiveSnapshotEntry(entries, folder);
  const prior = existing ? await readSnapshotMessages(deps.vfs, existing) : [];
  const cursor = existing?.liveThrough ?? 0;
  const fresh = existing ? chat.filter((message) => message.timestamp > cursor) : chat;
  const merged = [...prior, ...fresh];
  const liveThrough = Math.max(cursor, ...chat.map((message) => message.timestamp));

  const filename = existing?.filename ?? liveSnapshotFilename(folder);
  const frozenAt = existing?.frozenAt ?? new Date(now()).toISOString();
  const title = existing?.title ?? heuristicTitle(merged);
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
    compactions: (existing?.compactions ?? 0) + 1,
  };

  await ensureSessionsDir(deps.vfs);
  await deps.vfs.writeFile(`${SESSIONS_DIR}/${filename}`, formatArchiveAsMarkdown(archive));
  await upsertSessionsIndexEntry(deps.vfs, entry);
  await deps.vfs.flush();
  log.info('Live session snapshot written', {
    cone: folder,
    filename,
    trigger: deps.trigger,
    appended: fresh.length,
    total: merged.length,
    compactions: entry.compactions,
  });
  return { transcriptPath: `${SESSIONS_DIR}/${filename}`, entry, appended: fresh.length };
}

/**
 * Turn a cone's live snapshot into an ordinary pending archive: the
 * session ended WITHOUT going through the freezer (a bare `clear-chat`), so
 * the transcript is complete as written and the boot catch-up may enrich
 * its title like any quick-freeze draft. Nothing to do when there is none.
 */
export async function finalizeLiveSnapshot(vfs: ArchiveVfs, coneFolder: string): Promise<boolean> {
  const folder = coneFolder || PRIMARY_CONE_FOLDER;
  return serializeIndexWrite(async () => {
    const entries = await readSessionsIndexForWrite(vfs);
    const live = findLiveSnapshotEntry(entries, folder);
    if (!live) return false;
    const { live: _live, liveThrough: _through, ...rest } = live;
    const finalized: FrozenSessionIndexEntry = { ...rest, pendingEnrichment: true };
    const updated = entries.map((entry) => (entry === live ? finalized : entry));
    await vfs.writeFile(`${SESSIONS_DIR}/index.json`, JSON.stringify(updated, null, 2));
    await stripLiveFrontmatter(vfs, `${SESSIONS_DIR}/${live.filename}`);
    await vfs.flush();
    log.info('Live session snapshot finalized', { cone: folder, filename: live.filename });
    return true;
  });
}

async function readSnapshotMessages(
  vfs: ArchiveVfs,
  entry: FrozenSessionIndexEntry
): Promise<ChatMessage[]> {
  try {
    const raw = await vfs.readFile(`${SESSIONS_DIR}/${entry.filename}`, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return parseFrozenArchive(text).messages;
  } catch (err) {
    // A missing or unreadable archive restarts the snapshot from what the
    // agent still holds — losing the earlier rounds is better than losing
    // the pointer for this one.
    log.warn('Live snapshot archive unreadable; starting over', {
      filename: entry.filename,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Drop the `live: true` frontmatter line so an index rebuild sees a finished archive. */
async function stripLiveFrontmatter(vfs: ArchiveVfs, path: string): Promise<void> {
  try {
    const raw = await vfs.readFile(path, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fmMatch) return;
    const stripped = fmMatch[1].replace(/^live: true\n?/m, '');
    if (stripped === fmMatch[1]) return;
    await vfs.writeFile(path, `---\n${stripped}\n---\n${text.slice(fmMatch[0].length)}`);
  } catch (err) {
    if (err instanceof FsError && err.code === 'ENOENT') return;
    throw err;
  }
}
