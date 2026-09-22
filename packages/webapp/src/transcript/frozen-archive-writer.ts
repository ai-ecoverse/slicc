import { slugify as slugifyText } from '@slicc/shared-ts';
import { FsError } from '../fs/types.js';
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
  SESSIONS_DIR,
  SESSIONS_INDEX_PATH,
} from './frozen-archive-format.js';

export interface ArchiveVfs {
  readFile(path: string, options: { encoding: 'utf-8' }): Promise<string | Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  flush(): Promise<void>;
}

const SESSION_DATA_START = '<!-- slicc:session-data\n';
const SESSION_DATA_END = '\n-->';

export const LIVE_SNAPSHOT_PREFIX = 'live-';

export function isDraftArchiveFilename(filename: string): boolean {
  return filename.startsWith('pending-') || filename.startsWith(LIVE_SNAPSHOT_PREFIX);
}

export function liveSnapshotFilename(coneFolder: string): string {
  return `${LIVE_SNAPSHOT_PREFIX}${slugify(coneFolder)}-${shortId()}.md`;
}

export function findLiveSnapshotEntry(
  entries: readonly FrozenSessionIndexEntry[],
  coneFolder: string
): FrozenSessionIndexEntry | undefined {
  return entries.find((entry) => entry.live === true && (entry.cone ?? 'cone') === coneFolder);
}

export function shortId(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${time}-${rand}`;
}

export function slugify(text: string): string {
  return slugifyText(text, { maxLen: 48, fallback: 'session' });
}

const UNTITLED_SESSION_TITLE = 'untitled-session';

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

const INJECTED_TURN_RE = new RegExp(
  '^(?:_Forwarded from .+?\\._\\s*)*(?:' +
    '\\[@\\S+ (?:completed|idle|sudo-request|FAILED)\\b|' +
    '\\[scoop_wait\\b|' +
    `\\[(?:${LICK_HEADER_LABELS.join('|')})\\b|` +
    'Preview tab (?:connected|disconnected) from |' +
    '<context-summary\\b)'
);

function collapsedHead(text: string): string {
  return text.slice(0, 480).trim().replace(/\s+/g, ' ').slice(0, 240);
}

function isInjectedSessionText(text: string): boolean {
  const head = collapsedHead(text);
  return head.length > 0 && INJECTED_TURN_RE.test(head);
}

export function isProvisionalSessionTitle(title: string): boolean {
  return title === UNTITLED_SESSION_TITLE || isInjectedSessionText(title);
}

function isGenuineUserTurn(message: ChatMessage): boolean {
  if (message.role !== 'user' || !message.content?.trim()) return false;
  if (message.source === 'lick' || message.channel) return false;
  return !isInjectedSessionText(message.content);
}

export function heuristicTitle(messages: readonly ChatMessage[]): string {
  const firstUser = messages.find(isGenuineUserTurn);
  if (!firstUser?.content) return UNTITLED_SESSION_TITLE;
  const head = firstUser.content.trim().replace(/\s+/g, ' ');
  return head.length > 60 ? `${head.slice(0, 60)}…` : head || UNTITLED_SESSION_TITLE;
}

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

export function rewriteTranscriptPointers(
  content: string,
  fromPath: string,
  toPath: string
): string {
  if (!fromPath || fromPath === toPath) return content;
  return content.split(fromPath).join(toPath);
}

export function formatArchiveAsMarkdown(rawArchive: FrozenSessionArchive): string {
  const redactState = newAtRestState();
  const archive: FrozenSessionArchive = {
    ...rawArchive,
    title: redactArchiveText(rawArchive.title, redactState),
    messages: redactChatMessagesAtRest(rawArchive.messages, redactState) as ChatMessage[],
  };
  const usageFrontmatter =
    (archive.cost ? `cost: ${JSON.stringify(archive.cost)}\n` : '') +
    (archive.models ? `models: ${JSON.stringify(archive.models)}\n` : '');

  const coneFrontmatter =
    (archive.cone ? `cone: ${archive.cone}\n` : '') +
    (archive.coneLabel ? `coneLabel: ${JSON.stringify(archive.coneLabel)}\n` : '') +
    (archive.memorySkipped ? `memorySkipped: true\n` : '') +
    (archive.live ? `live: true\n` : '') +
    (archive.live && archive.liveThrough ? `liveThrough: ${archive.liveThrough}\n` : '') +
    (archive.live && archive.compactions ? `compactions: ${archive.compactions}\n` : '');
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
  const title = `# ${archive.title}\n\n`;

  const dataJson = JSON.stringify(stripEphemeral(archive.messages)).replace(/-->/g, '-- >');
  const dataBlock = `${SESSION_DATA_START}${dataJson}${SESSION_DATA_END}\n\n`;
  return header + dataBlock + title + formatChatForClipboard(archive.messages);
}

export function sessionsIndexPathFor(sessionsDir: string): string {
  return sessionsDir === SESSIONS_DIR ? SESSIONS_INDEX_PATH : `${sessionsDir}/index.json`;
}

export function sessionsIndexLockFor(sessionsDir: string): string {
  return sessionsDir === SESSIONS_DIR ? SESSIONS_INDEX_LOCK : `slicc:sessions-index:${sessionsDir}`;
}

export async function ensureSessionsDir(
  vfs: ArchiveVfs,
  sessionsDir: string = SESSIONS_DIR
): Promise<void> {
  try {
    await vfs.mkdir(sessionsDir, { recursive: true });
  } catch {}
}

export async function readSessionsIndexForWrite(
  vfs: ArchiveVfs,
  sessionsDir: string = SESSIONS_DIR
): Promise<FrozenSessionIndexEntry[]> {
  try {
    const raw = await vfs.readFile(sessionsIndexPathFor(sessionsDir), { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as FrozenSessionIndexEntry[]) : [];
  } catch (err) {
    if (err instanceof FsError && err.code !== 'ENOENT') throw err;
    return [];
  }
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export const SESSIONS_INDEX_LOCK = 'slicc:sessions-index';

let indexWriteChain: Promise<void> = Promise.resolve();

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

export function writeSessionsIndexUnlocked(
  vfs: ArchiveVfs,
  entries: readonly FrozenSessionIndexEntry[],
  sessionsDir: string = SESSIONS_DIR
): Promise<void> {
  return vfs.writeFile(sessionsIndexPathFor(sessionsDir), JSON.stringify(entries, null, 2));
}

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

export function upsertSessionsIndexEntry(
  vfs: ArchiveVfs,
  entry: FrozenSessionIndexEntry
): Promise<void> {
  return serializeIndexWrite(() => upsertSessionsIndexEntryUnlocked(vfs, entry));
}
