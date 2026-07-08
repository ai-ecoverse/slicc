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

import type { Api, Model } from '@earendil-works/pi-ai';
import type { BrowserAPI } from '../cdp/index.js';
import { createLogger } from '../core/logger.js';
import { SessionStore } from '../core/session.js';
import type { ImageContent } from '../core/types.js';
import { FsWatcher, VirtualFS } from '../fs/index.js';
import type { ProcessManager } from '../kernel/process-manager.js';
import { registerSessionCostsProvider } from '../shell/supplemental-commands/cost-command.js';
import type {
  ConeApprovalRouter,
  PendingSudoRequest,
  SudoBroker,
  SudoDecision,
  SudoRequest,
} from '../sudo/index.js';
import { SudoManager } from '../sudo/sudo-manager.js';
import { ConeMemoryStore } from './cone-memory-store.js';
import * as db from './db.js';
import { isExternalLickChannel } from './lick-formatting.js';
import { buildActiveLicksError, type LickEvent, type LickManager } from './lick-manager.js';
import { LickRegistry } from './lick-registry.js';
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
} from './types.js';

export type { ScoopObserver };

const log = createLogger('orchestrator');

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
    state: 'summarizing' | 'extracting-memory' | 'idle'
  ) => void;
  /** Called on error */
  onError: (scoopJid: string, error: string) => void;
  /** Get the BrowserAPI used by browser automation commands */
  getBrowserAPI: () => BrowserAPI;
  /** Called when a tool starts executing */
  onToolStart?: (scoopJid: string, toolName: string, toolInput: unknown) => void;
  /** Called when a tool finishes executing */
  onToolEnd?: (scoopJid: string, toolName: string, result: string, isError: boolean) => void;
  /** Called when a tool requests UI interaction */
  onToolUI?: (scoopJid: string, toolName: string, requestId: string, html: string) => void;
  /** Called when tool UI interaction is complete */
  onToolUIDone?: (scoopJid: string, requestId: string) => void;
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
  private fsWatcher: FsWatcher | null = null;
  /** Owns the live sudoers policy + shared approval broker for this float. */
  private sudoManager: SudoManager | null = null;
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
    findCone: () => Array.from(this.scoops.values()).find((s) => s.isCone),
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
      const cone = Array.from(this.scoops.values()).find((s) => s.isCone);
      return cone ? (this.lifecycle.getContext(cone.jid)?.getShell() ?? null) : null;
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
    sendPrompt: (jid, text, senderId, senderName, images) =>
      this.sendPrompt(jid, text, senderId, senderName, images ?? []),
    notifyIncomingMessage: (jid, msg) => this.callbacks.onIncomingMessage?.(jid, msg),
    onError: (jid, error) => this.callbacks.onError(jid, error),
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
      getSharedFs: () => this.sharedFs,
      getSessionStore: () => this.sessionStore,
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

  /** Initialize orchestrator and load saved scoops */
  async init(): Promise<void> {
    await db.initDB();

    // Create the single shared VirtualFS
    this.sharedFs = await VirtualFS.create({ dbName: 'slicc-fs' });
    this.sessionStore = new SessionStore();

    // Create and attach file system watcher
    this.fsWatcher = new FsWatcher();
    this.sharedFs.setWatcher(this.fsWatcher);
    (globalThis as any).__slicc_fs_watcher = this.fsWatcher;
    await this.ensureRootStructure();

    // Stand up the sudo policy manager: seeds the default /etc/sudoers
    // template, loads + merges the live policy, and watches for changes so
    // edits (and "Always" grants) take effect with no restart. The same
    // manager is threaded into every ScoopContext below.
    this.sudoManager = new SudoManager({ fs: this.sharedFs, watcher: this.fsWatcher });
    await this.sudoManager.init();

    const savedScoops = await db.getAllScoops();

    for (const scoop of Object.values(savedScoops)) {
      // Sanitize legacy cone records (may have trigger: '@Andy' from old groups code)
      if (scoop.isCone) {
        scoop.trigger = undefined;
        scoop.requiresTrigger = false;
        scoop.assistantLabel = scoop.assistantLabel || 'sliccy';
      }
      this.migrateScoopConfig(scoop);
      this.scoops.set(scoop.jid, scoop);
      this.messageRouter.ensureQueue(scoop.jid);

      // Restore last agent timestamp from state
      const ts = await db.getState(`lastAgentTs_${scoop.jid}`);
      if (ts) this.messageRouter.setLastAgentTimestamp(scoop.jid, ts);
    }

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

    // Initialize all scoop contexts
    for (const scoop of this.scoops.values()) {
      await this.createScoopTab(scoop.jid);
    }

    // Register session costs provider for the `cost` shell command
    registerSessionCostsProvider(() => this.getSessionCosts());

    // Start polling for pending messages
    this.messageRouter.startMessageLoop();
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
  private migrateScoopConfig(scoop: RegisteredScoop): void {
    if (scoop.isCone) return;
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
    scoop.configSchemaVersion = CURRENT_SCOOP_CONFIG_VERSION;
  }

  /** Ensure root directory structure exists on the shared FS */
  private async ensureRootStructure(): Promise<void> {
    if (!this.sharedFs) return;
    const dirs = ['/workspace', '/shared', '/scoops', '/home', '/tmp', '/mnt'];
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
   * Append a block of auto-extracted memory bullets to /workspace/CLAUDE.md.
   * Used by the compaction memory-extraction pass and by the "New session"
   * freezer flow. Delegates to {@link ConeMemoryStore} — see that module for
   * serialization + budget semantics.
   */
  appendConeMemory(
    bullets: string,
    meta: {
      source: string;
      model?: Model<Api>;
      apiKey?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    }
  ): Promise<void> {
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
    (globalThis as any).__slicc_lick_handler = (event: any) => {
      this.lickManager?.emitEvent(event);
    };
  }

  /**
   * Relay a webhook event into the LickManager. Used by `OffscreenBridge`
   * when the page-side `LeaderTrayManager` forwards a tray `webhook.event`
   * across the bridge (see `lick-webhook-event` message type). Pre-regression
   * this was a direct page-side call; post-refactor the tray sits on the
   * page and the lick manager sits in the worker, so the page relays the
   * event over the bridge and the orchestrator dispatches it locally.
   */
  handleWebhookEvent(webhookId: string, headers: Record<string, string>, body: unknown): void {
    this.lickManager?.handleWebhookEvent(webhookId, headers, body);
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
   * lick. The page-side `LeaderSyncManager` builds the full event (rate-limited,
   * `--quiet`-suppressed) and forwards it here — page-side via the `lick-preview`
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
   * `OffscreenBridge.routeSprinkleLick`), NOT from the agent tools — this is
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
    // Rebuild the sudo manager against the fresh VFS: re-seeds the default
    // /etc/sudoers template and re-attaches the live-reload watcher.
    this.sudoManager?.dispose();
    this.sudoManager = new SudoManager({ fs: this.sharedFs, watcher: this.fsWatcher });
    await this.sudoManager.init();
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
    images: ImageContent[] = []
  ): Promise<void> {
    return this.lifecycle.sendPrompt(jid, text, senderId, senderName, images);
  }

  /** Stop the message polling loop */
  stopMessageLoop(): void {
    this.messageRouter.stopMessageLoop();
  }

  /** Update the model on all active scoop contexts. */
  updateModel(): void {
    this.lifecycle.updateModelOnAll();
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

  /** Collect cost data from all active and dropped scoops for the `cost` shell command. */
  getSessionCosts(): ReturnType<ScoopCostTracker['getSessionCosts']> {
    return this.costTracker.getSessionCosts();
  }

  /** Per-model cost breakdown (sorted by cost descending) for the session-stats wire. */
  getModelCosts(): ReturnType<ScoopCostTracker['getModelCosts']> {
    return this.costTracker.getModelCosts();
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

    // Drop the sudoers live-reload watcher subscription.
    this.sudoManager?.dispose();
    this.sudoManager = null;

    log.info('Orchestrator shutdown');
  }
}
