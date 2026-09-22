import type { ToolProgressEvent } from '@slicc/shared-ts';
import { isGelatiereUnit } from '../base/gelatiere-constants.js';
import { createLogger } from '../base/logger.js';
import type { CompactionState, CompactionStateDetail } from '../core/context-compaction.js';
import type { SessionStore } from '../core/session.js';
import type { ImageContent } from '../core/types.js';
import type { VirtualFS } from '../fs/index.js';
import { RestrictedFS } from '../fs/restricted-fs.js';
import type { ProcessManager } from '../kernel/process-manager.js';
import type { SudoDecision, SudoRequest } from '../sudo/index.js';
import type { SudoManager } from '../sudo/sudo-manager.js';
import type { TurnGuestGate } from '../sudo/types.js';
import type { CapabilityBroker } from '../work-unit/capability/index.js';
import { conversationKeyFor } from '../work-unit/conversation/key.js';
import type { WorkUnitConversationStore } from '../work-unit/conversation/store.js';
import { toDescriptor, workspaceFor } from '../work-unit/descriptor.js';
import { LiveWorkUnit } from '../work-unit/live-unit.js';
import {
  assertChildPolicyAllowed,
  childrenOf,
  isRootUnit,
  rootOwnerOf,
  rootsOf,
} from '../work-unit/policy.js';
import {
  leadingRootOf,
  modelFor,
  modelIdFor,
  normalizeScoopRecord,
  setUnitModel,
  setUnitThinking,
  uniqueFolder,
} from '../work-unit/record.js';
import { includeMountsForMode, parseWorkspaceMode } from '../work-unit/workspace-mode.js';
import type { AppendConeMemoryMeta } from './cone-memory-store.js';
import { globalSeedModel } from './model-seed.js';
import type { TurnJournal } from './scoop-context/turn-journal.js';
import { ScoopContext, type ScoopContextCallbacks } from './scoop-context.js';
import { emitScoopLifecycle } from './scoop-telemetry-hook.js';
import type {
  ChannelMessage,
  RegisteredScoop,
  ScoopTabState,
  ThinkingLevel,
  WorkUnitModel,
} from './types.js';

const log = createLogger('scoop-lifecycle-manager');

export interface ScoopObserver {
  onStatusChange?: (status: ScoopTabState['status']) => void;
  onSendMessage?: (text: string) => void;
  onResponse?: (text: string, isPartial: boolean) => void;
  onError?: (error: string) => void;
}

export interface ScoopLifecycleCallbacks {
  onResponse(scoopJid: string, text: string, isPartial: boolean): void;
  onResponseDone(scoopJid: string): void;
  onSendMessage(targetJid: string, text: string): void;
  onStatusChange(scoopJid: string, status: ScoopTabState['status']): void;
  onCompactionStateChange?(
    scoopJid: string,
    state: CompactionState,
    detail: CompactionStateDetail
  ): void;
  onError(scoopJid: string, error: string, options?: { endTurn?: boolean }): void;
  getBrowserAPI(): ReturnType<ScoopContextCallbacks['getBrowserAPI']>;
  onToolStart?(scoopJid: string, toolName: string, toolInput: unknown, toolCallId?: string): void;
  onToolEnd?(
    scoopJid: string,
    toolName: string,
    result: string,
    isError: boolean,
    toolCallId?: string
  ): void;

  onToolUI?(
    scoopJid: string,
    toolName: string,
    requestId: string,
    html: string,
    displayScoopJid?: string
  ): void;
  onToolUIDone?(scoopJid: string, requestId: string, displayScoopJid?: string): void;
  onToolProgress?(
    scoopJid: string,
    toolName: string,
    progress: ToolProgressEvent,
    toolCallId?: string
  ): void;
  onIncomingMessage?(scoopJid: string, message: ChannelMessage): void;
  onScoopUnregistered?(scoop: RegisteredScoop): void;
}

export interface ScoopLifecycleDb {
  saveScoop(scoop: RegisteredScoop): Promise<void>;
  deleteScoop(jid: string): Promise<void>;
}

export interface ScoopLifecycleLickGuard {
  getLicksForScoopFromDb(
    name: string,
    folder: string
  ): Promise<{ webhooks: ReadonlyArray<unknown>; cronTasks: ReadonlyArray<unknown> }>;
}

export interface ScoopLifecycleDeps {
  getScoops(): Map<string, RegisteredScoop>;

  approverFor(jid: string): RegisteredScoop | undefined;

  getSharedFs(): VirtualFS | null;

  getSessionStore(): SessionStore | null;

  getConversationStore(): WorkUnitConversationStore | null;

  getProcessManager(): ProcessManager | null;

  getSudoManager(): SudoManager | null;

  getCapabilityBroker?(): CapabilityBroker | null;

  getTurnJournal?(): TurnJournal | null;

  callbacks: ScoopLifecycleCallbacks;

  idleTimers: { start(jid: string): void; clear(jid: string): void };

  completionService: {
    appendResponseChunk(jid: string, chunk: string): void;
    setResponseFull(jid: string, text: string): void;
    notifyCompletion(jid: string): Promise<void> | void;
    forgetScoop(jid: string, reason: 'unregister' | 'fatal-error' | 'close'): void;
    clearResponse(jid: string): void;
  };

  db: ScoopLifecycleDb;

  getLickManager(): ScoopLifecycleLickGuard | null;

  buildActiveLicksError(
    folder: string,
    webhooks: ReadonlyArray<unknown>,
    cronTasks: ReadonlyArray<unknown>
  ): Error | null;

  messageRouter: {
    ensureQueue(jid: string): void;
    forgetScoop(jid: string): void;
    flushOnIdle(jid: string): Promise<void>;
  };

  costTracker: { snapshot(jid: string): void };

  approvalRouter: { failScoop(jid: string): number };

  cone: {
    delegateToScoop(scoopJid: string, prompt: string, senderName: string): Promise<void>;
    registerScoop(scoop: RegisteredScoop): Promise<void>;
    unregisterScoop(jid: string): Promise<void>;
    muteScoops(jids: readonly string[]): void;
    unmuteScoops(
      jids: readonly string[]
    ): Promise<
      Array<{ jid: string; summary: string; timestamp: string; notificationPath: string | null }>
    >;
    scheduleScoopWait(
      jids: readonly string[],
      timeoutMs?: number,
      requesterJid?: string
    ): { scheduled: string[]; unknown: string[] };
    getScoops(): RegisteredScoop[];
    getGlobalMemory(): Promise<string>;
    setGlobalMemory(content: string): Promise<void>;
    appendConeMemory(bullets: string, meta: AppendConeMemoryMeta): Promise<void>;
    enqueueSudoRequest(scoopJid: string, request: SudoRequest): Promise<SudoDecision>;
    resolveActionableLick(
      id: string,
      decision: SudoDecision,
      approverJid?: string
    ): Promise<{
      settled: boolean;
      persisted: boolean;
      persistedPattern?: string;
      persistError?: string;
      scoopFolder?: string;
      kind?: SudoRequest['kind'];
      message?: string;
    }>;
    approveDirectedOrUser(
      request: import('../sudo/types.js').SudoRequest
    ): Promise<import('../sudo/types.js').SudoDecision>;
    listPendingSudoRequests(
      approverJid?: string
    ): ReturnType<NonNullable<ScoopContextCallbacks['onListSudoRequests']>>;
  };
}

export class ScoopLifecycleManager {
  private units: Map<string, LiveWorkUnit> = new Map();

  private tabCreates: Map<string, Promise<void>> = new Map();

  private gelatiereModelSync: Promise<void> = Promise.resolve();

  constructor(private deps: ScoopLifecycleDeps) {}

  getUnit(jid: string): LiveWorkUnit | undefined {
    return this.units.get(jid);
  }

  ensureUnit(jid: string): LiveWorkUnit {
    let unit = this.units.get(jid);
    if (!unit || unit.isClosed) {
      unit = new LiveWorkUnit(jid, {
        getScoop: (j) => this.deps.getScoops().get(j),
        sendPrompt: (j, text, senderId, senderName, options) =>
          this.sendPrompt(j, text, senderId, senderName, [], options),
        clearIdleTimer: (j) => this.deps.idleTimers.clear(j),
        forgetCompletion: (j, reason) => this.deps.completionService.forgetScoop(j, reason),
        unregister: (j) => this.unregister(j),
      });
      this.units.set(jid, unit);
    }
    return unit;
  }

  getContexts(): Map<string, ScoopContext> {
    const out = new Map<string, ScoopContext>();
    for (const [jid, unit] of this.units) {
      if (unit.context) out.set(jid, unit.context as ScoopContext);
    }
    return out;
  }

  getContext(jid: string): ScoopContext | undefined {
    return (this.units.get(jid)?.context as ScoopContext | null | undefined) ?? undefined;
  }

  syncReadGrants(folder?: string): void {
    for (const scoop of this.deps.getScoops().values()) {
      if (folder !== undefined && scoop.folder !== folder) continue;

      const fs = this.getContext(scoop.jid)?.getFS();
      this.applyPolicyReadGrants(scoop, fs);
    }
  }

  getTab(jid: string): ScoopTabState | undefined {
    return this.units.get(jid)?.tab ?? undefined;
  }

  observe(jid: string, observer: ScoopObserver): () => void {
    return this.ensureUnit(jid).observe(observer);
  }

  private displayJidFor(jid: string): string | undefined {
    const owner = this.deps.approverFor(jid)?.jid;
    return owner && owner !== jid ? owner : undefined;
  }

  private dispatch<K extends keyof ScoopObserver>(
    jid: string,
    event: K,
    ...args: Parameters<NonNullable<ScoopObserver[K]>>
  ): void {
    this.units.get(jid)?.dispatch(event, ...args);
  }

  private parentOf(scoop: RegisteredScoop): RegisteredScoop | undefined {
    const scoops = this.deps.getScoops();
    const parent = scoop.parentJid === null ? undefined : scoops.get(scoop.parentJid);
    return parent ?? rootsOf(scoops.values())[0];
  }

  private rootOf(scoop: RegisteredScoop): RegisteredScoop | undefined {
    const scoops = this.deps.getScoops();
    return rootOwnerOf(scoops.values(), scoop) ?? rootsOf(scoops.values())[0];
  }

  private async ensureSudoersLoaded(scoop: RegisteredScoop): Promise<void> {
    const sudoManager = this.deps.getSudoManager();
    if (!sudoManager) return;
    try {
      await sudoManager.initScoopPolicy(scoop.folder, scoop.config);
    } catch (err) {
      log.warn('Failed to initialize per-scoop sudo policy; continuing with existing policy', {
        folder: scoop.folder,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private applyPolicyReadGrants(
    scoop: RegisteredScoop,
    fs: VirtualFS | RestrictedFS | null | undefined
  ): void {
    if (!(fs instanceof RestrictedFS)) return;
    const policy = this.deps.getSudoManager()?.getPolicyForScoop(scoop.folder);
    if (!policy) return;
    fs.setReadGrants(policy.read.filter((rule) => rule.nopasswd).map((rule) => rule.pattern));
  }

  createTab(jid: string): Promise<void> {
    const inflight = this.tabCreates.get(jid);
    if (inflight) return inflight;
    let run!: Promise<void>;
    run = this.openTab(jid).finally(() => {
      if (this.tabCreates.get(jid) === run) this.tabCreates.delete(jid);
    });
    this.tabCreates.set(jid, run);
    return run;
  }

  private async openTab(jid: string): Promise<void> {
    const scoop = this.deps.getScoops().get(jid);
    if (!scoop) throw new Error(`Scoop not found: ${jid}`);

    const unit = this.ensureUnit(jid);
    if (unit.context) {
      if (unit.tab?.status === 'error') {
        log.info('Re-creating context after error', { jid });
        unit.disposeContext();
      } else {
        log.debug('Context already exists', { jid });
        return;
      }
    }

    const sharedFs = this.deps.getSharedFs();
    if (!sharedFs) throw new Error('Shared filesystem not initialized');

    const contextId = `scoop-${scoop.folder}-${Date.now()}`;

    const unitDescriptor = toDescriptor(scoop);
    const fsPolicy = unitDescriptor.policy.filesystem;
    if (fsPolicy.kind === 'restricted') {
      const parsedMode = parseWorkspaceMode(fsPolicy.mode);
      if (!parsedMode.ok) throw new Error(parsedMode.error);
    }
    const fs =
      fsPolicy.kind === 'full-workspace'
        ? sharedFs
        : new RestrictedFS(
            sharedFs,
            [...fsPolicy.writablePaths],
            [...fsPolicy.visiblePaths],
            'sudo-delegated',
            { includeMounts: includeMountsForMode(fsPolicy.mode) }
          );

    if (fsPolicy.kind === 'restricted') {
      await this.ensureSudoersLoaded(scoop);
      this.applyPolicyReadGrants(scoop, fs);
    }

    const contextCallbacks = this.buildContextCallbacks(jid, scoop);

    const coneJid = this.rootOf(scoop)?.jid;
    const context = new ScoopContext(
      scoop,
      contextCallbacks,
      fs,
      this.deps.getSessionStore() ?? undefined,
      sharedFs ?? undefined,
      coneJid,
      this.deps.getProcessManager() ?? undefined,
      this.deps.getSudoManager(),
      this.deps.getConversationStore(),
      this.deps.getCapabilityBroker?.() ?? undefined,
      this.deps.getTurnJournal?.() ?? undefined
    );

    unit.attachContext(context, contextId);

    await context.init();

    if (this.units.get(jid) !== unit || unit.context !== context) return;

    if (unit.tab?.status === 'initializing' && unit.transition('ready')) {
      this.deps.callbacks.onStatusChange(jid, 'ready');
      this.dispatch(jid, 'onStatusChange', 'ready');

      void Promise.resolve()
        .then(() => this.deps.messageRouter.flushOnIdle(jid))
        .catch((err) => {
          log.warn('Initial idle queue probe failed', {
            jid,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    const scoopForTimer = this.deps.getScoops().get(jid);
    if (
      scoopForTimer &&
      scoopForTimer.parentJid !== null &&
      scoopForTimer.notifyOnComplete !== false
    ) {
      this.deps.idleTimers.start(jid);
    }

    log.info('Scoop context created', { jid, contextId });
  }

  async reinitAfterPromote(jid: string): Promise<void> {
    const unit = this.units.get(jid);
    if (!unit?.context) return;
    unit.disposeContext();
    try {
      await this.createTab(jid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Failed to re-init promoted unit; next prompt will retry', { jid, error: message });

      unit.disposeContext();
      this.markTabError(jid, message);
    }
  }

  destroyTab(jid: string): void {
    this.deps.idleTimers.clear(jid);
    const unit = this.units.get(jid);
    if (!unit) return;

    void unit.teardown();
    this.units.delete(jid);
    log.info('Scoop context destroyed', { jid });
  }

  getTabsMap(): Map<string, ScoopTabState> {
    const out = new Map<string, ScoopTabState>();
    for (const [jid, unit] of this.units) {
      if (unit.tab) out.set(jid, unit.tab);
    }
    return out;
  }

  markTabError(jid: string, message: string): void {
    const unit = this.ensureUnit(jid);
    unit.transition('error', {
      contextId: unit.tab?.contextId ?? `scoop-error-${jid}`,
      error: message,
    });
  }

  dispatchEvent<K extends keyof ScoopObserver>(
    jid: string,
    event: K,
    ...args: Parameters<NonNullable<ScoopObserver[K]>>
  ): void {
    this.dispatch(jid, event, ...args);
  }

  stopAndClearAllContexts(): void {
    for (const unit of this.units.values()) {
      unit.detachContext();
    }
  }

  async destroyAllTabs(): Promise<void> {
    for (const jid of Array.from(this.units.keys())) {
      this.destroyTab(jid);
    }
  }

  private async waitForTabReady(jid: string, timeoutMs: number = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const tab = this.getTab(jid);
      if (!tab) return false;
      if (tab.status === 'ready' || tab.status === 'processing') return true;
      if (tab.status === 'error') return false;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    log.warn('Timed out waiting for tab to become ready', { jid });
    return false;
  }

  async sendPrompt(
    jid: string,
    text: string,
    _senderId: string,
    _senderName: string,
    images: ImageContent[] = [],
    options?: { steer?: boolean; guestGates?: TurnGuestGate[] }
  ): Promise<void> {
    const record = this.deps.getScoops().get(jid);
    if (record && isGelatiereUnit(record)) {
      await this.syncGelatiereModel();
      if (!modelFor(record)) {
        throw new Error('The gelatiere cannot run until the leading cone has a model');
      }
    }
    let context = this.getContext(jid);

    if (!context) {
      await this.createTab(jid);
      context = this.getContext(jid);
    }

    const unit = this.units.get(jid);
    if (unit?.tab?.status === 'initializing') {
      log.debug('Context initializing, waiting to send message', { jid });
      const ready = await this.waitForTabReady(jid);
      if (!ready) {
        log.error('Context did not become ready in time, dropping prompt', { jid });
        return;
      }
      context = this.getContext(jid);
    }

    if (!context || !unit) {
      log.error('Context not found after creation', { jid });
      return;
    }

    this.deps.idleTimers.clear(jid);

    this.deps.completionService.clearResponse(jid);
    if (unit.tab && unit.transition('processing')) {
      this.deps.callbacks.onStatusChange(jid, 'processing');
      this.dispatch(jid, 'onStatusChange', 'processing');
    }

    log.debug('Prompt sent to scoop', { jid, textLength: text.length, imageCount: images.length });

    await context.prompt(text, images, options);
  }

  async resumeTurn(jid: string, resumeCount: number, guestGates: TurnGuestGate[]): Promise<void> {
    const context = this.getContext(jid);
    const unit = this.units.get(jid);
    if (!context || !unit || context.isBusy) return;
    this.deps.idleTimers.clear(jid);
    this.deps.completionService.clearResponse(jid);
    if (unit.tab && unit.transition('processing')) {
      this.deps.callbacks.onStatusChange(jid, 'processing');
      this.dispatch(jid, 'onStatusChange', 'processing');
    }
    await context.resumeTurn(resumeCount, guestGates);
  }

  async register(scoop: RegisteredScoop): Promise<void> {
    const scoops = this.deps.getScoops();
    const previousLeadingJid = leadingRootOf(scoops.values())?.jid;
    normalizeScoopRecord(scoop);
    this.inheritModel(scoop);

    if (scoop.parentJid !== null) {
      const taken: string[] = [];
      for (const existing of scoops.values()) {
        if (existing.jid !== scoop.jid) taken.push(existing.folder);
      }
      const free = uniqueFolder(scoop.folder, taken);
      if (free !== scoop.folder) {
        log.warn('Scoop folder already taken — registering under a free variant', {
          jid: scoop.jid,
          requested: scoop.folder,
          folder: free,
        });
        scoop.folder = free;
        scoop.trigger = `@${free}`;
        scoop.assistantLabel = free;
      }
    }
    scoops.set(scoop.jid, scoop);
    try {
      await this.deps.db.saveScoop(scoop);
    } catch (err) {
      scoops.delete(scoop.jid);
      throw err;
    }
    this.deps.messageRouter.ensureQueue(scoop.jid);
    log.info('Scoop registered', { jid: scoop.jid, name: scoop.name });
    try {
      await this.createTab(scoop.jid);

      if (scoop.parentJid !== null) emitScoopLifecycle('spawn', scoop.folder);
    } catch (err) {
      log.error('Scoop init failed', {
        jid: scoop.jid,
        name: scoop.name,
        error: err instanceof Error ? err.message : String(err),
      });

      try {
        this.destroyTab(scoop.jid);
      } catch (destroyErr) {
        log.warn('Failed to destroy scoop runtime during init rollback', {
          jid: scoop.jid,
          name: scoop.name,
          error: destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
        });
      }
      scoops.delete(scoop.jid);
      this.deps.messageRouter.forgetScoop(scoop.jid);
      await this.deps.db.deleteScoop(scoop.jid).catch((rollbackErr) => {
        log.warn('Failed to rollback scoop registration', {
          jid: scoop.jid,
          name: scoop.name,
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        });
      });
      throw err;
    }
    if (leadingRootOf(scoops.values())?.jid !== previousLeadingJid) {
      await this.syncGelatiereModel().catch((err) => {
        log.warn('Failed to follow the new leading cone after registration', {
          jid: scoop.jid,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private inheritModel(scoop: RegisteredScoop): void {
    if (isGelatiereUnit(scoop)) {
      const leading = leadingRootOf(this.deps.getScoops().values());
      setUnitModel(scoop, leading ? modelFor(leading) : undefined);
      return;
    }
    if (modelIdFor(scoop)) return;
    const parent = scoop.parentJid ? this.deps.getScoops().get(scoop.parentJid) : undefined;
    const model = (parent ? modelFor(parent) : undefined) ?? globalSeedModel();
    if (model) setUnitModel(scoop, model);
  }

  async unregister(jid: string): Promise<void> {
    const scoops = this.deps.getScoops();
    const wasLeadingRoot = leadingRootOf(scoops.values())?.jid === jid;

    for (const child of childrenOf(scoops.values(), jid)) {
      await this.unregister(child.jid);
    }
    const scoop = scoops.get(jid);

    if (scoop && scoop.parentJid === null && rootsOf(scoops.values()).length <= 1) {
      throw new Error('Cannot drop the last cone');
    }
    const lickManager = this.deps.getLickManager();
    if (scoop && lickManager) {
      const { webhooks, cronTasks } = await lickManager.getLicksForScoopFromDb(
        scoop.name,
        scoop.folder
      );
      const err = this.deps.buildActiveLicksError(scoop.folder, webhooks, cronTasks);
      if (err) throw err;
    }

    this.deps.costTracker.snapshot(jid);

    const wsSubs = (
      globalThis as { __slicc_wsSubscribers?: { dropForScoop: (j: string) => Promise<number> } }
    ).__slicc_wsSubscribers;
    if (wsSubs) {
      void wsSubs.dropForScoop(jid).catch((err) => {
        log.warn('dropForScoop (ws subscribers) failed', {
          jid,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    this.destroyTab(jid);

    await Promise.all([
      scoop ? this.deps.getConversationStore()?.delete(conversationKeyFor(scoop)) : undefined,
      this.deps
        .getSessionStore()
        ?.delete(jid)
        .catch((err) => {
          log.warn('Failed to delete agent session', {
            jid,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
    ]);
    await this.deps.db.deleteScoop(jid);
    scoops.delete(jid);
    this.deps.messageRouter.forgetScoop(jid);
    this.deps.completionService.forgetScoop(jid, 'unregister');
    const sudoFailed = this.deps.approvalRouter.failScoop(jid);
    if (sudoFailed > 0) {
      log.info('Failed-closed pending sudo requests for unregistered scoop', {
        jid,
        count: sudoFailed,
      });
    }

    if (scoop) this.deps.getSudoManager()?.forgetScoopPolicies(scoop.folder);
    log.info('Scoop unregistered', { jid });
    if (scoop) {
      try {
        this.deps.callbacks.onScoopUnregistered?.(scoop);
      } catch (err) {
        log.warn('onScoopUnregistered callback threw', {
          jid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (wasLeadingRoot) {
      await this.syncGelatiereModel().catch((err) => {
        log.warn('Failed to follow the replacement leading cone after root removal', {
          jid,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  async setModel(jid: string, model: WorkUnitModel | undefined): Promise<boolean> {
    const scoop = this.deps.getScoops().get(jid);
    if (!scoop) return false;
    if (isGelatiereUnit(scoop)) {
      await this.syncGelatiereModel();
      return false;
    }
    const changesLeadingModel = leadingRootOf(this.deps.getScoops().values())?.jid === jid;
    const previous = scoop.model;
    setUnitModel(scoop, model);
    this.getContext(jid)?.updateModel();
    try {
      await this.deps.db.saveScoop(scoop);
    } catch (err) {
      setUnitModel(scoop, previous);
      this.getContext(jid)?.updateModel();
      log.warn('Failed to persist unit model; rolled back', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (changesLeadingModel) {
      await this.syncGelatiereModel().catch((err) => {
        log.warn('Failed to synchronize gelatiere after leading model change', {
          jid,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return true;
  }

  syncGelatiereModel(): Promise<boolean> {
    const run = this.gelatiereModelSync.then(() => this.applyGelatiereModel());
    this.gelatiereModelSync = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async applyGelatiereModel(): Promise<boolean> {
    const scoops = this.deps.getScoops();
    const gelatiere = [...scoops.values()].find(isGelatiereUnit);
    if (!gelatiere) return false;

    const leading = leadingRootOf(scoops.values());
    const desired = leading ? modelFor(leading) : undefined;
    const current = modelFor(gelatiere);
    const unchanged = desired
      ? current?.provider === desired.provider && current.id === desired.id
      : modelIdFor(gelatiere) === undefined;

    if (!unchanged) {
      const previousModel = gelatiere.model ? { ...gelatiere.model } : undefined;
      const previousConfig = gelatiere.config ? { ...gelatiere.config } : undefined;
      setUnitModel(gelatiere, desired);
      try {
        await this.deps.db.saveScoop(gelatiere);
      } catch (err) {
        gelatiere.model = previousModel;
        gelatiere.config = previousConfig;
        throw err;
      }
      log.info('Gelatiere model synchronized with leading cone', {
        jid: gelatiere.jid,
        leadingJid: leading?.jid,
        model: desired ? `${desired.provider}:${desired.id}` : undefined,
      });
    }

    if (desired) this.getContext(gelatiere.jid)?.updateModel();
    return !unchanged;
  }

  refreshModels(): void {
    const contexts = this.getContexts();
    for (const context of contexts.values()) {
      context.updateModel();
    }
    log.info('Models re-resolved on all active contexts', { contextCount: contexts.size });
  }

  async reloadAllSkills(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [jid, context] of this.getContexts()) {
      const tab = this.getTab(jid);
      if (tab?.status === 'ready' || tab?.status === 'processing') {
        promises.push(
          context.reloadSkills().catch((err) => {
            log.warn('Failed to reload skills for scoop', {
              jid,
              error: err instanceof Error ? err.message : String(err),
            });
          })
        );
      }
    }
    await Promise.all(promises);
    log.info('Skills reloaded across all contexts', { count: promises.length });
  }

  async setThinkingLevel(
    jid: string,
    level: ThinkingLevel | undefined,
    effortOverride?: string
  ): Promise<ThinkingLevel | null> {
    const scoop = this.deps.getScoops().get(jid);
    if (!scoop) return null;

    const context = this.getContext(jid);
    const applied = context ? context.setThinkingLevel(level, effortOverride) : null;

    setUnitThinking(scoop, level === undefined ? undefined : { level, effortOverride });

    try {
      await this.deps.db.saveScoop(scoop);
    } catch (err) {
      log.warn('Failed to persist thinkingLevel', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return applied;
  }

  private buildContextCallbacks(jid: string, scoop: RegisteredScoop): ScoopContextCallbacks {
    const { callbacks, completionService, cone } = this.deps;
    const scoops = () => this.deps.getScoops();
    const { policy, completion } = toDescriptor(scoop);
    const reportsToParent = completion.mode !== 'interactive';
    return {
      onResponse: (text, isPartial) => {
        if (!scoops().has(jid)) return;

        callbacks.onResponse(jid, text, isPartial);
        this.dispatch(jid, 'onResponse', text, isPartial);

        if (reportsToParent) {
          if (isPartial) {
            completionService.appendResponseChunk(jid, text);
          } else {
            completionService.setResponseFull(jid, text);
          }
        }
      },
      onResponseDone: () => {
        if (!scoops().has(jid)) return;

        this.units.get(jid)?.touch();
        callbacks.onResponseDone(jid);
      },
      onError: (error) => {
        if (!scoops().has(jid)) return;

        this.units.get(jid)?.transition('error', { error });
        emitScoopLifecycle('error', scoop.folder, error);
        callbacks.onError(jid, error);
        callbacks.onStatusChange(jid, 'error');
        this.dispatch(jid, 'onError', error);
        this.dispatch(jid, 'onStatusChange', 'error');
      },
      onFatalError: (error) => this.handleFatalError(jid, error),
      onStatusChange: (status) => {
        if (!scoops().has(jid)) return;

        this.units.get(jid)?.transition(status);
        callbacks.onStatusChange(jid, status);
        this.dispatch(jid, 'onStatusChange', status);

        if (status === 'ready') {
          void this.deps.messageRouter.flushOnIdle(jid);
        }

        if (status === 'ready' && reportsToParent) {
          void completionService.notifyCompletion(jid);
        }
      },
      onCompactionStateChange: (state, detail) => {
        callbacks.onCompactionStateChange?.(jid, state, detail);
      },
      onToolStart: (toolName, toolInput, toolCallId) => {
        callbacks.onToolStart?.(jid, toolName, toolInput, toolCallId);
      },
      onToolEnd: (toolName, result, isError, toolCallId) => {
        callbacks.onToolEnd?.(jid, toolName, result, isError, toolCallId);
      },

      onToolUI: (toolName, requestId, html) => {
        callbacks.onToolUI?.(jid, toolName, requestId, html, this.displayJidFor(jid));
      },
      onToolUIDone: (requestId) => {
        callbacks.onToolUIDone?.(jid, requestId, this.displayJidFor(jid));
      },
      onToolProgress: (toolName, progress, toolCallId) => {
        callbacks.onToolProgress?.(jid, toolName, progress, toolCallId);
      },
      onSendMessage: (text, sender) => {
        const prefixed = `${sender ? `[${sender}] ` : ''}${text}`;
        callbacks.onSendMessage(jid, prefixed);

        this.dispatch(jid, 'onSendMessage', text);
      },
      getScoops: () => cone.getScoops(),
      getScoopTabState: policy.canManageChildren ? (j: string) => this.getTab(j) : undefined,
      onFeedScoop: policy.canManageChildren
        ? (scoopJid, prompt) => cone.delegateToScoop(scoopJid, prompt, scoop.assistantLabel)
        : undefined,
      onScoopScoop: policy.canCreateChildren
        ? async (newScoop) => {
            const fullScoop: RegisteredScoop = {
              ...newScoop,
              jid: `scoop_${newScoop.folder}_${Date.now()}`,

              parentJid: scoop.jid,
            };
            assertChildPolicyAllowed(fullScoop, scoop);
            await cone.registerScoop(fullScoop);
            return fullScoop;
          }
        : undefined,
      onDropScoop: policy.canManageChildren
        ? async (scoopJid) => {
            await cone.unregisterScoop(scoopJid);
          }
        : undefined,
      onMuteScoops: policy.canManageChildren ? (jids) => cone.muteScoops(jids) : undefined,
      onUnmuteScoops: policy.canManageChildren ? (jids) => cone.unmuteScoops(jids) : undefined,

      onScheduleScoopWait: policy.canManageChildren
        ? (jids, timeoutMs) => cone.scheduleScoopWait(jids, timeoutMs, jid)
        : undefined,
      getGlobalMemory: () => cone.getGlobalMemory(),
      setGlobalMemory: policy.canWriteSharedMemory
        ? (content) => cone.setGlobalMemory(content)
        : undefined,

      appendConeMemory: policy.canWriteSharedMemory
        ? (bullets, meta) =>
            cone.appendConeMemory(bullets, {
              ...meta,
              memoryPath: workspaceFor(scoop).memoryPath,
            })
        : undefined,

      onSudoRequest:
        policy.approvalAuthority === 'user'
          ? undefined
          : (request) => cone.enqueueSudoRequest(jid, request),

      approveGuestToolCall: (request) => cone.approveDirectedOrUser(request),

      onSudoResolve: policy.canResolveApprovals
        ? (id, decision) =>
            cone.resolveActionableLick(id, decision, isRootUnit(scoop) ? undefined : jid)
        : undefined,
      onListSudoRequests: policy.canResolveApprovals
        ? () => cone.listPendingSudoRequests(isRootUnit(scoop) ? undefined : jid)
        : undefined,
      getBrowserAPI: () => callbacks.getBrowserAPI(),
    };
  }

  private handleFatalError(jid: string, error: string): void {
    const scoops = this.deps.getScoops();
    if (!scoops.has(jid)) return;

    const scoopRecord = scoops.get(jid)!;
    log.error('Fatal scoop error', { jid, folder: scoopRecord.folder, error });

    emitScoopLifecycle('error', scoopRecord.folder, error);

    this.units.get(jid)?.transition('error', { error });
    this.deps.callbacks.onError(jid, error);
    this.deps.callbacks.onStatusChange(jid, 'error');
    this.dispatch(jid, 'onError', error);
    this.dispatch(jid, 'onStatusChange', 'error');

    if (toDescriptor(scoopRecord).completion.mode === 'interactive') return;

    this.deps.completionService.forgetScoop(jid, 'fatal-error');

    const parent = this.parentOf(scoopRecord);
    if (!parent) return;

    try {
      this.deps.callbacks.onError(parent.jid, `[@${scoopRecord.assistantLabel} FAILED]: ${error}`, {
        endTurn: false,
      });
    } catch (err) {
      log.error('Failed to record fatal error for scoop owner', {
        scoop: scoopRecord.folder,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
