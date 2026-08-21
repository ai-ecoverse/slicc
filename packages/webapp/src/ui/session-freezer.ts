/**
 * Freezer — archive a cone's chat session to the VFS before a "New session"
 * reset clears it from IndexedDB.
 *
 * Flow (all best-effort, never throws past the caller):
 *   1. Load `session-<folder>` for the cone being frozen (`opts.cone`,
 *      defaulting to the primary cone) from the UI SessionStore.
 *   2. If the session is short (< MIN_MESSAGES_TO_FREEZE), skip everything
 *      and return null — nothing meaningful to extract or archive.
 *   3. Generate a title and icon, falling back to a heuristic title.
 *   4. Legacy mode extracts memory before writing the archive. Agentic mode
 *      takes a fast quick-mode snapshot (no LLM calls) with durable
 *      `pendingEnrichment` + `memoryPending` markers; its caller clears the
 *      chat immediately and runs title enrichment + the curator in the
 *      background.
 *
 * Scoops are intentionally untouched — they survive a "New session" reset
 * so the fresh cone inherits the existing scoop roster and decides what
 * to do with them.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { hasIcon } from '@slicc/webcomponents/icons';
import { createLogger } from '../base/logger.js';
import {
  COMPACTION_MEMORY_INSTRUCTION,
  COMPACTION_TITLE_INSTRUCTION,
  runOneOffCompactionCall,
} from '../core/context-compaction.js';
import { FsError } from '../fs/types.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';
import type { AgentBridge } from '../scoops/agent-bridge.js';
import { curatorReceiptPath, runAgenticMemoryPass } from '../scoops/agentic-memory.js';
import type { SessionStore } from '../scoops/chat-session-store.js';
import { applyConeMemoryBudget, readSessionCount } from '../scoops/cone-memory-budget.js';
import type {
  FrozenSessionArchive,
  FrozenSessionCost,
  FrozenSessionIndexEntry,
  FrozenSessionModel,
} from '../transcript/frozen-archive-format.js';
import {
  frozenSessionPath,
  parseFrozenArchive,
  readSessionsIndex,
  SESSIONS_DIR,
  SESSIONS_INDEX_PATH,
} from '../transcript/frozen-archive-format.js';
import { chatSessionIdFor, PRIMARY_CONE_FOLDER } from '../work-unit/record.js';
import { formatChatForClipboard } from './chat-clipboard.js';
import type { ChatMessage, Session } from './types.js';

export type {
  FrozenSessionArchive,
  FrozenSessionCost,
  FrozenSessionIndexEntry,
  FrozenSessionModel,
} from '../transcript/frozen-archive-format.js';
// Re-export the archive format so existing UI callers (`wc-freezer.ts`,
// `wc-live.ts`, `new-session.ts`, tests) keep their current import surface.
// The definitions now live at the transcript layer so lower-layer consumers
// (transcript export, cost command) can read the index and parse archives
// without back-edging into this UI-layer module.
export {
  frozenSessionPath,
  parseFrozenArchive,
  readSessionsIndex,
  SESSIONS_INDEX_PATH,
} from '../transcript/frozen-archive-format.js';

const log = createLogger('session-freezer');

/** Minimum cone message count before we bother freezing or extracting memory. */
const MIN_MESSAGES_TO_FREEZE = 4;

/** Max output tokens for the memory call — bullets, not a structured doc. */
const MEMORY_MAX_TOKENS = 2048;

/** Max output tokens for the title call — a short label. */
const TITLE_MAX_TOKENS = 40;

/** Permanently skip a pending archive after this many boot-time attempts. */
export const PENDING_SESSION_ATTEMPT_LIMIT = 3;

/** Where per-freeze attachments land beneath the sessions dir. */
const SESSION_ATTACHMENTS_DIR = `${SESSIONS_DIR}/attachments`;

export interface FrozenSession extends FrozenSessionIndexEntry {
  /** The full archive document written to disk. */
  archive: FrozenSessionArchive;
}

/**
 * The cone a freeze operates on (#2272). Narrow on purpose — the freezer
 * needs the storage folder that keys the chat session plus a label for the
 * rail card, not a whole `RegisteredScoop`. Omitting it targets the primary
 * cone, which is what every pre-#2272 caller meant.
 */
export interface FreezerConeRef {
  /** Storage folder of the root unit: `cone` (primary) or `cone-<slug>`. */
  folder: string;
  /** Chip label of that cone (`assistantLabel`); recorded for extra cones only. */
  label?: string;
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
   * so a boot-time enrichment pass can finish the enrichment in the background
   * after the next reload. (Note: `scheduleBackgroundEnrichment` was removed
   * in #1226 — entries stay `pendingEnrichment: true` until manually re-saved.)
   */
  mode?: 'full' | 'quick';
  /**
   * Injectable lucide icon picker (tests). Defaults to the page-side
   * `pickLucideIcon` from `quick-llm.js`. Only consulted when the LLM
   * calls are enabled (`mode: 'full'` with model + apiKey).
   */
  pickIcon?: (opts: { subject: string }) => Promise<string | null>;
  /**
   * Agent spawn seam supplied only when agentic memory is enabled. Its
   * presence selects the write-first curator path for an LLM-enabled full
   * freeze; quick mode and credential-less freezes remain legacy.
   */
  agenticMemorySpawn?: AgentBridge['spawn'];
  /**
   * Which cone to freeze. Defaults to the primary cone (`session-cone`), so
   * callers that predate multiple cones keep their behaviour verbatim.
   */
  cone?: FreezerConeRef;
}

/**
 * Run the freezer over a cone's session. Returns the entry written (or null
 * if nothing was frozen). Never throws past the caller — every step is
 * wrapped in try/catch so the New Session flow can always proceed to the
 * clear+reload step.
 */
export async function freezeConeSession(
  opts: FreezeConeSessionOptions
): Promise<FrozenSession | null> {
  const session = await loadSessionSafely(opts.sessionStore, coneFolderOf(opts));
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

  // A supplied curator spawn owns memory regardless of mode — the legacy
  // extraction call would double up with the curator's rewrite.
  if (!opts.agenticMemorySpawn) {
    await extractMemoriesBestEffort(opts, agentMessages, llmEnabled);
  }
  const title =
    (await generateTitleBestEffort(opts, agentMessages, llmEnabled)) ||
    heuristicTitle(session.messages);
  const icon = llmEnabled ? await pickIconBestEffort(opts, title) : undefined;
  // The durable `memoryPending` marker is set whenever a curator pass is
  // owed — including the agentic quick-snapshot path, where the caller
  // starts the curator only after the chat has already cleared.
  return await writeFrozenArchive(
    opts,
    session,
    title,
    mode,
    icon,
    Boolean(opts.agenticMemorySpawn)
  );
}

/**
 * Run the curator for an already-durable archive. Success clears the durable
 * pending marker; failure leaves it for a later recovery pass. A failure that
 * is known to have finished retains the existing legacy-extraction fallback.
 */
export async function curateFrozenSessionMemories(
  opts: FreezeConeSessionOptions,
  frozen: FrozenSession
): Promise<FrozenSessionIndexEntry | null> {
  const agentMessages = toAgentMessages(frozen.archive.messages);
  let result: Awaited<ReturnType<typeof runAgenticMemoryPass>>;
  try {
    result = await runAgenticMemoryPass({
      spawn: opts.agenticMemorySpawn!,
      vfs: opts.vfs,
      sessionArchivePath: frozenSessionPath(frozen),
      sessionCount: await readSessionCount(opts.vfs),
    });
  } catch (err) {
    result = {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      legacyFallbackSafe: false,
    };
  }
  if (result.ok) {
    const updated = await clearPendingMarkers(opts.vfs, frozen.filename);
    // The bridge's completion receipt has served its purpose once the
    // marker is durably cleared (or the entry is gone) — drop it so a
    // later catch-up never consumes stale evidence.
    await removeCuratorReceipt(opts.vfs, frozen.filename);
    if (!updated) {
      // The curated memory is already on disk; only the index bookkeeping
      // missed, so there is no work left for a retry to redo.
      log.info('Agentic memory pass completed; index entry already gone', {
        filename: frozen.filename,
      });
      return null;
    }
    delete frozen.memoryPending;
    log.info('Agentic memory pass completed', { filename: frozen.filename });
    return updated;
  }
  if (!result.legacyFallbackSafe) {
    log.warn('Agentic memory pass unfinished — entry stays pending for boot catch-up', {
      filename: frozen.filename,
      reason: result.reason,
      attemptLimit: PENDING_SESSION_ATTEMPT_LIMIT,
    });
    return null;
  }
  log.warn('Agentic memory pass failed after finishing — falling back to legacy extraction', {
    filename: frozen.filename,
    reason: result.reason,
  });
  await extractMemoriesBestEffort(opts, agentMessages, true);
  return null;
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
    const pick = opts.pickIcon ?? (await import('../providers/quick-llm.js')).pickLucideIcon;
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
  icon?: string,
  memoryPending = false
): Promise<FrozenSession | null> {
  const frozenAt = new Date().toISOString();
  // sessionId is generated BEFORE the filename so it is stable across
  // enrichment renames from `pending-…md` to the canonical slug form.
  const sessionId = crypto.randomUUID();
  const filename =
    mode === 'quick'
      ? `pending-${pendingShortId()}.md`
      : `${frozenAt.replace(/[:.]/g, '-')}-${slugify(title)}.md`;
  const usageSummary = summarizeSessionUsage(session.messages);
  // Provenance: which cone this chat came from, so the rail can label the
  // card and a thaw can route back to the right root (#2272). The label is
  // recorded for extra cones only — every primary card would just say
  // `sliccy`.
  const coneFolder = coneFolderOf(opts);
  const provenance = {
    cone: coneFolder,
    ...(coneFolder !== PRIMARY_CONE_FOLDER && opts.cone?.label
      ? { coneLabel: opts.cone.label }
      : {}),
  };
  const indexEntry: FrozenSessionIndexEntry = {
    filename,
    sessionId,
    title,
    frozenAt,
    messageCount: session.messages.length,
    ...(usageSummary ?? {}),
    ...provenance,
    ...(icon ? { icon } : {}),
    ...(mode === 'quick' ? { pendingEnrichment: true } : {}),
    ...(memoryPending ? { memoryPending: true } : {}),
  };
  try {
    await ensureDir(opts.vfs, SESSIONS_DIR);
    const messages = await persistTmpAttachments(
      opts.vfs,
      session.messages,
      filename.replace(/\.md$/, '')
    );
    const archive: FrozenSessionArchive = {
      id: session.id,
      title,
      frozenAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      messages,
      ...(usageSummary ?? {}),
      ...provenance,
    };
    const archiveMarkdown = formatArchiveAsMarkdown(archive);
    await opts.vfs.writeFile(`${SESSIONS_DIR}/${filename}`, archiveMarkdown);
    await updateSessionsIndex(opts.vfs, indexEntry);
    // The WC new-session flow clears the chat in-place (no `location.reload()`),
    // but the OPFS backend still persists on its own debounce; force a flush so
    // the archive + index are durable before the caller proceeds to clear the
    // cone (and, on the single-click "save" path, before any LLM enrichment runs).
    await opts.vfs.flush();
    log.info('Cone session frozen', {
      filename,
      title,
      cone: coneFolder,
      messageCount: session.messages.length,
    });
    return { ...indexEntry, archive };
  } catch (err) {
    log.warn('Failed to write frozen session to VFS', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function summarizeSessionUsage(
  messages: readonly ChatMessage[]
): Pick<FrozenSessionArchive, 'cost' | 'models'> | null {
  const cost: FrozenSessionCost = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = new Map<string, FrozenSessionModel>();
  let hasUsage = false;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const { model, usage } = message;
    if (!model || !usage || !hasFiniteUsage(usage)) return null;
    const usageCost = usage.cost;
    hasUsage = true;
    cost.total += usageCost.total;
    cost.input += usageCost.input;
    cost.output += usageCost.output;
    cost.cacheRead += usageCost.cacheRead;
    cost.cacheWrite += usageCost.cacheWrite;
    const existing = models.get(model) ?? {
      model,
      cost: 0,
      turns: 0,
      tokens: 0,
    };
    existing.cost += usageCost.total;
    existing.turns += 1;
    existing.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    models.set(model, existing);
  }
  if (!hasUsage) return null;
  return { cost, models: [...models.values()].sort((a, b) => b.cost - a.cost) };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasFiniteUsage(usage: NonNullable<ChatMessage['usage']>): boolean {
  const { cost } = usage;
  return (
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(isFiniteNumber) &&
    [cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total].every(isFiniteNumber)
  );
}

async function persistTmpAttachments(
  vfs: WritableVfsClient,
  messages: ChatMessage[],
  archiveKey: string
): Promise<ChatMessage[]> {
  const context: TmpAttachmentArchiveContext = {
    vfs,
    archiveDir: `${SESSION_ATTACHMENTS_DIR}/${archiveKey}`,
    copiedPaths: new Map(),
    fileIndex: 0,
  };
  const archived: ChatMessage[] = [];
  for (const message of messages) {
    if (!message.attachments?.some(isPathOnlyTmpAttachment)) {
      archived.push(message);
      continue;
    }
    const attachments: SessionAttachment[] = [];
    for (const attachment of message.attachments) {
      attachments.push(await persistTmpAttachment(context, attachment));
    }
    archived.push({ ...message, attachments });
  }
  return archived;
}

type SessionAttachment = NonNullable<ChatMessage['attachments']>[number];

interface TmpAttachmentArchiveContext {
  vfs: WritableVfsClient;
  archiveDir: string;
  copiedPaths: Map<string, string>;
  fileIndex: number;
}

async function persistTmpAttachment(
  context: TmpAttachmentArchiveContext,
  attachment: SessionAttachment
): Promise<SessionAttachment> {
  if (!isPathOnlyTmpAttachment(attachment)) return attachment;
  const existing = context.copiedPaths.get(attachment.path);
  if (existing) return { ...attachment, path: existing };
  const bytes = await readTmpAttachmentBytes(context.vfs, attachment.path);
  if (!bytes) return unavailableTmpAttachment(attachment);
  const safeName = attachment.name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'attachment';
  const archivedPath = `${context.archiveDir}/${context.fileIndex++}-${safeName}`;
  await ensureDir(context.vfs, context.archiveDir);
  await context.vfs.writeFile(archivedPath, bytes);
  context.copiedPaths.set(attachment.path, archivedPath);
  return { ...attachment, path: archivedPath };
}

async function readTmpAttachmentBytes(
  vfs: WritableVfsClient,
  path: string
): Promise<Uint8Array | null> {
  try {
    if (!(await isSafeTmpFile(vfs, path))) return null;
    const bytes = await vfs.readFile(path, { encoding: 'binary' });
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`Expected binary attachment content at ${path}`);
    }
    return bytes;
  } catch {
    return null;
  }
}

function isPathOnlyTmpAttachment(
  attachment: SessionAttachment
): attachment is SessionAttachment & { path: string } {
  return (
    typeof attachment.path === 'string' &&
    attachment.path.startsWith('/tmp/') &&
    attachment.data === undefined &&
    attachment.text === undefined
  );
}

async function isSafeTmpFile(vfs: WritableVfsClient, path: string): Promise<boolean> {
  const parts = path.split('/').slice(1);
  if (
    parts.length < 2 ||
    parts[0] !== 'tmp' ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    return false;
  }
  let parent = '/';
  for (let index = 0; index < parts.length; index += 1) {
    const entry = (await vfs.readDir(parent)).find((candidate) => candidate.name === parts[index]);
    if (!entry) return false;
    if (index === parts.length - 1) return entry.type === 'file';
    if (entry.type !== 'directory') return false;
    parent = parent === '/' ? `/${parts[index]}` : `${parent}/${parts[index]}`;
  }
  return false;
}

function unavailableTmpAttachment(attachment: SessionAttachment): SessionAttachment {
  const { path: _path, ...withoutPath } = attachment;
  return {
    ...withoutPath,
    error: attachment.error ?? 'Archived attachment file is missing or unsafe to preserve.',
  };
}

/** Folder of the cone a freeze targets — the primary cone unless told otherwise. */
function coneFolderOf(opts: Pick<FreezeConeSessionOptions, 'cone'>): string {
  return opts.cone?.folder || PRIMARY_CONE_FOLDER;
}

async function loadSessionSafely(store: SessionStore, folder: string): Promise<Session | null> {
  const sessionId = chatSessionIdFor({ folder });
  try {
    return await store.load(sessionId);
  } catch (err) {
    log.warn('Failed to load cone chat session', {
      sessionId,
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
  const usageFrontmatter =
    (archive.cost ? `cost: ${JSON.stringify(archive.cost)}\n` : '') +
    (archive.models ? `models: ${JSON.stringify(archive.models)}\n` : '');
  // Cone provenance rides the archive too, so a rebuild from `/sessions/*.md`
  // (corrupt index) recovers it. The label is user text — quote it like the
  // title so newlines and quotes round-trip.
  const coneFrontmatter =
    (archive.cone ? `cone: ${archive.cone}\n` : '') +
    (archive.coneLabel ? `coneLabel: ${JSON.stringify(archive.coneLabel)}\n` : '');
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

/**
 * Whether a filename is a quick-mode draft name (and so safe to rename once
 * the real title is known). Canonical `<timestamp>-<slug>.md` names are final:
 * the rail, deep links, and snapshot lookups all key off them.
 */
function isPendingDraftFilename(filename: string): boolean {
  return filename.startsWith('pending-');
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
  } catch (err) {
    // Only treat "file doesn't exist yet" as empty. Anything else (transient
    // OPFS fault, RestrictedFS EACCES, mount-backed I/O error) MUST propagate
    // to the caller's outer catch — otherwise the unconditional writeFile below
    // would clobber existing durable memory with just the new bullets. Mirrors
    // the ENOENT-only pattern from `readIfPresent` in
    // packages/cloud-core/src/operations/resume.ts (PR #1357).
    if (!(err instanceof FsError) || err.code !== 'ENOENT') throw err;
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
  } catch (err) {
    if (!(err instanceof FsError) || err.code !== 'ENOENT') throw err;
    // No index yet — start fresh.
  }
  // Newest first.
  const updated = [newEntry, ...existing.filter((e) => e.filename !== newEntry.filename)];
  await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
}

/**
 * Subset of the sessions index that still needs recovery, under either pending
 * marker. Entries at the retry cap are permanently skipped. Returns `[]` when
 * the index is missing, empty, or malformed — never throws.
 */
export async function listPendingEnrichments(
  vfs: LocalVfsClient
): Promise<FrozenSessionIndexEntry[]> {
  const all = await readSessionsIndex(vfs);
  return all.filter(
    (entry) =>
      (entry.pendingEnrichment === true || entry.memoryPending === true) &&
      pendingAttemptCount(entry) < PENDING_SESSION_ATTEMPT_LIMIT
  );
}

export interface ProcessPendingSessionsOptions {
  vfs: WritableVfsClient;
  model?: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface PendingSessionProcessingResult {
  attempted: number;
  completed: number;
}

/**
 * Process every eligible pending archive serially, always through the legacy
 * single-call enrichment — never by re-running the curator. A curator pass is an
 * unbounded multi-turn agent run (one measured pass billed $53.81 over 163 turns
 * and 30 minutes) and `AgentSpawnOptions` has no cancellation path, so
 * `timeoutSeconds` cannot stop it. Recovering a `memoryPending` archive with one
 * bounded call is the cheap substitute for re-driving that agent.
 *
 * Attempts are persisted before work starts so reloads and permanently failing
 * archives cannot cause an LLM call on every boot. Best-effort: never throws.
 */
export async function processPendingSessions(
  opts: ProcessPendingSessionsOptions
): Promise<PendingSessionProcessingResult> {
  const result = { attempted: 0, completed: 0 };
  if (!opts.model || !opts.apiKey) return result;
  try {
    const entries = await listPendingEnrichments(opts.vfs);
    for (const listedEntry of entries) {
      try {
        const entry = await recordPendingAttempt(opts.vfs, listedEntry.filename);
        if (!entry) continue;
        result.attempted += 1;
        const updated = await enrichPendingSession(opts.vfs, entry, {
          model: opts.model,
          apiKey: opts.apiKey,
          headers: opts.headers,
        });
        if (updated) result.completed += 1;
      } catch (err) {
        log.warn('Pending session catch-up attempt failed', {
          filename: listedEntry.filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    log.warn('Pending session catch-up failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return result;
}

function pendingAttemptCount(entry: FrozenSessionIndexEntry): number {
  const count = entry.pendingAttemptCount;
  return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 0;
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
  /**
   * Skip the memory-extraction LLM call and its append: title + icon only.
   * Set by the agentic background pass, where the curator owns memory —
   * running the legacy extraction as well would append duplicate bullets on
   * top of the curator's rewrite. The `memoryPending` marker survives the
   * rename in this mode so a curator that never finishes stays recoverable
   * by the boot catch-up.
   */
  skipMemory?: boolean;
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
  if (!entry.pendingEnrichment && !entry.memoryPending) {
    return null;
  }
  const archiveContent = await readPendingArchive(vfs, entry);
  if (archiveContent === null) return null;
  const agentMessages = recoverPendingMessages(entry, archiveContent);
  if (agentMessages === null) return null;
  // #1989: the agentic background pass clears `memoryPending` only AFTER
  // the curator's rewrite lands — a tab dying between the two leaves a
  // marker whose memory work is already done. The agent bridge writes a
  // per-archive receipt (worker realm, before the spawn resolves) on
  // curator success; if THIS archive's receipt exists, run title-only
  // recovery instead of appending legacy-extracted duplicates on top of
  // the curated memory, and let the marker drop. Per-entry by design: a
  // sibling archive's enrichment or any other memory write can never be
  // misattributed to this one.
  const curatorAlreadyRan =
    entry.memoryPending === true &&
    opts.skipMemory !== true &&
    (await curatorReceiptExists(vfs, entry));
  const effectiveOpts = curatorAlreadyRan ? { ...opts, skipMemory: true } : opts;
  const calls = await runEnrichmentCalls(entry, agentMessages, effectiveOpts);
  if (calls === null) return null;
  // Pick the icon BEFORE appending memory: the pick is a read-only LLM call
  // that can hang, while the append is non-idempotent. Running it first means
  // a hung/aborted pick leaves the archive cleanly pending with NO memory
  // written yet, so the boot retry runs once with no duplicate memory.
  const icon = await pickEnrichmentIcon(effectiveOpts, calls.newTitle);
  await appendEnrichmentMemory(vfs, entry, calls.bullets, effectiveOpts);
  // `preserveMemoryPending` follows the CALLER's skipMemory, not the
  // effective one: the agentic save path (curator still owed) keeps the
  // marker, while the curator-already-ran case drops it by omission.
  const committed = await commitEnrichedArchive(
    vfs,
    entry,
    archiveContent,
    calls.newTitle,
    icon,
    opts.skipMemory === true
  );
  if (committed && curatorAlreadyRan) await removeCuratorReceipt(vfs, entry.filename);
  return committed;
}

/**
 * #1989 discriminator: `true` when the agent bridge's per-archive
 * completion receipt exists for this entry — the curator finished even
 * though the `memoryPending` marker survived. Fail-closed: a missing
 * receipt (or a stat error) keeps the legacy extraction.
 */
async function curatorReceiptExists(
  vfs: WritableVfsClient,
  entry: FrozenSessionIndexEntry
): Promise<boolean> {
  try {
    await vfs.stat(curatorReceiptPath(`/sessions/${entry.filename}`));
    return true;
  } catch {
    return false;
  }
}

/** Best-effort receipt cleanup once its evidence has been consumed. */
async function removeCuratorReceipt(vfs: WritableVfsClient, filename: string): Promise<void> {
  try {
    await vfs.rm(curatorReceiptPath(`/sessions/${filename}`));
  } catch {
    /* already gone or unreadable — the receipt is only advisory */
  }
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
  if (!opts.skipMemory) {
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
/**
 * Rebuild the index entry for a just-enriched archive. Carries a
 * freshly-picked icon (single-click "save" path) or preserves an existing
 * one, and keeps `sessionId` across the rename so the snapshot data
 * directory stays reachable. A title-only pass (agentic `skipMemory`) has
 * not run the curator yet: `preserveMemoryPending` keeps that marker so a
 * curator that never finishes leaves a recoverable entry, while the legacy
 * pass — which just extracted memory — drops it by omission as before.
 */
function buildEnrichedIndexEntry(
  entry: FrozenSessionIndexEntry,
  newFilename: string,
  resolvedTitle: string,
  icon: string | undefined,
  preserveMemoryPending: boolean
): FrozenSessionIndexEntry {
  const resolvedIcon = icon ?? entry.icon;
  return {
    filename: newFilename,
    title: resolvedTitle,
    frozenAt: entry.frozenAt,
    messageCount: entry.messageCount,
    ...(entry.cost ? { cost: entry.cost } : {}),
    ...(entry.models ? { models: entry.models } : {}),
    // Cone provenance survives the rename — the archive stays the property
    // of the cone that produced it (#2272).
    ...(entry.cone ? { cone: entry.cone } : {}),
    ...(entry.coneLabel ? { coneLabel: entry.coneLabel } : {}),
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(resolvedIcon ? { icon: resolvedIcon } : {}),
    ...(entry.completeSnapshotUnavailable ? { completeSnapshotUnavailable: true } : {}),
    ...(preserveMemoryPending && entry.memoryPending ? { memoryPending: true } : {}),
  };
}

async function commitEnrichedArchive(
  vfs: WritableVfsClient,
  entry: FrozenSessionIndexEntry,
  archiveContent: string,
  newTitle: string,
  icon?: string,
  preserveMemoryPending = false
): Promise<FrozenSessionIndexEntry | null> {
  const oldPath = frozenSessionPath(entry);
  // Only a quick-mode `pending-…md` draft carries a placeholder title and a
  // throwaway name. A curator archive is written straight to its canonical
  // name, so when the legacy fallback picks one up (agentic-memory toggled off
  // before catch-up ran) retitling it would rename the file out from under
  // deep links that already point at it.
  const isDraft = isPendingDraftFilename(entry.filename);
  const resolvedTitle = isDraft ? newTitle : entry.title;
  const newFilename = isDraft
    ? `${entry.frozenAt.replace(/[:.]/g, '-')}-${slugify(newTitle)}.md`
    : entry.filename;
  const newPath = `${SESSIONS_DIR}/${newFilename}`;
  if (isDraft) {
    try {
      await ensureDir(vfs, SESSIONS_DIR);
      await vfs.writeFile(newPath, rewriteArchiveTitle(archiveContent, resolvedTitle));
    } catch (err) {
      log.warn('Enrichment write failed (entry stays pending)', {
        filename: entry.filename,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  const updatedEntry = buildEnrichedIndexEntry(
    entry,
    newFilename,
    resolvedTitle,
    icon,
    preserveMemoryPending
  );
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
    title: resolvedTitle,
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
 * background enrichment pass racing a freshly-quick-frozen entry)
 * would otherwise read the same stale snapshot and clobber one of the
 * writes. Cross-tab concurrency is out of scope — the app runs in a
 * single context.
 */
let indexWriteChain: Promise<void> = Promise.resolve();

/** Clear every catch-up marker and its attempt counter after successful work. */
async function clearPendingMarkers(
  vfs: WritableVfsClient,
  filename: string
): Promise<FrozenSessionIndexEntry | null> {
  let cleared: FrozenSessionIndexEntry | null = null;
  const run = async (): Promise<void> => {
    const existing = await readSessionsIndex(vfs);
    const index = existing.findIndex((entry) => entry.filename === filename);
    if (index === -1) return;
    const {
      memoryPending: _memoryPending,
      pendingEnrichment: _pendingEnrichment,
      pendingAttemptCount: _pendingAttemptCount,
      ...updatedEntry
    } = existing[index];
    const updated = existing.slice();
    updated[index] = updatedEntry;
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
    await vfs.flush();
    cleared = updatedEntry;
  };
  const next = indexWriteChain.then(run, run);
  indexWriteChain = next.then(
    () => undefined,
    () => undefined
  );
  try {
    await next;
  } catch (err) {
    log.warn('Failed to clear agentic memory pending marker', {
      filename,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return cleared;
}

/** Persist one attempt before its LLM call, serialized with every index mutation. */
async function recordPendingAttempt(
  vfs: WritableVfsClient,
  filename: string
): Promise<FrozenSessionIndexEntry | null> {
  let attempted: FrozenSessionIndexEntry | null = null;
  const run = async (): Promise<void> => {
    const existing = await readSessionsIndex(vfs);
    const index = existing.findIndex((entry) => entry.filename === filename);
    if (index === -1) return;
    const current = existing[index];
    if (!current.pendingEnrichment && !current.memoryPending) return;
    const attempts = pendingAttemptCount(current);
    if (attempts >= PENDING_SESSION_ATTEMPT_LIMIT) return;
    attempted = { ...current, pendingAttemptCount: attempts + 1 };
    const updated = existing.slice();
    updated[index] = attempted;
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
    await vfs.flush();
  };
  const next = indexWriteChain.then(run, run);
  indexWriteChain = next.then(
    () => undefined,
    () => undefined
  );
  await next;
  return attempted;
}

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
    } catch (err) {
      if (!(err instanceof FsError) || err.code !== 'ENOENT') throw err;
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
 * Mark a frozen session's index entry with `completeSnapshotUnavailable: true`.
 *
 * Called after `captureCompleteSnapshot` fails so the UI knows the full
 * sanitized transcript bundle was not produced. Best-effort — write failures
 * are swallowed by the caller.
 *
 * The entire read-modify-write executes inside `indexWriteChain` so a
 * concurrent enrichment rename cannot interleave between the read and write.
 */
export async function markSnapshotUnavailable(
  vfs: WritableVfsClient,
  filename: string
): Promise<void> {
  const run = async (): Promise<void> => {
    let existing: FrozenSessionIndexEntry[] = [];
    try {
      const raw = await vfs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) existing = parsed as FrozenSessionIndexEntry[];
    } catch (err) {
      if (!(err instanceof FsError) || err.code !== 'ENOENT') throw err;
      // No index yet — nothing to mark.
      return;
    }
    const entry = existing.find((e) => e.filename === filename);
    if (!entry) return; // Entry not found — nothing to update.
    const updated = existing.map((e) =>
      e.filename === filename ? { ...e, completeSnapshotUnavailable: true } : e
    );
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
  };
  const next = indexWriteChain.then(run, run);
  indexWriteChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}
