/**
 * Freezer — archive the cone's chat session to the VFS before a "New session"
 * reset clears it from IndexedDB.
 *
 * Flow (all best-effort, never throws past the caller):
 *   1. Load `session-cone` from the UI SessionStore.
 *   2. If the session is short (< MIN_MESSAGES_TO_FREEZE), skip everything
 *      and return null — nothing meaningful to extract or archive.
 *   3. Run two LLM calls over the message list with a shared system prompt
 *      (Anthropic prompt cache hits on the prefix for the second call):
 *        - Memory extraction → append bullets to /shared/CLAUDE.md.
 *        - Title generation → 3-6 word label used to name the archive.
 *      Either call may fail independently; failures fall through to safe
 *      defaults (no memory append, heuristic title).
 *   4. Write the session JSON to `/sessions/<timestamp>-<slug>.json` and
 *      prepend the entry to `/sessions/index.json`.
 *
 * Scoops are intentionally untouched — they survive a "New session" reset
 * so the fresh cone inherits the existing scoop roster and decides what
 * to do with them.
 */

import type { Api, Model } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { VirtualFS } from '../fs/index.js';
import { createLogger } from '../core/logger.js';
import type { ChatMessage, Session } from './types.js';
import type { SessionStore } from './session-store.js';
import {
  runOneOffCompactionCall,
  COMPACTION_MEMORY_INSTRUCTION,
  COMPACTION_TITLE_INSTRUCTION,
} from '../core/context-compaction.js';
import { formatChatForClipboard } from './chat-panel.js';

const log = createLogger('session-freezer');

/** Minimum cone message count before we bother freezing or extracting memory. */
const MIN_MESSAGES_TO_FREEZE = 4;

/** Max output tokens for the memory call — bullets, not a structured doc. */
const MEMORY_MAX_TOKENS = 2048;

/** Max output tokens for the title call — a short label. */
const TITLE_MAX_TOKENS = 40;

/** Where session archives and the index live. */
const SESSIONS_DIR = '/sessions';
const SESSIONS_INDEX_PATH = '/sessions/index.json';

export interface FrozenSessionIndexEntry {
  /** Filename within /sessions/, e.g. "2026-05-13T19-30-00Z-fix-build.json". */
  filename: string;
  /** Human-readable title from the LLM, or a heuristic fallback. */
  title: string;
  /** ISO timestamp when the freeze happened. */
  frozenAt: string;
  /** Count of messages in the frozen session. */
  messageCount: number;
}

export interface FrozenSession extends FrozenSessionIndexEntry {
  /** The full archive document written to disk. */
  archive: FrozenSessionArchive;
}

export interface FrozenSessionArchive {
  id: string;
  title: string;
  frozenAt: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  messages: ChatMessage[];
}

export interface FreezeConeSessionOptions {
  sessionStore: SessionStore;
  vfs: VirtualFS;
  /**
   * Active LLM model. When omitted (e.g. no provider configured) the
   * freezer still archives the session but skips the memory and title
   * LLM calls — a heuristic title is used in their place.
   */
  model?: Model<Api>;
  /**
   * API key for the active provider. Same fallback semantics as `model` —
   * when empty/missing, LLM calls are skipped.
   */
  apiKey?: string;
  /** Adobe X-Session-Id and friends — forwarded to both LLM calls. */
  headers?: Record<string, string>;
}

/**
 * Run the freezer over the cone session. Returns the entry written (or null
 * if nothing was frozen). Never throws past the caller — every step is
 * wrapped in try/catch so the New Session flow can always proceed to the
 * clear+reload step.
 */
export async function freezeConeSession(
  opts: FreezeConeSessionOptions
): Promise<FrozenSession | null> {
  const session = await loadSessionSafely(opts.sessionStore);
  if (!session || session.messages.length < MIN_MESSAGES_TO_FREEZE) {
    log.info('Skipping freeze: session below threshold or missing', {
      messageCount: session?.messages.length ?? 0,
    });
    return null;
  }

  const agentMessages = toAgentMessages(session.messages);
  const llmEnabled = Boolean(opts.apiKey && opts.model);

  // 1. Memory extraction (best-effort).
  if (llmEnabled) {
    try {
      const bullets = await runOneOffCompactionCall({
        messages: agentMessages,
        instruction: COMPACTION_MEMORY_INSTRUCTION,
        model: opts.model!,
        apiKey: opts.apiKey!,
        maxTokens: MEMORY_MAX_TOKENS,
        headers: opts.headers,
      });
      if (bullets.trim() && bullets.trim() !== 'NONE') {
        try {
          await appendGlobalMemoryViaVfs(opts.vfs, bullets.trim(), 'new-session');
          log.info('Memory extracted and appended on new-session');
        } catch (err) {
          log.warn('Memory append failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        log.info('Memory extraction returned no durable memories');
      }
    } catch (err) {
      log.warn('Memory extraction call failed (freeze still proceeds)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log.info('LLM unavailable — skipping memory extraction; freezing anyway');
  }

  // 2. Title generation (best-effort).
  let title = '';
  if (llmEnabled) {
    try {
      const raw = await runOneOffCompactionCall({
        messages: agentMessages,
        instruction: COMPACTION_TITLE_INSTRUCTION,
        model: opts.model!,
        apiKey: opts.apiKey!,
        maxTokens: TITLE_MAX_TOKENS,
        headers: opts.headers,
      });
      title = cleanTitle(raw);
    } catch (err) {
      log.warn('Title generation call failed (using heuristic)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!title) title = heuristicTitle(session.messages);

  // 3. Write the archive and update the index. Archive is markdown — same
  //    format the chat-panel uses for the "copy chat history" long-press,
  //    plus a small YAML-style header for the freezer's own metadata.
  const frozenAt = new Date().toISOString();
  const filename = `${frozenAt.replace(/[:.]/g, '-')}-${slugify(title)}.md`;
  const archive: FrozenSessionArchive = {
    id: session.id,
    title,
    frozenAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    messages: session.messages,
  };
  const archiveMarkdown = formatArchiveAsMarkdown(archive);
  const indexEntry: FrozenSessionIndexEntry = {
    filename,
    title,
    frozenAt,
    messageCount: session.messages.length,
  };
  try {
    await ensureDir(opts.vfs, SESSIONS_DIR);
    await opts.vfs.writeFile(`${SESSIONS_DIR}/${filename}`, archiveMarkdown);
    await updateSessionsIndex(opts.vfs, indexEntry);
    // LightningFS debounces superblock saves — `location.reload()` after
    // this returns would race the debounce timer and orphan the new
    // /sessions/ directory inode. Force a flush so the writes are
    // durable on IDB before the caller reloads.
    await opts.vfs.flush();
    log.info('Cone session frozen', { filename, title, messageCount: session.messages.length });
    return { ...indexEntry, archive };
  } catch (err) {
    log.warn('Failed to write frozen session to VFS', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function loadSessionSafely(store: SessionStore): Promise<Session | null> {
  try {
    return await store.load('session-cone');
  } catch (err) {
    log.warn('Failed to load session-cone', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Lift ChatMessage[] (UI shape) into a minimal AgentMessage[] suitable for
 * `runOneOffCompactionCall`'s serializer. We drop tool-call detail and
 * attachments — for memory extraction and titling, the plain conversation
 * text is what matters.
 */
function toAgentMessages(messages: ChatMessage[]): AgentMessage[] {
  return messages.map(
    (m) =>
      ({
        role: m.role,
        content: [{ type: 'text', text: m.content }],
        timestamp: m.timestamp,
      }) as unknown as AgentMessage
  );
}

/**
 * Render the archive as markdown. Header is a small YAML-style block carrying
 * the metadata that used to live in the JSON envelope (so a future "thaw"
 * action can rehydrate timestamps without parsing the body); the body itself
 * is the same markdown the chat-panel produces for the "copy chat history"
 * long-press gesture.
 */
function formatArchiveAsMarkdown(archive: FrozenSessionArchive): string {
  const header =
    `---\n` +
    `id: ${archive.id}\n` +
    `title: ${JSON.stringify(archive.title)}\n` +
    `frozenAt: ${archive.frozenAt}\n` +
    `createdAt: ${archive.createdAt}\n` +
    `updatedAt: ${archive.updatedAt}\n` +
    `messageCount: ${archive.messageCount}\n` +
    `---\n\n` +
    `# ${archive.title}\n\n`;
  return header + formatChatForClipboard(archive.messages);
}

function cleanTitle(raw: string): string {
  let t = raw.trim();
  // Strip surrounding quotes if the model added any
  t = t.replace(/^["'`]+|["'`]+$/g, '').trim();
  // Collapse whitespace, drop newlines (titles should be one line)
  t = t.replace(/\s+/g, ' ');
  // Hard cap so very chatty models don't blow out the filename
  if (t.length > 80) t = t.slice(0, 80).trimEnd();
  return t;
}

function heuristicTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser || !firstUser.content) return 'untitled-session';
  const head = firstUser.content.trim().replace(/\s+/g, ' ');
  return head.length > 60 ? `${head.slice(0, 60)}…` : head || 'untitled-session';
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'session';
}

async function ensureDir(vfs: VirtualFS, path: string): Promise<void> {
  try {
    await vfs.mkdir(path, { recursive: true });
  } catch {
    // Already exists or unsupported — writeFile will surface the real error.
  }
}

async function appendGlobalMemoryViaVfs(
  vfs: VirtualFS,
  bullets: string,
  source: string
): Promise<void> {
  const path = '/shared/CLAUDE.md';
  let current = '';
  try {
    const raw = await vfs.readFile(path, { encoding: 'utf-8' });
    current = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    // File doesn't exist yet — we'll create it via writeFile below.
    await ensureDir(vfs, '/shared');
  }
  const date = new Date().toISOString().slice(0, 10);
  const heading = `## Auto-extracted (${date}, ${source})`;
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  const block = `${separator}\n${heading}\n\n${bullets}\n`;
  await vfs.writeFile(path, current + block);
}

async function updateSessionsIndex(
  vfs: VirtualFS,
  newEntry: FrozenSessionIndexEntry
): Promise<void> {
  let existing: FrozenSessionIndexEntry[] = [];
  try {
    const raw = await vfs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) existing = parsed as FrozenSessionIndexEntry[];
  } catch {
    // No index yet, or malformed — start fresh.
  }
  // Newest first.
  const updated = [newEntry, ...existing.filter((e) => e.filename !== newEntry.filename)];
  await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
}

/** Read the sessions index (or empty array if missing/malformed). */
export async function readSessionsIndex(vfs: VirtualFS): Promise<FrozenSessionIndexEntry[]> {
  try {
    const raw = await vfs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as FrozenSessionIndexEntry[]) : [];
  } catch {
    return [];
  }
}

/** Path to the archive JSON for a given index entry. Useful for "open in Files" actions. */
export function frozenSessionPath(entry: FrozenSessionIndexEntry): string {
  return `${SESSIONS_DIR}/${entry.filename}`;
}
