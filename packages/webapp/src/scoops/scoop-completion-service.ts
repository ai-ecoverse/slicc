import { createLogger } from '../base/logger.js';
import type { VirtualFS } from '../fs/index.js';
import { emitScoopLifecycle } from './scoop-telemetry-hook.js';
import type { ChannelMessage, RegisteredScoop } from './types.js';

const log = createLogger('scoop-completion-service');

const SCOOP_NOTIFICATION_DIR = '/shared/scoop-notifications';
const SCOOP_NOTIFICATION_MAX_FILES = 200;
const SCOOP_NOTIFICATION_PREVIEW_CHARS = 1000;
const WAITER_SUMMARY_MAX_CHARS = 20000;

function countTextLines(text: string): number {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === '\n') lines++;
  }
  return normalized.endsWith('\n') ? lines - 1 : lines;
}

function truncateForWaiter(text: string): string {
  return text.length > WAITER_SUMMARY_MAX_CHARS
    ? text.slice(0, WAITER_SUMMARY_MAX_CHARS) + '\n... (truncated)'
    : text;
}

export interface ScoopCompletionServiceDeps {
  getSharedFs(): VirtualFS | null;
  getScoop(jid: string): RegisteredScoop | undefined;

  findParent(jid: string): RegisteredScoop | undefined;

  hasScoop(jid: string): boolean;

  notifyIncomingMessage(scoopJid: string, msg: ChannelMessage): void;

  handleMessage(msg: ChannelMessage): Promise<void>;

  reportError(scoopJid: string, error: string): void;
}

export interface WaitResult {
  jid: string;
  summary: string | null;
  timedOut: boolean;
}

export interface UnmuteResult {
  jid: string;
  summary: string;
  timestamp: string;
  notificationPath: string | null;
}

export interface ScoopPassOutcome {
  exitCode: number;

  reason?: string;

  receiptPath?: string;
}

type DeferredDisposition = 'notify' | 'mute' | 'wait';

interface DeferredCompletion {
  responseText: string;
  timestamp: string;
  disposition: DeferredDisposition;
}

export class ScoopCompletionService {
  private scoopResponseBuffer: Map<string, string> = new Map();

  private mutedScoops: Set<string> = new Set();

  private pendingCompletions: Map<string, { responseText: string; timestamp: string }> = new Map();

  private deferredCompletions: Map<string, DeferredCompletion> = new Map();

  private failureReasons: Map<string, string> = new Map();

  private completionWaiters: Map<string, Array<(summary: string | null) => void>> = new Map();
  private readonly deps: ScoopCompletionServiceDeps;

  constructor(deps: ScoopCompletionServiceDeps) {
    this.deps = deps;
  }

  recordFailure(jid: string, reason: string): void {
    const trimmed = reason.trim();
    if (!trimmed) return;

    if (!this.failureReasons.has(jid)) this.failureReasons.set(jid, trimmed);
  }

  appendResponseChunk(jid: string, text: string): void {
    const buf = this.scoopResponseBuffer.get(jid) ?? '';
    this.scoopResponseBuffer.set(jid, buf + text);
  }

  setResponseFull(jid: string, text: string): void {
    this.scoopResponseBuffer.set(jid, text);
  }

  clearResponse(jid: string): void {
    this.scoopResponseBuffer.delete(jid);
    this.failureReasons.delete(jid);
  }

  muteScoops(jids: readonly string[]): void {
    for (const jid of jids) this.mutedScoops.add(jid);
    log.info('Scoops muted', { count: jids.length });
  }

  isScoopMuted(jid: string): boolean {
    return this.mutedScoops.has(jid);
  }

  forgetScoop(jid: string, reason: 'unregister' | 'fatal-error' | 'close'): void {
    this.scoopResponseBuffer.delete(jid);
    this.mutedScoops.delete(jid);
    this.pendingCompletions.delete(jid);
    this.deferredCompletions.delete(jid);
    this.failureReasons.delete(jid);
    const waiters = this.completionWaiters.get(jid);
    if (waiters && waiters.length > 0) {
      this.completionWaiters.delete(jid);
      for (const w of waiters) {
        try {
          w(null);
        } catch (err) {
          log.warn('completion waiter threw on cleanup', {
            jid,
            reason,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  shutdown(): void {
    for (const waiters of this.completionWaiters.values()) {
      for (const w of waiters) {
        try {
          w(null);
        } catch (err) {
          log.warn('completion waiter threw during shutdown', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    this.completionWaiters.clear();
    this.mutedScoops.clear();
    this.pendingCompletions.clear();
    this.deferredCompletions.clear();
    this.failureReasons.clear();
    this.scoopResponseBuffer.clear();
  }

  async notifyCompletion(jid: string): Promise<void> {
    const scoop = this.deps.getScoop(jid);
    if (!scoop || scoop.parentJid === null) return;

    emitScoopLifecycle('complete', scoop.folder);

    const responseText = this.scoopResponseBuffer.get(jid) ?? '';
    this.scoopResponseBuffer.delete(jid);

    if (scoop.notifyOnComplete === false) {
      this.failureReasons.delete(jid);
      return;
    }

    if (scoop.outcomeReceiptPath) {
      this.deferForOutcomeReceipt(scoop, jid, responseText);
      return;
    }

    if (this.claimWaiters(jid, responseText)) {
      this.failureReasons.delete(jid);
      return;
    }

    if (this.mutedScoops.has(jid)) {
      this.stashMuted(jid, scoop.folder, responseText, new Date().toISOString(), 'completion');
      return;
    }

    const failureReason = this.failureReasons.get(jid);
    this.failureReasons.delete(jid);
    if (!responseText && !failureReason) return;

    await this.deliverCompletionToParent(scoop, responseText, {
      exitCode: failureReason ? 1 : 0,
      ...(failureReason ? { reason: failureReason } : {}),
    });
  }

  async notifyWithOutcome(jid: string, outcome: ScoopPassOutcome): Promise<void> {
    const scoop = this.deps.getScoop(jid);
    this.failureReasons.delete(jid);
    const deferred = this.deferredCompletions.get(jid);
    this.deferredCompletions.delete(jid);

    if (!scoop || scoop.parentJid === null) return;
    if (scoop.notifyOnComplete === false) return;

    const responseText =
      deferred?.responseText ?? this.scoopResponseBuffer.get(jid) ?? outcome.reason ?? '';
    this.scoopResponseBuffer.delete(jid);

    const summaryText = formatOutcomeAwareSummary(responseText, outcome);
    const disposition = deferred?.disposition ?? 'notify';
    const timestamp = deferred?.timestamp ?? new Date().toISOString();

    if (this.applyDeferredDisposition(jid, scoop, disposition, summaryText, timestamp, outcome)) {
      return;
    }

    if (!responseText && outcome.exitCode === 0) return;

    await this.deliverCompletionToParent(scoop, responseText, {
      exitCode: outcome.exitCode,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.receiptPath ? { receiptPath: outcome.receiptPath } : {}),
    });
  }

  private deferForOutcomeReceipt(scoop: RegisteredScoop, jid: string, responseText: string): void {
    const disposition = this.currentDeferredDisposition(jid);
    this.deferredCompletions.set(jid, {
      responseText,
      timestamp: new Date().toISOString(),
      disposition,
    });
    log.info('Scoop completion deferred pending outcome receipt', {
      scoop: scoop.folder,
      receiptPath: scoop.outcomeReceiptPath,
      disposition,
      responseLength: responseText.length,
    });
  }

  private currentDeferredDisposition(jid: string): DeferredDisposition {
    const waiters = this.completionWaiters.get(jid);
    if (waiters && waiters.length > 0) return 'wait';
    if (this.mutedScoops.has(jid)) return 'mute';
    return 'notify';
  }

  private claimWaiters(jid: string, summary: string): boolean {
    const waiters = this.completionWaiters.get(jid);
    if (!waiters || waiters.length === 0) return false;
    this.completionWaiters.delete(jid);
    const waiterSummary = truncateForWaiter(summary);
    for (const w of waiters) {
      try {
        w(waiterSummary || null);
      } catch (err) {
        log.warn('completion waiter threw', {
          jid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return true;
  }

  private stashMuted(
    jid: string,
    folder: string,
    responseText: string,
    timestamp: string,
    kind: 'completion' | 'outcome',
    exitCode?: number
  ): void {
    this.pendingCompletions.set(jid, { responseText, timestamp });
    log.info(
      kind === 'outcome' ? 'Scoop outcome stashed (muted)' : 'Scoop completion stashed (muted)',
      {
        scoop: folder,
        responseLength: responseText.length,
        ...(exitCode !== undefined ? { exitCode } : {}),
      }
    );
  }

  private applyDeferredDisposition(
    jid: string,
    scoop: RegisteredScoop,
    disposition: DeferredDisposition,
    summaryText: string,
    timestamp: string,
    outcome: ScoopPassOutcome
  ): boolean {
    if (disposition === 'wait' && this.claimWaiters(jid, summaryText)) return true;
    if (disposition === 'mute' && this.mutedScoops.has(jid)) {
      this.stashMuted(jid, scoop.folder, summaryText, timestamp, 'outcome', outcome.exitCode);
      return true;
    }
    return false;
  }

  private async deliverCompletionToParent(
    scoop: RegisteredScoop,
    responseText: string,
    outcome: ScoopPassOutcome = { exitCode: 0 }
  ): Promise<void> {
    const cone = this.deps.findParent(scoop.jid);
    if (!cone) return;

    const failed = outcome.exitCode !== 0;
    const lineCount = countTextLines(responseText);
    const preview = responseText.slice(0, SCOOP_NOTIFICATION_PREVIEW_CHARS);
    let notifyContent: string;
    let artifactError: string | null = null;
    let notificationPath: string | null = null;

    const artifactBody = responseText || outcome.reason || `(exit code: ${outcome.exitCode})`;
    try {
      notificationPath = await this.writeScoopCompletionArtifact(scoop, artifactBody);
      log.info('Routing scoop completion to cone', {
        scoop: scoop.folder,
        responseLength: responseText.length,
        lineCount,
        notificationPath,
        failed,
        exitCode: outcome.exitCode,
      });
    } catch (err) {
      artifactError = err instanceof Error ? err.message : String(err);
      log.warn('Failed to persist scoop completion artifact, falling back to inline preview', {
        scoop: scoop.folder,
        error: artifactError,
      });
    }

    const headline = failed ? 'failed' : 'completed';
    if (artifactError === null) {
      notifyContent = formatScoopCompletionNotification(
        scoop.assistantLabel,
        headline,
        notificationPath ?? 'unavailable',
        lineCount,
        preview || artifactBody.slice(0, SCOOP_NOTIFICATION_PREVIEW_CHARS),
        outcome
      );
    } else {
      notifyContent = formatScoopCompletionFallbackNotification(
        scoop.assistantLabel,
        headline,
        lineCount,
        preview || artifactBody.slice(0, SCOOP_NOTIFICATION_PREVIEW_CHARS),
        artifactError,
        outcome
      );
    }

    const notifyMsg: ChannelMessage = {
      id: `scoop-done-${scoop.jid}-${Date.now()}`,
      chatJid: cone.jid,
      senderId: scoop.folder,
      senderName: scoop.assistantLabel,
      content: notifyContent,
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'scoop-notify',
    };

    try {
      this.deps.notifyIncomingMessage(cone.jid, notifyMsg);
    } catch (err) {
      log.warn('onIncomingMessage for scoop-notify threw', {
        scoop: scoop.folder,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await this.deps.handleMessage(notifyMsg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to route scoop completion to cone', {
        scoop: scoop.folder,
        error: msg,
      });
      this.deps.reportError(
        cone.jid,
        `Scoop ${scoop.folder} ${headline} but notification failed: ${msg}`
      );
    }
  }

  private async writeScoopCompletionArtifact(
    scoop: RegisteredScoop,
    responseText: string
  ): Promise<string> {
    const fs = this.deps.getSharedFs();
    if (!fs) throw new Error('Shared filesystem not initialized');

    await fs.mkdir(SCOOP_NOTIFICATION_DIR, { recursive: true });
    await this.pruneScoopCompletionArtifacts(SCOOP_NOTIFICATION_MAX_FILES - 1);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = Math.random().toString(36).slice(2, 8);
    const path = `${SCOOP_NOTIFICATION_DIR}/${timestamp}-${scoop.folder}-${suffix}.md`;
    await fs.writeFile(path, responseText);
    await this.pruneScoopCompletionArtifacts();
    return path;
  }

  private async pruneScoopCompletionArtifacts(
    maxArtifacts: number = SCOOP_NOTIFICATION_MAX_FILES
  ): Promise<void> {
    const fs = this.deps.getSharedFs();
    if (!fs) return;

    let entries: Awaited<ReturnType<VirtualFS['readDir']>>;
    try {
      entries = await fs.readDir(SCOOP_NOTIFICATION_DIR);
    } catch {
      return;
    }

    const files = entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => entry.name)
      .sort();
    const excess = files.length - maxArtifacts;
    if (excess <= 0) return;

    for (const name of files.slice(0, excess)) {
      const path = `${SCOOP_NOTIFICATION_DIR}/${name}`;
      try {
        await fs.rm(path);
      } catch (err) {
        log.warn('Failed to prune scoop completion artifact', {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async unmuteScoops(jids: readonly string[]): Promise<UnmuteResult[]> {
    const consumed: UnmuteResult[] = [];
    const artifactWrites: Array<Promise<void>> = [];
    for (const jid of jids) {
      this.mutedScoops.delete(jid);
      const pending = this.pendingCompletions.get(jid);
      if (!pending) continue;
      this.pendingCompletions.delete(jid);
      const scoop = this.deps.getScoop(jid);
      if (!scoop || scoop.parentJid === null) continue;
      const summary = truncateForWaiter(pending.responseText);
      const entry: UnmuteResult = {
        jid,
        summary,
        timestamp: pending.timestamp,
        notificationPath: null,
      };
      consumed.push(entry);
      artifactWrites.push(
        this.writeScoopCompletionArtifact(scoop, pending.responseText)
          .then((path) => {
            entry.notificationPath = path;
          })
          .catch((err) => {
            log.warn('unmute artifact persist failed', {
              jid,
              error: err instanceof Error ? err.message : String(err),
            });
          })
      );
    }
    await Promise.all(artifactWrites);
    log.info('Scoops unmuted', { count: jids.length, consumed: consumed.length });
    return consumed;
  }

  async waitForScoops(jids: readonly string[], timeoutMs?: number): Promise<WaitResult[]> {
    if (jids.length === 0) return [];

    const uniqueJids = Array.from(new Set(jids));

    const results = new Map<string, { summary: string | null; timedOut: boolean }>();
    const muteAdded: string[] = [];
    for (const jid of uniqueJids) {
      if (!this.mutedScoops.has(jid)) {
        this.mutedScoops.add(jid);
        muteAdded.push(jid);
      }
    }

    this.claimPendingSummaries(uniqueJids, results);

    const missing = uniqueJids.filter((jid) => !results.has(jid));
    const resolvable = missing.filter((jid) => this.deps.hasScoop(jid));
    const unknown = missing.filter((jid) => !this.deps.hasScoop(jid));
    for (const jid of unknown) {
      results.set(jid, { summary: null, timedOut: true });
    }

    const registered: Array<{ jid: string; waiter: (s: string | null) => void }> = [];
    const promises = resolvable.map(
      (jid) =>
        new Promise<void>((resolve) => {
          const waiter = (summary: string | null) => {
            if (results.has(jid)) return;
            results.set(jid, { summary, timedOut: summary === null });
            resolve();
          };
          registered.push({ jid, waiter });
          let list = this.completionWaiters.get(jid);
          if (!list) {
            list = [];
            this.completionWaiters.set(jid, list);
          }
          list.push(waiter);
        })
    );

    try {
      await this.awaitScoopWaiters(promises, timeoutMs);
    } finally {
      this.removeCompletionWaiters(registered);
      for (const jid of muteAdded) this.mutedScoops.delete(jid);
    }

    for (const jid of resolvable) {
      if (!results.has(jid)) {
        results.set(jid, { summary: null, timedOut: true });
      }
    }

    return jids.map((jid) => {
      const r = results.get(jid) ?? { summary: null, timedOut: true };
      return { jid, summary: r.summary, timedOut: r.timedOut };
    });
  }

  private claimPendingSummaries(
    jids: readonly string[],
    results: Map<string, { summary: string | null; timedOut: boolean }>
  ): void {
    for (const jid of jids) {
      const pending = this.pendingCompletions.get(jid);
      if (!pending) continue;
      this.pendingCompletions.delete(jid);
      results.set(jid, { summary: truncateForWaiter(pending.responseText), timedOut: false });
    }
  }

  private async awaitScoopWaiters(promises: Promise<void>[], timeoutMs?: number): Promise<void> {
    if (promises.length === 0) return;
    if (timeoutMs == null || timeoutMs < 0) {
      await Promise.all(promises);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        Promise.all(promises),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => resolve(), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private removeCompletionWaiters(
    registered: Array<{ jid: string; waiter: (s: string | null) => void }>
  ): void {
    for (const { jid, waiter } of registered) {
      const list = this.completionWaiters.get(jid);
      if (!list) continue;
      const idx = list.indexOf(waiter);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this.completionWaiters.delete(jid);
    }
  }

  scheduleScoopWait(
    jids: readonly string[],
    timeoutMs?: number,
    requesterJid?: string
  ): { scheduled: string[]; unknown: string[] } {
    const uniqueJids = Array.from(new Set(jids));
    const scheduled = uniqueJids.filter((jid) => this.deps.hasScoop(jid));
    const unknown = uniqueJids.filter((jid) => !this.deps.hasScoop(jid));

    void this.waitForScoops(scheduled, timeoutMs)
      .then((results) => this.deliverWaitResultsToCone(results, requesterJid))
      .catch((err) => {
        log.error('scheduleScoopWait failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return { scheduled, unknown };
  }

  private async deliverWaitResultsToCone(
    results: WaitResult[],
    requesterJid?: string
  ): Promise<void> {
    if (results.length === 0) return;

    const requester = requesterJid === undefined ? undefined : this.deps.getScoop(requesterJid);
    if (requester) {
      await this.deliverWaitResultsTo(requester, results);
      return;
    }

    const byParent = new Map<string, { parent: RegisteredScoop; results: WaitResult[] }>();
    for (const r of results) {
      const parent = this.deps.findParent(r.jid);
      if (!parent) continue;
      const group = byParent.get(parent.jid) ?? { parent, results: [] };
      group.results.push(r);
      byParent.set(parent.jid, group);
    }
    for (const { parent, results: own } of byParent.values()) {
      await this.deliverWaitResultsTo(parent, own);
    }
  }

  private async deliverWaitResultsTo(cone: RegisteredScoop, results: WaitResult[]): Promise<void> {
    const lines: string[] = ['[scoop_wait completed]'];
    let timedOutCount = 0;
    let completedCount = 0;
    for (const r of results) {
      const target = this.deps.getScoop(r.jid);
      const label = target?.folder ?? r.jid;
      if (r.timedOut) {
        timedOutCount += 1;
        lines.push(`--- ${label} (timed out) ---`);
      } else {
        completedCount += 1;
        lines.push(`--- ${label} ---`);
        lines.push(r.summary ?? '(no output)');
      }
    }
    const summary = `${completedCount} completed, ${timedOutCount} timed out`;
    lines.splice(1, 0, summary);

    const msg: ChannelMessage = {
      id: `scoop-wait-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      chatJid: cone.jid,
      senderId: 'scoop-wait',
      senderName: 'scoop-wait',
      content: lines.join('\n'),
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'scoop-wait',
    };

    try {
      this.deps.notifyIncomingMessage(cone.jid, msg);
    } catch (err) {
      log.warn('onIncomingMessage for scoop-wait threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await this.deps.handleMessage(msg);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('Failed to route scoop-wait result to cone', { error: errMsg });
      this.deps.reportError(cone.jid, `scoop_wait completed but notification failed: ${errMsg}`);
    }
  }
}

function formatScoopCompletionNotification(
  assistantLabel: string,
  headline: 'completed' | 'failed',
  notificationPath: string,
  lineCount: number,
  preview: string,
  outcome: ScoopPassOutcome
): string {
  return [
    `[@${assistantLabel} ${headline}]`,
    ...outcomeLines(outcome),
    `VFS path: ${notificationPath}`,
    `Total lines: ${lineCount}`,
    `Preview (up to ${SCOOP_NOTIFICATION_PREVIEW_CHARS} chars):`,
    preview,
  ].join('\n');
}

function formatScoopCompletionFallbackNotification(
  assistantLabel: string,
  headline: 'completed' | 'failed',
  lineCount: number,
  preview: string,
  artifactError: string,
  outcome: ScoopPassOutcome
): string {
  return [
    `[@${assistantLabel} ${headline}]`,
    ...outcomeLines(outcome),
    'VFS path: unavailable',
    `Artifact persistence error: ${artifactError}`,
    `Total lines: ${lineCount}`,
    `Preview (up to ${SCOOP_NOTIFICATION_PREVIEW_CHARS} chars):`,
    preview,
  ].join('\n');
}

function outcomeLines(outcome: ScoopPassOutcome): string[] {
  const lines: string[] = [];
  const failed = outcome.exitCode !== 0;
  if (!failed && !outcome.reason && !outcome.receiptPath) return lines;
  lines.push(`status: ${failed ? 'failed' : 'ok'}`);
  lines.push(`exitCode: ${outcome.exitCode}`);
  if (outcome.reason) lines.push(`reason: ${outcome.reason.slice(0, 500)}`);
  if (outcome.receiptPath) lines.push(`status.json: ${outcome.receiptPath}`);
  return lines;
}

function formatOutcomeAwareSummary(responseText: string, outcome: ScoopPassOutcome): string {
  if (outcome.exitCode === 0) return responseText;
  const head = outcome.reason
    ? `failed (exit ${outcome.exitCode}): ${outcome.reason}`
    : `failed (exit ${outcome.exitCode})`;
  return responseText ? `${head}\n${responseText}` : head;
}
