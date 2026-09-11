/**
 * Session JSONL sidecar — machine-readable archive companion.
 *
 * When Memory v2 is on, `/sessions/<name>.md` stays prose-only (grep-safe)
 * and the structured messages live beside it as `<name>.jsonl`: one
 * pi-ai-shaped message per line. Legacy archives keep the HTML-commented
 * JSON block inside the markdown; this module only writes/reads the split
 * form.
 */

import type { ChatMessage, MessageAttachment, ToolCall } from '@slicc/shared-ts';
import { FsError } from '../fs/types.js';
import { redactChatMessagesAtRest } from './archive-redaction.js';
import {
  type FrozenSessionArchive,
  parseFrozenArchive,
  SESSIONS_DIR,
} from './frozen-archive-format.js';
import { formatArchiveAsMarkdown, stripEphemeral } from './frozen-archive-writer.js';

/** Text content block matching pi-ai's `TextContent`. */
export interface SessionJsonlTextContent {
  type: 'text';
  text: string;
}

/** Tool-call content block matching pi-ai's toolCall shape (arguments object). */
export interface SessionJsonlToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: unknown;
}

export type SessionJsonlContent = SessionJsonlTextContent | SessionJsonlToolCallContent;

/**
 * One JSONL line. Mirrors pi-ai `Message` roles so agents and tools can
 * round-trip without the ChatMessage tool-call flattening.
 */
export interface SessionJsonlMessage {
  role: 'user' | 'assistant' | 'toolResult';
  content: SessionJsonlContent[] | string;
  id?: string;
  timestamp?: number;
  toolCallId?: string;
  isError?: boolean;
  source?: string;
  channel?: string;
  compaction?: ChatMessage['compaction'];
  /** Preserved so thaw/export keep attachment chips and ZIP files. */
  attachments?: MessageAttachment[];
}

/** Minimal read surface for loading a JSONL sidecar. */
export interface SessionJsonlReader {
  readFile(path: string, options: { encoding: 'utf-8' }): Promise<string | Uint8Array>;
}

/** VFS surface needed to read/write a sidecar next to an archive. */
export interface SessionJsonlVfs extends SessionJsonlReader {
  writeFile(path: string, content: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/** `/sessions/foo.md` → `/sessions/foo.jsonl`. */
export function sidecarPathForArchive(archivePathOrFilename: string): string {
  const base = archivePathOrFilename.endsWith('.md')
    ? archivePathOrFilename.slice(0, -3)
    : archivePathOrFilename.replace(/\.md$/i, '');
  const withExt = `${base}.jsonl`;
  return withExt.startsWith('/') ? withExt : `${SESSIONS_DIR}/${withExt}`;
}

/** Filename only (`foo.jsonl`) for frontmatter. */
export function sidecarFilenameForArchive(archiveFilename: string): string {
  return archiveFilename.replace(/\.md$/i, '.jsonl');
}

/**
 * Turn the eager embedded-JSON markdown into Memory v2 prose+sidecar form:
 * drop the HTML-commented data block and record `sidecar:` in frontmatter.
 */
function formatArchiveProseWithSidecar(
  archive: FrozenSessionArchive,
  sidecarFilename: string
): string {
  const embedded = formatArchiveAsMarkdown(archive);
  const prose = embedded.replace(/<!-- slicc:session-data\n[\s\S]*?\n-->\n\n/, '');
  return prose.replace(/^---\n([\s\S]*?)\n---\n\n/, (_match, body: string) => {
    return `---\n${body}\nsidecar: ${sidecarFilename}\n---\n\n`;
  });
}

/**
 * Write a Memory v2 archive: prose-only markdown + JSONL sidecar.
 * Call only when `memory-v2` is on; flag-off callers write via
 * {@link formatArchiveAsMarkdown} so the eager worker graph stays clean.
 */
export async function writeArchiveBundle(
  vfs: SessionJsonlVfs,
  filename: string,
  archive: FrozenSessionArchive
): Promise<{ markdownPath: string; sidecarPath: string }> {
  const sidecarFilename = sidecarFilenameForArchive(filename);
  const markdownPath = `${SESSIONS_DIR}/${filename}`;
  await vfs.writeFile(markdownPath, formatArchiveProseWithSidecar(archive, sidecarFilename));
  const sidecarPath = await writeSessionJsonl(vfs, filename, stripEphemeral(archive.messages));
  return { markdownPath, sidecarPath };
}

/**
 * Load messages for an archive, resolving a Memory v2 JSONL sidecar when
 * the markdown has no embedded session-data block.
 */
export async function loadFrozenArchive(
  vfs: SessionJsonlReader,
  markdown: string,
  archiveFilename?: string
): Promise<
  Pick<
    FrozenSessionArchive,
    | 'title'
    | 'messages'
    | 'cost'
    | 'models'
    | 'cone'
    | 'coneLabel'
    | 'memorySkipped'
    | 'live'
    | 'liveThrough'
    | 'compactions'
  > & { id?: string; sidecar?: string }
> {
  const parsed = parseFrozenArchive(markdown);
  if (parsed.messages.length > 0 || !parsed.sidecar) return parsed;
  const filename = archiveFilename ?? parsed.sidecar.replace(/\.jsonl$/i, '.md');
  const fromSidecar = await readSessionJsonl(vfs, filename);
  if (fromSidecar) return { ...parsed, messages: fromSidecar };
  return parsed;
}

/** Serialize ChatMessage[] to pi-ai-shaped JSONL (one message per line). */
export function chatMessagesToJsonl(messages: readonly ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    for (const line of expandChatMessage(message)) {
      lines.push(JSON.stringify(line));
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Parse JSONL back into ChatMessage[] (toolCall + toolResult collapsed). */
export function jsonlToChatMessages(jsonl: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  let lastAssistant: ChatMessage | null = null;
  for (const rawLine of jsonl.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseJsonlLine(line);
    if (!parsed) continue;
    if (parsed.role === 'user') {
      out.push(userFromJsonl(parsed));
      lastAssistant = null;
    } else if (parsed.role === 'assistant') {
      const chat = assistantFromJsonl(parsed);
      out.push(chat);
      lastAssistant = chat;
    } else if (parsed.role === 'toolResult') {
      attachToolResult(lastAssistant, parsed);
    }
  }
  return out;
}

function parseJsonlLine(line: string): SessionJsonlMessage | null {
  try {
    return JSON.parse(line) as SessionJsonlMessage;
  } catch {
    return null;
  }
}

function userFromJsonl(parsed: SessionJsonlMessage): ChatMessage {
  return {
    id: parsed.id ?? fallbackId('u'),
    role: 'user',
    content: contentToText(parsed.content),
    timestamp: parsed.timestamp ?? 0,
    ...(parsed.source ? { source: parsed.source } : {}),
    ...(parsed.channel ? { channel: parsed.channel } : {}),
    ...(parsed.attachments?.length ? { attachments: parsed.attachments } : {}),
  };
}

function assistantFromJsonl(parsed: SessionJsonlMessage): ChatMessage {
  const toolCalls = extractToolCalls(parsed.content);
  return {
    id: parsed.id ?? fallbackId('a'),
    role: 'assistant',
    content: contentToText(parsed.content),
    timestamp: parsed.timestamp ?? 0,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(parsed.source ? { source: parsed.source } : {}),
    ...(parsed.compaction ? { compaction: parsed.compaction } : {}),
    ...(parsed.attachments?.length ? { attachments: parsed.attachments } : {}),
  };
}

function attachToolResult(lastAssistant: ChatMessage | null, parsed: SessionJsonlMessage): void {
  if (!parsed.toolCallId || !lastAssistant?.toolCalls) return;
  const match = lastAssistant.toolCalls.find((tc) => tc.id === parsed.toolCallId);
  if (!match) return;
  match.result = contentToText(parsed.content);
  if (parsed.isError) match.isError = true;
}

export async function writeSessionJsonl(
  vfs: SessionJsonlVfs,
  archiveFilename: string,
  messages: readonly ChatMessage[]
): Promise<string> {
  const path = sidecarPathForArchive(archiveFilename);
  // At-rest credential redaction (P0c) — the sidecar is the structured copy
  // of the same transcript `formatArchiveAsMarkdown` scrubs; both surfaces
  // must persist clean. Idempotent (markers are excluded from re-scan).
  await vfs.writeFile(path, chatMessagesToJsonl(redactChatMessagesAtRest(messages)));
  return path;
}

export async function readSessionJsonl(
  vfs: SessionJsonlReader,
  archiveFilenameOrPath: string
): Promise<ChatMessage[] | null> {
  const path = sidecarPathForArchive(archiveFilenameOrPath);
  try {
    const raw = await vfs.readFile(path, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return jsonlToChatMessages(text);
  } catch (err) {
    if (err instanceof FsError && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function removeSessionJsonl(
  vfs: SessionJsonlVfs,
  archiveFilenameOrPath: string
): Promise<void> {
  const path = sidecarPathForArchive(archiveFilenameOrPath);
  try {
    await vfs.rm(path);
  } catch (err) {
    if (err instanceof FsError && err.code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Copy a sidecar next to a renamed archive without deleting the source.
 * Callers that need atomic rename should commit the index first, then
 * {@link removeSessionJsonl} the old path — so a failed index write does not
 * strand the only structured transcript under an unindexed name.
 */
export async function copySessionJsonl(
  vfs: SessionJsonlVfs,
  fromArchiveFilename: string,
  toArchiveFilename: string
): Promise<void> {
  if (fromArchiveFilename === toArchiveFilename) return;
  const from = sidecarPathForArchive(fromArchiveFilename);
  const to = sidecarPathForArchive(toArchiveFilename);
  try {
    const raw = await vfs.readFile(from, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    await vfs.writeFile(to, text);
  } catch (err) {
    if (err instanceof FsError && err.code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Rename a sidecar with the archive. No-op when the source is missing.
 * Prefer {@link copySessionJsonl} + deferred {@link removeSessionJsonl} when
 * the index write can still fail after the copy.
 */
export async function renameSessionJsonl(
  vfs: SessionJsonlVfs,
  fromArchiveFilename: string,
  toArchiveFilename: string
): Promise<void> {
  if (fromArchiveFilename === toArchiveFilename) return;
  await copySessionJsonl(vfs, fromArchiveFilename, toArchiveFilename);
  await removeSessionJsonl(vfs, fromArchiveFilename);
}

function expandChatMessage(message: ChatMessage): SessionJsonlMessage[] {
  if (message.role === 'user') {
    return [
      {
        role: 'user',
        content: [{ type: 'text', text: message.content }],
        id: message.id,
        timestamp: message.timestamp,
        ...(message.source ? { source: message.source } : {}),
        ...(message.channel ? { channel: message.channel } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      },
    ];
  }

  const content: SessionJsonlContent[] = [];
  if (message.content) content.push({ type: 'text', text: message.content });
  for (const tc of message.toolCalls ?? []) {
    content.push({
      type: 'toolCall',
      id: tc.id,
      name: tc.name,
      arguments: tc.input,
    });
  }
  const assistant: SessionJsonlMessage = {
    role: 'assistant',
    content: content.length ? content : [{ type: 'text', text: '' }],
    id: message.id,
    timestamp: message.timestamp,
    ...(message.source ? { source: message.source } : {}),
    ...(message.compaction ? { compaction: message.compaction } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
  };
  const lines: SessionJsonlMessage[] = [assistant];
  for (const tc of message.toolCalls ?? []) {
    if (tc.result === undefined && !tc.isError) continue;
    lines.push({
      role: 'toolResult',
      toolCallId: tc.id,
      content: [{ type: 'text', text: tc.result ?? '' }],
      ...(tc.isError ? { isError: true } : {}),
      timestamp: message.timestamp,
    });
  }
  return lines;
}

function contentToText(content: SessionJsonlContent[] | string): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is SessionJsonlTextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function extractToolCalls(content: SessionJsonlContent[] | string): ToolCall[] {
  if (typeof content === 'string') return [];
  return content
    .filter((block): block is SessionJsonlToolCallContent => block.type === 'toolCall')
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: block.arguments,
    }));
}

function fallbackId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
