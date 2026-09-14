import type { ToolProgressEvent } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { BrowserAPI } from '../cdp/index.js';
import type { CompactionState, CompactionStateDetail } from '../core/context-compaction.js';
import { SessionStore } from '../core/session.js';
import type { ImageContent } from '../core/types.js';
import { FsWatcher, VirtualFS } from '../fs/index.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { ProcessManager } from '../kernel/process-manager.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';
import {
  frozenSessionToCostData,
  registerSessionBudgetProvider,
  registerSessionCostsProvider,
  type ScoopCostData,
  type SessionCostScope,
} from '../shell/supplemental-commands/cost-command.js';
import type {
  ConeApprovalRouter,
  PendingSudoRequest,
  SudoApproverDirective,
  SudoBroker,
  SudoDecision,
  SudoRequest,
  TurnGuestGate,
} from '../sudo/index.js';
import { SudoManager } from '../sudo/sudo-manager.js';
import { registerTranscriptExportService } from '../transcript/export-provider.js';
import { DefaultTranscriptExportService } from '../transcript/export-service.js';
import { readSnapshot, writeSnapshot } from '../transcript/snapshot-store.js';
import { getStrictKnownSecretRedactor } from '../transcript/strict-secret-client.js';
import type { CapabilityBroker } from '../work-unit/capability/index.js';
import { migrateConversations } from '../work-unit/conversation/migration.js';
import {
  type ConversationIdentity,
  WorkUnitConversationStore,
} from '../work-unit/conversation/store.js';
import {
  defaultChildVisibleRoots,
  ownerWorkspaceFor,
  PRIMARY_WORKSPACE,
  workspaceFor,
} from '../work-unit/descriptor.js';
import type { LiveWorkUnit } from '../work-unit/live-unit.js';
import { WorkUnitManager } from '../work-unit/manager.js';
import { capableApproverOf, rootOwnerOf, rootsOf } from '../work-unit/policy.js';
import {
  legacyRecordIsCone,
  modelFor,
  modelIdFor,
  normalizeScoopRecord,
  setUnitModel,
} from '../work-unit/record.js';
import { SessionStore as UiSessionStore } from './chat-session-store.js';
import { type AppendConeMemoryMeta, ConeMemoryStore } from './cone-memory-store.js';
import * as db from './db.js';
import { isExternalLickChannel } from './lick-formatting.js';
import {
  buildActiveLicksError,
  type LickEvent,
  type LickManager,
  type WebhookDeliveryDisposition,
} from './lick-manager.js';
import { LickRegistry } from './lick-registry.js';
import { LlmsTxtIgnorePolicy } from './llms-txt-ignore.js';
import { ModelPolicyFile } from './model-policy-file.js';
import { globalSeedModel } from './model-seed.js';
import { withMountHeartbeat } from './mount-heartbeat.js';
import { TaskScheduler } from './scheduler.js';
import { ScoopApprovalRouter } from './scoop-approval-router.js';
import { ScoopCompletionService } from './scoop-completion-service.js';
import type { ClearSessionOptions, ScoopContext } from './scoop-context.js';
import { ScoopCostTracker } from './scoop-cost-tracker.js';
import { ScoopIdleTimers } from './scoop-idle-timers.js';
import { ScoopLifecycleManager, type ScoopObserver } from './scoop-lifecycle-manager.js';
import { ScoopMessageRouter } from './scoop-message-router.js';
import { createDefaultSkills } from './skills.js';
import {
  type ChannelMessage,
  CURRENT_SCOOP_CONFIG_VERSION,
  type RegisteredScoop,
  type ScoopTabState,
  type ThinkingLevel,
  type WorkUnitModel,
} from './types.js';

export type { ScoopObserver };

const log = createLogger('orchestrator');

const DENY: SudoDecision = { decision: 'deny' };
type SliccGlobalHooks = typeof globalThis & {
  __slicc_fs_watcher?: FsWatcher;
  __slicc_lick_handler?: (event: LickEvent) => void;
};

export { SCOOP_IDLE_TIMEOUT_MS } from './scoop-idle-timers.js';

export interface OrchestratorCallbacks {
  onResponse: (scoopJid: string, text: string, isPartial: boolean) => void;

  onResponseDone: (scoopJid: string) => void;

  onSendMessage: (targetJid: string, text: string) => void;

  onStatusChange: (scoopJid: string, status: ScoopTabState['status']) => void;

  onCompactionStateChange?: (
    scoopJid: string,
    state: CompactionState,
    detail: CompactionStateDetail
  ) => void;

  onError: (scoopJid: string, error: string) => void;

  onLickBackpressure?: (scoopJid: string, info: { count: number; waitingMs: number }) => void;

  getBrowserAPI: () => BrowserAPI;

  onToolStart?: (
    scoopJid: string,
    toolName: string,
    toolInput: unknown,
    toolCallId?: string
  ) => void;

  onToolEnd?: (
    scoopJid: string,
    toolName: string,
    result: string,
    isError: boolean,
    toolCallId?: string
  ) => void;

  onToolUI?: (
    scoopJid: string,
    toolName: string,
    requestId: string,
    html: string,
    displayScoopJid?: string
  ) => void;

  onToolUIDone?: (scoopJid: string, requestId: string, displayScoopJid?: string) => void;

  onToolProgress?: (
    scoopJid: string,
    toolName: string,
    progress: ToolProgressEvent,
    toolCallId?: string
  ) => void;

  onIncomingMessage?: (scoopJid: string, message: ChannelMessage) => void;

  onMessageUpdate?: (
    scoopJid: string,
    update: {
      messageId: string;
      lickId?: string;
      lickState?: 'pending' | 'confirmed' | 'dismissed';
    }
  ) => void;

  onScoopUnregistered?: (scoop: RegisteredScoop) => void;
}

export interface AssistantConfig {
  name: string;
  triggerPattern: RegExp;
}

export class Orchestrator implements ConeApprovalRouter {
  private scoops: Map<string, RegisteredScoop> = new Map();

  private readonly workUnits = new WorkUnitManager(this);
  private container: HTMLElement;
  private callbacks: OrchestratorCallbacks;
  private config: AssistantConfig;
  private scheduler: TaskScheduler | null = null;
  private sharedFs: VirtualFS | null = null;
  private memoryStore: ConeMemoryStore = new ConeMemoryStore({
    getSharedFs: () => this.sharedFs,
  });
  private lickManager: LickManager | null = null;
  private sessionStore: SessionStore | null = null;

  private conversationStore: WorkUnitConversationStore | null = null;
  private fsWatcher: FsWatcher | null = null;

  private sudoManager: SudoManager | null = null;

  private capabilityBroker: CapabilityBroker | null = null;

  private llmsTxtIgnorePolicy: LlmsTxtIgnorePolicy | null = null;

  private modelPolicyFile: ModelPolicyFile | null = null;

  private lifecycle!: ScoopLifecycleManager;

  private idleTimers: ScoopIdleTimers = new ScoopIdleTimers({
    getScoops: () => this.scoops,
    getTabs: () => this.lifecycle.getTabsMap(),
    findParent: (jid) => this.parentOrDefaultRoot(jid),
    handleMessage: (msg) => this.handleMessage(msg),
    notifyIncomingMessage: (jid, msg) => this.callbacks.onIncomingMessage?.(jid, msg),
  });

  private costTracker: ScoopCostTracker = new ScoopCostTracker({
    getScoops: () => this.scoops,
    getContexts: () => this.lifecycle.getContexts(),
  });

  private completionService: ScoopCompletionService = new ScoopCompletionService({
    getSharedFs: () => this.sharedFs,
    getScoop: (jid) => this.scoops.get(jid),
    findParent: (jid) => this.parentOrDefaultRoot(jid),
    hasScoop: (jid) => this.scoops.has(jid),
    notifyIncomingMessage: (jid, msg) => this.callbacks.onIncomingMessage?.(jid, msg),
    handleMessage: (msg) => this.handleMessage(msg),
    reportError: (jid, error) => this.callbacks.onError(jid, error),
  });

  private processManager: ProcessManager | null = null;

  private unregisterExportService: (() => void) | null = null;

  private approvalRouter: ScoopApprovalRouter = new ScoopApprovalRouter({
    getScoops: () => this.scoops,
    findApprover: (scoopJid) => this.capableApproverOrDefaultRoot(scoopJid),
    getSudoManager: () => this.sudoManager,
    getLickManager: () => this.lickManager,
    handleMessage: (msg) => this.handleMessage(msg),
    onMessageUpdate: (jid, update) => this.callbacks.onMessageUpdate?.(jid, update),
    getMessagesForScoop: (jid) => db.getMessagesForScoop(jid),
    saveMessage: (msg) => db.saveMessage(msg),
  });

  private lickRegistry: LickRegistry = new LickRegistry({
    getConeShell: () => {
      const cone = this.defaultRoot();
      return cone ? (this.lifecycle.getContext(cone.jid)?.getShell() ?? null) : null;
    },
    getConeFs: () => {
      const cone = this.defaultRoot();
      return cone ? (this.lifecycle.getContext(cone.jid)?.getFS() ?? null) : null;
    },
    persistLickDecision: (id, decision) => this.approvalRouter.persistLickDecision(id, decision),
  });

  private messageRouter: ScoopMessageRouter = new ScoopMessageRouter({
    getScoops: () => this.scoops,
    getTabs: () => this.lifecycle.getTabsMap(),
    getContexts: () => this.lifecycle.getContexts(),
    createScoopTab: (jid) => this.createScoopTab(jid),
    sendPrompt: (jid, text, senderId, senderName, images, options) =>
      this.sendPrompt(jid, text, senderId, senderName, images ?? [], options),
    notifyIncomingMessage: (jid, msg) => this.callbacks.onIncomingMessage?.(jid, msg),
    onError: (jid, error) => this.callbacks.onError(jid, error),
    onLickBackpressure: (jid, info) => this.callbacks.onLickBackpressure?.(jid, info),
    getSessionStore: () => this.sessionStore,
    resetCostTracker: () => this.costTracker.reset(),
    db: {
      saveMessage: (msg) => db.saveMessage(msg),
      deleteMessage: (id) => db.deleteMessage(id),
      clearMessagesForScoop: (jid) => db.clearMessagesForScoop(jid),
      clearAllMessages: () => db.clearAllMessages(),
      getMessagesSince: (jid, since, excludeName) => db.getMessagesSince(jid, since, excludeName),
      setState: (key, value) => db.setState(key, value),
    },
    isExternalLickChannel,
  });

  constructor(
    container: HTMLElement,
    callbacks: OrchestratorCallbacks,
    config: AssistantConfig = { name: 'sliccy', triggerPattern: /^@sliccy\b/i }
  ) {
    this.container = container;
    this.callbacks = callbacks;
    this.config = config;
    this.lifecycle = new ScoopLifecycleManager({
      getScoops: () => this.scoops,
      approverFor: (jid) => this.ownerRootOrDefault(jid),
      getSharedFs: () => this.sharedFs,
      getSessionStore: () => this.sessionStore,
      getConversationStore: () => this.conversationStore,
      getProcessManager: () => this.processManager,
      getSudoManager: () => this.sudoManager,
      getCapabilityBroker: () => this.capabilityBroker,
      callbacks: this.callbacks,
      idleTimers: this.idleTimers,
      completionService: this.completionService,
      db: { saveScoop: (s) => db.saveScoop(s), deleteScoop: (j) => db.deleteScoop(j) },
      getLickManager: () => this.lickManager,
      buildActiveLicksError: (folder, webhooks, cronTasks) =>
        buildActiveLicksError(
          folder,
          webhooks as Parameters<typeof buildActiveLicksError>[1],
          cronTasks as Parameters<typeof buildActiveLicksError>[2]
        ),
      messageRouter: {
        ensureQueue: (jid) => this.messageRouter.ensureQueue(jid),
        forgetScoop: (jid) => this.messageRouter.forgetScoop(jid),
        flushOnIdle: (jid) => this.messageRouter.flushOnIdle(jid),
      },
      costTracker: { snapshot: (jid) => this.costTracker.snapshot(jid) },
      approvalRouter: { failScoop: (jid) => this.approvalRouter.failScoop(jid) },
      cone: {
        delegateToScoop: (jid, prompt, sender) => this.delegateToScoop(jid, prompt, sender),
        registerScoop: (s) => this.registerScoop(s),
        unregisterScoop: (jid) => this.unregisterScoop(jid),
        muteScoops: (jids) => this.muteScoops(jids),
        unmuteScoops: (jids) => this.unmuteScoops(jids),

        scheduleScoopWait: (jids, timeoutMs, requesterJid) =>
          this.scheduleScoopWait(jids, timeoutMs, requesterJid),
        getScoops: () => this.getScoops(),
        getGlobalMemory: () => this.getGlobalMemory(),
        setGlobalMemory: (content) => this.setGlobalMemory(content),
        appendConeMemory: (bullets, meta) => this.appendConeMemory(bullets, meta),
        enqueueSudoRequest: (jid, request) => this.enqueueSudoRequest(jid, request),

        resolveActionableLick: (id, decision, approverJid) =>
          this.resolveActionableLick(id, decision, approverJid),
        approveDirectedOrUser: (request) => this.approveDirectedOrUser(request),
        listPendingSudoRequests: (approverJid) => this.listPendingSudoRequests(approverJid),
      },
      handleMessage: (msg) => this.handleMessage(msg),
    });
  }

  setProcessManager(pm: ProcessManager): void {
    this.processManager = pm;
  }

  setCapabilityBroker(broker: CapabilityBroker): void {
    this.capabilityBroker = broker;
  }

  getCapabilityBroker(): CapabilityBroker | null {
    return this.capabilityBroker;
  }

  getProcessManager(): ProcessManager | null {
    return this.processManager;
  }

  private async initPolicyLayerAndLoadRecords(
    sharedFs: VirtualFS,
    fsWatcher: FsWatcher,
    onBootProgress?: (stage: string) => void
  ): Promise<Record<string, RegisteredScoop>> {
    return withMountHeartbeat(
      async (tick) => {
        await this.ensureRootStructure();
        tick();

        this.sudoManager = new SudoManager({
          fs: sharedFs,
          watcher: fsWatcher,

          capabilityBroker: this.capabilityBroker,
          onPolicyReload: (folder) => {
            this.lifecycle.syncReadGrants(folder);

            this.approvalRouter.settleGrantedRequests(folder);
          },
        });
        await this.sudoManager.init();
        tick();
        this.llmsTxtIgnorePolicy = new LlmsTxtIgnorePolicy(sharedFs, fsWatcher);
        await this.llmsTxtIgnorePolicy.init();
        tick();

        this.modelPolicyFile = new ModelPolicyFile(sharedFs, fsWatcher);
        await this.modelPolicyFile.init();
        tick();

        return db.getAllScoops();
      },
      onBootProgress,
      { stagePrefix: 'orchestrator-init' }
    );
  }

  async init(onBootProgress?: (stage: string) => void): Promise<void> {
    await db.initDB();

    this.sharedFs = await withMountHeartbeat(
      (tick) => VirtualFS.create({ dbName: 'slicc-fs', onRepairProgress: tick }),
      onBootProgress
    );
    this.sessionStore = new SessionStore();
    this.conversationStore = new WorkUnitConversationStore();

    this.fsWatcher = new FsWatcher();
    this.sharedFs.setWatcher(this.fsWatcher);
    (globalThis as SliccGlobalHooks).__slicc_fs_watcher = this.fsWatcher;

    const savedScoops = await this.initPolicyLayerAndLoadRecords(
      this.sharedFs,
      this.fsWatcher,
      onBootProgress
    );

    const restoredRootJid = Object.values(savedScoops).find((s) => legacyRecordIsCone(s))?.jid;

    for (const scoop of Object.values(savedScoops)) {
      await this.backfillParent(scoop, restoredRootJid);

      normalizeScoopRecord(scoop);

      this.migrateScoopConfig(scoop, Object.values(savedScoops));
      this.scoops.set(scoop.jid, scoop);
      this.messageRouter.ensureQueue(scoop.jid);

      const ts = await db.getState(`lastAgentTs_${scoop.jid}`);
      if (ts) this.messageRouter.setLastAgentTimestamp(scoop.jid, ts);
    }

    await this.backfillModels();

    await this.migrateConversations(onBootProgress);

    await this.memoryStore.ensureGlobalMemory();

    await this.memoryStore.migrateLegacyConeMemory();

    this.scheduler = new TaskScheduler({
      onTaskRun: async (task, scoop) => {
        log.info('Running scheduled task', { taskId: task.id, scoop: scoop.name });
        await this.sendPrompt(
          scoop.jid,
          `[SCHEDULED TASK]\n\n${task.prompt}`,
          'scheduler',
          'Scheduled Task'
        );
      },
      getScoop: (folder) => {
        for (const s of this.scoops.values()) {
          if (s.folder === folder) return s;
        }
        return undefined;
      },
    });
    this.scheduler.start();

    log.info('Orchestrator initialized', { scoopCount: this.scoops.size });

    for (const scoop of this.scoops.values()) {
      try {
        await this.createScoopTab(scoop.jid);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('Skipping scoop whose context failed to initialize during boot', {
          jid: scoop.jid,
          folder: scoop.folder,
          root: scoop.parentJid === null,
          error: message,
        });

        if (scoop.parentJid !== null) {
          this.lifecycle.markTabError(scoop.jid, message);
        }
      } finally {
        onBootProgress?.(`scoop-restored:${scoop.jid}`);
      }
    }

    registerSessionCostsProvider((scope) => this.getSessionCostsForCommand(scope));

    registerSessionBudgetProvider(async () => {
      const { refreshBudgetWindow } = await import('../providers/budget-usage-source.js');
      return refreshBudgetWindow();
    });

    this.unregisterExportService = registerTranscriptExportService(this.buildWorkerExportService());

    this.messageRouter.startMessageLoop();
  }

  private async migrateConversations(onBootProgress?: (stage: string) => void): Promise<void> {
    const store = this.conversationStore;
    if (!store) return;
    const uiSessionStore = new UiSessionStore();
    try {
      await migrateConversations({
        store,
        units: [...this.scoops.values()],
        loadAgentSession: async (id) => {
          const saved = await this.sessionStore?.load(id);
          return saved ? { messages: saved.messages, createdAt: saved.createdAt } : null;
        },
        loadChatSession: async (id) => {
          const saved = await uiSessionStore.load(id);
          return saved ? { messages: saved.messages, createdAt: saved.createdAt } : null;
        },
        onProgress: onBootProgress,
      });
    } catch (err) {
      log.warn('Canonical conversation migration failed; staying on the legacy stores', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async backfillParent(
    scoop: RegisteredScoop,
    restoredRootJid: string | undefined
  ): Promise<void> {
    if (scoop.parentJid !== undefined) return;
    scoop.parentJid = legacyRecordIsCone(scoop) ? null : (restoredRootJid ?? null);
    try {
      await db.saveScoop(scoop);
    } catch (err) {
      log.warn('Failed to persist backfilled parentJid; will retry next boot', {
        jid: scoop.jid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async backfillModels(): Promise<void> {
    const pending = [...this.scoops.values()].filter((scoop) => !modelIdFor(scoop));
    if (pending.length === 0) return;
    const seed = globalSeedModel();

    const ordered = [...pending].sort(
      (a, b) => Number(a.parentJid !== null) - Number(b.parentJid !== null)
    );
    for (const scoop of ordered) {
      const parent = scoop.parentJid ? this.scoops.get(scoop.parentJid) : undefined;
      const model = (parent ? modelFor(parent) : undefined) ?? seed;
      if (!model) continue;
      setUnitModel(scoop, model);
      try {
        await db.saveScoop(scoop);
      } catch (err) {
        log.warn('Failed to persist backfilled model; will retry next boot', {
          jid: scoop.jid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private migrateScoopConfig(scoop: RegisteredScoop, registry: RegisteredScoop[]): void {
    if (scoop.parentJid === null) return;
    const version = scoop.configSchemaVersion ?? 0;
    if (version >= CURRENT_SCOOP_CONFIG_VERSION) return;

    if (version < 1) {
      scoop.config = {
        ...scoop.config,
        visiblePaths: scoop.config?.visiblePaths ?? ['/workspace/'],
      };
    }
    if (version < 2) {
      scoop.config = {
        ...scoop.config,
        writablePaths: scoop.config?.writablePaths ?? [`/scoops/${scoop.folder}/`, '/shared/'],
      };
    }
    if (version < 3) {
      const primaryRoot = `${PRIMARY_WORKSPACE.root}/`;
      const ownerRoots = defaultChildVisibleRoots(ownerWorkspaceFor(registry, scoop));
      const visible = scoop.config?.visiblePaths;
      const isHistoricalDefault = visible?.length === 1 && visible[0] === primaryRoot;
      if (ownerRoots[0] !== primaryRoot && isHistoricalDefault) {
        scoop.config = { ...scoop.config, visiblePaths: ownerRoots };
      }
    }
    scoop.configSchemaVersion = CURRENT_SCOOP_CONFIG_VERSION;
  }

  private async ensureRootStructure(): Promise<void> {
    if (!this.sharedFs) return;

    const dirs = ['/workspace', '/shared', '/scoops', '/home', '/home/user', '/tmp', '/mnt'];
    for (const dir of dirs) {
      try {
        await this.sharedFs.mkdir(dir, { recursive: true });
      } catch {}
    }
  }

  getGlobalMemory(): Promise<string> {
    return this.memoryStore.getGlobalMemory();
  }

  setGlobalMemory(content: string): Promise<void> {
    return this.memoryStore.setGlobalMemory(content);
  }

  appendConeMemory(bullets: string, meta: AppendConeMemoryMeta): Promise<void> {
    return this.memoryStore.appendConeMemory(bullets, meta);
  }

  getSharedFS(): VirtualFS | null {
    return this.sharedFs;
  }

  getSessionStore(): SessionStore | null {
    return this.sessionStore;
  }

  getConversationStore(): WorkUnitConversationStore | null {
    return this.conversationStore;
  }

  getSudoManager(): SudoManager | null {
    return this.sudoManager;
  }

  setLickManager(lickManager: LickManager): void {
    this.lickManager = lickManager;
    lickManager.setDiscoveryIgnore?.((event) => this.llmsTxtIgnorePolicy?.ignores(event) ?? false);

    lickManager.setUnitRosterProvider?.(() =>
      this.getScoops().map((s) => ({ name: s.name, folder: s.folder }))
    );
    (globalThis as SliccGlobalHooks).__slicc_lick_handler = (event: LickEvent) => {
      this.lickManager?.emitEvent(event);
    };
  }

  handleWebhookEvent(
    webhookId: string,
    headers: Record<string, string>,
    body: unknown
  ): WebhookDeliveryDisposition | undefined {
    return this.lickManager?.handleWebhookEvent(webhookId, headers, body);
  }

  handleCherryHostEvent(cherryRuntimeId: string | undefined, name: string, detail?: unknown): void {
    this.lickManager?.emitEvent({
      type: 'cherry',
      cherryRuntimeId,
      cherryName: name,
      cherryOrigin: undefined,
      body: detail,
      timestamp: new Date().toISOString(),
    });
  }

  handlePreviewLick(event: unknown): void {
    this.lickManager?.emitEvent(event as LickEvent);
  }

  observeScoop(jid: string, observer: ScoopObserver): () => void {
    return this.lifecycle.observe(jid, observer);
  }

  muteScoops(jids: readonly string[]): void {
    this.completionService.muteScoops(jids);
  }

  unmuteScoops(
    jids: readonly string[]
  ): Promise<
    Array<{ jid: string; summary: string; timestamp: string; notificationPath: string | null }>
  > {
    return this.completionService.unmuteScoops(jids);
  }

  isScoopMuted(jid: string): boolean {
    return this.completionService.isScoopMuted(jid);
  }

  waitForScoops(
    jids: readonly string[],
    timeoutMs?: number
  ): Promise<Array<{ jid: string; summary: string | null; timedOut: boolean }>> {
    return this.completionService.waitForScoops(jids, timeoutMs);
  }

  scheduleScoopWait(
    jids: readonly string[],
    timeoutMs?: number,
    requesterJid?: string
  ): { scheduled: string[]; unknown: string[] } {
    return this.completionService.scheduleScoopWait(jids, timeoutMs, requesterJid);
  }

  async enqueueSudoRequest(scoopJid: string, request: SudoRequest): Promise<SudoDecision> {
    return this.approvalRouter.enqueueSudoRequest(scoopJid, request);
  }

  async approveDirectedOrUser(request: SudoRequest): Promise<SudoDecision> {
    const { runDirectedApproval } = await import('./directed-approval.js');
    return runDirectedApproval(request, {
      scoops: this.scoops,
      ownerRootOf: (jid) => this.ownerRootOrDefault(jid),
      enqueue: (jid, req, opts) => this.approvalRouter.enqueueSudoRequest(jid, req, opts),
      getSharedFs: () => this.sharedFs,
      workspaceFor,
      approveAsUser: async (req) => {
        const manager = this.sudoManager;
        if (!manager) {
          log.warn('Guest approval before SudoManager init — failing closed');
          return DENY;
        }
        return manager.approve(req);
      },
    });
  }

  async enqueueDirectedApproval(
    directive: SudoApproverDirective,
    request: SudoRequest
  ): Promise<SudoDecision> {
    return this.approveDirectedOrUser({ ...request, approver: directive });
  }

  resolveSudoRequest(id: string, decision: SudoDecision): boolean {
    return this.approvalRouter.resolveSudoRequest(id, decision);
  }

  async resolveSudoRequestAndPersist(
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
  }> {
    return this.approvalRouter.resolveSudoRequestAndPersist(id, decision, approverJid);
  }

  registerNavigateLick(event: LickEvent): string {
    return this.lickRegistry.registerNavigate(event);
  }

  registerSessionReloadLick(event: LickEvent): string {
    return this.lickRegistry.registerSessionReload(event);
  }

  registerUpgradeLick(event: LickEvent): string {
    return this.lickRegistry.registerUpgrade(event);
  }

  registerDiscoveryLick(event: LickEvent): string | null {
    return this.lickRegistry.registerDiscovery(event);
  }

  async resolveActionableLick(
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
  }> {
    const resolved = await this.lickRegistry.resolve(id, decision);
    if (resolved) return resolved;
    return this.resolveSudoRequestAndPersist(id, decision, approverJid);
  }

  async resolveNavigateHandoffByHuman(lickId: string, accepted: boolean): Promise<boolean> {
    return this.lickRegistry.resolveHandoffByHuman(lickId, accepted);
  }

  getConeSudoBroker(scoopJid: string): SudoBroker {
    return this.approvalRouter.getConeSudoBroker(scoopJid);
  }

  listPendingSudoRequests(approverJid?: string): PendingSudoRequest[] {
    return this.approvalRouter.listPendingSudoRequests(approverJid);
  }

  registerScoop(scoop: RegisteredScoop): Promise<void> {
    return this.lifecycle.register(scoop);
  }

  async persistScoop(scoop: RegisteredScoop): Promise<void> {
    this.scoops.set(scoop.jid, scoop);
    await db.saveScoop(scoop);
  }

  reinitLiveUnit(jid: string): Promise<void> {
    return this.lifecycle.reinitAfterPromote(jid);
  }

  async rekeyConversation(fromKey: string, identity: ConversationIdentity): Promise<void> {
    await this.conversationStore?.rekey(fromKey, identity);
  }

  unregisterScoop(jid: string): Promise<void> {
    return this.lifecycle.unregister(jid);
  }

  getScoops(): RegisteredScoop[] {
    return Array.from(this.scoops.values());
  }

  getScoop(jid: string): RegisteredScoop | undefined {
    return this.scoops.get(jid);
  }

  getScoopTabState(jid: string): ScoopTabState | undefined {
    return this.lifecycle.getTab(jid);
  }

  private defaultRoot(): RegisteredScoop | undefined {
    return rootsOf(this.scoops.values())[0];
  }

  private parentOrDefaultRoot(jid: string | undefined): RegisteredScoop | undefined {
    const scoop = jid === undefined ? undefined : this.scoops.get(jid);
    const parent = scoop?.parentJid ? this.scoops.get(scoop.parentJid) : undefined;
    return parent ?? this.defaultRoot();
  }

  private capableApproverOrDefaultRoot(jid: string | undefined): RegisteredScoop | undefined {
    const scoop = jid === undefined ? undefined : this.scoops.get(jid);
    return capableApproverOf(this.scoops.values(), scoop) ?? this.defaultRoot();
  }

  private ownerRootOrDefault(jid: string | undefined): RegisteredScoop | undefined {
    const scoop = jid === undefined ? undefined : this.scoops.get(jid);
    return rootOwnerOf(this.scoops.values(), scoop) ?? this.defaultRoot();
  }

  getWorkUnits(): WorkUnitManager {
    return this.workUnits;
  }

  getLiveUnit(jid: string): LiveWorkUnit | undefined {
    return this.lifecycle.getUnit(jid);
  }

  ensureLiveUnit(jid: string): LiveWorkUnit {
    return this.lifecycle.ensureUnit(jid);
  }

  async resetFilesystem(): Promise<void> {
    this.lifecycle.stopAndClearAllContexts();

    this.sharedFs = await VirtualFS.create({ dbName: 'slicc-fs', wipe: true });
    if (this.fsWatcher) {
      this.sharedFs.setWatcher(this.fsWatcher);
    }
    await this.ensureRootStructure();
    await this.memoryStore.ensureGlobalMemory();
    await createDefaultSkills(this.sharedFs).catch((err) => {
      log.warn('Failed to re-seed default skills', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.sudoManager?.dispose();
    this.sudoManager = new SudoManager({
      fs: this.sharedFs,
      watcher: this.fsWatcher,
      capabilityBroker: this.capabilityBroker,
      onPolicyReload: (folder) => {
        this.lifecycle.syncReadGrants(folder);

        this.approvalRouter.settleGrantedRequests(folder);
      },
    });
    await this.sudoManager.init();
    this.llmsTxtIgnorePolicy?.dispose();
    this.llmsTxtIgnorePolicy = new LlmsTxtIgnorePolicy(this.sharedFs, this.fsWatcher);
    await this.llmsTxtIgnorePolicy.init();
    this.modelPolicyFile?.dispose();
    this.modelPolicyFile = new ModelPolicyFile(this.sharedFs, this.fsWatcher);
    await this.modelPolicyFile.init();
    this.lickManager?.setDiscoveryIgnore?.(
      (event) => this.llmsTxtIgnorePolicy?.ignores(event) ?? false
    );
    this.costTracker.reset();
    log.info('Filesystem reset and defaults re-seeded');
  }

  clearScoopMessages(jid: string, options: ClearSessionOptions = {}): Promise<void> {
    return this.messageRouter.clearScoopMessages(jid, this.lifecycle.getContext(jid), options);
  }

  clearAllMessages(): Promise<void> {
    return this.messageRouter.clearAllMessages();
  }

  handleMessage(message: ChannelMessage): Promise<void> {
    return this.messageRouter.handleMessage(message);
  }

  delegateToScoop(scoopJid: string, prompt: string, senderName: string): Promise<void> {
    return this.messageRouter.delegateToScoop(scoopJid, prompt, senderName);
  }

  createScoopTab(jid: string): Promise<void> {
    return this.lifecycle.createTab(jid);
  }

  async destroyScoopTab(jid: string): Promise<void> {
    this.lifecycle.destroyTab(jid);
  }

  isProcessing(jid: string): boolean {
    return this.lifecycle.getTab(jid)?.status === 'processing';
  }

  getScoopContext(jid: string): ScoopContext | undefined {
    return this.lifecycle.getContext(jid);
  }

  getQueuedMessageIds(jid: string): string[] {
    return this.messageRouter.getQueuedMessageIds(jid);
  }

  clearQueuedMessages(jid: string): Promise<void> {
    return this.messageRouter.clearQueuedMessages(jid);
  }

  deleteQueuedMessage(jid: string, messageId: string): Promise<void> {
    return this.messageRouter.deleteQueuedMessage(jid, messageId);
  }

  async getMessagesForScoop(jid: string): Promise<ChannelMessage[]> {
    return db.getMessagesForScoop(jid);
  }

  sendPrompt(
    jid: string,
    text: string,
    senderId: string,
    senderName: string,
    images: ImageContent[] = [],
    options?: { steer?: boolean; guestGates?: TurnGuestGate[] }
  ): Promise<void> {
    return this.lifecycle.sendPrompt(jid, text, senderId, senderName, images, options);
  }

  stopMessageLoop(): void {
    this.messageRouter.stopMessageLoop();
  }

  setScoopModel(jid: string, model: WorkUnitModel | undefined): Promise<boolean> {
    return this.lifecycle.setModel(jid, model);
  }

  refreshModels(): void {
    this.lifecycle.refreshModels();
  }

  setScoopThinkingLevel(
    jid: string,
    level: ThinkingLevel | undefined,
    effortOverride?: string
  ): Promise<ThinkingLevel | null> {
    return this.lifecycle.setThinkingLevel(jid, level, effortOverride);
  }

  reloadAllSkills(): Promise<void> {
    return this.lifecycle.reloadAllSkills();
  }

  stopScoop(jid: string): void {
    this.lifecycle.getContext(jid)?.stop();
  }

  getSessionCosts(
    options?: Parameters<ScoopCostTracker['getSessionCosts']>[0]
  ): ReturnType<ScoopCostTracker['getSessionCosts']> {
    return this.costTracker.getSessionCosts(options);
  }

  async getSessionCostsForCommand(scope: SessionCostScope): Promise<ScoopCostData[]> {
    const costs = this.getSessionCosts({ includeDropped: scope === 'all' });
    if (scope === 'live' || !this.sharedFs) return costs;
    const { readSessionsIndex } = await import('../transcript/frozen-archive-format.js');
    const frozenSessions = await readSessionsIndex(this.sharedFs);
    return [...costs, ...frozenSessions.map(frozenSessionToCostData)];
  }

  getModelCosts(
    options?: Parameters<ScoopCostTracker['getModelCosts']>[0]
  ): ReturnType<ScoopCostTracker['getModelCosts']> {
    return this.costTracker.getModelCosts(options);
  }

  getBurnRate(nowMs?: number): ReturnType<ScoopCostTracker['getBurnRate']> {
    return this.costTracker.getBurnRate(nowMs);
  }

  getContextFills(): ReturnType<ScoopCostTracker['getContextFills']> {
    return this.costTracker.getContextFills();
  }

  async shutdown(): Promise<void> {
    this.stopMessageLoop();

    this.idleTimers.clearAll();

    this.scheduler?.stop();
    this.scheduler = null;

    this.completionService.shutdown();

    const sudoFailed = this.approvalRouter.failAll();
    if (sudoFailed > 0) {
      log.info('Failed-closed pending sudo requests during shutdown', { count: sudoFailed });
    }

    await this.lifecycle.destroyAllTabs();

    this.lickManager?.setDiscoveryIgnore?.(null);
    this.llmsTxtIgnorePolicy?.dispose();
    this.llmsTxtIgnorePolicy = null;
    this.modelPolicyFile?.dispose();
    this.modelPolicyFile = null;
    this.sudoManager?.dispose();
    this.sudoManager = null;

    this.unregisterExportService?.();
    this.unregisterExportService = null;

    log.info('Orchestrator shutdown');
  }

  private buildWorkerExportService(): DefaultTranscriptExportService {
    const uiSessionStore = new UiSessionStore();
    const fs = this.sharedFs!;
    return new DefaultTranscriptExportService({
      collection: {
        listScoops: () => this.getScoops(),
        isProcessing: (jid) => this.isProcessing(jid),
        getAgentMessages: (jid) => this.getScoopContext(jid)?.getAgentMessages() ?? null,
        loadPersistedSessions: () => this.sessionStore?.loadAll() ?? Promise.resolve([]),
        loadUiChatSessions: async () => {
          const ids = await uiSessionStore.list();
          const sessions = await Promise.all(ids.map((id) => uiSessionStore.load(id)));
          return sessions.filter((s): s is NonNullable<typeof s> => s !== null);
        },
        wait: (ms) => new Promise((res) => setTimeout(res, ms)),
      },
      knownSecrets: getStrictKnownSecretRedactor(),

      snapshotStore: {
        read: (sessionId) => readSnapshot(fs as unknown as LocalVfsClient, sessionId),
        write: (sessionId, snapshot) =>
          writeSnapshot(fs as unknown as WritableVfsClient, sessionId, snapshot),
      },

      vfs: fs as unknown as LocalVfsClient,
      getActiveSessionInfo: () => {
        const cone = this.defaultRoot();
        return { id: cone?.jid ?? `session-${Date.now()}`, title: cone?.name ?? 'Active Session' };
      },
      version: __SLICC_VERSION__,
    });
  }
}
