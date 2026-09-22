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
  isProvisionalSessionTitle,
  liveSnapshotFilename,
  readSessionsIndexForWrite,
  serializeIndexWrite,
  sessionsIndexLockFor,
  upsertSessionsIndexEntryUnlocked,
  writeSessionsIndexUnlocked,
} from '../transcript/frozen-archive-writer.js';
import { PRIMARY_CONE_FOLDER } from '../work-unit/record.js';
import { agentMessagesToChatMessages } from './agent-message-to-chat.js';
import type { ChatMessage } from './chat-types.js';

const log = createLogger('live-session-snapshot');

export function scoopSessionsDir(folder: string, jid: string): string {
  return `/scoops/${folder}/sessions/${jid}`;
}

export interface SnapshotLiveSessionDeps {
  vfs: ArchiveVfs;

  cone: { folder: string; label?: string };

  messages: readonly AgentMessage[];
  trigger: CompactionTrigger;

  sessionsDir?: string;

  stillValid?: () => boolean;

  now?: () => number;
}

export interface LiveSessionSnapshotResult {
  transcriptPath: string;
  entry: FrozenSessionIndexEntry;

  appended: number;
}

export function snapshotLiveSession(
  deps: SnapshotLiveSessionDeps
): Promise<LiveSessionSnapshotResult | null> {
  const folder = deps.cone.folder || PRIMARY_CONE_FOLDER;
  const sessionsDir = deps.sessionsDir ?? SESSIONS_DIR;

  const chat = agentMessagesToChatMessages(deps.messages, {
    source: deps.cone.label ?? folder,
    uncapped: true,
  });
  return serializeIndexWrite(async () => {
    if (deps.stillValid && !deps.stillValid()) {
      log.info('Live session snapshot skipped: session gone before the write', {
        cone: folder,
        sessionsDir,
        trigger: deps.trigger,
      });
      return null;
    }
    return writeSnapshot(deps, folder, sessionsDir, chat);
  }, sessionsIndexLockFor(sessionsDir));
}

async function writeSnapshot(
  deps: SnapshotLiveSessionDeps,
  folder: string,
  sessionsDir: string,
  chat: ChatMessage[]
): Promise<LiveSessionSnapshotResult> {
  const now = deps.now ?? Date.now;
  const entries = await readSessionsIndexForWrite(deps.vfs, sessionsDir);
  const existing = findLiveSnapshotEntry(entries, folder);
  const prior = existing ? await readSnapshotMessages(deps.vfs, sessionsDir, existing) : null;

  const cursor = prior === null ? 0 : (existing?.liveThrough ?? newestTimestamp(prior));
  const fresh = selectFresh(chat, prior ?? [], cursor);
  const merged = [...(prior ?? []), ...fresh];
  const liveThrough = Math.max(cursor, newestTimestamp(chat));

  const filename = existing?.filename ?? liveSnapshotFilename(folder);
  const frozenAt = existing?.frozenAt ?? new Date(now()).toISOString();

  const derivedTitle = heuristicTitle(merged);
  const title =
    existing?.title && !isProvisionalSessionTitle(existing.title) ? existing.title : derivedTitle;
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

  await ensureSessionsDir(deps.vfs, sessionsDir);
  const transcriptPath = `${sessionsDir}/${filename}`;

  await deps.vfs.writeFile(transcriptPath, formatArchiveAsMarkdown(archive));
  await upsertSessionsIndexEntryUnlocked(deps.vfs, entry, sessionsDir);
  await deps.vfs.flush();
  log.info('Live session snapshot written', {
    cone: folder,
    sessionsDir,
    filename,
    trigger: deps.trigger,
    appended: fresh.length,
    total: merged.length,
    compactions,
  });
  return { transcriptPath, entry, appended: fresh.length };
}

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

      const { removeSessionJsonl } = await import('../transcript/session-jsonl.js');
      await removeSessionJsonl(vfs, entry.filename);
    }

    const { invalidateSessionSearchIndex } = await import('../transcript/session-search-index.js');
    await invalidateSessionSearchIndex(vfs);
    await vfs.flush();
    log.info('Live session snapshot discarded', { cone: folder, removed: removed.length });
    return removed.length;
  });
}

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

async function readSnapshotMessages(
  vfs: ArchiveVfs,
  sessionsDir: string,
  entry: FrozenSessionIndexEntry
): Promise<ChatMessage[] | null> {
  try {
    const raw = await vfs.readFile(`${sessionsDir}/${entry.filename}`, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return parseFrozenArchive(text).messages;
  } catch (err) {
    if (!(err instanceof FsError) || err.code !== 'ENOENT') throw err;

    log.warn('Live snapshot archive missing; rewriting from the agent history', {
      sessionsDir,
      filename: entry.filename,
    });
    return null;
  }
}

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
