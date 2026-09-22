/**
 * Incremental curation of a cone's live session archive.
 *
 * A chat that is never finalized keeps one growing `/sessions/live-*.md`.
 * The freezer's curator runs only on "New chat", and the nightly dreamer
 * consolidates the memory file without reading transcripts, so weeks of
 * work in a never-reset cone never reach durable memory.
 *
 * This pass mines only messages newer than the archive's `curatedThrough`
 * cursor. It uses the same curator scoop as a freeze: budget, wall-clock
 * timeout, and the dreamer as an `exclusiveWith` rival. Each slice has its
 * own receipt (`/sessions/.curated/<sessionId>-<from>-<to>.md`), so a later
 * finalize does not mine those messages again.
 *
 * Compaction itself still does not extract memories (#2003). The round only
 * schedules this pass after the snapshot is durable. `memory dream` runs
 * one slice before the dreamer. Both are gated on `memory-v2` and
 * `agentic-memory` — with the curator flag off, compaction's own extraction
 * is still the writer.
 */

import { createLogger } from '../base/logger.js';
import { isFeatureEnabled } from '../core/feature-flags.js';
import { FsError } from '../fs/types.js';
import {
  type FrozenSessionArchive,
  type FrozenSessionIndexEntry,
  parseFrozenArchive,
  SESSIONS_DIR,
} from '../transcript/frozen-archive-format.js';
import {
  type ArchiveVfs,
  findLiveSnapshotEntry,
  formatArchiveAsMarkdown,
  readSessionsIndexForWrite,
  serializeIndexWrite,
  writeSessionsIndexUnlocked,
} from '../transcript/frozen-archive-writer.js';
import { messagesAfterCursor, newestMessageTimestamp } from '../transcript/live-cursor.js';
import { PRIMARY_CONE_FOLDER } from '../work-unit/record.js';
import { AGENT_NAME_IN_USE_PREFIX, type AgentBridge } from './agent-bridge.js';
import { type CuratorConeRef, curatorReceiptPath, runAgenticMemoryPass } from './agentic-memory.js';
import type { ChatMessage } from './chat-types.js';

const log = createLogger('live-session-curation');

/** Messages one unattended slice will mine. A multi-week archive is past one context. */
export const LIVE_DELTA_MAX_MESSAGES = 200;
/** Characters of content (plus tool-call JSON) one unattended slice will mine. */
export const LIVE_DELTA_MAX_CHARS = 80_000;

const LIVE_DELTA_DIR = '/sessions/.live-deltas';

export interface DeltaLimits {
  maxMessages: number;
  maxChars: number;
}

export const DEFAULT_DELTA_LIMITS: DeltaLimits = {
  maxMessages: LIVE_DELTA_MAX_MESSAGES,
  maxChars: LIVE_DELTA_MAX_CHARS,
};

/**
 * VFS surface the pass needs. `flush` is optional so a caller whose fake
 * only implements the curator reads can still host a no-op pass.
 */
export interface LiveCurationVfs {
  readFile(path: string, options?: { encoding?: 'utf-8' }): Promise<string | Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm?(path: string, options?: { recursive?: boolean }): Promise<void>;
  flush?(): Promise<void>;
}

export type LiveDeltaResult =
  | {
      status: 'skipped';
      reason: 'flag-off' | 'no-archive' | 'caught-up' | 'index-unreadable' | 'no-bridge';
    }
  | { status: 'curated'; curatedThrough: number; filename: string }
  | { status: 'failed'; reason: string; filename?: string };

export interface CurateLiveDeltaOptions {
  vfs: LiveCurationVfs;
  cone: CuratorConeRef;
  spawn: AgentBridge['spawn'];
  /**
   * Override the feature-flag gate. `true` / `false` force the pass on or
   * off; omitted reads `memory-v2` and `agentic-memory`.
   */
  enabled?: boolean;
  limits?: DeltaLimits;
  signal?: AbortSignal;
  /** Internal: the caller already registered this run in the in-flight map. */
  hold?: 'held';
}

export interface ScheduleLiveDeltaRequest {
  vfs: LiveCurationVfs;
  cone: CuratorConeRef;
  limits?: DeltaLimits;
}

/** What "New chat" should hand the curator for an archive that may already have been mined. */
export type FinalizeCurationTarget =
  | { kind: 'full' }
  | { kind: 'covered'; through: number }
  | { kind: 'delta'; path: string; through: number; messages: ChatMessage[] };

interface AgentGlobals {
  __slicc_agent?: AgentBridge;
}

const inflight = new Map<string, Promise<LiveDeltaResult>>();
const rerun = new Map<string, ScheduleLiveDeltaRequest>();

/** Both flags: memory v2 owns the dream schedule, and the curator owns memory writes. */
export function liveDeltaCurationEnabled(): boolean {
  return isFeatureEnabled('memory-v2') && isFeatureEnabled('agentic-memory');
}

/**
 * Receipt and prompt path for one mined range. `from` is the cursor the
 * slice started at (0 when the archive had never been curated). `to` is the
 * newest timestamp the slice includes.
 */
export function liveDeltaArchivePath(sessionId: string, from: number, to: number): string {
  return `${LIVE_DELTA_DIR}/${sessionId}-${from}-${to}.md`;
}

/**
 * Oldest prefix of `messages` that fits the limits, extended through the
 * trailing timestamp so the cursor does not skip a sibling left behind.
 * Always includes at least one message when the list is non-empty, so a
 * single oversized turn still lets the cursor advance.
 */
export function takeDeltaSlice(
  messages: readonly ChatMessage[],
  limits: DeltaLimits = DEFAULT_DELTA_LIMITS
): ChatMessage[] {
  if (messages.length === 0) return [];
  const slice: ChatMessage[] = [];
  let chars = 0;
  for (const message of messages) {
    const weight = messageWeight(message);
    const over =
      slice.length >= limits.maxMessages || (slice.length > 0 && chars + weight > limits.maxChars);
    if (over) break;
    slice.push(message);
    chars += weight;
  }
  if (slice.length === 0) slice.push(messages[0]);
  const endTs = slice[slice.length - 1].timestamp;
  let index = slice.length;
  while (index < messages.length && messages[index].timestamp === endTs) {
    slice.push(messages[index]);
    index += 1;
  }
  return slice;
}

/**
 * Schedule a slice for one cone. Compaction calls this without awaiting:
 * the round must not wait on a curator. A second schedule while a pass is
 * in flight is remembered and run once that pass finishes.
 */
export function scheduleLiveDeltaCuration(
  request: ScheduleLiveDeltaRequest
): Promise<LiveDeltaResult> {
  if (!liveDeltaCurationEnabled()) {
    return Promise.resolve({ status: 'skipped', reason: 'flag-off' });
  }
  const folder = request.cone.folder || PRIMARY_CONE_FOLDER;
  const cone = { ...request.cone, folder };
  const bridge = readAgentBridge();
  if (!bridge) {
    log.info('Live delta curation skipped: agent bridge not published', { cone: folder });
    return Promise.resolve({ status: 'skipped', reason: 'no-bridge' });
  }
  const scheduled = { ...request, cone };
  const existing = inflight.get(folder);
  if (existing) {
    rerun.set(folder, scheduled);
    return existing;
  }
  return startScheduled(scheduled, bridge);
}

/** Mine the next uncurated slice of the cone's live archive, or skip when there is none. */
export function curateLiveSessionDelta(opts: CurateLiveDeltaOptions): Promise<LiveDeltaResult> {
  const folder = opts.cone.folder || PRIMARY_CONE_FOLDER;
  const cone: CuratorConeRef = { ...opts.cone, folder };
  const next = { ...opts, cone };
  if (opts.hold === 'held') return runLiveDelta(next);
  const existing = inflight.get(folder);
  if (existing) return existing.then(() => curateLiveSessionDelta(next));
  const job = runLiveDelta(next);
  return track(folder, job);
}

/**
 * How far receipts already prove this transcript was mined. Advances the
 * index cursor when a receipt sits ahead of it (the pass finished and the
 * page died before the cursor write). `caughtUp` means nothing remains.
 */
export async function incrementalCoverage(
  vfs: LiveCurationVfs,
  entry: { sessionId?: string; filename: string; curatedThrough?: number },
  messages: readonly ChatMessage[],
  limits?: DeltaLimits
): Promise<{ through: number; caughtUp: boolean }> {
  const stored = entry.curatedThrough ?? 0;
  const through = entry.sessionId
    ? await drainReceipts(vfs, entry.sessionId, entry.filename, messages, stored, limits)
    : stored;
  const caughtUp = through > 0 && messagesAfterCursor(messages, through).length === 0;
  return { through, caughtUp };
}

/**
 * Decide the finalize pass. An archive that was never incrementally curated
 * keeps the historical whole-file pass (receipt keyed by filename). One that
 * already has a cursor, or slice receipts, mines only the remainder.
 */
export async function curationTargetForFinalize(
  vfs: LiveCurationVfs,
  frozen: {
    sessionId: string;
    filename: string;
    title: string;
    frozenAt: string;
    cone?: string;
    coneLabel?: string;
    curatedThrough?: number;
    messages: readonly ChatMessage[];
  }
): Promise<FinalizeCurationTarget> {
  const hadCursor = (frozen.curatedThrough ?? 0) > 0;
  const cursor = await drainReceipts(
    vfs,
    frozen.sessionId,
    frozen.filename,
    frozen.messages,
    frozen.curatedThrough ?? 0
  );
  const fresh = messagesAfterCursor(frozen.messages, cursor);
  if (fresh.length === 0) return { kind: 'covered', through: cursor };
  if (!hadCursor && cursor === 0) return { kind: 'full' };
  const through = newestMessageTimestamp(fresh);
  const path = liveDeltaArchivePath(frozen.sessionId, cursor, through);
  if (await receiptExists(vfs, path)) {
    await advanceCuratedThrough(vfs, frozen.filename, through);
    return { kind: 'covered', through };
  }
  await writeDeltaArchive(vfs, frozen, fresh, path);
  return { kind: 'delta', path, through, messages: [...fresh] };
}

/** Move `curatedThrough` forward. Never moves it backward. Clears a stale failure note. */
export async function advanceCuratedThrough(
  vfs: LiveCurationVfs,
  filename: string,
  through: number
): Promise<void> {
  if (!(through > 0)) return;
  await serializeIndexWrite(async () => {
    const entries = await readSessionsIndexForWrite(asArchive(vfs));
    const index = entries.findIndex((entry) => entry.filename === filename);
    if (index === -1) return;
    const current = entries[index].curatedThrough ?? 0;
    if (through <= current) return;
    const { memoryFailed: _failed, ...rest } = entries[index];
    const updated = entries.slice();
    updated[index] = { ...rest, curatedThrough: through };
    await writeSessionsIndexUnlocked(asArchive(vfs), updated);
    await patchCuratedThroughFrontmatter(vfs, `${SESSIONS_DIR}/${filename}`, through);
    await vfs.flush?.();
  });
}

function startScheduled(
  request: ScheduleLiveDeltaRequest,
  bridge: AgentBridge
): Promise<LiveDeltaResult> {
  const folder = request.cone.folder || PRIMARY_CONE_FOLDER;
  const job = curateLiveSessionDelta({
    vfs: request.vfs,
    cone: request.cone,
    spawn: (options) => bridge.spawn(options),
    enabled: true,
    hold: 'held',
    ...(request.limits ? { limits: request.limits } : {}),
  });
  return track(folder, job);
}

function track(folder: string, job: Promise<LiveDeltaResult>): Promise<LiveDeltaResult> {
  inflight.set(folder, job);
  // Both branches handle the outcome. `finally` would mint a second promise
  // that rejects with the original reason, and voiding that promise is an
  // unhandledrejection even when the caller caught `job`.
  void job.then(
    () => releaseInflight(folder, job),
    () => releaseInflight(folder, job)
  );
  return job;
}

function releaseInflight(folder: string, job: Promise<LiveDeltaResult>): void {
  if (inflight.get(folder) !== job) return;
  inflight.delete(folder);
  const again = rerun.get(folder);
  rerun.delete(folder);
  if (!again || !liveDeltaCurationEnabled()) return;
  const bridge = readAgentBridge();
  if (!bridge) return;
  void startScheduled(again, bridge).catch((error) => {
    log.warn('Follow-up live delta curation failed to start', {
      cone: folder,
      error: errorText(error),
    });
  });
}

async function runLiveDelta(opts: CurateLiveDeltaOptions): Promise<LiveDeltaResult> {
  if (!(opts.enabled ?? liveDeltaCurationEnabled())) {
    return { status: 'skipped', reason: 'flag-off' };
  }
  const folder = opts.cone.folder || PRIMARY_CONE_FOLDER;
  const limits = opts.limits ?? DEFAULT_DELTA_LIMITS;
  let entries: FrozenSessionIndexEntry[];
  try {
    entries = await readSessionsIndexForWrite(asArchive(opts.vfs));
  } catch (error) {
    log.warn('Live delta curation skipped: sessions index unreadable', {
      cone: folder,
      error: errorText(error),
    });
    return { status: 'skipped', reason: 'index-unreadable' };
  }
  const entry = findLiveSnapshotEntry(entries, folder);
  if (!entry?.sessionId) return { status: 'skipped', reason: 'no-archive' };
  const loaded = await readArchiveMessages(opts.vfs, `${SESSIONS_DIR}/${entry.filename}`);
  if (!loaded) return { status: 'skipped', reason: 'no-archive' };
  const cursor = await drainReceipts(
    opts.vfs,
    entry.sessionId,
    entry.filename,
    loaded,
    entry.curatedThrough ?? 0,
    limits
  );
  const fresh = messagesAfterCursor(loaded, cursor);
  if (fresh.length === 0) return { status: 'skipped', reason: 'caught-up' };
  const slice = takeDeltaSlice(fresh, limits);
  const through = newestMessageTimestamp(slice);
  if (through <= cursor) return { status: 'skipped', reason: 'caught-up' };
  const path = liveDeltaArchivePath(entry.sessionId, cursor, through);
  await writeDeltaArchive(
    opts.vfs,
    {
      sessionId: entry.sessionId,
      filename: entry.filename,
      title: entry.title,
      frozenAt: entry.frozenAt,
      cone: entry.cone,
      coneLabel: entry.coneLabel,
    },
    slice,
    path
  );
  const result = await runAgenticMemoryPass({
    spawn: opts.spawn,
    vfs: opts.vfs,
    sessionArchivePath: path,
    sessionCount: entries.length,
    ...(folder !== PRIMARY_CONE_FOLDER || opts.cone.jid ? { cone: opts.cone } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!result.ok) {
    if (!result.reason.startsWith(AGENT_NAME_IN_USE_PREFIX)) {
      await stampLiveFailure(opts.vfs, entry.filename, result.reason);
    }
    log.warn('Live delta curation failed', {
      cone: folder,
      filename: entry.filename,
      reason: result.reason,
    });
    return { status: 'failed', reason: result.reason, filename: entry.filename };
  }
  await advanceCuratedThrough(opts.vfs, entry.filename, through);
  log.info('Live delta curated', { cone: folder, filename: entry.filename, through });
  return { status: 'curated', curatedThrough: through, filename: entry.filename };
}

/**
 * Walk slice-shaped receipts ahead of `cursor` and persist the cursor when
 * one of them proves a range the index does not yet record.
 */
async function drainReceipts(
  vfs: LiveCurationVfs,
  sessionId: string,
  filename: string,
  messages: readonly ChatMessage[],
  cursor: number,
  limits?: DeltaLimits
): Promise<number> {
  let current = cursor;
  for (let steps = 0; steps < 50; steps += 1) {
    const fresh = messagesAfterCursor(messages, current);
    if (fresh.length === 0) break;
    const slice = takeDeltaSlice(fresh, limits ?? DEFAULT_DELTA_LIMITS);
    const through = newestMessageTimestamp(slice);
    if (through <= current) break;
    const path = liveDeltaArchivePath(sessionId, current, through);
    if (!(await receiptExists(vfs, path))) break;
    current = through;
  }
  if (current > cursor) await advanceCuratedThrough(vfs, filename, current);
  return current;
}

async function writeDeltaArchive(
  vfs: LiveCurationVfs,
  source: {
    sessionId: string;
    filename: string;
    title: string;
    frozenAt: string;
    cone?: string;
    coneLabel?: string;
  },
  messages: readonly ChatMessage[],
  path: string
): Promise<void> {
  const archive: FrozenSessionArchive = {
    id: source.sessionId,
    title: source.title,
    frozenAt: source.frozenAt,
    createdAt: messages[0]?.timestamp ?? 0,
    updatedAt: newestMessageTimestamp(messages),
    messageCount: messages.length,
    messages: [...messages],
    ...(source.cone ? { cone: source.cone } : {}),
    ...(source.coneLabel ? { coneLabel: source.coneLabel } : {}),
  };
  await vfs.mkdir(LIVE_DELTA_DIR, { recursive: true });
  await vfs.writeFile(path, formatArchiveAsMarkdown(archive));
}

async function stampLiveFailure(
  vfs: LiveCurationVfs,
  filename: string,
  reason: string
): Promise<void> {
  try {
    await serializeIndexWrite(async () => {
      const entries = await readSessionsIndexForWrite(asArchive(vfs));
      const index = entries.findIndex((entry) => entry.filename === filename);
      if (index === -1) return;
      const updated = entries.slice();
      updated[index] = { ...entries[index], memoryFailed: reason.slice(0, 300) };
      await writeSessionsIndexUnlocked(asArchive(vfs), updated);
      await vfs.flush?.();
    });
  } catch (error) {
    log.warn('Failed to record live curation failure', {
      filename,
      error: errorText(error),
    });
  }
}

async function patchCuratedThroughFrontmatter(
  vfs: LiveCurationVfs,
  path: string,
  through: number
): Promise<void> {
  let text: string;
  try {
    text = await readText(vfs, path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return;
  const line = `curatedThrough: ${through}`;
  const fm = /^curatedThrough:\s*\d+\s*$/m.test(fmMatch[1])
    ? fmMatch[1].replace(/^curatedThrough:\s*\d+\s*$/m, line)
    : `${fmMatch[1]}\n${line}`;
  if (fm === fmMatch[1]) return;
  await vfs.writeFile(path, `---\n${fm}\n---\n${text.slice(fmMatch[0].length)}`);
}

async function readArchiveMessages(
  vfs: LiveCurationVfs,
  path: string
): Promise<ChatMessage[] | null> {
  try {
    return parseFrozenArchive(await readText(vfs, path)).messages;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function receiptExists(vfs: LiveCurationVfs, deltaPath: string): Promise<boolean> {
  try {
    await vfs.readFile(curatorReceiptPath(deltaPath), { encoding: 'utf-8' });
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function readText(vfs: LiveCurationVfs, path: string): Promise<string> {
  const raw = await vfs.readFile(path, { encoding: 'utf-8' });
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

function readAgentBridge(): AgentBridge | undefined {
  return (globalThis as unknown as AgentGlobals).__slicc_agent;
}

function messageWeight(message: ChatMessage): number {
  const tools = message.toolCalls ? JSON.stringify(message.toolCalls).length : 0;
  return message.content.length + tools;
}

function asArchive(vfs: LiveCurationVfs): ArchiveVfs {
  return vfs as ArchiveVfs;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  if (error instanceof FsError) return error.code === 'ENOENT';
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ENOENT';
}
