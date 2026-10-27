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
 *
 * Every whole-index writer, in either realm, takes its baseline from
 * {@link readSessionsIndexForWrite}. A present-but-unparsable index is
 * rebuilt from the `/sessions/*.md` archives there, so no writer can replace
 * it with a one-row list and orphan the rest (#4151).
 */

import { slugify as slugifyText } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { ChatMessage } from '../scoops/chat-types.js';
import {
  newAtRestState,
  redactArchiveText,
  redactChatMessagesAtRest,
} from './archive-redaction.js';
import { formatChatForClipboard } from './chat-markdown.js';
import {
  type FrozenSessionArchive,
  type FrozenSessionIndexEntry,
  parseFrozenArchive,
  SESSIONS_DIR,
  SESSIONS_INDEX_PATH,
} from './frozen-archive-format.js';

const log = createLogger('frozen-archive-writer');

/** The filesystem surface an archive write needs; nothing more. */
export interface ArchiveVfs {
  readFile(path: string, options: { encoding: 'utf-8' }): Promise<string | Uint8Array>;
  /** Lists the archives when a corrupt index has to be rebuilt. */
  readDir(path: string): Promise<Array<{ name: string; type: string }>>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  flush(): Promise<void>;
}

/** What reading the index needs, including the archive rebuild. */
export type SessionsIndexReadVfs = Pick<ArchiveVfs, 'readFile' | 'readDir'>;

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
  return slugifyText(text, { maxLen: 48, fallback: 'session' });
}

/** Neutral title when the transcript has no genuine user prompt yet. */
const UNTITLED_SESSION_TITLE = 'untitled-session';

/**
 * Bracket labels `formatLickEventForCone` writes (`LICK_LABELS`), plus the
 * lowercase "Preview event" chip. A title taken from one of these is the
 * lick, not the conversation.
 */
const LICK_HEADER_LABELS = [
  'Webhook Event',
  'Sprinkle Event',
  'File Watch Event',
  'Session Reload',
  'Navigate Event',
  'Upgrade Event',
  'Cherry Event',
  'Workflow Event',
  'Background Command',
  'jshd Unit',
  'Cron Event',
  'Scoop Access Request',
  'Preview Event',
  'Preview event',
  'Discovery Event',
];

/**
 * Opening of a lick body or a compaction summary. The forwarded prefix is
 * what a generic lick prepends. Only the head is tested — titles are 60
 * characters, and a long JSON body must not be scanned.
 */
const INJECTED_TURN_RE = new RegExp(
  '^(?:_Forwarded from .+?\\._\\s*)*(?:' +
    '\\[@\\S+ (?:completed|idle|sudo-request|FAILED)\\b|' +
    '\\[scoop_wait\\b|' +
    `\\[(?:${LICK_HEADER_LABELS.join('|')})\\b|` +
    'Preview tab (?:connected|disconnected) from |' +
    '<context-summary\\b)'
);

function collapsedHead(text: string): string {
  // Headers sit at the start. Skip the rest so a large lick JSON body is
  // not whitespace-collapsed just to decide it is not a title.
  return text.slice(0, 480).trim().replace(/\s+/g, ' ').slice(0, 240);
}

/** True when `text` opens like a lick body or a compaction `<context-summary>`. */
function isInjectedSessionText(text: string): boolean {
  const head = collapsedHead(text);
  return head.length > 0 && INJECTED_TURN_RE.test(head);
}

/**
 * A stored live title that should be replaced on a later snapshot: the
 * placeholder, or a head taken from a lick (including rows written before
 * those turns were skipped).
 */
export function isProvisionalSessionTitle(title: string): boolean {
  return title === UNTITLED_SESSION_TITLE || isInjectedSessionText(title);
}

function isGenuineUserTurn(message: ChatMessage): boolean {
  if (message.role !== 'user' || !message.content?.trim()) return false;
  if (message.source === 'lick' || message.channel) return false;
  return !isInjectedSessionText(message.content);
}

/**
 * Title from the first genuine user message, when no LLM title is available.
 * Lick headers (`[@… sudo-request]`, `[Cron Event: …]`, `[Sprinkle Event: …]`)
 * and compaction summaries are skipped; with none left, the neutral label.
 */
export function heuristicTitle(messages: readonly ChatMessage[]): string {
  const firstUser = messages.find(isGenuineUserTurn);
  if (!firstUser?.content) return UNTITLED_SESSION_TITLE;
  const head = firstUser.content.trim().replace(/\s+/g, ' ');
  return head.length > 60 ? `${head.slice(0, 60)}…` : head || UNTITLED_SESSION_TITLE;
}

/**
 * Strip ephemeral fields that should never survive into a frozen archive
 * (transient pointers held only for the live render). What's left is a
 * pure data shape suitable for JSON round-trip and re-render.
 *
 * Compaction seams are kept: they are durable annotations (`transcriptPath`
 * points at the pre-compaction archive), not render-only state. Enrichment
 * rewrites those paths when it renames a provisional `live-`/`pending-`
 * file ({@link rewriteTranscriptPointers}).
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
    if (m.compaction) out.compaction = m.compaction;
    return out;
  });
}

/**
 * Rewrite every occurrence of a provisional archive path to its canonical
 * post-enrichment path. Covers the summary pointer sentence ("saved at …")
 * in both the markdown body and the HTML-commented JSON message block, and
 * any `ChatCompactionMarker.transcriptPath` values in that JSON.
 *
 * Exact substring replace (no regex): paths are absolute `/sessions/…`
 * filenames, so a partial match cannot collide with other prose.
 */
export function rewriteTranscriptPointers(
  content: string,
  fromPath: string,
  toPath: string
): string {
  if (!fromPath || fromPath === toPath) return content;
  return content.split(fromPath).join(toPath);
}

/**
 * Render the archive as markdown. The frontmatter carries scalar
 * metadata; an HTML-commented JSON block carries the full structured
 * message list (toolCalls, attachments, source, channel, timestamps)
 * so the read-only chat-panel view can render with the same fidelity
 * as a live scoop. The visible markdown body is what the chat panel's
 * "copy chat history" long-press produces.
 *
 * Memory v2 prose+JSONL archives are written by `writeArchiveBundle` in
 * `session-jsonl.ts` (lazy) — keep this eager path free of that glue.
 */
export function formatArchiveAsMarkdown(rawArchive: FrozenSessionArchive): string {
  // At-rest credential redaction (P0c): scrub structural key material out
  // of the bytes before they persist. Title included — the heuristic title
  // is the first user message's head, which can carry a pasted key.
  const redactState = newAtRestState();
  const archive: FrozenSessionArchive = {
    ...rawArchive,
    title: redactArchiveText(rawArchive.title, redactState),
    messages: redactChatMessagesAtRest(rawArchive.messages, redactState) as ChatMessage[],
  };
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
    // session's transcript to the enrichment catch-up — and it needs the
    // cursor back, or the next round re-appends the kept tail.
    (archive.live ? `live: true\n` : '') +
    (archive.live && archive.liveThrough ? `liveThrough: ${archive.liveThrough}\n` : '') +
    (archive.live && archive.compactions ? `compactions: ${archive.compactions}\n` : '') +
    // Kept on a finished archive too: finalize uses it to avoid re-mining
    // a range the live passes already curated.
    (archive.curatedThrough ? `curatedThrough: ${archive.curatedThrough}\n` : '');
  const header =
    `---\n` +
    `id: ${archive.id}\n` +
    (archive.sessionId ? `sessionId: ${archive.sessionId}\n` : '') +
    (archive.attachmentsKey ? `attachmentsKey: ${archive.attachmentsKey}\n` : '') +
    `title: ${JSON.stringify(archive.title)}\n` +
    `frozenAt: ${archive.frozenAt}\n` +
    `createdAt: ${archive.createdAt}\n` +
    `updatedAt: ${archive.updatedAt}\n` +
    `messageCount: ${archive.messageCount}\n` +
    usageFrontmatter +
    coneFrontmatter +
    `---\n\n`;
  const title = `# ${archive.title}\n\n`;
  // Escape the only sequence that would prematurely close an HTML comment.
  const dataJson = JSON.stringify(stripEphemeral(archive.messages)).replace(/-->/g, '-- >');
  const dataBlock = `${SESSION_DATA_START}${dataJson}${SESSION_DATA_END}\n\n`;
  return header + dataBlock + title + formatChatForClipboard(archive.messages);
}

/** Index path for a sessions directory (`/sessions` or a scoop sandbox). */
export function sessionsIndexPathFor(sessionsDir: string): string {
  return sessionsDir === SESSIONS_DIR ? SESSIONS_INDEX_PATH : `${sessionsDir}/index.json`;
}

/**
 * Web Lock name for a sessions index. Cone archives share one origin-wide
 * lock; scoop sandboxes each get their own so a scoop compaction cannot
 * serialize behind the freezer.
 */
export function sessionsIndexLockFor(sessionsDir: string): string {
  return sessionsDir === SESSIONS_DIR ? SESSIONS_INDEX_LOCK : `slicc:sessions-index:${sessionsDir}`;
}

export async function ensureSessionsDir(
  vfs: ArchiveVfs,
  sessionsDir: string = SESSIONS_DIR
): Promise<void> {
  try {
    await vfs.mkdir(sessionsDir, { recursive: true });
  } catch {
    // Already exists or unsupported — writeFile will surface the real error.
  }
}

/**
 * Read the index for a WRITER — the one baseline every whole-index writer
 * uses. Missing (ENOENT) is an empty list. Present but unparsable (or not an
 * array) is rebuilt from the archives: an empty baseline would let the
 * writer's own row replace every other session, and once the file parses
 * again nothing would ever run the rebuild (#4151). Any other read fault
 * propagates — treating an EIO as "no entries" would rewrite the index
 * without them.
 *
 * Side-effect free, so it is safe outside the index lock too; the caller's
 * own write is what persists the repaired index.
 */
export async function readSessionsIndexForWrite(
  vfs: SessionsIndexReadVfs,
  sessionsDir: string = SESSIONS_DIR
): Promise<FrozenSessionIndexEntry[]> {
  const state = await readSessionsIndexState(vfs, sessionsDir);
  if (state.kind === 'ok') return state.entries;
  if (state.kind === 'missing') return [];
  const rebuilt = await rebuildSessionsIndexFromArchives(vfs, sessionsDir);
  log.warn('Sessions index corrupt; rebuilt from archives before writing', {
    sessionsDir,
    archives: rebuilt.length,
  });
  return rebuilt;
}

/** Discriminated read of a sessions index. */
export type SessionsIndexState =
  | { kind: 'ok'; entries: FrozenSessionIndexEntry[] }
  | { kind: 'missing' }
  | { kind: 'corrupt' };

/**
 * The index as written, missing, or corrupt (unparsable or not an array,
 * e.g. a write cut off by a reload killing the worker). Throws on any read
 * fault other than ENOENT.
 */
export async function readSessionsIndexState(
  vfs: Pick<ArchiveVfs, 'readFile'>,
  sessionsDir: string = SESSIONS_DIR
): Promise<SessionsIndexState> {
  let text: string;
  try {
    const raw = await vfs.readFile(sessionsIndexPathFor(sessionsDir), { encoding: 'utf-8' });
    text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch (err) {
    if (isEnoent(err)) return { kind: 'missing' };
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? { kind: 'ok', entries: parsed as FrozenSessionIndexEntry[] }
      : { kind: 'corrupt' };
  } catch {
    return { kind: 'corrupt' };
  }
}

/**
 * Rebuild a sessions index from its `*.md` archives, the ground truth when
 * `index.json` is corrupt. Titles, timestamps and counts come from each
 * archive's frontmatter; `pending-*` filenames keep their enrichment marker
 * and cone provenance, live cursors and the curator cursor come back from
 * the frontmatter. Newest first, like the live index.
 *
 * An archive that vanished mid-scan is skipped. One that will not read for
 * any other reason keeps a placeholder row (title = filename): dropping it
 * would orphan it for good once the rebuilt index is written. A directory
 * listing fault throws — without the listing nothing can be rebuilt.
 */
export async function rebuildSessionsIndexFromArchives(
  vfs: SessionsIndexReadVfs,
  sessionsDir: string = SESSIONS_DIR
): Promise<FrozenSessionIndexEntry[]> {
  let names: string[];
  try {
    const dir = await vfs.readDir(sessionsDir);
    names = dir.filter((d) => d.type === 'file' && d.name.endsWith('.md')).map((d) => d.name);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const entries: FrozenSessionIndexEntry[] = [];
  for (const filename of names) {
    let text = '';
    try {
      const raw = await vfs.readFile(`${sessionsDir}/${filename}`, { encoding: 'utf-8' });
      text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    } catch (err) {
      if (isEnoent(err)) continue;
      log.warn('Archive unreadable during index rebuild; keeping a placeholder row', {
        sessionsDir,
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    entries.push(entryFromArchive(filename, text));
  }
  entries.sort((a, b) => b.frozenAt.localeCompare(a.frozenAt));
  return entries;
}

/** One rebuilt index row from an archive's text (frontmatter + data block). */
function entryFromArchive(filename: string, text: string): FrozenSessionIndexEntry {
  const header = text.slice(0, 2000);
  const title = /^title:\s*"?(.*?)"?\s*$/m.exec(header)?.[1] ?? filename;
  const frozenAt = /^frozenAt:\s*"?(.*?)"?\s*$/m.exec(header)?.[1] ?? new Date(0).toISOString();
  const messageCount = Number(/^messageCount:\s*(\d+)\s*$/m.exec(header)?.[1] ?? 0);
  const parsed = parseFrozenArchive(text);
  // A live compaction snapshot is still being written to — it must not be
  // handed to the enrichment catch-up, and it needs its cursor back. A
  // `live-` file WITHOUT the marker was finalized (bare clear-chat) and is
  // an ordinary draft.
  const pending = filename.startsWith('pending-') || (filename.startsWith('live-') && !parsed.live);
  return {
    filename,
    title,
    frozenAt,
    messageCount,
    ...(parsed.cost ? { cost: parsed.cost } : {}),
    ...(parsed.models ? { models: parsed.models } : {}),
    ...(parsed.cone ? { cone: parsed.cone } : {}),
    ...(parsed.coneLabel ? { coneLabel: parsed.coneLabel } : {}),
    ...(parsed.memorySkipped ? { memorySkipped: true as const } : {}),
    ...(parsed.live ? { live: true as const } : {}),
    ...(parsed.live && parsed.liveThrough ? { liveThrough: parsed.liveThrough } : {}),
    ...(parsed.live && parsed.compactions ? { compactions: parsed.compactions } : {}),
    ...(parsed.curatedThrough ? { curatedThrough: parsed.curatedThrough } : {}),
    // Per-freeze UUID only. Frontmatter `id` is the live chat key
    // (`session-<folder>`); copying it here collapsed every freeze on a
    // cone onto one sessionId after a corrupt-index rebuild (#3807).
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
    ...(pending ? { pendingEnrichment: true } : {}),
  };
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/**
 * Web Locks name every `/sessions/index.json` read-modify-write takes. The
 * index is one shared file written from TWO realms — the page (a "New chat"
 * freeze, enrichment) and the kernel worker (a compaction snapshot) — and a
 * promise chain only orders writers inside one realm. Web Locks are
 * origin-wide and available in dedicated workers, so both realms (and a
 * second tab) queue on the same lock; without them, two RMWs that both read
 * `[A]` would each write their own row over the other's.
 */
export const SESSIONS_INDEX_LOCK = 'slicc:sessions-index';

/**
 * Per-realm chain so index read-modify-writes from one realm run strictly
 * in arrival order. `.then(run, run)` keeps a failed write from poisoning
 * the chain for later callers; each caller still sees its own error.
 */
let indexWriteChain: Promise<void> = Promise.resolve();

/**
 * Run `run` as ONE index transaction: after every earlier writer in this
 * realm, and — where Web Locks exist — after every writer in any other
 * realm. The callback must do the whole read-modify-write inside and must
 * not call another locked helper (Web Locks are not reentrant); the
 * `*Unlocked` primitives are for that.
 *
 * `lockName` defaults to the cone `/sessions` lock; scoop sandboxes pass
 * {@link sessionsIndexLockFor} so they do not share the freezer's lock.
 */
export function serializeIndexWrite<T>(
  run: () => Promise<T>,
  lockName: string = SESSIONS_INDEX_LOCK
): Promise<T> {
  const locked = (): Promise<T> => {
    const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    if (typeof locks?.request !== 'function') return run();
    return locks.request(lockName, () => run());
  };
  const next = indexWriteChain.then(locked, locked);
  indexWriteChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * Write the whole index. Caller holds the lock (`serializeIndexWrite`) and
 * built `entries` from {@link readSessionsIndexForWrite} — the only index
 * write in `src/` (a source-scan test keeps it that way).
 */
export function writeSessionsIndexUnlocked(
  vfs: Pick<ArchiveVfs, 'writeFile'>,
  entries: readonly FrozenSessionIndexEntry[],
  sessionsDir: string = SESSIONS_DIR
): Promise<void> {
  return vfs.writeFile(sessionsIndexPathFor(sessionsDir), JSON.stringify(entries, null, 2));
}

/** Insert or replace one row, newest first. Caller holds the lock. */
export async function upsertSessionsIndexEntryUnlocked(
  vfs: ArchiveVfs,
  entry: FrozenSessionIndexEntry,
  sessionsDir: string = SESSIONS_DIR
): Promise<void> {
  const existing = await readSessionsIndexForWrite(vfs, sessionsDir);
  await writeSessionsIndexUnlocked(
    vfs,
    [entry, ...existing.filter((e) => e.filename !== entry.filename)],
    sessionsDir
  );
}

/**
 * Insert or replace one index row. The row moves to the head of the list
 * (newest first) and any other row with the same filename is dropped.
 */
export function upsertSessionsIndexEntry(
  vfs: ArchiveVfs,
  entry: FrozenSessionIndexEntry
): Promise<void> {
  return serializeIndexWrite(() => upsertSessionsIndexEntryUnlocked(vfs, entry));
}
