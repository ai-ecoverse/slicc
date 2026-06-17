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
 *        - Memory extraction → append bullets to /workspace/CLAUDE.md.
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

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { hasIcon } from '@slicc/webcomponents/icons';
import {
  COMPACTION_MEMORY_INSTRUCTION,
  COMPACTION_TITLE_INSTRUCTION,
  runOneOffCompactionCall,
} from '../core/context-compaction.js';
import { createLogger } from '../core/logger.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';
import { applyConeMemoryBudget } from '../scoops/cone-memory-budget.js';
import { formatChatForClipboard } from './chat-clipboard.js';
import type { SessionStore } from './session-store.js';
import type { ChatMessage, Session } from './types.js';

const log = createLogger('session-freezer');

/** Minimum cone message count before we bother freezing or extracting memory. */
const MIN_MESSAGES_TO_FREEZE = 4;

/** Max output tokens for the memory call — bullets, not a structured doc. */
const MEMORY_MAX_TOKENS = 2048;

/** Max output tokens for the title call — a short label. */
const TITLE_MAX_TOKENS = 40;

/** Where session archives and the index live. */
const SESSIONS_DIR = '/sessions';
export const SESSIONS_INDEX_PATH = '/sessions/index.json';

export interface FrozenSessionIndexEntry {
  /** Filename within /sessions/, e.g. "2026-05-13T19-30-00Z-fix-build.json". */
  filename: string;
  /** Human-readable title from the LLM, or a heuristic fallback. */
  title: string;
  /** ISO timestamp when the freeze happened. */
  frozenAt: string;
  /** Count of messages in the frozen session. */
  messageCount: number;
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
  /**
   * Writable VFS handle. Under `slicc_opfs_vfs === 'opfs'` AND on the
   * OPFS-leader tab, callers pass a `RemoteWritableVfsClient` so
   * writes route to the worker's `VfsRpcHost` and hit the canonical
   * OPFS store. With the flag off the existing page-side `VirtualFS`
   * satisfies the same shape structurally, keeping behavior
   * byte-identical.
   */
  vfs: WritableVfsClient;
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
  /**
   * Freeze mode. `'full'` (default) runs the memory + title LLM calls
   * synchronously before writing. `'quick'` skips both calls, writes the
   * archive under a synthetic `pending-<short-id>.md` filename with the
   * heuristic title, and marks the index entry `pendingEnrichment: true`
   * so a boot-time scanner can finish the enrichment in the background
   * after the next reload.
   */
  mode?: 'full' | 'quick';
  /**
   * Injectable lucide icon picker (tests). Defaults to the page-side
   * `pickLucideIcon` from `quick-llm.js`. Only consulted when the LLM
   * calls are enabled (`mode: 'full'` with model + apiKey).
   */
  pickIcon?: (opts: { subject: string }) => Promise<string | null>;
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
  const mode = opts.mode ?? 'full';
  // Quick mode skips both LLM calls outright — same effect as `llmEnabled=false`
  // but additionally marks the index entry as needing later enrichment.
  const llmEnabled = mode === 'full' && Boolean(opts.apiKey && opts.model);

  await extractMemoriesBestEffort(opts, agentMessages, llmEnabled);
  const title =
    (await generateTitleBestEffort(opts, agentMessages, llmEnabled)) ||
    heuristicTitle(session.messages);
  const icon = llmEnabled ? await pickIconBestEffort(opts, title) : undefined;
  return await writeFrozenArchive(opts, session, title, mode, icon);
}

/**
 * Freeze step 2b — pick a lucide rail icon for the thread from its title
 * (best-effort; `undefined` on failure — the card keeps its snowflake and
 * the rail's lazy enrichment can retry later).
 */
async function pickIconBestEffort(
  opts: FreezeConeSessionOptions,
  title: string
): Promise<string | undefined> {
  try {
    const pick = opts.pickIcon ?? (await import('./quick-llm.js')).pickLucideIcon;
    const picked = (await pick({ subject: `"${title}" — an archived chat session` })) ?? undefined;
    return keepIfLucide(picked);
  } catch (err) {
    log.warn('Icon pick failed (freeze still proceeds)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Validation gate at the recording boundary: drop any picked name that isn't
 * a real lucide registry entry so a non-lucide string never reaches the index
 * (the card then falls back to its snowflake / lazy backfill). The injectable
 * `pickIcon` seam can return any string, so we validate against the shared
 * `hasIcon` registry check used by the default picker.
 */
function keepIfLucide(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return hasIcon(name) ? name : undefined;
}

/** Freeze step 1 — memory extraction (best-effort; failures never block). */
async function extractMemoriesBestEffort(
  opts: FreezeConeSessionOptions,
  agentMessages: AgentMessage[],
  llmEnabled: boolean
): Promise<void> {
  if (!llmEnabled) {
    log.info('LLM unavailable — skipping memory extraction; freezing anyway');
    return;
  }
  let bullets = '';
  try {
    bullets = await runOneOffCompactionCall({
      messages: agentMessages,
      instruction: COMPACTION_MEMORY_INSTRUCTION,
      model: opts.model!,
      apiKey: opts.apiKey!,
      maxTokens: MEMORY_MAX_TOKENS,
      headers: opts.headers,
    });
  } catch (err) {
    log.warn('Memory extraction call failed (freeze still proceeds)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!bullets.trim() || bullets.trim() === 'NONE') {
    log.info('Memory extraction returned no durable memories');
    return;
  }
  try {
    await appendConeMemoryViaVfs(opts.vfs, bullets.trim(), 'new-session', {
      model: opts.model,
      apiKey: opts.apiKey,
      headers: opts.headers,
    });
    log.info('Memory extracted and appended on new-session');
  } catch (err) {
    log.warn('Memory append failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Freeze step 2 — LLM title (best-effort; empty string on failure). */
async function generateTitleBestEffort(
  opts: FreezeConeSessionOptions,
  agentMessages: AgentMessage[],
  llmEnabled: boolean
): Promise<string> {
  if (!llmEnabled) return '';
  try {
    const raw = await runOneOffCompactionCall({
      messages: agentMessages,
      instruction: COMPACTION_TITLE_INSTRUCTION,
      model: opts.model!,
      apiKey: opts.apiKey!,
      maxTokens: TITLE_MAX_TOKENS,
      headers: opts.headers,
    });
    return cleanTitle(raw);
  } catch (err) {
    log.warn('Title generation call failed (using heuristic)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

/**
 * Freeze step 3 — write the archive markdown and update the index. Quick
 * mode uses a synthetic `pending-<short-id>.md` filename so a later
 * enrichment pass can rename to the canonical `<timestamp>-<slug>.md` form
 * once the LLM-derived title is known.
 */
async function writeFrozenArchive(
  opts: FreezeConeSessionOptions,
  session: Session,
  title: string,
  mode: 'full' | 'quick',
  icon?: string
): Promise<FrozenSession | null> {
  const frozenAt = new Date().toISOString();
  const filename =
    mode === 'quick'
      ? `pending-${pendingShortId()}.md`
      : `${frozenAt.replace(/[:.]/g, '-')}-${slugify(title)}.md`;
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
    ...(icon ? { icon } : {}),
    ...(mode === 'quick' ? { pendingEnrichment: true } : {}),
  };
  try {
    await ensureDir(opts.vfs, SESSIONS_DIR);
    await opts.vfs.writeFile(`${SESSIONS_DIR}/${filename}`, archiveMarkdown);
    await updateSessionsIndex(opts.vfs, indexEntry);
    // The WC new-session flow clears the chat in-place (no `location.reload()`),
    // but the OPFS backend still persists on its own debounce; force a flush so
    // the archive + index are durable before the caller proceeds to clear the
    // cone (and, on the single-click "save" path, before any LLM enrichment runs).
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

/** Markers for the embedded structured-data block. */
const SESSION_DATA_START = '<!-- slicc:session-data\n';
const SESSION_DATA_END = '\n-->';

/**
 * Strip ephemeral fields that should never survive into a frozen archive
 * (transient pointers held only for the live render). What's left is a
 * pure data shape suitable for JSON round-trip and re-render.
 */
function stripEphemeral(messages: ChatMessage[]): ChatMessage[] {
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
function formatArchiveAsMarkdown(archive: FrozenSessionArchive): string {
  const header =
    `---\n` +
    `id: ${archive.id}\n` +
    `title: ${JSON.stringify(archive.title)}\n` +
    `frozenAt: ${archive.frozenAt}\n` +
    `createdAt: ${archive.createdAt}\n` +
    `updatedAt: ${archive.updatedAt}\n` +
    `messageCount: ${archive.messageCount}\n` +
    `---\n\n`;
  // Escape the only sequence that would prematurely close an HTML comment.
  const dataJson = JSON.stringify(stripEphemeral(archive.messages)).replace(/-->/g, '-- >');
  const dataBlock = `${SESSION_DATA_START}${dataJson}${SESSION_DATA_END}\n\n`;
  const title = `# ${archive.title}\n\n`;
  return header + dataBlock + title + formatChatForClipboard(archive.messages);
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
  if (!firstUser?.content) return 'untitled-session';
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

/**
 * Short, unique-enough id used in quick-mode pending filenames. Pairs a
 * base-36 timestamp with a few random characters so multiple pending
 * freezes within the same millisecond still collide-free.
 */
function pendingShortId(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${time}-${rand}`;
}

async function ensureDir(vfs: WritableVfsClient, path: string): Promise<void> {
  try {
    await vfs.mkdir(path, { recursive: true });
  } catch {
    // Already exists or unsupported — writeFile will surface the real error.
  }
}

/**
 * Append auto-extracted bullets to `/workspace/CLAUDE.md`, then route through
 * the logarithmic memory budget (`applyConeMemoryBudget`) so a long-running
 * series of freezer/enrichment appends gets restructured the same way the
 * orchestrator's compaction-driven `appendConeMemory` path does. The budget
 * step is best-effort — credentials are optional; when missing or when the
 * sink throws, the appended bullets stay on disk and we just log.
 */
async function appendConeMemoryViaVfs(
  vfs: WritableVfsClient,
  bullets: string,
  source: string,
  budgetOpts?: {
    model?: Parameters<typeof applyConeMemoryBudget>[0]['model'];
    apiKey?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }
): Promise<void> {
  const path = '/workspace/CLAUDE.md';
  let current = '';
  try {
    const raw = await vfs.readFile(path, { encoding: 'utf-8' });
    current = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    // File doesn't exist yet — we'll create it via writeFile below.
    await ensureDir(vfs, '/workspace');
  }
  const date = new Date().toISOString().slice(0, 10);
  const heading = `## Auto-extracted (${date}, ${source})`;
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  const block = `${separator}\n${heading}\n\n${bullets}\n`;
  await vfs.writeFile(path, current + block);

  // Post-append budget step. Symmetric to the orchestrator path —
  // bound `/workspace/CLAUDE.md` against the logarithmic budget when
  // credentials are wired through. Failures are swallowed by the sink
  // itself, but wrap in try/catch defensively so a thrown error never
  // escapes the freezer.
  try {
    await applyConeMemoryBudget({
      vfs,
      model: budgetOpts?.model,
      apiKey: budgetOpts?.apiKey,
      headers: budgetOpts?.headers,
      signal: budgetOpts?.signal,
    });
  } catch (err) {
    log.warn('Cone memory budget step threw (append already committed)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function updateSessionsIndex(
  vfs: WritableVfsClient,
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
 * Subset of the sessions index that still needs the LLM-driven enrichment
 * pass (memory extraction + title rewrite). Returns `[]` when the index
 * is missing, empty, or malformed — never throws. Read-only, so typed
 * against `LocalVfsClient`.
 */
export async function listPendingEnrichments(
  vfs: LocalVfsClient
): Promise<FrozenSessionIndexEntry[]> {
  const all = await readSessionsIndex(vfs);
  return all.filter((e) => e.pendingEnrichment === true);
}

export interface EnrichPendingSessionOptions {
  /** Active LLM model — required for both LLM calls. */
  model: Model<Api>;
  /** API key for the active provider. */
  apiKey: string;
  /** Adobe X-Session-Id and friends — forwarded to both LLM calls. */
  headers?: Record<string, string>;
  /**
   * Optional lucide icon picker. When provided, enrichment picks a rail
   * icon from the LLM title and records it on the renamed index entry —
   * so the single-click "save" path lands a fully-enriched archive (real
   * slug + icon) without waiting for the rail's lazy backfill. Omitted by
   * the boot-time pass, which leaves icons to the rail's lazy enrichment.
   */
  pickIcon?: (opts: { subject: string }) => Promise<string | null>;
}

/**
 * Finish a quick-frozen archive: re-run the two compaction calls over
 * the archived messages, append extracted memories to /shared/CLAUDE.md,
 * rewrite the archive's frontmatter + heading with the LLM title, then
 * rename the file from `pending-…md` to the canonical
 * `<timestamp>-<slug>.md` form. The matching index entry has its
 * `pendingEnrichment` flag dropped and `title` + `filename` updated.
 *
 * Best-effort end to end: every step is wrapped in try/catch and a
 * failure leaves the pending entry intact so the next boot retries.
 * Idempotent: running twice on the same entry (e.g. after the rename
 * already happened, or against a missing file) is a silent no-op.
 *
 * Returns the updated index entry on success, `null` on no-op / failure.
 */
export async function enrichPendingSession(
  vfs: WritableVfsClient,
  entry: FrozenSessionIndexEntry,
  opts: EnrichPendingSessionOptions
): Promise<FrozenSessionIndexEntry | null> {
  // 1. Idempotency guard — entry no longer pending, nothing to do.
  if (!entry.pendingEnrichment) {
    return null;
  }
  const archiveContent = await readPendingArchive(vfs, entry);
  if (archiveContent === null) return null;
  const agentMessages = recoverPendingMessages(entry, archiveContent);
  if (agentMessages === null) return null;
  const calls = await runEnrichmentCalls(entry, agentMessages, opts);
  if (calls === null) return null;
  // Pick the icon BEFORE appending memory: the pick is a read-only LLM call
  // that can hang, while the append is non-idempotent. Running it first means
  // a hung/aborted pick leaves the archive cleanly pending with NO memory
  // written yet, so the boot retry runs once with no duplicate memory.
  const icon = await pickEnrichmentIcon(opts, calls.newTitle);
  await appendEnrichmentMemory(vfs, entry, calls.bullets, opts);
  return await commitEnrichedArchive(vfs, entry, archiveContent, calls.newTitle, icon);
}

/**
 * Enrichment step 5b — pick a lucide rail icon from the LLM title
 * (best-effort; `undefined` on failure or when no picker was supplied).
 * Only the single-click "save" path passes `pickIcon`; the boot pass
 * leaves icons to the rail's lazy backfill.
 */
async function pickEnrichmentIcon(
  opts: EnrichPendingSessionOptions,
  title: string
): Promise<string | undefined> {
  if (!opts.pickIcon) return undefined;
  try {
    const picked =
      (await opts.pickIcon({ subject: `"${title}" — an archived chat session` })) ?? undefined;
    return await keepIfLucide(picked);
  } catch (err) {
    log.warn('Enrichment icon pick failed (continuing without icon)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Enrichment step 2 — load the archive. Missing file → already renamed (or
 * wiped) → no-op. Any other read failure (permission, IO, etc.) is a real
 * error: log it as a warn so it shows up in the console, but still return
 * null and leave the entry pending so the next boot retries.
 */
async function readPendingArchive(
  vfs: WritableVfsClient,
  entry: FrozenSessionIndexEntry
): Promise<string | null> {
  try {
    const raw = await vfs.readFile(frozenSessionPath(entry), { encoding: 'utf-8' });
    return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') {
      log.info('Pending archive missing — treating as already enriched', {
        filename: entry.filename,
      });
    } else {
      log.warn('Failed to read pending archive (entry stays pending)', {
        filename: entry.filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

/** Enrichment step 3 — recover the messages so the LLM calls can re-run. */
function recoverPendingMessages(
  entry: FrozenSessionIndexEntry,
  archiveContent: string
): AgentMessage[] | null {
  let messages: ChatMessage[];
  try {
    messages = parseFrozenArchive(archiveContent).messages;
  } catch (err) {
    log.warn('Failed to parse pending archive — leaving entry intact', {
      filename: entry.filename,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (messages.length === 0) {
    log.info('Pending archive has no messages — skipping enrichment', {
      filename: entry.filename,
    });
    return null;
  }
  return toAgentMessages(messages);
}

/**
 * Enrichment step 4 — run BOTH LLM calls before mutating anything. If
 * either fails the pending entry stays put for the next retry; if memory
 * succeeded but title failed we'd otherwise duplicate memory bullets on
 * every boot, which is worse than waiting one more retry.
 */
async function runEnrichmentCalls(
  entry: FrozenSessionIndexEntry,
  agentMessages: AgentMessage[],
  opts: EnrichPendingSessionOptions
): Promise<{ bullets: string; newTitle: string } | null> {
  let bullets = '';
  try {
    bullets = await runOneOffCompactionCall({
      messages: agentMessages,
      instruction: COMPACTION_MEMORY_INSTRUCTION,
      model: opts.model,
      apiKey: opts.apiKey,
      maxTokens: MEMORY_MAX_TOKENS,
      headers: opts.headers,
    });
  } catch (err) {
    log.warn('Enrichment memory call failed (entry stays pending)', {
      filename: entry.filename,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  let newTitle = '';
  try {
    const raw = await runOneOffCompactionCall({
      messages: agentMessages,
      instruction: COMPACTION_TITLE_INSTRUCTION,
      model: opts.model,
      apiKey: opts.apiKey,
      maxTokens: TITLE_MAX_TOKENS,
      headers: opts.headers,
    });
    newTitle = cleanTitle(raw);
  } catch (err) {
    log.warn('Enrichment title call failed (entry stays pending)', {
      filename: entry.filename,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!newTitle) {
    log.info('Enrichment title call returned empty — entry stays pending', {
      filename: entry.filename,
    });
    return null;
  }
  return { bullets, newTitle };
}

/** Enrichment step 5 — append memory bullets (best-effort). */
async function appendEnrichmentMemory(
  vfs: WritableVfsClient,
  entry: FrozenSessionIndexEntry,
  bullets: string,
  opts: EnrichPendingSessionOptions
): Promise<void> {
  const trimmedBullets = bullets.trim();
  if (!trimmedBullets || trimmedBullets === 'NONE') return;
  try {
    await appendConeMemoryViaVfs(vfs, trimmedBullets, 'pending-enrichment', {
      model: opts.model,
      apiKey: opts.apiKey,
      headers: opts.headers,
    });
  } catch (err) {
    log.warn('Enrichment memory append failed (continuing with title rewrite)', {
      filename: entry.filename,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Enrichment steps 6–8 — rewrite the archive title, write under the new
 * canonical name, update the index, then drop the old pending file last.
 * This ordering keeps the index consistent with what's on disk even if
 * the final unlink fails — at worst we leak a stale pending-… file,
 * no data loss.
 */
async function commitEnrichedArchive(
  vfs: WritableVfsClient,
  entry: FrozenSessionIndexEntry,
  archiveContent: string,
  newTitle: string,
  icon?: string
): Promise<FrozenSessionIndexEntry | null> {
  const oldPath = frozenSessionPath(entry);
  const newContent = rewriteArchiveTitle(archiveContent, newTitle);
  const newFilename = `${entry.frozenAt.replace(/[:.]/g, '-')}-${slugify(newTitle)}.md`;
  const newPath = `${SESSIONS_DIR}/${newFilename}`;
  try {
    await ensureDir(vfs, SESSIONS_DIR);
    await vfs.writeFile(newPath, newContent);
  } catch (err) {
    log.warn('Enrichment write failed (entry stays pending)', {
      filename: entry.filename,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Carry a freshly-picked icon (single-click "save" path) or preserve an
  // existing one; absent on the boot pass, where the rail backfills lazily.
  const resolvedIcon = icon ?? entry.icon;
  const updatedEntry: FrozenSessionIndexEntry = {
    filename: newFilename,
    title: newTitle,
    frozenAt: entry.frozenAt,
    messageCount: entry.messageCount,
    ...(resolvedIcon ? { icon: resolvedIcon } : {}),
  };
  try {
    await replaceIndexEntry(vfs, entry.filename, updatedEntry);
  } catch (err) {
    log.warn('Enrichment index update failed (entry may stay pending)', {
      filename: entry.filename,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (newPath !== oldPath) {
    try {
      await vfs.rm(oldPath);
    } catch (err) {
      log.info('Stale pending archive cleanup failed (harmless)', {
        oldPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  try {
    await vfs.flush();
  } catch {
    // flush is best-effort — IDB will persist on its own debounce.
  }
  log.info('Pending session enriched', {
    oldFilename: entry.filename,
    newFilename,
    title: newTitle,
  });
  return updatedEntry;
}

/**
 * Replace the `title:` value in the frontmatter (and the leading `# title`
 * heading in the body) of a freezer-shaped archive markdown string with
 * the LLM-derived title. When the frontmatter regex doesn't match, the
 * original content is returned unchanged — callers are expected to hand
 * in archive-shaped content (well-formed `---\n…\n---\n…` frontmatter)
 * produced by `formatArchiveAsMarkdown`. A silent rewrite of malformed
 * archives could corrupt user data, so the no-match path intentionally
 * does nothing rather than appending a synthesized header.
 */
function rewriteArchiveTitle(content: string, newTitle: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return content;
  const fm = fmMatch[1].replace(/^title:\s*.+$/m, `title: ${JSON.stringify(newTitle)}`);
  let body = fmMatch[2];
  body = body.replace(/^#\s+[^\n]*$/m, `# ${newTitle}`);
  return `---\n${fm}\n---\n${body}`;
}

/**
 * Promise-chain mutex serializing every `replaceIndexEntry` call within
 * this module. The sessions index is a single shared JSON file with a
 * read-modify-write update; two concurrent callers (e.g. the boot-time
 * background enrichment scanner racing a freshly-quick-frozen entry)
 * would otherwise read the same stale snapshot and clobber one of the
 * writes. Cross-tab concurrency is out of scope — the app runs in a
 * single context.
 */
let indexWriteChain: Promise<void> = Promise.resolve();

/**
 * Swap one entry in the sessions index by filename. Used by the
 * enrichment pass to flip a `pending-…` entry over to its renamed
 * canonical form. Always dedupes by `replacement.filename` so a row
 * with the same target name is never duplicated when `oldFilename`
 * isn't found in the index. Writes are serialized via {@link indexWriteChain}.
 */
async function replaceIndexEntry(
  vfs: WritableVfsClient,
  oldFilename: string,
  replacement: FrozenSessionIndexEntry
): Promise<void> {
  const run = async (): Promise<void> => {
    let existing: FrozenSessionIndexEntry[] = [];
    try {
      const raw = await vfs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) existing = parsed as FrozenSessionIndexEntry[];
    } catch {
      // No index — nothing to replace; write the entry as the only row so
      // the rename is still visible to the panel on next reload.
    }
    const idx = existing.findIndex((e) => e.filename === oldFilename);
    let updated: FrozenSessionIndexEntry[];
    if (idx === -1) {
      // Old entry not in the index — prepend the replacement, but strip
      // any pre-existing row already pointing at `replacement.filename`
      // so concurrent rename-then-replace flows don't leave duplicates.
      updated = [replacement, ...existing.filter((e) => e.filename !== replacement.filename)];
    } else {
      updated = existing.slice();
      updated[idx] = replacement;
      // Drop any other row sharing the replacement's filename (e.g. the
      // canonical row already exists alongside the stale pending one).
      updated = updated.filter((e, i) => i === idx || e.filename !== replacement.filename);
    }
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
  };
  // Append to the shared chain so writers run strictly in arrival order.
  // `.catch(() => {})` keeps a failed write from poisoning the chain for
  // subsequent callers; each call still surfaces its own error via the
  // returned `next` promise below.
  const next = indexWriteChain.then(run, run);
  indexWriteChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
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
export function parseFrozenArchive(markdown: string): {
  title: string;
  messages: ChatMessage[];
} {
  let body = markdown;
  let title = 'Untitled';

  // 1. Strip YAML-style frontmatter and pull out the title.
  //    The writer emits `title: ${JSON.stringify(value)}`, which means
  //    quoted titles can contain `\"` and `\\` escapes (e.g. a title
  //    like `Debug "Auth" bug`). Parse the value as JSON when it starts
  //    with a quote so embedded escapes round-trip cleanly; fall back
  //    to a raw read for unquoted scalars.
  const fmMatch = body.match(/^---\n([\s\S]*?)\n---\n+/);
  if (fmMatch) {
    body = body.slice(fmMatch[0].length);
    const titleLine = fmMatch[1].match(/^title:\s*(.+?)\s*$/m);
    if (titleLine) {
      const raw = titleLine[1].trim();
      if (raw.startsWith('"')) {
        try {
          // JSON.parse handles \", \\, \n, \uXXXX, etc. — same escapes
          // JSON.stringify produced on the way in.
          const decoded = JSON.parse(raw);
          if (typeof decoded === 'string') title = decoded;
        } catch {
          // Malformed quoted value — strip surrounding quotes as a last resort.
          title = raw.replace(/^"|"$/g, '');
        }
      } else {
        title = raw;
      }
    }
  }

  // 2. Prefer the embedded structured-data block when present —
  //    round-trip-rich rendering for tool calls, attachments, etc.
  const dataMatch = body.match(/<!-- slicc:session-data\n([\s\S]*?)\n-->\n*/);
  if (dataMatch) {
    try {
      const restored = dataMatch[1].replace(/-- >/g, '-->');
      const parsed = JSON.parse(restored);
      if (Array.isArray(parsed)) {
        return { title, messages: parsed as ChatMessage[] };
      }
    } catch {
      // Malformed block — fall through to text parser.
    }
    // Strip the block before the text parser sees it.
    body = body.replace(/<!-- slicc:session-data\n[\s\S]*?\n-->\n*/, '');
  }

  // 3. Drop the leading `# title` heading if present.
  body = body.replace(/^#\s+[^\n]*\n+/, '');

  return { title, messages: parseHeadingFallback(body) };
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
