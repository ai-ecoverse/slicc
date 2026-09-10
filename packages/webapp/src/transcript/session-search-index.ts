/**
 * Keyword session-history index (Memory v2).
 *
 * MiniSearch over VFS/IndexedDB — no SQLite, no WASM natives, no embeddings.
 * Ranking borrows qmd's weights (title 4× body) plus posthorse's rule that
 * original content outranks recovery echoes (summaries, compaction stubs,
 * prior search output).
 *
 * Loaded lazily so it never enters the first-load eager graph.
 */

import type { ChatMessage } from '@slicc/shared-ts';
import {
  type FrozenSessionIndexEntry,
  loadFrozenArchive,
  readSessionsIndex,
  SESSIONS_DIR,
} from './frozen-archive-format.js';

export const SESSION_SEARCH_INDEX_PATH = '/sessions/.search-index.json';

/** Hard cap on a single `session read` response (bytes, UTF-8). */
export const SESSION_READ_BYTE_CAP = 12_000;

/**
 * Cap on indexed/stored body text per message (UTF-8 bytes). Compaction
 * archives can hold multi-MB tool payloads; indexing them verbatim would
 * blow the kernel-worker heap on first search.
 */
export const SESSION_INDEX_BODY_BYTE_CAP = 4_000;

/** Default number of search hits returned. */
export const SESSION_SEARCH_DEFAULT_LIMIT = 8;

/** Max hits even when the caller asks for more. */
export const SESSION_SEARCH_MAX_LIMIT = 20;

/** Read + write surface the search index needs (shell VFS / VirtualFS). */
export interface SessionSearchVfs {
  readFile(path: string, options?: { encoding?: string }): Promise<string | Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
}

export type SessionEchoKind = 'original' | 'summary' | 'echo';

export interface SessionSearchDoc {
  id: string;
  title: string;
  body: string;
  sessionId: string;
  sessionTitle: string;
  filename: string;
  messageId: string;
  messageIndex: number;
  role: string;
  echoKind: SessionEchoKind;
  path: string;
}

export interface SessionSearchHit {
  id: string;
  score: number;
  echoKind: SessionEchoKind;
  sessionId: string;
  sessionTitle: string;
  filename: string;
  messageId: string;
  messageIndex: number;
  role: string;
  path: string;
  excerpt: string;
}

interface IndexMeta {
  version: 1;
  builtAt: number;
  archiveCount: number;
  fingerprint: string;
}

type MiniSearchLike = {
  addAll(docs: SessionSearchDoc[]): void;
  search(
    query: string,
    opts?: { boost?: Record<string, number>; prefix?: boolean }
  ): Array<{ id: string; score: number }>;
  getStoredFields(id: string): Partial<SessionSearchDoc> | null;
  toJSON(): unknown;
};

type MiniSearchCtor = new (opts: {
  fields: string[];
  storeFields: string[];
  idField: string;
  processTerm?: (term: string) => string | null;
  searchOptions?: { boost?: Record<string, number>; prefix?: boolean };
}) => MiniSearchLike & { constructor: { loadJSON(json: unknown, opts: unknown): MiniSearchLike } };

const INDEX_OPTIONS = {
  fields: ['title', 'body'],
  storeFields: [
    'title',
    'body',
    'sessionId',
    'sessionTitle',
    'filename',
    'messageId',
    'messageIndex',
    'role',
    'echoKind',
    'path',
  ],
  idField: 'id',
  processTerm: (term: string) => {
    const lower = term.toLowerCase();
    if (lower.length < 2) return null;
    return porterStem(lower);
  },
  searchOptions: {
    boost: { title: 4, body: 1 },
    prefix: true,
  },
};

const ECHO_SCORE_MULT: Record<SessionEchoKind, number> = {
  original: 1,
  summary: 0.35,
  echo: 0.15,
};

export function classifyEchoKind(message: ChatMessage): SessionEchoKind {
  if (message.compaction) return 'summary';
  const text = message.content ?? '';
  if (
    /<context-summary>/i.test(text) ||
    /Earlier conversation messages were compacted/i.test(text) ||
    /full transcript of the conversation before this compaction is saved at/i.test(text)
  ) {
    return 'summary';
  }
  if (
    /^# session (search|read):/m.test(text) ||
    /\bid=sess\/[^\s]+/.test(text) ||
    (message.role === 'assistant' &&
      message.toolCalls?.some(
        (tc) =>
          tc.name === 'bash' &&
          typeof tc.input === 'object' &&
          tc.input !== null &&
          /session\s+(search|read)\b/.test(String((tc.input as { command?: string }).command ?? ''))
      ))
  ) {
    return 'echo';
  }
  return 'original';
}

export function makeHitId(sessionId: string, messageId: string): string {
  return `sess/${sessionId}/msg/${messageId}`;
}

export function parseHitId(id: string): { sessionId: string; messageId: string } | null {
  const match = /^sess\/([^/]+)\/msg\/(.+)$/.exec(id);
  if (!match) return null;
  return { sessionId: match[1], messageId: match[2] };
}

/** Build searchable docs from one archive's messages. */
export function docsFromArchive(args: {
  sessionId: string;
  sessionTitle: string;
  filename: string;
  messages: readonly ChatMessage[];
}): SessionSearchDoc[] {
  const path = `${SESSIONS_DIR}/${args.filename}`;
  const docs: SessionSearchDoc[] = [];
  args.messages.forEach((message, messageIndex) => {
    const messageId = message.id || `i${messageIndex}`;
    const bodyParts = [message.content];
    for (const tc of message.toolCalls ?? []) {
      bodyParts.push(tc.name, safeJson(tc.input));
      if (tc.result) bodyParts.push(tc.result);
    }
    const body = truncateUtf8(bodyParts.filter(Boolean).join('\n'), SESSION_INDEX_BODY_BYTE_CAP);
    if (!body.trim() && !message.compaction) return;
    docs.push({
      id: makeHitId(args.sessionId, messageId),
      title: args.sessionTitle,
      body,
      sessionId: args.sessionId,
      sessionTitle: args.sessionTitle,
      filename: args.filename,
      messageId,
      messageIndex,
      role: message.role,
      echoKind: classifyEchoKind(message),
      path,
    });
  });
  return docs;
}

export async function rebuildSessionSearchIndex(vfs: SessionSearchVfs): Promise<{
  docs: number;
  archives: number;
}> {
  const MiniSearch = (await import('minisearch')).default as unknown as MiniSearchCtor;
  const entries = await readSessionsIndex(vfs as never);
  const docs: SessionSearchDoc[] = [];
  for (const entry of entries) {
    const archiveDocs = await docsForEntry(vfs, entry);
    docs.push(...archiveDocs);
  }
  const mini = new MiniSearch(INDEX_OPTIONS);
  if (docs.length) mini.addAll(docs);
  const meta: IndexMeta = {
    version: 1,
    builtAt: Date.now(),
    archiveCount: entries.length,
    fingerprint: fingerprintEntries(entries),
  };
  await vfs.writeFile(SESSION_SEARCH_INDEX_PATH, JSON.stringify({ meta, index: mini.toJSON() }));
  return { docs: docs.length, archives: entries.length };
}

export async function ensureSessionSearchIndex(vfs: SessionSearchVfs): Promise<MiniSearchLike> {
  const MiniSearch = (await import('minisearch')).default as unknown as MiniSearchCtor;
  const entries = await readSessionsIndex(vfs as never);
  const wanted = fingerprintEntries(entries);
  try {
    const raw = await vfs.readFile(SESSION_SEARCH_INDEX_PATH, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text) as { meta?: IndexMeta; index?: unknown };
    if (parsed.meta?.fingerprint === wanted && parsed.index) {
      return (
        MiniSearch as unknown as {
          loadJS(json: unknown, opts: typeof INDEX_OPTIONS): MiniSearchLike;
        }
      ).loadJS(parsed.index, INDEX_OPTIONS);
    }
  } catch {
    // Missing or corrupt — rebuild below.
  }
  await rebuildSessionSearchIndex(vfs);
  const raw = await vfs.readFile(SESSION_SEARCH_INDEX_PATH, { encoding: 'utf-8' });
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  const parsed = JSON.parse(text) as { index: unknown };
  return (
    MiniSearch as unknown as {
      loadJS(json: unknown, opts: typeof INDEX_OPTIONS): MiniSearchLike;
    }
  ).loadJS(parsed.index, INDEX_OPTIONS);
}

export async function searchSessions(
  vfs: SessionSearchVfs,
  query: string,
  options: { limit?: number } = {}
): Promise<SessionSearchHit[]> {
  const limit = Math.min(
    Math.max(1, options.limit ?? SESSION_SEARCH_DEFAULT_LIMIT),
    SESSION_SEARCH_MAX_LIMIT
  );
  const trimmed = query.trim();
  if (!trimmed) return [];
  const mini = await ensureSessionSearchIndex(vfs);
  const raw = mini.search(trimmed, { boost: { title: 4, body: 1 }, prefix: true });
  const hits: SessionSearchHit[] = [];
  for (const row of raw) {
    const stored = mini.getStoredFields(row.id) as SessionSearchDoc | null;
    if (!stored) continue;
    const echoKind = stored.echoKind ?? 'original';
    const score = row.score * (ECHO_SCORE_MULT[echoKind] ?? 1);
    hits.push({
      id: String(row.id),
      score,
      echoKind,
      sessionId: stored.sessionId,
      sessionTitle: stored.sessionTitle,
      filename: stored.filename,
      messageId: stored.messageId,
      messageIndex: stored.messageIndex,
      role: stored.role,
      path: stored.path,
      excerpt: makeExcerpt(stored.body, trimmed),
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export async function readSessionHit(
  vfs: SessionSearchVfs,
  hitId: string,
  options: { from?: number; count?: number } = {}
): Promise<{
  hit: { sessionId: string; messageId: string; sessionTitle: string; path: string };
  messages: ChatMessage[];
  from: number;
  count: number;
  total: number;
  remaining: number;
  truncated: boolean;
  text: string;
} | null> {
  const parsed = parseHitId(hitId);
  if (!parsed) return null;
  const entries = await readSessionsIndex(vfs as never);
  const entry =
    entries.find((e) => e.sessionId === parsed.sessionId) ??
    entries.find((e) => e.filename.replace(/\.md$/i, '') === parsed.sessionId);
  if (!entry) return null;
  const messages = await loadMessagesForEntry(vfs, entry);
  const anchor = messages.findIndex((m, i) => (m.id || `i${i}`) === parsed.messageId);
  const from = Math.max(0, options.from ?? Math.max(0, anchor));
  const requested = Math.max(1, options.count ?? 3);
  let page = messages.slice(from, from + requested);
  let text = formatReadPage(page, from);
  let truncated = false;
  while (utf8ByteLength(text) > SESSION_READ_BYTE_CAP && page.length > 1) {
    page = page.slice(0, -1);
    text = formatReadPage(page, from);
    truncated = true;
  }
  if (utf8ByteLength(text) > SESSION_READ_BYTE_CAP) {
    text = `${truncateUtf8(text, SESSION_READ_BYTE_CAP - 20)}\n…[truncated]\n`;
    truncated = true;
  }
  const count = page.length;
  const remaining = Math.max(0, messages.length - (from + count));
  return {
    hit: {
      sessionId: entry.sessionId ?? parsed.sessionId,
      messageId: parsed.messageId,
      sessionTitle: entry.title,
      path: `${SESSIONS_DIR}/${entry.filename}`,
    },
    messages: page,
    from,
    count,
    total: messages.length,
    remaining,
    truncated,
    text,
  };
}

async function docsForEntry(
  vfs: SessionSearchVfs,
  entry: FrozenSessionIndexEntry
): Promise<SessionSearchDoc[]> {
  const messages = await loadMessagesForEntry(vfs, entry);
  const sessionId = entry.sessionId ?? entry.filename.replace(/\.md$/i, '');
  return docsFromArchive({
    sessionId,
    sessionTitle: entry.title,
    filename: entry.filename,
    messages,
  });
}

async function loadMessagesForEntry(
  vfs: SessionSearchVfs,
  entry: FrozenSessionIndexEntry
): Promise<ChatMessage[]> {
  try {
    const raw = await vfs.readFile(`${SESSIONS_DIR}/${entry.filename}`, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const archive = await loadFrozenArchive(vfs as never, text, entry.filename);
    return archive.messages;
  } catch {
    return [];
  }
}

function fingerprintEntries(entries: readonly FrozenSessionIndexEntry[]): string {
  return entries
    .map((e) => `${e.filename}:${e.messageCount}:${e.frozenAt}:${e.sessionId ?? ''}`)
    .sort()
    .join('|');
}

function makeExcerpt(body: string, query: string, radius = 80): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  let idx = -1;
  for (const term of terms) {
    idx = flat.toLowerCase().indexOf(term);
    if (idx >= 0) break;
  }
  if (idx < 0) return flat.slice(0, radius * 2) + (flat.length > radius * 2 ? '…' : '');
  const start = Math.max(0, idx - radius);
  const end = Math.min(flat.length, idx + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

function formatReadPage(messages: readonly ChatMessage[], from: number): string {
  const blocks: string[] = [];
  messages.forEach((message, i) => {
    const idx = from + i;
    const id = message.id || `i${idx}`;
    blocks.push(`## [${idx}] ${message.role} id=${id}`);
    if (message.content) blocks.push(message.content);
    for (const tc of message.toolCalls ?? []) {
      blocks.push(`### tool ${tc.name} (${tc.id})${tc.isError ? ' ERROR' : ''}`);
      blocks.push(safeJson(tc.input));
      if (tc.result) blocks.push(tc.result);
    }
    blocks.push('');
  });
  return blocks.join('\n');
}

/** Drop the persisted index so erased archives cannot be recovered from it. */
export async function invalidateSessionSearchIndex(vfs: {
  rm(path: string): Promise<void>;
}): Promise<void> {
  try {
    await vfs.rm(SESSION_SEARCH_INDEX_PATH);
  } catch {
    // Missing index is the desired end state.
  }
}

const utf8Encoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

/** Truncate to at most `maxBytes` UTF-8 bytes on a code-point boundary. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const encoded = utf8Encoder.encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // Avoid splitting a multi-byte sequence: continuation bytes are 0b10xxxxxx.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(encoded.subarray(0, end));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Compact Porter stemmer (step-1 focused). Enough for English keyword
 * recall without pulling in a separate stemming package.
 */
export function porterStem(word: string): string {
  if (word.length < 3) return word;
  let w = word;
  if (w.endsWith('sses')) w = `${w.slice(0, -2)}`;
  else if (w.endsWith('ies')) w = `${w.slice(0, -2)}`;
  else if (w.endsWith('ss')) {
    /* keep */
  } else if (w.endsWith('s') && w.length > 3) w = w.slice(0, -1);

  if (w.endsWith('eed')) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else if (/(ed|ing)$/.test(w)) {
    const stem = w.replace(/(ed|ing)$/, '');
    if (/[aeiouy]/.test(stem)) {
      w = stem;
      if (/(at|bl|iz)$/.test(w)) w = `${w}e`;
      else if (/(.)\1$/.test(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
      else if (measure(w) === 1 && cvc(w)) w = `${w}e`;
    }
  }
  if (w.endsWith('y') && /[aeiouy]/.test(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;
  return w;
}

function measure(word: string): number {
  const m = word
    .toLowerCase()
    .replace(/[^aeiouy]+/g, 'C')
    .replace(/[aeiouy]+/g, 'V')
    .replace(/^C/, '')
    .replace(/V$/, '');
  return (m.match(/VC/g) ?? []).length;
}

function cvc(word: string): boolean {
  if (word.length < 3) return false;
  const a = word[word.length - 3]!;
  const b = word[word.length - 2]!;
  const c = word[word.length - 1]!;
  const vowel = (ch: string) => /[aeiouy]/.test(ch);
  return !vowel(a) && vowel(b) && !vowel(c) && !/[wxy]/.test(c);
}
