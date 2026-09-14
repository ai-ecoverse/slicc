import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { hasIcon } from '@slicc/webcomponents/icons';
import { createLogger } from '../base/logger.js';
import {
  COMPACTION_MEMORY_INSTRUCTION,
  COMPACTION_TITLE_INSTRUCTION,
  runOneOffCompactionCall,
} from '../core/context-compaction.js';
import { isFeatureEnabled } from '../core/feature-flags.js';
import { FsError } from '../fs/types.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';
import type { AgentBridge } from '../scoops/agent-bridge.js';
import {
  curationBasePath,
  curationDraftPath,
  curatorReceiptPath,
  runAgenticMemoryPass,
} from '../scoops/agentic-memory.js';
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
  readSessionsIndex,
  SESSIONS_DIR,
  SESSIONS_INDEX_PATH,
} from '../transcript/frozen-archive-format.js';
import {
  findLiveSnapshotEntry,
  formatArchiveAsMarkdown,
  heuristicTitle,
  isDraftArchiveFilename,
  readSessionsIndexForWrite,
  rewriteTranscriptPointers,
  serializeIndexWrite,
  shortId,
  slugify,
  upsertSessionsIndexEntry,
} from '../transcript/frozen-archive-writer.js';
import {
  copySessionJsonl,
  loadFrozenArchive,
  removeSessionJsonl,
  sidecarPathForArchive,
} from '../transcript/session-jsonl.js';
import { workspaceFor } from '../work-unit/descriptor.js';
import { chatSessionIdFor, PRIMARY_CONE_FOLDER } from '../work-unit/record.js';
import type { ChatMessage, Session } from './types.js';

export type {
  FrozenSessionArchive,
  FrozenSessionCost,
  FrozenSessionIndexEntry,
  FrozenSessionModel,
} from '../transcript/frozen-archive-format.js';

export {
  frozenSessionPath,
  parseFrozenArchive,
  readSessionsIndex,
  SESSIONS_INDEX_PATH,
} from '../transcript/frozen-archive-format.js';

const log = createLogger('session-freezer');

const MIN_MESSAGES_TO_FREEZE = 4;

const MEMORY_MAX_TOKENS = 2048;

const TITLE_MAX_TOKENS = 40;

export const PENDING_SESSION_ATTEMPT_LIMIT = 3;

const SESSION_ATTACHMENTS_DIR = `${SESSIONS_DIR}/attachments`;

export interface FrozenSession extends FrozenSessionIndexEntry {
  archive: FrozenSessionArchive;
}

export interface FreezerConeRef {
  folder: string;

  label?: string;

  jid?: string;
}

export interface FreezeConeSessionOptions {
  sessionStore: SessionStore;

  vfs: WritableVfsClient;

  model?: Model<Api>;

  apiKey?: string;

  headers?: Record<string, string>;

  mode?: 'full' | 'quick';

  memory?: 'skip';

  pickIcon?: (opts: { subject: string }) => Promise<string | null>;

  agenticMemorySpawn?: AgentBridge['spawn'];

  cone?: FreezerConeRef;
}

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

  const llmEnabled = mode === 'full' && Boolean(opts.apiKey && opts.model);

  if (!opts.agenticMemorySpawn && opts.memory !== 'skip') {
    await extractMemoriesBestEffort(opts, agentMessages, llmEnabled);
  }
  const title =
    (await generateTitleBestEffort(opts, agentMessages, llmEnabled)) ||
    heuristicTitle(session.messages);
  const icon = llmEnabled ? await pickIconBestEffort(opts, title) : undefined;

  return await writeFrozenArchive(
    opts,
    session,
    title,
    mode,
    icon,
    Boolean(opts.agenticMemorySpawn) && opts.memory !== 'skip'
  );
}

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

      ...(opts.cone ? { cone: opts.cone } : {}),
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

    await removeCuratorReceipt(opts.vfs, frozen.filename);
    if (!updated) {
      log.info('Agentic memory pass completed; index entry already gone', {
        filename: frozen.filename,
      });
      return null;
    }
    delete frozen.memoryPending;
    log.info('Agentic memory pass completed', { filename: frozen.filename });
    return updated;
  }

  await stampMemoryFailure(opts.vfs, frozen.filename, result.reason);
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

function keepIfLucide(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return hasIcon(name) ? name : undefined;
}

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
    await appendConeMemoryViaVfs(
      opts.vfs,
      coneMemoryPathFor(coneFolderOf(opts)),
      bullets.trim(),
      'new-session',
      {
        model: opts.model,
        apiKey: opts.apiKey,
        headers: opts.headers,
      }
    );
    log.info('Memory extracted and appended on new-session');
  } catch (err) {
    log.warn('Memory append failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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

async function writeFrozenArchive(
  opts: FreezeConeSessionOptions,
  session: Session,
  title: string,
  mode: 'full' | 'quick',
  icon?: string,
  memoryPending = false
): Promise<FrozenSession | null> {
  const frozenAt = new Date().toISOString();
  const coneFolder = coneFolderOf(opts);

  const live = await findLiveConeSnapshot(opts.vfs, coneFolder);

  const sessionId = live?.sessionId ?? crypto.randomUUID();
  const filename =
    live?.filename ??
    (mode === 'quick'
      ? `pending-${shortId()}.md`
      : `${frozenAt.replace(/[:.]/g, '-')}-${slugify(title)}.md`);
  const usageSummary = summarizeSessionUsage(session.messages);

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

    ...(mode === 'quick' || live ? { pendingEnrichment: true } : {}),
    ...(memoryPending ? { memoryPending: true } : {}),
    ...(opts.memory === 'skip' ? { memorySkipped: true } : {}),
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
      ...(opts.memory === 'skip' ? { memorySkipped: true as const } : {}),
    };
    if (isFeatureEnabled('memory-v2')) {
      const { writeArchiveBundle } = await import('../transcript/session-jsonl.js');
      await writeArchiveBundle(opts.vfs, filename, archive);
    } else {
      await opts.vfs.writeFile(`${SESSIONS_DIR}/${filename}`, formatArchiveAsMarkdown(archive));
    }
    await upsertSessionsIndexEntry(opts.vfs, indexEntry);

    await opts.vfs.flush();
    log.info('Cone session frozen', {
      filename,
      title,
      cone: coneFolder,
      messageCount: session.messages.length,
      completedLiveSnapshot: Boolean(live),
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

function coneFolderOf(opts: Pick<FreezeConeSessionOptions, 'cone'>): string {
  return opts.cone?.folder || PRIMARY_CONE_FOLDER;
}

function coneMemoryPathFor(folder: string): string {
  return workspaceFor({ parentJid: null, folder }).memoryPath;
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

async function findLiveConeSnapshot(
  vfs: WritableVfsClient,
  coneFolder: string
): Promise<FrozenSessionIndexEntry | undefined> {
  try {
    return findLiveSnapshotEntry(await readSessionsIndexForWrite(vfs), coneFolder);
  } catch (err) {
    log.warn('Sessions index unreadable while looking for a live snapshot', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

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

function cleanTitle(raw: string): string {
  let t = raw.trim();

  t = t.replace(/^["'`]+|["'`]+$/g, '').trim();

  t = t.replace(/\s+/g, ' ');

  if (t.length > 80) t = t.slice(0, 80).trimEnd();
  return t;
}

async function ensureDir(vfs: WritableVfsClient, path: string): Promise<void> {
  try {
    await vfs.mkdir(path, { recursive: true });
  } catch {}
}

async function appendConeMemoryViaVfs(
  vfs: WritableVfsClient,
  memoryPath: string,
  bullets: string,
  source: string,
  budgetOpts?: {
    model?: Parameters<typeof applyConeMemoryBudget>[0]['model'];
    apiKey?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }
): Promise<void> {
  const path = memoryPath;
  let current = '';
  try {
    const raw = await vfs.readFile(path, { encoding: 'utf-8' });
    current = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch (err) {
    if (!(err instanceof FsError) || err.code !== 'ENOENT') throw err;
    await ensureDir(vfs, path.slice(0, path.lastIndexOf('/')));
  }
  const date = new Date().toISOString().slice(0, 10);
  const heading = `## Auto-extracted (${date}, ${source})`;
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  const block = `${separator}\n${heading}\n\n${bullets}\n`;
  await vfs.writeFile(path, current + block);

  try {
    await applyConeMemoryBudget({
      vfs,
      memoryPath: path,
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

export async function processPendingSessions(
  opts: ProcessPendingSessionsOptions
): Promise<PendingSessionProcessingResult> {
  const result = { attempted: 0, completed: 0 };
  if (!opts.model || !opts.apiKey) return result;
  try {
    for (const capped of await readSessionsIndex(opts.vfs)) {
      if (
        capped.memoryPending === true &&
        capped.memoryFailed === undefined &&
        pendingAttemptCount(capped) >= PENDING_SESSION_ATTEMPT_LIMIT
      ) {
        await stampMemoryFailure(
          opts.vfs,
          capped.filename,
          `catch-up retries exhausted (${PENDING_SESSION_ATTEMPT_LIMIT})`
        );
      }
    }
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
  model: Model<Api>;

  apiKey: string;

  headers?: Record<string, string>;

  pickIcon?: (opts: { subject: string }) => Promise<string | null>;

  skipMemory?: boolean;
}

export async function enrichPendingSession(
  vfs: WritableVfsClient,
  entry: FrozenSessionIndexEntry,
  opts: EnrichPendingSessionOptions
): Promise<FrozenSessionIndexEntry | null> {
  if (!entry.pendingEnrichment && !entry.memoryPending) {
    return null;
  }
  const archiveContent = await readPendingArchive(vfs, entry);
  if (archiveContent === null) return null;
  const agentMessages = await recoverPendingMessages(vfs, entry, archiveContent);
  if (agentMessages === null) return null;

  const curatorAlreadyRan =
    entry.memoryPending === true &&
    opts.skipMemory !== true &&
    (await curatorReceiptExists(vfs, entry));

  const effectiveOpts =
    curatorAlreadyRan || entry.memorySkipped === true ? { ...opts, skipMemory: true } : opts;
  const calls = await runEnrichmentCalls(entry, agentMessages, effectiveOpts);
  if (calls === null) return null;

  const icon = await pickEnrichmentIcon(effectiveOpts, calls.newTitle);
  await appendEnrichmentMemory(vfs, entry, calls.bullets, effectiveOpts);

  const committed = await commitEnrichedArchive(
    vfs,
    entry,
    archiveContent,
    calls.newTitle,
    icon,
    opts.skipMemory === true
  );
  if (committed && curatorAlreadyRan) {
    await removeCuratorReceipt(vfs, entry.filename);

    await stampMemoryCurated(vfs, committed.filename);
    await removeCurationStaging(vfs, entry.filename);
  }
  return committed;
}

async function removeCurationStaging(vfs: WritableVfsClient, filename: string): Promise<void> {
  for (const path of [
    curationBasePath(`/sessions/${filename}`),
    curationDraftPath(`/sessions/${filename}`),
  ]) {
    try {
      await vfs.rm(path);
    } catch {}
  }
}

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

async function removeCuratorReceipt(vfs: WritableVfsClient, filename: string): Promise<void> {
  try {
    await vfs.rm(curatorReceiptPath(`/sessions/${filename}`));
  } catch {}
}

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

async function recoverPendingMessages(
  vfs: LocalVfsClient,
  entry: FrozenSessionIndexEntry,
  archiveContent: string
): Promise<AgentMessage[] | null> {
  let messages: ChatMessage[];
  try {
    messages = (await loadFrozenArchive(vfs, archiveContent, entry.filename)).messages;
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

async function appendEnrichmentMemory(
  vfs: WritableVfsClient,
  entry: FrozenSessionIndexEntry,
  bullets: string,
  opts: EnrichPendingSessionOptions
): Promise<void> {
  const trimmedBullets = bullets.trim();
  if (!trimmedBullets || trimmedBullets === 'NONE') return;
  try {
    await appendConeMemoryViaVfs(
      vfs,

      coneMemoryPathFor(entry.cone || PRIMARY_CONE_FOLDER),
      trimmedBullets,
      'pending-enrichment',
      {
        model: opts.model,
        apiKey: opts.apiKey,
        headers: opts.headers,
      }
    );
  } catch (err) {
    log.warn('Enrichment memory append failed (continuing with title rewrite)', {
      filename: entry.filename,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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

    ...(entry.cone ? { cone: entry.cone } : {}),
    ...(entry.coneLabel ? { coneLabel: entry.coneLabel } : {}),
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(resolvedIcon ? { icon: resolvedIcon } : {}),
    ...(entry.completeSnapshotUnavailable ? { completeSnapshotUnavailable: true } : {}),
    ...(preserveMemoryPending && entry.memoryPending ? { memoryPending: true } : {}),

    ...(entry.memorySkipped ? { memorySkipped: true } : {}),
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

  const isDraft = isDraftArchiveFilename(entry.filename);
  const resolvedTitle = isDraft ? newTitle : entry.title;
  const newFilename = isDraft
    ? `${entry.frozenAt.replace(/[:.]/g, '-')}-${slugify(newTitle)}.md`
    : entry.filename;
  const newPath = `${SESSIONS_DIR}/${newFilename}`;
  if (isDraft) {
    try {
      await ensureDir(vfs, SESSIONS_DIR);

      const titled = rewriteArchiveTitle(archiveContent, resolvedTitle);
      const oldSidecar = sidecarPathForArchive(entry.filename);
      const newSidecar = sidecarPathForArchive(newFilename);
      let rewritten = rewriteTranscriptPointers(titled, oldPath, newPath);
      rewritten = rewriteTranscriptPointers(rewritten, oldSidecar, newSidecar);

      if (oldSidecar !== newSidecar) {
        const oldBase = oldSidecar.slice(oldSidecar.lastIndexOf('/') + 1);
        const newBase = newSidecar.slice(newSidecar.lastIndexOf('/') + 1);
        rewritten = rewritten.split(`sidecar: ${oldBase}`).join(`sidecar: ${newBase}`);
      }
      await vfs.writeFile(newPath, rewritten);

      await copySessionJsonl(vfs, entry.filename, newFilename);
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
    try {
      await removeSessionJsonl(vfs, entry.filename);
    } catch (err) {
      log.info('Stale pending sidecar cleanup failed (harmless)', {
        filename: entry.filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  try {
    await vfs.flush();
  } catch {}
  log.info('Pending session enriched', {
    oldFilename: entry.filename,
    newFilename,
    title: resolvedTitle,
  });
  return updatedEntry;
}

function rewriteArchiveTitle(content: string, newTitle: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return content;
  const fm = fmMatch[1].replace(/^title:\s*.+$/m, `title: ${JSON.stringify(newTitle)}`);
  let body = fmMatch[2];
  body = body.replace(/^#\s+[^\n]*$/m, `# ${newTitle}`);
  return `---\n${fm}\n---\n${body}`;
}

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
      memoryFailed: _memoryFailed,
      ...rest
    } = existing[index];
    const updatedEntry: FrozenSessionIndexEntry = {
      ...rest,
      memoryCuratedAt: new Date().toISOString(),
    };
    const updated = existing.slice();
    updated[index] = updatedEntry;
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
    await vfs.flush();
    cleared = updatedEntry;
  };
  const next = serializeIndexWrite(run);
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
  const next = serializeIndexWrite(run);
  await next;
  return attempted;
}

async function stampMemoryFailure(
  vfs: WritableVfsClient,
  filename: string,
  reason: string
): Promise<void> {
  const run = async (): Promise<void> => {
    const existing = await readSessionsIndex(vfs);
    const index = existing.findIndex((entry) => entry.filename === filename);
    if (index === -1) return;
    const updated = existing.slice();
    updated[index] = { ...existing[index], memoryFailed: reason.slice(0, 300) };
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
    await vfs.flush();
  };
  const next = serializeIndexWrite(run);
  try {
    await next;
  } catch (err) {
    log.warn('Failed to record curator failure in sessions index', {
      filename,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function stampMemoryCurated(vfs: WritableVfsClient, filename: string): Promise<void> {
  const run = async (): Promise<void> => {
    const existing = await readSessionsIndex(vfs);
    const index = existing.findIndex((entry) => entry.filename === filename);
    if (index === -1) return;
    const { memoryFailed: _memoryFailed, ...rest } = existing[index];
    const updated = existing.slice();
    updated[index] = { ...rest, memoryCuratedAt: new Date().toISOString() };
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
    await vfs.flush();
  };
  const next = serializeIndexWrite(run);
  try {
    await next;
  } catch (err) {
    log.warn('Failed to record curator completion in sessions index', {
      filename,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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
    }
    const idx = existing.findIndex((e) => e.filename === oldFilename);
    let updated: FrozenSessionIndexEntry[];
    if (idx === -1) {
      updated = [replacement, ...existing.filter((e) => e.filename !== replacement.filename)];
    } else {
      updated = existing.slice();
      updated[idx] = replacement;

      updated = updated.filter((e, i) => i === idx || e.filename !== replacement.filename);
    }
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
  };

  const next = serializeIndexWrite(run);
  return next;
}

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

      return;
    }
    const entry = existing.find((e) => e.filename === filename);
    if (!entry) return;
    const updated = existing.map((e) =>
      e.filename === filename ? { ...e, completeSnapshotUnavailable: true } : e
    );
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
  };
  const next = serializeIndexWrite(run);
  return next;
}
