/**
 * Orchestrator - manages scoop contexts and routes messages.
 *
 * The orchestrator:
 * - Creates/destroys scoop contexts
 * - Routes incoming messages to the right scoop
 * - Handles responses from scoops
 * - Manages the message queue per scoop
 * - Owns a single shared VirtualFS instance
 */

import type { ToolProgressEvent } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { BrowserAPI } from '../cdp/index.js';
import { SessionStore } from '../core/session.js';
import type { ImageContent } from '../core/types.js';
import { FsWatcher, VirtualFS } from '../fs/index.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { ProcessManager } from '../kernel/process-manager.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';
import {
  frozenSessionToCostData,
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
import { migrateConversations } from '../work-unit/conversation/migration.js';
import { WorkUnitConversationStore } from '../work-unit/conversation/store.js';
import {
  defaultChildVisibleRoots,
  ownerWorkspaceFor,
  PRIMARY_WORKSPACE,
} from '../work-unit/descriptor.js';
import type { LiveWorkUnit } from '../work-unit/live-unit.js';
import { WorkUnitManager } from '../work-unit/manager.js';
import { derivePolicy, rootOwnerOf, rootsOf } from '../work-unit/policy.js';
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
import type { ScoopContext } from './scoop-context.js';
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
type SliccGlobalHooks = typeof globalThis & {
  __slicc_fs_watcher?: FsWatcher;
  __slicc_lick_handler?: (event: LickEvent) => void;
};

// Re-exported from the idle-timers module so consumers (tests, the cone-idle
// notice copy) can keep importing it from this barrel.
export { SCOOP_IDLE_TIMEOUT_MS } from './scoop-idle-timers.js';

export interface OrchestratorCallbacks {
  /** Called when a scoop sends a response */
  onResponse: (scoopJid: string, text: string, isPartial: boolean) => void;
  /** Called when a scoop finishes responding */
  onResponseDone: (scoopJid: string) => void;
  /** Called when a scoop wants to send a message to another scoop/channel */
  onSendMessage: (targetJid: string, text: string) => void;
  /** Called when scoop status changes */
  onStatusChange: (scoopJid: string, status: ScoopTabState['status']) => void;
  /**
   * Called when the scoop's compaction pass enters / leaves a phase. The
   * UI uses this to render a ghost-bubble affordance while the agent is
   * silent during the summarize + memory-extract round-trips. `'idle'`
   * clears the affordance.
   */
  onCompactionStateChange?: (
    scoopJid: string,
    state: 'summarizing' | 'extracting-memory' | 'fallback' | 'idle'
  ) => void;
  /** Called on error */
  onError: (scoopJid: string, error: string) => void;
  /** Called when sustained lick backpressure is reported or cleared. */
  onLickBackpressure?: (scoopJid: string, info: { count: number; waitingMs: number }) => void;
  /** Get the BrowserAPI used by browser automation commands */
  getBrowserAPI: () => BrowserAPI;
  /** Called when a tool starts executing */
  onToolStart?: (
    scoopJid: string,
    toolName: string,
    toolInput: unknown,
    toolCallId?: string
  ) => void;
  /** Called when a tool finishes executing */
  onToolEnd?: (
    scoopJid: string,
    toolName: string,
    result: string,
    isError: boolean,
    toolCallId?: string
  ) => void;
  /**
   * Called when a tool requests UI interaction. `scoopJid` is the ORIGIN;
   * `displayScoopJid` is where the card is rendered when that differs — the
   * owning cone for a scoop, since users never talk to scoops (#2312).
   */
  onToolUI?: (
    scoopJid: string,
    toolName: string,
    requestId: string,
    html: string,
    displayScoopJid?: string
  ) => void;
  /** Called when tool UI interaction is complete */
  onToolUIDone?: (scoopJid: string, requestId: string, displayScoopJid?: string) => void;
  /** Called for each bash progress tick inside a tool call */
  onToolProgress?: (
    scoopJid: string,
    toolName: string,
    progress: ToolProgressEvent,
    toolCallId?: string
  ) => void;
  /** Called when a message is routed to a scoop (delegation, lick, etc.) */
  onIncomingMessage?: (scoopJid: string, message: ChannelMessage) => void;
  /**
   * Called when an already-delivered message's render-relevant state changes
   * in place (no new message). Currently fires when an actionable lick
   * (sudo-request) settles, so the UI can flip the rendered card's state
   * without appending a row. The update is located by `lickId`.
   */
  onMessageUpdate?: (
    scoopJid: string,
    update: {
      messageId: string;
      lickId?: string;
      lickState?: 'pending' | 'confirmed' | 'dismissed';
    }
  ) => void;
  /**
   * Called after a scoop has been fully unregistered, with a snapshot of
   * the scoop taken BEFORE removal (the registry entry is already gone
   * when this fires). Fires for EVERY unregistration path — the panel's
   * scoop-drop, the cone's `drop_scoop` tool, ephemeral `agent` spawns,
   * and workflow subagents — so consumers that keep per-scoop state
   * (e.g. the kernel bridge's chat buffers, which hold full transcripts
   * including tool results) can evict it. Before this hook existed,
   * programmatic teardown leaked every destroyed scoop's conversation.
   */
  onScoopUnregistered?: (scoop: RegisteredScoop) => void;
}

export interface AssistantConfig {
  name: string;
  triggerPattern: RegExp;
}

export class Orchestrator implements ConeApprovalRouter {
  private scoops: Map<string, RegisteredScoop> = new Map();
  /**
   * Hierarchy-aware view over {@link scoops} (#1666). Answers parent / child /
   * default-root questions from the explicit `parentJid` edge; creation and
   * teardown still flow through {@link registerScoop} / {@link unregisterScoop}.
   */
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
  /**
   * The canonical conversation store (#2275). Created in {@link init}
   * alongside `sessionStore`; every `ScoopContext` writes both while the
   * read-old/write-new window is open.
   */
  private conversationStore: WorkUnitConversationStore | null = null;
  private fsWatcher: FsWatcher | null = null;
  /** Owns the live sudoers policy + shared approval broker for this float. */
  private sudoManager: SudoManager | null = null;
  /** Live /etc/llmstxtignore policy installed into the LickManager upstream gate. */
  private llmsTxtIgnorePolicy: LlmsTxtIgnorePolicy | null = null;
  /** Live `/etc/models` loader — publishes the model access policy (#2195). */
  private modelPolicyFile: ModelPolicyFile | null = null;
  /**
   * Owns the per-scoop `tabs` / `contexts` maps, the context-callback factory,
   * the fatal-error escalation, and the per-scoop event observers
   * (`observeScoop`). Everything that creates / destroys a scoop's runtime
   * (or fans events out to per-scoop subscribers) flows through here.
   */
  private lifecycle!: ScoopLifecycleManager;
  /**
   * Per-scoop "no work received yet" notifier. Fires a single cone-facing
   * lick when a non-cone scoop stays `ready` for {@link SCOOP_IDLE_TIMEOUT_MS}
   * so a forgotten delegation surfaces in chat. Armed by every
   * `ready`-transitioning lifecycle hook; cleared on status change /
   * destroy / unregister / shutdown.
   */
  private idleTimers: ScoopIdleTimers = new ScoopIdleTimers({
    getScoops: () => this.scoops,
    getTabs: () => this.lifecycle.getTabsMap(),
    findParent: (jid) => this.parentOrDefaultRoot(jid),
    handleMessage: (msg) => this.handleMessage(msg),
    notifyIncomingMessage: (jid, msg) => this.callbacks.onIncomingMessage?.(jid, msg),
  });
  /** Per-session cost aggregation; preserves dropped scoops' usage. */
  private costTracker: ScoopCostTracker = new ScoopCostTracker({
    getScoops: () => this.scoops,
    getContexts: () => this.lifecycle.getContexts(),
  });
  /**
   * Owns the per-scoop response buffer, completion artifact / cone-notify
   * flow, and the `scoop_mute` / `scoop_wait` coordination state. The
   * orchestrator delegates streaming updates and lifecycle cleanup into
   * the service via {@link ScoopCompletionServiceDeps}.
   */
  private completionService: ScoopCompletionService = new ScoopCompletionService({
    getSharedFs: () => this.sharedFs,
    getScoop: (jid) => this.scoops.get(jid),
    findParent: (jid) => this.parentOrDefaultRoot(jid),
    hasScoop: (jid) => this.scoops.has(jid),
    notifyIncomingMessage: (jid, msg) => this.callbacks.onIncomingMessage?.(jid, msg),
    handleMessage: (msg) => this.handleMessage(msg),
    reportError: (jid, error) => this.callbacks.onError(jid, error),
  });
  /**
   * Process manager threaded into each `ScoopContext` so prompts
   * and tool calls show up as named processes. Set via
   * {@link setProcessManager} (mirrors `setLickManager`); the
   * kernel-worker boot path wires it. Inline standalone / extension
   * paths can leave it `null` — `ScoopContext` falls back to its
   * untracked-prompt behavior (plain AbortController).
   */
  private processManager: ProcessManager | null = null;
  /** Teardown for the registered worker-side TranscriptExportService. */
  private unregisterExportService: (() => void) | null = null;
  /**
   * Cone-mediated sudo approval lifecycle: pending-request registry,
   * cone delivery, sudoers persistence, and lick-card flip-on-resolve.
   * Implements {@link ConeApprovalRouter}; the per-scoop broker built by
   * {@link getConeSudoBroker} routes scoop-originated `requestApproval`
   * calls here. The user broker is intentionally NOT routed through here —
   * only scoop-originated requests do.
   */
  private approvalRouter: ScoopApprovalRouter = new ScoopApprovalRouter({
    getScoops: () => this.scoops,
    findApprover: (scoopJid) => this.parentOrDefaultRoot(scoopJid),
    getSudoManager: () => this.sudoManager,
    getLickManager: () => this.lickManager,
    handleMessage: (msg) => this.handleMessage(msg),
    onMessageUpdate: (jid, update) => this.callbacks.onMessageUpdate?.(jid, update),
    getMessagesForScoop: (jid) => db.getMessagesForScoop(jid),
    saveMessage: (msg) => db.saveMessage(msg),
  });

  /**
   * Single dispatch for every actionable lick variant — collapses the previous
   * four disjoint Map/Set containers (navigate-upskill / navigate-handoff /
   * session-reload-mount / session-reload-plain / upgrade) onto one keyed
   * `Map<lickId, LickEntry>` so per-variant resolvers live next to their data.
   * Side effects (running the cone shell, flipping the persisted card) are
   * injected via {@link LickRegistryDeps} so this registry stays free of
   * cone-state coupling.
   */
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
  /**
   * Per-scoop message queues, the high-water mark used by
   * {@link ScoopMessageRouter.processScoopQueue}, and the 2-second polling
   * loop that drives ready scoops. The router lives next to the data it
   * owns; side-effects (createScoopTab retry, sendPrompt dispatch,
   * incoming-message callbacks, error reporting, cost-tracker reset) are
   * injected via {@link ScoopMessageRouterDeps}.
   */
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
        scheduleScoopWait: (jids, timeoutMs) => this.scheduleScoopWait(jids, timeoutMs),
        getScoops: () => this.getScoops(),
        getGlobalMemory: () => this.getGlobalMemory(),
        setGlobalMemory: (content) => this.setGlobalMemory(content),
        appendConeMemory: (bullets, meta) => this.appendConeMemory(bullets, meta),
        enqueueSudoRequest: (jid, request) => this.enqueueSudoRequest(jid, request),
        resolveActionableLick: (id, decision) => this.resolveActionableLick(id, decision),
        approveDirectedOrUser: (request) => this.approveDirectedOrUser(request),
        listPendingSudoRequests: () => this.listPendingSudoRequests(),
      },
      handleMessage: (msg) => this.handleMessage(msg),
    });
  }

  /**
   * Inject the process manager. New `ScoopContext`s created after
   * this point pick it up. Existing contexts are unaffected —
   * restart the agent to see them in `ps`.
   */
  setProcessManager(pm: ProcessManager): void {
    this.processManager = pm;
  }

  /**
   * Read-only accessor — `ps` / `kill` shell commands look up
   * the manager via this getter (or via the kernel-worker
   * `globalThis.__slicc_pm` fallback for code that can't accept DI).
   */
  getProcessManager(): ProcessManager | null {
    return this.processManager;
  }

  /**
   * The init tail is the boot's OTHER silent stretch (2026-08-24 x-ray:
   * ~50s of OPFS-stat I/O-wait between the mount finishing and the first
   * scoop restore, with zero progress messages — enough to blow the
   * kernel-ready watchdog on its own). Root-structure seeding, the sudo
   * policy, the /etc caches, and the scoop-record load all do per-entry
   * VFS I/O with no milestones of their own, so they get the same
   * heartbeat under their own stage prefix: interval beats keep the
   * watchdog armed through one slow step, ticks between steps reset the
   * quiet budget, and a genuinely wedged step still goes quiet and times
   * out.
   */
  private async initPolicyLayerAndLoadRecords(
    sharedFs: VirtualFS,
    fsWatcher: FsWatcher,
    onBootProgress?: (stage: string) => void
  ): Promise<Record<string, RegisteredScoop>> {
    return withMountHeartbeat(
      async (tick) => {
        await this.ensureRootStructure();
        tick();

        // Stand up the sudo policy manager: seeds the default /etc/sudoers
        // template, loads + merges the live policy, and watches for changes
        // so edits (and "Always" grants) take effect with no restart. The
        // same manager is threaded into every ScoopContext below.
        this.sudoManager = new SudoManager({
          fs: sharedFs,
          watcher: fsWatcher,
          onPolicyReload: (folder) => {
            this.lifecycle.syncReadGrants(folder);
            // Unblock any pending sudo requests the reloaded policy now
            // grants (#2416) — e.g. after an "Always" approval widened the
            // scoop's sandbox, its other queued requests for the same
            // subtree must not stall until individually approved.
            this.approvalRouter.settleGrantedRequests(folder);
          },
        });
        await this.sudoManager.init();
        tick();
        this.llmsTxtIgnorePolicy = new LlmsTxtIgnorePolicy(sharedFs, fsWatcher);
        await this.llmsTxtIgnorePolicy.init();
        tick();
        // Seed + load `/etc/models` BEFORE any scoop is restored: the policy
        // gates which provider a scoop may be spawned against, and an
        // unloaded policy is closed (own catalogue only), so loading late
        // would reject valid spawns.
        this.modelPolicyFile = new ModelPolicyFile(sharedFs, fsWatcher);
        await this.modelPolicyFile.init();
        tick();

        return db.getAllScoops();
      },
      onBootProgress,
      { stagePrefix: 'orchestrator-init' }
    );
  }

  /** Initialize orchestrator and load saved scoops */
  /**
   * @param onBootProgress Optional heartbeat fired after each restored
   *   scoop's context init — the boot's main time sink for a large
   *   session. Lets the page re-arm its kernel-ready watchdog so a
   *   slow-but-advancing boot isn't killed by the timeout (#2007).
   */
  async init(onBootProgress?: (stage: string) => void): Promise<void> {
    await db.initDB();

    // Create the single shared VirtualFS. The mount parses the metadata
    // sidecar and runs the unconditional pre-boot repair (#2146) — O(tree
    // size) with no milestones of its own, 25-30s+ on a COLD boot of a
    // large tree (2026-08-18 restart brick: "did not signal ready" on
    // every fresh Chrome start, warm reloads passed; 2026-08-24: ~8
    // minutes on an I/O-starved disk). The heartbeat keeps the page's
    // kernel-ready watchdog (#2007) armed while the mount provably
    // advances: the repair ticks per sidecar entry probed, so beats flow
    // for as long as the scan moves and go quiet only when it stalls.
    this.sharedFs = await withMountHeartbeat(
      (tick) => VirtualFS.create({ dbName: 'slicc-fs', onRepairProgress: tick }),
      onBootProgress
    );
    this.sessionStore = new SessionStore();
    this.conversationStore = new WorkUnitConversationStore();

    // Create and attach file system watcher
    this.fsWatcher = new FsWatcher();
    this.sharedFs.setWatcher(this.fsWatcher);
    (globalThis as SliccGlobalHooks).__slicc_fs_watcher = this.fsWatcher;

    const savedScoops = await this.initPolicyLayerAndLoadRecords(
      this.sharedFs,
      this.fsWatcher,
      onBootProgress
    );
    // Legacy records predate the ownership edge; the deleted `isCone` field
    // is the only root signal they carry, so it anchors the backfill once,
    // here — through `legacyRecordIsCone`, the one sanctioned read.
    const restoredRootJid = Object.values(savedScoops).find((s) => legacyRecordIsCone(s))?.jid;

    for (const scoop of Object.values(savedScoops)) {
      await this.backfillParent(scoop, restoredRootJid);
      // Derive the presentation fields from the edge (also sanitizes legacy
      // cone records that carried a trigger from the old groups code).
      normalizeScoopRecord(scoop);
      // Every saved record (not just the ones already in `this.scoops`) — the
      // v3 step resolves the owning cone, whose record may come later in this
      // very loop.
      this.migrateScoopConfig(scoop, Object.values(savedScoops));
      this.scoops.set(scoop.jid, scoop);
      this.messageRouter.ensureQueue(scoop.jid);

      // Restore last agent timestamp from state
      const ts = await db.getState(`lastAgentTs_${scoop.jid}`);
      if (ts) this.messageRouter.setLastAgentTimestamp(scoop.jid, ts);
    }

    // Records saved before per-cone model selection (#2310) carry no `model`.
    await this.backfillModels();

    // One canonical conversation record per work unit (#2275). Resumable and
    // versioned, and it never deletes a legacy record: for as long as both
    // stores are written, dropping the canonical database is a full rollback.
    // Failure here is non-fatal by construction — every reader falls back to
    // the legacy stores when a unit has no canonical record.
    await this.migrateConversations(onBootProgress);

    // Initialize global memory
    await this.memoryStore.ensureGlobalMemory();

    // One-time migration: move legacy auto-extracted blocks from
    // /shared/CLAUDE.md into /workspace/CLAUDE.md. Auto-memory now lives on
    // the cone's CLAUDE.md so it doesn't leak into every scoop's prompt
    // surface. Idempotent — guarded by a sentinel file.
    await this.memoryStore.migrateLegacyConeMemory();

    // Initialize task scheduler
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

    // Initialize all scoop contexts. A single scoop whose context fails to
    // initialize — e.g. a corrupt/unreadable persisted VFS file surfacing a
    // ZenFS "Unexpected mismatch in file data size" throw — must not abort the
    // whole boot. Skip that one scoop with a warning and keep loading the rest
    // so the app still reaches a ready state instead of the opaque 30s
    // ready-timeout the caller would otherwise hit.
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
        // Leave a NON-cone scoop in a retryable 'error' state so a later
        // feed_scoop/lick triggers the existing `routeToScoop` retry-on-error
        // path (and `drop_scoop` still works), instead of a silent no-tab
        // entry that stays unusable until a full reset. A failed cone is
        // effectively fatal — there is no usable cone to retry into — so keep
        // skipping+logging it rather than surfacing a phantom error tab.
        if (scoop.parentJid !== null) {
          this.lifecycle.markTabError(scoop.jid, message);
        }
      } finally {
        // Heartbeat per scoop (success OR skip) so the page's ready
        // watchdog keeps resetting through a slow multi-scoop restore
        // instead of firing mid-progress (#2007).
        onBootProgress?.(`scoop-restored:${scoop.jid}`);
      }
    }

    // Register session costs provider for the `cost` shell command
    registerSessionCostsProvider((scope) => this.getSessionCostsForCommand(scope));

    // Register the worker-side transcript export service so
    // getTranscriptExportService() works from any worker-side caller.
    // Teardown is captured and called in shutdown() to prevent stale
    // registration after the orchestrator is destroyed.
    this.unregisterExportService = registerTranscriptExportService(this.buildWorkerExportService());

    // Start polling for pending messages
    this.messageRouter.startMessageLoop();
  }

  /**
   * Run (or resume) the migration of the legacy conversation stores into the
   * canonical work-unit store (#2275). Reads `agent-sessions` through the
   * live `SessionStore` and `browser-coding-agent` through a lazily created
   * UI store — the same two stores every reader falls back to.
   */
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
      // A migration that cannot run at all must not stop the boot: the legacy
      // stores are untouched and every read falls back to them.
      log.warn('Canonical conversation migration failed; staying on the legacy stores', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Backfill the work-unit ownership edge on records saved before
   * `parentJid` was required (#1666). A cone becomes a root; a scoop is
   * adopted by the single restored cone (there was exactly one). Unlike
   * {@link migrateScoopConfig} this IS written back — the field is required
   * and every later phase routes on it.
   */
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

  /**
   * Give every restored record a model (#2310). Records written before the
   * field existed carry none; a spawn-time `config.modelId` pin has already
   * been lifted onto the record by `normalizeScoopRecord`, so what is left
   * inherits: a root from the global `selected-model` seed (its last job), a
   * scoop from the unit that owns it — the same rule creation follows, so a
   * migrated profile and a fresh one agree.
   *
   * Written back (like {@link backfillParent}, unlike
   * {@link migrateScoopConfig}) because the model is now authoritative: left
   * in memory only, a reload would resolve the global selection again and a
   * per-cone choice would look like it never stuck. When no global selection
   * is resolvable yet (no account configured), nothing is written and the
   * next boot retries.
   */
  private async backfillModels(): Promise<void> {
    const pending = [...this.scoops.values()].filter((scoop) => !modelIdFor(scoop));
    if (pending.length === 0) return;
    const seed = globalSeedModel();
    // Roots first, so a scoop whose root was itself backfilled inherits the
    // value that root just received rather than falling through to the seed.
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

  /**
   * One-shot in-memory compat migration for `ScoopConfig`. Mutates the scoop
   * record in place so the rest of the runtime sees the normalized shape;
   * the DB copy stays legacy until some other operation happens to call
   * `db.saveScoop` (e.g. a user-initiated scoop update). That's fine — this
   * migration is idempotent and cheap, so re-running it on every boot until
   * the record gets rewritten is a non-issue.
   *
   * Gated on {@link RegisteredScoop.configSchemaVersion} rather than a truthy
   * check on individual fields, so a record explicitly saved with
   * `visiblePaths: undefined` (or an empty array) under the current schema
   * keeps that authoritative value — "no read-only paths" stays "no read-only
   * paths." Only records that predate a field get the historical default
   * filled in.
   *
   * Cones have no `ScoopConfig` path surface at all; they ignore the version.
   */
  private migrateScoopConfig(scoop: RegisteredScoop, registry: RegisteredScoop[]): void {
    if (scoop.parentJid === null) return;
    const version = scoop.configSchemaVersion ?? 0;
    if (version >= CURRENT_SCOOP_CONFIG_VERSION) return;

    if (version < 1) {
      // Pre-visiblePaths era: default to the historical `/workspace/` read
      // access so skills stay visible after restart.
      scoop.config = {
        ...scoop.config,
        visiblePaths: scoop.config?.visiblePaths ?? ['/workspace/'],
      };
    }
    if (version < 2) {
      // Pre-writablePaths era: default to the historical writable set so
      // existing scoops keep being able to write to their own sandbox and
      // to `/shared/`.
      scoop.config = {
        ...scoop.config,
        writablePaths: scoop.config?.writablePaths ?? [`/scoops/${scoop.folder}/`, '/shared/'],
      };
    }
    if (version < 3) {
      // Pre-per-cone-workspace era (#2271): an extra cone moved off
      // `/workspace`, but the scoops it had already spawned kept the historical
      // read-only default and would keep reading the PRIMARY cone's files.
      // Re-point exactly that default at the owning cone's workspace; a record
      // whose list says anything else is a deliberate configuration and is left
      // alone. Scoops of the primary cone resolve to `/workspace/` and so never
      // change.
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

  /** Ensure root directory structure exists on the shared FS */
  private async ensureRootStructure(): Promise<void> {
    if (!this.sharedFs) return;
    // '/home/user' is the shell's fallback $HOME when onboarding never ran
    // (or a nuke wiped '/home') — created here on the RAW fs because shells
    // must never write through their own (possibly sudo-gated) handle at
    // init. Onboarded '/home/<slug>' homes outrank it in resolveHomeDir.
    const dirs = ['/workspace', '/shared', '/scoops', '/home', '/home/user', '/tmp', '/mnt'];
    for (const dir of dirs) {
      try {
        await this.sharedFs.mkdir(dir, { recursive: true });
      } catch {
        // Already exists
      }
    }
  }

  /** Get global memory content */
  getGlobalMemory(): Promise<string> {
    return this.memoryStore.getGlobalMemory();
  }

  /** Update global memory */
  setGlobalMemory(content: string): Promise<void> {
    return this.memoryStore.setGlobalMemory(content);
  }

  /**
   * Append a block of auto-extracted memory bullets to the calling cone's
   * `CLAUDE.md` (`meta.memoryPath`; the primary's when absent). Used by the
   * compaction memory-extraction pass and by the "New session" freezer flow.
   * Delegates to {@link ConeMemoryStore} — see that module for serialization
   * + budget semantics.
   */
  appendConeMemory(bullets: string, meta: AppendConeMemoryMeta): Promise<void> {
    return this.memoryStore.appendConeMemory(bullets, meta);
  }

  /** Get the shared VirtualFS */
  getSharedFS(): VirtualFS | null {
    return this.sharedFs;
  }

  /**
   * Get the orchestrator's SessionStore, if initialized. Used by
   * {@link createAgentBridge} to clean up any stored session entry for an
   * ephemeral `agent`-spawned scoop. Returns `null` before `init()`
   * resolves.
   */
  getSessionStore(): SessionStore | null {
    return this.sessionStore;
  }

  /**
   * The canonical conversation store (#2275), or null before {@link init}.
   * Read by the kernel bridge so a UI history rebuild can derive from the
   * canonical record instead of repairing across the legacy stores.
   */
  getConversationStore(): WorkUnitConversationStore | null {
    return this.conversationStore;
  }

  /**
   * Get the live {@link SudoManager} for this float, or `null` before
   * `init()` resolves. The panel-terminal host boot reads this to thread the
   * same broker + persist sink into the human Terminal's shell — with
   * `transparentGating: false` so plain commands still run ungated and only
   * the explicit `sudo <cmd...>` invocation prompts.
   */
  getSudoManager(): SudoManager | null {
    return this.sudoManager;
  }

  /** Set the LickManager for guarding scoop removal against active licks */
  setLickManager(lickManager: LickManager): void {
    this.lickManager = lickManager;
    lickManager.setDiscoveryIgnore?.((event) => this.llmsTxtIgnorePolicy?.ignores(event) ?? false);
    // Inject the live unit roster so the LickManager can detect and self-heal
    // orphaned licks (crontasks/webhooks whose target scoop is gone) and refuse
    // an unresolvable `--scoop` at create time (#2524). Matching lives in the
    // LickManager so it agrees with the guard.
    lickManager.setUnitRosterProvider?.(() =>
      this.getScoops().map((s) => ({ name: s.name, folder: s.folder }))
    );
    (globalThis as SliccGlobalHooks).__slicc_lick_handler = (event: LickEvent) => {
      this.lickManager?.emitEvent(event);
    };
  }

  /**
   * Relay a webhook event into the LickManager. Used by `Bridge`
   * when the page-side `LeaderTrayManager` forwards a tray `webhook.event`
   * across the bridge (see `lick-webhook-event` message type). Pre-regression
   * this was a direct page-side call; post-refactor the tray sits on the
   * page and the lick manager sits in the worker, so the page relays the
   * event over the bridge and the orchestrator dispatches it locally.
   *
   * Returns the delivery disposition so the receiver holding the webhook POST
   * open can answer honestly (#2524); `undefined` when no LickManager is bound
   * yet, which is not the same claim as "delivered".
   */
  handleWebhookEvent(
    webhookId: string,
    headers: Record<string, string>,
    body: unknown
  ): WebhookDeliveryDisposition | undefined {
    return this.lickManager?.handleWebhookEvent(webhookId, headers, body);
  }

  /**
   * Relay a cherry host event into the LickManager as a `'cherry'` lick. Used
   * by the leader tray (page-side via the `lick-cherry-host-event` bridge,
   * extension-side in-process) when a follower forwards a `cherry.host_event`
   * emitted by its embedded cherry host page. The owning follower's runtime id
   * is resolved by the leader sync manager; the host origin is not carried at
   * the tray layer, so it is left undefined.
   */
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

  /**
   * Relay a preview-bridge lifecycle lick into the LickManager as a `'preview'`
   * lick. The page-side `LeaderSyncManager` builds the first-connection event
   * (per-preview latched and `--quiet`-suppressed) and forwards it here via the `lick-preview`
   * bridge, extension-side in-process — because the `LickManager` lives in the
   * kernel worker while the sync manager runs on the page. Accepts `unknown`
   * because the bridge carries the structural `ForwardedLickEvent` mirror.
   */
  handlePreviewLick(event: unknown): void {
    this.lickManager?.emitEvent(event as LickEvent);
  }

  /** Register a new scoop and wait until its tab/context has been registered
   *  before returning. Does NOT guarantee successful initialization:
   *  `ScoopContext.init()` can handle failures internally and leave the tab
   *  in 'error' state while `createScoopTab` still resolves. The guarantee
   *  here is that by the time this resolves, the tab/context entry exists in
   *  `this.contexts` / `this.tabs` (ready or error).
   *
   *  Awaiting createScoopTab (rather than firing-and-forgetting it) is what
   *  prevents a race with the caller's immediate follow-up sendPrompt.
   *  `scoop_scoop` with an initial prompt fires `onFeedScoop` the moment
   *  this resolves: if the tab had not yet been registered in `this.contexts`
   *  / `this.tabs`, sendPrompt would call createScoopTab itself, and both
   *  calls would race past the `this.contexts.has(jid)` early-return guard
   *  (the guard only catches duplicates once `contexts.set` has run, which
   *  happens partway through the function). The losing context ends up
   *  orphaned and the initial prompt is silently dropped. See issue #440.
   *
   *  On failure, rolls back the in-memory and on-disk scoop records so the
   *  caller doesn't see a half-registered scoop, and rethrows so the caller
   *  can surface the error. */
  /**
   * Subscribe to events for a single scoop. Returns an unsubscribe function
   * that MUST be called when the caller is done observing — the observer
   * set holds strong references and leaks otherwise.
   *
   * Observer handlers run AFTER the orchestrator's top-level
   * {@link OrchestratorCallbacks}, so subscribing never interferes with the
   * normal event flow. Exceptions in a handler are caught and logged.
   */
  observeScoop(jid: string, observer: ScoopObserver): () => void {
    return this.lifecycle.observe(jid, observer);
  }

  /**
   * Mute a set of scoops so their completion notifications do NOT reach
   * the cone until a matching `scoop_unmute` (or `scoop_wait` consumption).
   * Idempotent — already-muted jids are silently retained.
   */
  muteScoops(jids: readonly string[]): void {
    this.completionService.muteScoops(jids);
  }

  /** Unmute a set of scoops and return any completions stashed while muted. */
  unmuteScoops(
    jids: readonly string[]
  ): Promise<
    Array<{ jid: string; summary: string; timestamp: string; notificationPath: string | null }>
  > {
    return this.completionService.unmuteScoops(jids);
  }

  /** Test / debug helper: returns whether the given jid is currently muted. */
  isScoopMuted(jid: string): boolean {
    return this.completionService.isScoopMuted(jid);
  }

  /**
   * Wait until every scoop in `jids` completes its current work, up to an
   * optional timeout. See {@link ScoopCompletionService.waitForScoops}.
   */
  waitForScoops(
    jids: readonly string[],
    timeoutMs?: number
  ): Promise<Array<{ jid: string; summary: string | null; timedOut: boolean }>> {
    return this.completionService.waitForScoops(jids, timeoutMs);
  }

  /** Non-blocking variant of {@link waitForScoops}. */
  scheduleScoopWait(
    jids: readonly string[],
    timeoutMs?: number
  ): { scheduled: string[]; unknown: string[] } {
    return this.completionService.scheduleScoopWait(jids, timeoutMs);
  }

  /**
   * {@link ConeApprovalRouter} implementation — thin delegate to
   * {@link ScoopApprovalRouter.enqueueSudoRequest}. See that method for the
   * full fail-closed contract (no cone / unknown scoop / delivery failure /
   * unregister / timeout all resolve `deny`).
   */
  async enqueueSudoRequest(scoopJid: string, request: SudoRequest): Promise<SudoDecision> {
    return this.approvalRouter.enqueueSudoRequest(scoopJid, request);
  }

  /**
   * Settle a request through a NON-human approver named by the caller — the
   * cone that owns a thread, or a scoop the cone delegated to.
   *
   * Used by the biscotto message gate: the seat record says who reviews a
   * guest's messages, and that is not derivable from the requester the way a
   * scoop's parent is. Fails CLOSED on every unresolvable case (unknown unit,
   * unknown scoop name, no orchestrator state) — an approver that cannot be
   * found must never degrade into "nobody has to approve".
   *
   * `ownerRootOrDefault` (not `parentOrDefaultRoot`) resolves the cone tier so
   * a card raised on cone B renders in B rather than the oldest cone.
   */
  /**
   * Single approval entry point for the guest tool gate: honour the request's
   * approver directive when it has one, otherwise fall back to the owner's own
   * broker via {@link SudoManager.approve} — which is also what applies the
   * never-persist guard for the guest kinds.
   */
  async approveDirectedOrUser(request: SudoRequest): Promise<SudoDecision> {
    if (request.approver && request.approver.kind !== 'user') {
      return this.enqueueDirectedApproval(request.approver, request);
    }
    const manager = this.sudoManager;
    if (!manager) {
      log.warn('Guest tool approval before SudoManager init — failing closed');
      return { decision: 'deny' };
    }
    return manager.approve(request);
  }

  async enqueueDirectedApproval(
    directive: SudoApproverDirective,
    request: SudoRequest
  ): Promise<SudoDecision> {
    if (directive.kind === 'user') return { decision: 'deny' };
    const requesterJid = directive.unitJid;
    if (!this.scoops.has(requesterJid)) {
      log.warn('Directed approval for an unknown unit — failing closed', { requesterJid });
      return { decision: 'deny' };
    }
    const owner = this.ownerRootOrDefault(requesterJid);
    if (!owner) {
      log.warn('No owning cone for directed approval — failing closed', { requesterJid });
      return { decision: 'deny' };
    }

    let approver: RegisteredScoop | undefined;
    if (directive.kind === 'cone') {
      approver = owner;
    } else {
      // Scoped to THIS cone's own children, and never to a root. A bare name
      // search over the whole roster can match a different cone's scoop —
      // names are not unique across cones — and would hand a guest's text to
      // an approval principal in someone else's thread.
      approver = [...this.scoops.values()].find(
        (scoop) =>
          scoop.parentJid === owner.jid &&
          (scoop.name === directive.scoopName || scoop.folder === directive.scoopName)
      );
      if (!approver) {
        // Dropped, renamed, or never belonged to this cone. Denying is the only
        // safe reading — the alternative is asking the wrong principal.
        log.warn('Delegated approver scoop not found under this cone — failing closed', {
          scoopName: directive.scoopName,
          coneJid: owner.jid,
        });
        return { decision: 'deny' };
      }
    }

    // An approver that cannot actually settle would leave the request to time
    // out five minutes later and deny — indistinguishable, to the owner, from
    // a reviewer who ignored it. `canResolveApprovals` is false for delegated
    // children today (`delegatedChildPolicy`), so a scoop-tier seat lands here
    // until a policy seam exists to designate an approver scoop.
    if (!derivePolicy(approver).canResolveApprovals) {
      log.warn('Directed approver cannot resolve approvals — failing closed', {
        approverJid: approver.jid,
        approverName: approver.name,
        kind: directive.kind,
      });
      return { decision: 'deny' };
    }

    return this.approvalRouter.enqueueSudoRequest(requesterJid, request, { approver });
  }

  /**
   * Settle a pending cone-mediated sudo request. Used by the cone's
   * `lick_confirm` / `lick_dismiss` tools (and tests). Returns `true` when an
   * entry was actually resolved, `false` for unknown / already-settled /
   * timed-out ids so the caller can surface that as "this request expired"
   * to the cone.
   *
   * Note: this does NOT persist an "Always" grant on its own — use
   * {@link resolveSudoRequestAndPersist} for the cone-tool path that
   * needs to write a NOPASSWD rule into the requesting scoop's sudoers.
   */
  resolveSudoRequest(id: string, decision: SudoDecision): boolean {
    return this.approvalRouter.resolveSudoRequest(id, decision);
  }

  /**
   * Cone-tool surface: settle a pending sudo request and, when the
   * decision is `'always'`, durably widen the requesting scoop's sandbox
   * by appending a `NOPASSWD <directive> <pattern>` line to its
   * `/scoops/<folder>/etc/sudoers` via the trusted manager sink (which
   * bypasses the self-protection invariant). `kind: 'secret'` never
   * persists — there is no `Secret` directive in the sudoers parser,
   * so the request resolves as an allow-once.
   *
   * Resolution order for the pattern: caller-supplied → request's
   * `suggestedPattern` → request `detail` (sanitized).
   *
   * Returns a structured outcome the tool surfaces verbatim.
   */
  async resolveSudoRequestAndPersist(
    id: string,
    decision: SudoDecision
  ): Promise<{
    settled: boolean;
    persisted: boolean;
    persistedPattern?: string;
    persistError?: string;
    scoopFolder?: string;
    kind?: SudoRequest['kind'];
  }> {
    return this.approvalRouter.resolveSudoRequestAndPersist(id, decision);
  }

  /**
   * Mint a stable `lickId` for a navigate (handoff / upskill) lick and register
   * it so a later resolution can flip the rendered card. Upskill licks are
   * agent-actionable (`lick_confirm` runs `upskill`); handoff licks stay
   * human-gated (the approval dip is the authority — see
   * {@link resolveNavigateHandoffByHuman}). Called from the kernel host's lick
   * router before the cone `ChannelMessage` is built so the id flows onto both
   * the UI chip and the persisted message. Mirrors the `lick-<ts>-<rand>` id
   * shape used by {@link ConeRequestRegistry}.
   */
  registerNavigateLick(event: LickEvent): string {
    return this.lickRegistry.registerNavigate(event);
  }

  /**
   * Mint a stable `lickId` for a session-reload lick and register it so a later
   * resolution can flip the rendered card. Mount-recovery licks (non-empty
   * `mounts`) are agent-actionable (`lick_confirm` re-runs the listed `mount …`
   * commands); plain reload notices are dismiss-only (the reload already
   * happened — nothing to confirm). Called from the kernel host's lick router
   * before the cone `ChannelMessage` is built so the id flows onto both the UI
   * chip and the persisted message. Mirrors {@link registerNavigateLick}.
   */
  registerSessionReloadLick(event: LickEvent): string {
    return this.lickRegistry.registerSessionReload(event);
  }

  /**
   * Mint a stable `lickId` for an upgrade lick and register it so a later
   * resolution can flip the rendered card. Upgrade licks are agent-actionable
   * with a binary mapping: `lick_confirm` triggers "Update workspace files"
   * (the three-way merge between the stored `from`→`to` tags); `lick_dismiss`
   * clears the notice. Called from the kernel host's lick router before the
   * cone `ChannelMessage` is built so the id flows onto both the UI chip and
   * the persisted message. Mirrors {@link registerNavigateLick}.
   */
  registerUpgradeLick(event: LickEvent): string {
    return this.lickRegistry.registerUpgrade(event);
  }

  /** Register a dismiss-only llms.txt discovery lick, when it has a valid host. */
  registerDiscoveryLick(event: LickEvent): string | null {
    return this.lickRegistry.registerDiscovery(event);
  }

  /**
   * Resolve an actionable lick for the cone's `lick_confirm` / `lick_dismiss`
   * tools. Dispatches via {@link LickRegistry} (navigate-upskill,
   * session-reload mount-recovery, plain session-reload dismiss-only, upgrade);
   * falls through to the sudo-request resolver when the id is not in the lick
   * registry.
   * Handoff lick ids are intentionally NOT resolvable here — they are
   * human-gated, so the registry returns `null` for them and the call falls
   * through to the sudo path, which reports unknown / already-resolved to the
   * agent.
   */
  async resolveActionableLick(
    id: string,
    decision: SudoDecision
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
    return this.resolveSudoRequestAndPersist(id, decision);
  }

  /**
   * Flip a human-gated navigate·handoff lick card once the user resolves the
   * approval dip. Returns `true` when `lickId` matched a pending handoff lick.
   * Called from the dip-lick routing path (the shared
   * `Bridge.routeSprinkleLick`), NOT from the agent tools — this is
   * what preserves the human-approval gate while still letting the card show
   * ✓ on accept / muted ✗ on dismiss.
   */
  async resolveNavigateHandoffByHuman(lickId: string, accepted: boolean): Promise<boolean> {
    return this.lickRegistry.resolveHandoffByHuman(lickId, accepted);
  }

  /**
   * Build a {@link SudoBroker} that routes through {@link enqueueSudoRequest}
   * for the given scoop. The cone keeps using the user broker
   * (`SudoManager.getBroker()`); non-cone scoops should use this so their
   * approvals come from the cone agent, not the human user.
   */
  getConeSudoBroker(scoopJid: string): SudoBroker {
    return this.approvalRouter.getConeSudoBroker(scoopJid);
  }

  /** Snapshot all pending cone-mediated sudo requests (cone-side listing). */
  listPendingSudoRequests(): PendingSudoRequest[] {
    return this.approvalRouter.listPendingSudoRequests();
  }

  /** Register a new scoop. Delegates to {@link ScoopLifecycleManager}. */
  registerScoop(scoop: RegisteredScoop): Promise<void> {
    return this.lifecycle.register(scoop);
  }

  /** Unregister a scoop. Throws if the scoop has active licks (webhooks/cron tasks). */
  unregisterScoop(jid: string): Promise<void> {
    return this.lifecycle.unregister(jid);
  }

  /** Get all registered scoops */
  getScoops(): RegisteredScoop[] {
    return Array.from(this.scoops.values());
  }

  /** Get scoop by JID */
  getScoop(jid: string): RegisteredScoop | undefined {
    return this.scoops.get(jid);
  }

  /** Live tab state of a scoop's runtime (`undefined` before its context exists). */
  getScoopTabState(jid: string): ScoopTabState | undefined {
    return this.lifecycle.getTab(jid);
  }

  /** The default (oldest) root — where unaddressed events land. */
  private defaultRoot(): RegisteredScoop | undefined {
    return rootsOf(this.scoops.values())[0];
  }

  /**
   * The unit that owns `jid`, or the default root when the parent is gone or
   * `jid` is unknown. Delegated results, idle notices and approval requests
   * must always land somewhere a user can see them.
   */
  private parentOrDefaultRoot(jid: string | undefined): RegisteredScoop | undefined {
    const scoop = jid === undefined ? undefined : this.scoops.get(jid);
    const parent = scoop?.parentJid ? this.scoops.get(scoop.parentJid) : undefined;
    return parent ?? this.defaultRoot();
  }

  /**
   * The root that owns `jid` — itself when it IS a root (#2312). Unlike
   * {@link parentOrDefaultRoot} a cone resolves to itself rather than to the
   * default root, which matters once several cones exist: an interactive card
   * raised by cone B must render in B, not in the oldest cone. A dangling or
   * looping edge falls back to the default root, same as the approval path.
   */
  private ownerRootOrDefault(jid: string | undefined): RegisteredScoop | undefined {
    const scoop = jid === undefined ? undefined : this.scoops.get(jid);
    return rootOwnerOf(this.scoops.values(), scoop) ?? this.defaultRoot();
  }

  /** Hierarchy-aware work-unit view over the registry (#1666). */
  getWorkUnits(): WorkUnitManager {
    return this.workUnits;
  }

  /** The owning live runtime of a scoop, once spawned or observed. */
  getLiveUnit(jid: string): LiveWorkUnit | undefined {
    return this.lifecycle.getUnit(jid);
  }

  /**
   * The owning live runtime of a scoop, created if it has none yet — the
   * `WorkUnitHost` hook `WorkUnitManager` resolves every registered record
   * through (#2279). Callers that only want an already-live unit ask
   * {@link getLiveUnit}.
   */
  ensureLiveUnit(jid: string): LiveWorkUnit {
    return this.lifecycle.ensureUnit(jid);
  }

  /** Wipe the virtual filesystem and re-seed default files (skills, shared CLAUDE.md). */
  async resetFilesystem(): Promise<void> {
    // Destroy all scoop contexts (they hold references to the old VFS)
    this.lifecycle.stopAndClearAllContexts();
    // Re-create the VFS with wipe: true
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
    // Rebuild the config managers against the fresh VFS and reattach their
    // live-reload watchers.
    this.sudoManager?.dispose();
    this.sudoManager = new SudoManager({
      fs: this.sharedFs,
      watcher: this.fsWatcher,
      onPolicyReload: (folder) => {
        this.lifecycle.syncReadGrants(folder);
        // Unblock any pending sudo requests the reloaded policy now
        // grants (#2416) — e.g. after an "Always" approval widened the
        // scoop's sandbox, its other queued requests for the same
        // subtree must not stall until individually approved.
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

  /**
   * Clear messages for a single scoop (live agent + persisted agent session
   * + queued messages + timestamp tracking + per-scoop ChannelMessage
   * history). Used by the "New session" flow to reset the cone while
   * leaving every other scoop's runtime state untouched. The
   * orchestrator-level `clearAllMessages` keeps its existing all-scoops
   * semantics.
   *
   * The per-scoop channel-history wipe is load-bearing: without it,
   * `processScoopQueue` calls `db.getMessagesSince(chatJid, '')` on the
   * next prompt (because `lastAgentTimestamp` was just deleted) and
   * replays every pre-reset turn back into the live agent.
   */
  clearScoopMessages(jid: string): Promise<void> {
    return this.messageRouter.clearScoopMessages(jid, this.lifecycle.getContext(jid));
  }

  /** Clear all messages from the orchestrator DB, agent sessions, and live agent contexts. */
  clearAllMessages(): Promise<void> {
    return this.messageRouter.clearAllMessages();
  }

  /** Handle incoming message from a channel */
  handleMessage(message: ChannelMessage): Promise<void> {
    return this.messageRouter.handleMessage(message);
  }

  /** Delegate a prompt directly to a scoop's agent. Used by the delegate_to_scoop tool. */
  delegateToScoop(scoopJid: string, prompt: string, senderName: string): Promise<void> {
    return this.messageRouter.delegateToScoop(scoopJid, prompt, senderName);
  }

  /** Create and initialize a scoop context. Delegates to {@link ScoopLifecycleManager}. */
  createScoopTab(jid: string): Promise<void> {
    return this.lifecycle.createTab(jid);
  }

  /** Destroy a scoop context. Delegates to {@link ScoopLifecycleManager}. */
  async destroyScoopTab(jid: string): Promise<void> {
    this.lifecycle.destroyTab(jid);
  }

  /** Check if a scoop is currently processing. */
  isProcessing(jid: string): boolean {
    return this.lifecycle.getTab(jid)?.status === 'processing';
  }

  /** Get the scoop context for a JID. */
  getScoopContext(jid: string): ScoopContext | undefined {
    return this.lifecycle.getContext(jid);
  }

  /**
   * Ids of a scoop's still-pending queued messages, in delivery order
   * (#2354). See {@link ScoopMessageRouter.getQueuedMessageIds}.
   */
  getQueuedMessageIds(jid: string): string[] {
    return this.messageRouter.getQueuedMessageIds(jid);
  }

  /** Clear all queued messages for a scoop (removes from both IndexedDB and in-memory queue). */
  clearQueuedMessages(jid: string): Promise<void> {
    return this.messageRouter.clearQueuedMessages(jid);
  }

  /** Delete a queued message by ID (removes from both IndexedDB and in-memory queue). */
  deleteQueuedMessage(jid: string, messageId: string): Promise<void> {
    return this.messageRouter.deleteQueuedMessage(jid, messageId);
  }

  /** Get all messages for a scoop */
  async getMessagesForScoop(jid: string): Promise<ChannelMessage[]> {
    return db.getMessagesForScoop(jid);
  }

  /** Send a prompt to a scoop. Delegates to {@link ScoopLifecycleManager}. */
  sendPrompt(
    jid: string,
    text: string,
    senderId: string,
    senderName: string,
    images: ImageContent[] = [],
    options?: { steer?: boolean; guestGate?: TurnGuestGate }
  ): Promise<void> {
    return this.lifecycle.sendPrompt(jid, text, senderId, senderName, images, options);
  }

  /** Stop the message polling loop */
  stopMessageLoop(): void {
    this.messageRouter.stopMessageLoop();
  }

  /**
   * Set the model of ONE unit (#2310) — the selected cone, from the picker,
   * or the cone a follower is looking at. Never touches another unit: there
   * is no global picker any more. Resolves `false` for an unknown jid.
   */
  setScoopModel(jid: string, model: WorkUnitModel | undefined): Promise<boolean> {
    return this.lifecycle.setModel(jid, model);
  }

  /**
   * Re-resolve every active context's model against its OWN record — after
   * the provider catalogue changed (account added, re-login), not after a
   * model pick.
   */
  refreshModels(): void {
    this.lifecycle.refreshModels();
  }

  /** Update a single scoop's reasoning / thinking level. */
  setScoopThinkingLevel(
    jid: string,
    level: ThinkingLevel | undefined,
    effortOverride?: string
  ): Promise<ThinkingLevel | null> {
    return this.lifecycle.setThinkingLevel(jid, level, effortOverride);
  }

  /** Reload skills on all active scoop contexts (cone + scoops). */
  reloadAllSkills(): Promise<void> {
    return this.lifecycle.reloadAllSkills();
  }

  /** Stop a specific scoop */
  stopScoop(jid: string): void {
    this.lifecycle.getContext(jid)?.stop();
  }

  /** Collect live cost data, optionally including dropped scoop history. */
  getSessionCosts(
    options?: Parameters<ScoopCostTracker['getSessionCosts']>[0]
  ): ReturnType<ScoopCostTracker['getSessionCosts']> {
    return this.costTracker.getSessionCosts(options);
  }

  /** Collect the cost command's live or complete history, including frozen sessions. */
  async getSessionCostsForCommand(scope: SessionCostScope): Promise<ScoopCostData[]> {
    const costs = this.getSessionCosts({ includeDropped: scope === 'all' });
    if (scope === 'live' || !this.sharedFs) return costs;
    const { readSessionsIndex } = await import('../transcript/frozen-archive-format.js');
    const frozenSessions = await readSessionsIndex(this.sharedFs);
    return [...costs, ...frozenSessions.map(frozenSessionToCostData)];
  }

  /** Per-model cost breakdown (sorted by cost descending) for the session-stats wire. */
  getModelCosts(
    options?: Parameters<ScoopCostTracker['getModelCosts']>[0]
  ): ReturnType<ScoopCostTracker['getModelCosts']> {
    return this.costTracker.getModelCosts(options);
  }

  /** Recency-weighted active-session USD/hour blend, floored at the full-session average. */
  getBurnRate(nowMs?: number): ReturnType<ScoopCostTracker['getBurnRate']> {
    return this.costTracker.getBurnRate(nowMs);
  }

  /**
   * Per-scoop context-window fill (0..1), from each scoop's last assistant
   * turn. Drives the chip pupils — they dilate as the context fills up.
   */
  getContextFills(): ReturnType<ScoopCostTracker['getContextFills']> {
    return this.costTracker.getContextFills();
  }

  /** Cleanup */
  async shutdown(): Promise<void> {
    this.stopMessageLoop();

    // Clear all idle timers
    this.idleTimers.clearAll();

    // Stop the scheduler
    this.scheduler?.stop();
    this.scheduler = null;

    // Drain any outstanding `scoop_wait` waiters so their promises
    // resolve instead of hanging past shutdown, then drop mute / pending
    // state so a re-initialized orchestrator starts from a clean slate.
    this.completionService.shutdown();

    // Fail-closed every pending cone-mediated sudo request — same
    // rationale as the `completionWaiters` drain above: scoops holding
    // a `requestApproval` promise must see a deterministic deny instead
    // of a hang past shutdown.
    const sudoFailed = this.approvalRouter.failAll();
    if (sudoFailed > 0) {
      log.info('Failed-closed pending sudo requests during shutdown', { count: sudoFailed });
    }

    await this.lifecycle.destroyAllTabs();

    // Drop the discovery-ignore and sudoers live-reload watcher subscriptions.
    this.lickManager?.setDiscoveryIgnore?.(null);
    this.llmsTxtIgnorePolicy?.dispose();
    this.llmsTxtIgnorePolicy = null;
    this.modelPolicyFile?.dispose();
    this.modelPolicyFile = null;
    this.sudoManager?.dispose();
    this.sudoManager = null;

    // Unregister the worker-side transcript export service (identity-safe).
    this.unregisterExportService?.();
    this.unregisterExportService = null;

    log.info('Orchestrator shutdown');
  }

  // ---------------------------------------------------------------------------
  // Private — worker-side export service factory
  // ---------------------------------------------------------------------------

  /**
   * Build a `DefaultTranscriptExportService` wired to the orchestrator's live
   * state. Called once at the end of `init()` so `sharedFs` and
   * `sessionStore` are already initialised.
   *
   * Uses a lazy `UiSessionStore` for `loadUiChatSessions` — the
   * `browser-coding-agent` IDB is accessible from dedicated workers (same
   * origin as the page). The VirtualFS is cast to both read and write
   * client interfaces it already structurally satisfies.
   */
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
      // SAFETY: `VirtualFS` structurally implements the read/write surface of
      // `LocalVfsClient` / `WritableVfsClient` (readFile/writeFile/exists/
      // readDir); the client types are narrower views declared in a package
      // that cannot import VirtualFS, so the bridge is asserted here.
      snapshotStore: {
        read: (sessionId) => readSnapshot(fs as unknown as LocalVfsClient, sessionId),
        write: (sessionId, snapshot) =>
          // SAFETY: same structural bridge as above — VirtualFS satisfies the
          // WritableVfsClient write surface.
          writeSnapshot(fs as unknown as WritableVfsClient, sessionId, snapshot),
      },
      // SAFETY: same structural bridge as above — VirtualFS satisfies the
      // LocalVfsClient read surface.
      vfs: fs as unknown as LocalVfsClient,
      getActiveSessionInfo: () => {
        const cone = this.defaultRoot();
        return { id: cone?.jid ?? `session-${Date.now()}`, title: cone?.name ?? 'Active Session' };
      },
      version: __SLICC_VERSION__,
    });
  }
}
