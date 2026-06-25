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
import { formatPromptWithAttachments, imageContentFromAttachments } from '../core/attachments.js';
import { createLogger } from '../core/logger.js';
import { SessionStore } from '../core/session.js';
import type { ImageContent } from '../core/types.js';
import { FsWatcher, VirtualFS } from '../fs/index.js';
import { type MountRecoveryEntry, shellQuote } from '../fs/mount-recovery.js';
import { RestrictedFS } from '../fs/restricted-fs.js';
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
import { ScoopContext, type ScoopContextCallbacks } from './scoop-context.js';
import { ScoopCostTracker } from './scoop-cost-tracker.js';
import { ScoopIdleTimers } from './scoop-idle-timers.js';
import { emitScoopLifecycle } from './scoop-telemetry-hook.js';
import { createDefaultSkills } from './skills.js';
import {
  type ChannelMessage,
  CURRENT_SCOOP_CONFIG_VERSION,
  type RegisteredScoop,
  type ScoopTabState,
  type ThinkingLevel,
} from './types.js';

const log = createLogger('orchestrator');

// Re-exported from the idle-timers module so consumers (tests, the cone-idle
// notice copy) can keep importing it from this barrel.
export { SCOOP_IDLE_TIMEOUT_MS } from './scoop-idle-timers.js';

/**
 * Reconstruct the `mount …` command for a mount-recovery entry, byte-for-byte
 * matching what `formatMountRecoveryPrompt` rendered to the cone: local mounts
 * re-open the directory picker via `mount '<path>'`; remote mounts re-attach
 * via `mount --source '<source>' [--profile '<profile>'] '<path>'` (the
 * `--profile` flag is omitted for the `default` profile). Every argument is
 * shell-quoted because paths/sources originate from user-mounted targets.
 */
function buildMountRecoveryCommand(entry: MountRecoveryEntry): string {
  if (entry.kind === 'local') {
    return `mount ${shellQuote(entry.path)}`;
  }
  const profileFlag = entry.profile === 'default' ? '' : ` --profile ${shellQuote(entry.profile)}`;
  return `mount --source ${shellQuote(entry.source)}${profileFlag} ${shellQuote(entry.path)}`;
}

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

/**
 * Per-scoop event observer. Subscribed via {@link Orchestrator.observeScoop}
 * so a caller can react to events on a single scoop's lifecycle without
 * reading the orchestrator's top-level callbacks (which fanout events from
 * every scoop).
 *
 * Used by the `agent` shell command's bridge to block a bash invocation
 * until a spawned sub-scoop reaches terminal status and to capture the
 * scoop's `send_message` payloads along the way.
 *
 * All handlers are optional — subscribers install only the ones they need.
 * Exceptions thrown from a handler are caught and logged; they do not
 * disrupt the orchestrator's own callback chain.
 */
export interface ScoopObserver {
  onStatusChange?: (status: ScoopTabState['status']) => void;
  onSendMessage?: (text: string) => void;
  onResponse?: (text: string, isPartial: boolean) => void;
  onError?: (error: string) => void;
}

export class Orchestrator implements ConeApprovalRouter {
  private scoops: Map<string, RegisteredScoop> = new Map();
  private tabs: Map<string, ScoopTabState> = new Map();
  private contexts: Map<string, ScoopContext> = new Map();
  private messageQueues: Map<string, ChannelMessage[]> = new Map();
  private lastAgentTimestamp: Map<string, string> = new Map();
  private container: HTMLElement;
  private callbacks: OrchestratorCallbacks;
  private config: AssistantConfig;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
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
   * Per-scoop "no work received yet" notifier. Fires a single cone-facing
   * lick when a non-cone scoop stays `ready` for {@link SCOOP_IDLE_TIMEOUT_MS}
   * so a forgotten delegation surfaces in chat. Armed by every
   * `ready`-transitioning lifecycle hook; cleared on status change /
   * destroy / unregister / shutdown.
   */
  private idleTimers: ScoopIdleTimers = new ScoopIdleTimers({
    getScoops: () => this.scoops,
    getTabs: () => this.tabs,
    handleMessage: (msg) => this.handleMessage(msg),
    notifyIncomingMessage: (jid, msg) => this.callbacks.onIncomingMessage?.(jid, msg),
  });
  /** Per-session cost aggregation; preserves dropped scoops' usage. */
  private costTracker: ScoopCostTracker = new ScoopCostTracker({
    getScoops: () => this.scoops,
    getContexts: () => this.contexts,
  });
  /**
   * Per-scoop event observers. The `agent` shell command (`agent-bridge.ts`)
   * uses this to await a sub-scoop's completion without having to own its
   * own `ScoopContext`: it subscribes, calls `sendPrompt`, and watches for
   * status / send_message / error events on the one jid it cares about.
   */
  private scoopObservers: Map<string, Set<ScoopObserver>> = new Map();
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
    runUpskillInstall: (entry) => this.runUpskillInstall(entry),
    runMountRecovery: (mounts) => this.runMountRecovery(mounts),
    persistLickDecision: (id, decision) => this.approvalRouter.persistLickDecision(id, decision),
  });

  constructor(
    container: HTMLElement,
    callbacks: OrchestratorCallbacks,
    config: AssistantConfig = { name: 'sliccy', triggerPattern: /^@sliccy\b/i }
  ) {
    this.container = container;
    this.callbacks = callbacks;
    this.config = config;
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
      this.messageQueues.set(scoop.jid, []);

      // Restore last agent timestamp from state
      const ts = await db.getState(`lastAgentTs_${scoop.jid}`);
      if (ts) this.lastAgentTimestamp.set(scoop.jid, ts);
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
    this.startMessageLoop();
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
    let set = this.scoopObservers.get(jid);
    if (!set) {
      set = new Set();
      this.scoopObservers.set(jid, set);
    }
    set.add(observer);
    return () => {
      const s = this.scoopObservers.get(jid);
      if (!s) return;
      s.delete(observer);
      if (s.size === 0) this.scoopObservers.delete(jid);
    };
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
   * Run the `upskill` install for a confirmed navigate·upskill lick through the
   * cone's shell (which carries the cone fs, proxied fetch, and skills-dir
   * discovery). Each argument is single-quoted because `target` / `branch` /
   * `path` originate from an attacker-controlled `Link` header — never
   * interpolate them raw into the command string. Returns the combined
   * stdout/stderr (or an error line) for the tool to surface verbatim.
   */
  private async runUpskillInstall(entry: {
    target: string;
    branch?: string;
    path?: string;
  }): Promise<string> {
    const cone = Array.from(this.scoops.values()).find((s) => s.isCone);
    const shell = cone ? this.contexts.get(cone.jid)?.getShell() : null;
    if (!shell) return 'upskill could not run: no cone shell available.';
    const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const parts = ['upskill'];
    if (entry.branch) parts.push('--branch', quote(entry.branch));
    if (entry.path) parts.push('--path', quote(entry.path));
    parts.push(quote(entry.target));
    try {
      const result = await shell.executeCommand(parts.join(' '));
      const out = `${result.stdout}${result.stderr}`.trim();
      return out.length > 0 ? out : `upskill exited ${result.exitCode}.`;
    } catch (err) {
      return `upskill failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Re-run the `mount …` commands for a confirmed mount-recovery lick through
   * the cone's shell (which carries the shared fs and the gesture-aware `mount`
   * command). Each command is reconstructed from the persisted
   * `MountRecoveryEntry` exactly as `formatMountRecoveryPrompt` rendered it, so
   * the agent re-runs what the user saw. Returns the combined per-command
   * output (or an error line) for the tool to surface verbatim.
   */
  private async runMountRecovery(mounts: MountRecoveryEntry[]): Promise<string> {
    const cone = Array.from(this.scoops.values()).find((s) => s.isCone);
    const shell = cone ? this.contexts.get(cone.jid)?.getShell() : null;
    if (!shell) return 'mount recovery could not run: no cone shell available.';
    const outputs: string[] = [];
    for (const mount of mounts) {
      const cmd = buildMountRecoveryCommand(mount);
      try {
        const result = await shell.executeCommand(cmd);
        const out = `${result.stdout}${result.stderr}`.trim();
        outputs.push(out.length > 0 ? out : `${cmd} exited ${result.exitCode}.`);
      } catch (err) {
        outputs.push(`${cmd} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return outputs.join('\n');
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

  private dispatchScoopEvent<K extends keyof ScoopObserver>(
    jid: string,
    event: K,
    ...args: Parameters<NonNullable<ScoopObserver[K]>>
  ): void {
    const observers = this.scoopObservers.get(jid);
    if (!observers) return;
    for (const o of observers) {
      const handler = o[event];
      if (!handler) continue;
      try {
        (handler as (...a: unknown[]) => void)(...(args as unknown[]));
      } catch (err) {
        log.warn('scoop observer threw', {
          jid,
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async registerScoop(scoop: RegisteredScoop): Promise<void> {
    await db.saveScoop(scoop);
    this.scoops.set(scoop.jid, scoop);
    this.messageQueues.set(scoop.jid, []);
    log.info('Scoop registered', { jid: scoop.jid, name: scoop.name });
    try {
      await this.createScoopTab(scoop.jid);
      // Cones are tracked separately via boot-time `createScoopTab`
      // (not `registerScoop`), so this only fires for runtime-spawned
      // sub-scoops — which is what "delegation activity" cares about.
      if (!scoop.isCone) emitScoopLifecycle('spawn', scoop.folder);
    } catch (err) {
      log.error('Scoop init failed', {
        jid: scoop.jid,
        name: scoop.name,
        error: err instanceof Error ? err.message : String(err),
      });
      // Best-effort rollback — leave no half-registered scoop behind.
      await this.destroyScoopTab(scoop.jid).catch((destroyErr) => {
        log.warn('Failed to destroy scoop runtime during init rollback', {
          jid: scoop.jid,
          name: scoop.name,
          error: destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
        });
      });
      this.scoops.delete(scoop.jid);
      this.messageQueues.delete(scoop.jid);
      await db.deleteScoop(scoop.jid).catch((rollbackErr) => {
        log.warn('Failed to rollback scoop registration', {
          jid: scoop.jid,
          name: scoop.name,
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        });
      });
      throw err;
    }
  }

  /** Unregister a scoop. Throws if the scoop has active licks (webhooks/cron tasks). */
  async unregisterScoop(jid: string): Promise<void> {
    // Guard: check for active licks before allowing removal
    const scoop = this.scoops.get(jid);
    if (scoop && this.lickManager) {
      const { webhooks, cronTasks } = this.lickManager.getLicksForScoop(scoop.name, scoop.folder);
      const err = buildActiveLicksError(scoop.folder, webhooks, cronTasks);
      if (err) throw err;
    }

    // Snapshot cost data before destroying context
    this.costTracker.snapshot(jid);

    // Auto-cleanup any `browser.websocket` subscribers owned by this
    // scoop — keeps the page-side router from forwarding into a dead
    // sink. Best-effort; never blocks tear-down.
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

    this.idleTimers.clear(jid);
    await this.destroyScoopTab(jid);
    this.sessionStore?.delete(jid).catch((err) => {
      log.warn('Failed to delete agent session', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    await db.deleteScoop(jid);
    this.scoops.delete(jid);
    this.messageQueues.delete(jid);
    this.lastAgentTimestamp.delete(jid);
    // Defensive observer cleanup — subscribers are expected to call their
    // unsubscribe, but if they never get the chance (uncaught exception
    // before `finally`, bridge crash mid-spawn, etc.) the set would
    // otherwise linger and could fire against stale handlers if the jid
    // were ever reused. Dropping the whole key is safe because every
    // legitimate observer for this scoop is about to lose its relevance
    // anyway: the scoop's context has been destroyed.
    this.scoopObservers.delete(jid);
    // Drop the response buffer, mute / pending state, and release any
    // `scoop_wait` resolvers targeting this jid so the wait doesn't stall
    // on a scoop that no longer exists.
    this.completionService.forgetScoop(jid, 'unregister');
    // Fail-closed any cone-mediated sudo requests this scoop had in
    // flight. Without this, a scoop dropped mid-approval would leave
    // its `requestApproval` promise dangling forever.
    const sudoFailed = this.approvalRouter.failScoop(jid);
    if (sudoFailed > 0) {
      log.info('Failed-closed pending sudo requests for unregistered scoop', {
        jid,
        count: sudoFailed,
      });
    }
    log.info('Scoop unregistered', { jid });
    // Notify last, with the pre-removal snapshot, so consumers see a
    // fully torn-down orchestrator. Guarded: a throwing consumer must
    // not break scoop teardown.
    if (scoop) {
      try {
        this.callbacks.onScoopUnregistered?.(scoop);
      } catch (err) {
        log.warn('onScoopUnregistered callback threw', {
          jid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
    for (const [jid, ctx] of this.contexts.entries()) {
      this.idleTimers.clear(jid);
      ctx.stop();
      this.contexts.delete(jid);
    }
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
  async clearScoopMessages(jid: string): Promise<void> {
    const ctx = this.contexts.get(jid);
    if (ctx) {
      ctx.clearMessages();
      if (this.sessionStore) {
        const sessionId = ctx.getSessionId();
        await this.sessionStore.delete(sessionId).catch((err) => {
          log.warn('Failed to clear agent session for scoop', {
            jid,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
    await db.clearMessagesForScoop(jid).catch((err) => {
      log.warn('Failed to clear persisted channel history for scoop', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.lastAgentTimestamp.delete(jid);
    this.messageQueues.set(jid, []);
    log.info('Scoop messages cleared', { jid });
  }

  /** Clear all messages from the orchestrator DB, agent sessions, and live agent contexts. */
  async clearAllMessages(): Promise<void> {
    await db.clearAllMessages();
    if (this.sessionStore) {
      await this.sessionStore.clearAll().catch((err) => {
        log.warn('Failed to clear agent sessions', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    // Clear in-memory conversation history from all live scoop agents
    for (const ctx of this.contexts.values()) {
      ctx.clearMessages();
    }
    this.lastAgentTimestamp.clear();
    for (const jid of this.scoops.keys()) {
      this.messageQueues.set(jid, []);
    }
    this.costTracker.reset();
    log.info('All messages cleared');
  }

  /** Handle incoming message from a channel */
  async handleMessage(message: ChannelMessage): Promise<void> {
    log.info('handleMessage', {
      id: message.id,
      chatJid: message.chatJid,
      sender: message.senderName,
      channel: message.channel,
      contentPreview: message.content.slice(0, 80),
    });

    // Surface external lick events (webhook / cron / sprinkle / fswatch /
    // session-reload / navigate / upgrade / cherry / workflow / sudo-request)
    // to the UI as a chat chip the moment they arrive. Without this fire the
    // lick persists to IDB and queues for the agent, but the chat panel only
    // learns about it on session reload. Scoop-lifecycle channels
    // (scoop-notify, scoop-idle, scoop-wait, scoop-error, delegation) are
    // intentionally excluded — their builders fire `onIncomingMessage`
    // explicitly next to the point they create the message, so they would
    // double-fire here.
    if (isExternalLickChannel(message.channel)) {
      try {
        this.callbacks.onIncomingMessage?.(message.chatJid, message);
      } catch (err) {
        log.warn('onIncomingMessage for external lick channel threw', {
          channel: message.channel,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Store the message
    await db.saveMessage(message);

    // Route to the direct target (chatJid) only.
    // No @mention scanning — the cone delegates to scoops via the delegate_to_scoop tool,
    // which lets it add context/clarification before routing.
    await this.routeToScoop(message);
  }

  /** Delegate a prompt directly to a scoop's agent. Used by the delegate_to_scoop tool. */
  async delegateToScoop(scoopJid: string, prompt: string, senderName: string): Promise<void> {
    const scoop = this.scoops.get(scoopJid);
    if (!scoop) throw new Error(`Scoop not found: ${scoopJid}`);

    emitScoopLifecycle('feed', scoop.folder);

    // Save as a channel message so it shows up in history
    const msg: ChannelMessage = {
      id: `delegate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chatJid: scoopJid,
      senderId: 'cone',
      senderName,
      content: prompt,
      timestamp: new Date().toISOString(),
      fromAssistant: true,
      channel: 'delegation',
    };
    await db.saveMessage(msg);

    // Notify UI about the incoming delegation
    this.callbacks.onIncomingMessage?.(scoopJid, msg);

    log.info('Delegating to scoop', {
      scoopJid,
      scoopName: scoop.name,
      promptLength: prompt.length,
    });

    // Fire-and-forget: don't await the scoop's agent loop.
    // The cone's tool call returns immediately so the cone can finish its turn.
    // The scoop processes in the background; completion notification routes back to cone.
    this.sendPrompt(scoopJid, prompt, 'cone', senderName).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Delegation failed', { scoopJid, error: msg });
      this.callbacks.onError(scoopJid, `Delegation failed: ${msg}`);
    });
  }

  /** Route a message to the scoop specified by message.chatJid */
  private async routeToScoop(message: ChannelMessage): Promise<void> {
    const scoop = this.scoops.get(message.chatJid);
    if (!scoop) {
      log.info('routeToScoop: unregistered target', { chatJid: message.chatJid });
      return;
    }

    // Check trigger requirement using the scoop's own trigger
    // Bypass trigger check for lick messages — they're explicitly routed to this scoop
    const isLick =
      message.channel === 'webhook' ||
      message.channel === 'cron' ||
      message.channel === 'fswatch' ||
      message.channel === 'sprinkle';
    if (!scoop.isCone && scoop.requiresTrigger && scoop.trigger && !isLick) {
      if (!message.content.includes(scoop.trigger)) {
        log.info('routeToScoop: trigger not found in content', {
          chatJid: message.chatJid,
          trigger: scoop.trigger,
          contentPreview: message.content.slice(0, 80),
        });
        return;
      }
    }

    // Queue the message
    const queue = this.messageQueues.get(message.chatJid) ?? [];
    queue.push(message);
    this.messageQueues.set(message.chatJid, queue);

    // Process immediately if tab is ready; retry init if in error state
    let tab = this.tabs.get(message.chatJid);
    log.debug('routeToScoop: queued', {
      chatJid: message.chatJid,
      scoopName: scoop.name,
      tabStatus: tab?.status ?? 'no-tab',
      queueLength: queue.length,
    });
    if (tab?.status === 'error') {
      log.info('routeToScoop: tab in error state, retrying init', { chatJid: message.chatJid });
      try {
        await this.createScoopTab(message.chatJid);
        tab = this.tabs.get(message.chatJid);
      } catch {
        log.warn('routeToScoop: retry init failed', { chatJid: message.chatJid });
      }
    }
    if (tab?.status === 'ready') {
      await this.processScoopQueue(message.chatJid);
    }
  }

  /**
   * Seed (or reload) the per-scoop sudoers file from `ScoopConfig` so the
   * scoop's `writablePaths` / `visiblePaths` / `allowedCommands` materialize
   * as `NOPASSWD` grants. Without this the scoop's effective policy is the
   * global one + nothing, and every in-sandbox action would escalate
   * (the SudoFS default disposition is `'require-approval'` for scoops).
   *
   * - Missing file: seed from config. Fresh-boot fast path.
   * - Existing file: only reload into the in-memory cache — overwriting on
   *   every boot would wipe any "Always" grants added mid-session via
   *   {@link SudoManager.appendScoopRule}. Re-seeding when `ScoopConfig`
   *   changes is a separate flow (handled by the scoop-edit path).
   *
   * Best-effort: a failed seed is logged and the scoop boots with whatever
   * policy is already on disk.
   */
  private async ensureScoopSudoersLoaded(scoop: RegisteredScoop): Promise<void> {
    if (!this.sudoManager || !this.sharedFs) return;
    try {
      const path = `/scoops/${scoop.folder}/etc/sudoers`;
      if (await this.sharedFs.exists(path)) {
        await this.sudoManager.reloadScoopPolicyByFolder(scoop.folder);
      } else {
        await this.sudoManager.seedScoopSudoers(scoop.folder, scoop.config);
      }
    } catch (err) {
      log.warn('Failed to seed per-scoop sudoers; continuing with existing policy', {
        folder: scoop.folder,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Create and initialize a scoop context */
  async createScoopTab(jid: string): Promise<void> {
    const scoop = this.scoops.get(jid);
    if (!scoop) throw new Error(`Scoop not found: ${jid}`);

    if (this.contexts.has(jid)) {
      // If previous init failed (error state), destroy and re-create
      const existingTab = this.tabs.get(jid);
      if (existingTab?.status === 'error') {
        log.info('Re-creating context after error', { jid });
        this.contexts.get(jid)?.dispose();
        this.contexts.delete(jid);
        this.tabs.delete(jid);
      } else {
        log.debug('Context already exists', { jid });
        return;
      }
    }

    if (!this.sharedFs) throw new Error('Shared filesystem not initialized');

    const contextId = `scoop-${scoop.folder}-${Date.now()}`;

    // Create the appropriate filesystem for this scoop.
    // Cone gets unrestricted access; non-cone scoops use a RestrictedFS whose
    // read-only and read-write prefixes come straight from config (pure
    // replace — defaults live in `scoop_scoop` and in the restore backfill,
    // not here).
    //
    // `writeEnforcement: 'sudo-delegated'` lets the outer SudoFS escalate
    // out-of-sandbox writes to the cone instead of dying here with EACCES.
    // Reads stay silently filtered (ENOENT/[]). The symlink-escape EACCES
    // in RestrictedFS stays active in both modes — a `/scoops/<f>/escape`
    // symlink to `/etc/sudoers` is a security invariant, not a policy choice.
    const fs = scoop.isCone
      ? this.sharedFs
      : new RestrictedFS(
          this.sharedFs,
          scoop.config?.writablePaths ? [...scoop.config.writablePaths] : [],
          scoop.config?.visiblePaths ? [...scoop.config.visiblePaths] : [],
          'sudo-delegated'
        );

    if (!scoop.isCone) {
      await this.ensureScoopSudoersLoaded(scoop);
    }

    // Create the scoop context with full callbacks
    const contextCallbacks = this.buildScoopContextCallbacks(jid, scoop);

    const coneJid = Array.from(this.scoops.values()).find((s) => s.isCone)?.jid;
    const context = new ScoopContext(
      scoop,
      contextCallbacks,
      fs,
      this.sessionStore ?? undefined,
      this.sharedFs ?? undefined,
      coneJid,
      this.processManager ?? undefined,
      this.sudoManager
    );

    this.contexts.set(jid, context);
    this.tabs.set(jid, {
      jid,
      contextId,
      status: 'initializing',
      lastActivity: new Date().toISOString(),
    });

    // Initialize the context
    await context.init();

    // Mark tab as ready so queued messages (lick events, etc.) get processed
    const initTab = this.tabs.get(jid);
    if (initTab && initTab.status === 'initializing') {
      initTab.status = 'ready';
      this.tabs.set(jid, initTab);
      this.callbacks.onStatusChange(jid, 'ready');
      this.dispatchScoopEvent(jid, 'onStatusChange', 'ready');
    }

    // Start idle timer for non-cone scoops
    const scoopForTimer = this.scoops.get(jid);
    if (scoopForTimer && !scoopForTimer.isCone) {
      this.idleTimers.start(jid);
    }

    log.info('Scoop context created', { jid, contextId });
  }

  /**
   * Build the `ScoopContextCallbacks` wired into a scoop's context by
   * {@link createScoopTab}. Mostly thin per-scoop adapters over the
   * orchestrator's top-level callbacks; cone-only capabilities
   * (scoop management, memory writes) are gated on `scoop.isCone`.
   */
  private buildScoopContextCallbacks(jid: string, scoop: RegisteredScoop): ScoopContextCallbacks {
    return {
      onResponse: (text, isPartial) => {
        if (!this.scoops.has(jid)) return;

        this.callbacks.onResponse(jid, text, isPartial);
        this.dispatchScoopEvent(jid, 'onResponse', text, isPartial);
        // Accumulate response text for routing back to cone. Both partial
        // (streaming deltas) and full (non-streaming) variants are buffered
        // since models without streaming emit isPartial=false with the full
        // text.
        if (!scoop.isCone) {
          if (isPartial) {
            this.completionService.appendResponseChunk(jid, text);
          } else {
            this.completionService.setResponseFull(jid, text);
          }
        }
      },
      onResponseDone: () => {
        if (!this.scoops.has(jid)) return;

        // Per-turn callback — DON'T set tab to 'ready' here.
        // The tab stays 'processing' until prompt() resolves (setStatus('ready') in finally).
        // This prevents the message queue from dequeuing during multi-turn.
        const tab = this.tabs.get(jid);
        if (tab) {
          tab.lastActivity = new Date().toISOString();
          this.tabs.set(jid, tab);
        }
        this.callbacks.onResponseDone(jid);
      },
      onError: (error) => {
        if (!this.scoops.has(jid)) return;

        const tab = this.tabs.get(jid);
        if (tab) {
          tab.status = 'error';
          tab.error = error;
          this.tabs.set(jid, tab);
        }
        emitScoopLifecycle('error', scoop.folder, error);
        this.callbacks.onError(jid, error);
        this.callbacks.onStatusChange(jid, 'error');
        this.dispatchScoopEvent(jid, 'onError', error);
        this.dispatchScoopEvent(jid, 'onStatusChange', 'error');
      },
      onFatalError: (error) => this.handleScoopFatalError(jid, error),
      onStatusChange: (status) => {
        if (!this.scoops.has(jid)) return;

        const tab = this.tabs.get(jid);
        if (tab) {
          tab.status = status;
          tab.lastActivity = new Date().toISOString();
          this.tabs.set(jid, tab);
        }
        this.callbacks.onStatusChange(jid, status);
        this.dispatchScoopEvent(jid, 'onStatusChange', status);

        // When a non-cone scoop finishes, route its response to the cone
        // with a VFS path + preview so the cone can decide how to follow up.
        if (status === 'ready' && !scoop.isCone) {
          void this.completionService.notifyCompletion(jid);
        }
      },
      onCompactionStateChange: (state) => {
        this.callbacks.onCompactionStateChange?.(jid, state);
      },
      onToolStart: (toolName, toolInput) => {
        this.callbacks.onToolStart?.(jid, toolName, toolInput);
      },
      onToolEnd: (toolName, result, isError) => {
        this.callbacks.onToolEnd?.(jid, toolName, result, isError);
      },
      onToolUI: (toolName, requestId, html) => {
        this.callbacks.onToolUI?.(jid, toolName, requestId, html);
      },
      onToolUIDone: (requestId) => {
        this.callbacks.onToolUIDone?.(jid, requestId);
      },
      // NanoClaw tools callbacks
      onSendMessage: (text, sender) => {
        const prefixed = `${sender ? `[${sender}] ` : ''}${text}`;
        this.callbacks.onSendMessage(jid, prefixed);
        // Observer gets the raw payload (not the sender-prefixed form) so the
        // `agent` shell command can surface the scoop's send_message text
        // verbatim for stdout.
        this.dispatchScoopEvent(jid, 'onSendMessage', text);
      },
      getScoops: () => this.getScoops(),
      getScoopTabState: scoop.isCone ? (jid: string) => this.tabs.get(jid) : undefined,
      onFeedScoop: scoop.isCone
        ? (scoopJid, prompt) => this.delegateToScoop(scoopJid, prompt, scoop.assistantLabel)
        : undefined,
      onScoopScoop: scoop.isCone
        ? async (newScoop) => {
            const fullScoop: RegisteredScoop = {
              ...newScoop,
              jid: `scoop_${newScoop.folder}_${Date.now()}`,
            };
            await this.registerScoop(fullScoop);
            return fullScoop;
          }
        : undefined,
      onDropScoop: scoop.isCone
        ? async (scoopJid) => {
            await this.unregisterScoop(scoopJid);
          }
        : undefined,
      onMuteScoops: scoop.isCone ? (jids) => this.muteScoops(jids) : undefined,
      onUnmuteScoops: scoop.isCone ? (jids) => this.unmuteScoops(jids) : undefined,
      onScheduleScoopWait: scoop.isCone
        ? (jids, timeoutMs) => this.scheduleScoopWait(jids, timeoutMs)
        : undefined,
      getGlobalMemory: () => this.getGlobalMemory(),
      setGlobalMemory: scoop.isCone ? (content) => this.setGlobalMemory(content) : undefined,
      appendConeMemory: scoop.isCone
        ? (bullets, meta) => this.appendConeMemory(bullets, meta)
        : undefined,
      // Sudo escalation wiring — symmetrical to the brokers but exposed as
      // tools. Scoops get `onSudoRequest` (routes through the pending-request
      // registry); the cone gets `onSudoResolve` + `onListSudoRequests` to
      // drain it. The cone keeps the user broker for its own FS / shell gate.
      onSudoRequest: scoop.isCone ? undefined : (request) => this.enqueueSudoRequest(jid, request),
      onSudoResolve: scoop.isCone
        ? (id, decision) => this.resolveActionableLick(id, decision)
        : undefined,
      onListSudoRequests: scoop.isCone ? () => this.listPendingSudoRequests() : undefined,
      getBrowserAPI: () => this.callbacks.getBrowserAPI(),
    };
  }

  /**
   * Handle an unrecoverable scoop failure (invalid model, auth failure,
   * exhausted retries). Fatal errors bypass mute and always notify the
   * cone immediately so the user is aware the scoop died.
   */
  private handleScoopFatalError(jid: string, error: string): void {
    if (!this.scoops.has(jid)) return;

    const scoopRecord = this.scoops.get(jid)!;
    log.error('Fatal scoop error', { jid, folder: scoopRecord.folder, error });

    emitScoopLifecycle('error', scoopRecord.folder, error);

    const tab = this.tabs.get(jid);
    if (tab) {
      tab.status = 'error';
      tab.error = error;
      this.tabs.set(jid, tab);
    }
    this.callbacks.onError(jid, error);
    this.callbacks.onStatusChange(jid, 'error');
    this.dispatchScoopEvent(jid, 'onError', error);
    this.dispatchScoopEvent(jid, 'onStatusChange', 'error');

    // Skip cone notification for the cone itself
    if (scoopRecord.isCone) return;

    // Force-unmute, drop any partial response, and release any pending
    // waiters so the error notification reaches the cone and `scoop_wait`
    // callers unblock instead of stalling.
    this.completionService.forgetScoop(jid, 'fatal-error');

    // Notify the cone about this fatal error
    const cone = Array.from(this.scoops.values()).find((s) => s.isCone);
    if (!cone) return;

    const notifyMsg: ChannelMessage = {
      id: `scoop-error-${jid}-${Date.now()}`,
      chatJid: cone.jid,
      senderId: scoopRecord.folder,
      senderName: scoopRecord.assistantLabel,
      content: `[@${scoopRecord.assistantLabel} FAILED]: ${error}`,
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'scoop-error',
    };

    // Fire onIncomingMessage so the UI renders the error as a lick widget
    try {
      this.callbacks.onIncomingMessage?.(cone.jid, notifyMsg);
    } catch (err) {
      log.warn('onIncomingMessage for scoop-error threw', {
        scoop: scoopRecord.folder,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Route to cone's agent queue so it can act on the failure
    this.handleMessage(notifyMsg).catch((err) => {
      log.error('Failed to route fatal error to cone', {
        scoop: scoopRecord.folder,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** Destroy a scoop context */
  async destroyScoopTab(jid: string): Promise<void> {
    this.idleTimers.clear(jid);
    const context = this.contexts.get(jid);
    if (context) {
      context.dispose();
      this.contexts.delete(jid);
      this.tabs.delete(jid);
      // Drop any lingering per-scoop observers alongside the context so
      // the shutdown / reset paths (which call us directly, bypassing
      // `unregisterScoop`) also reclaim them. See the matching delete
      // in `unregisterScoop` for the rationale.
      this.scoopObservers.delete(jid);
      log.info('Scoop context destroyed', { jid });
    }
  }

  /** Check if a scoop is currently processing. */
  isProcessing(jid: string): boolean {
    const tab = this.tabs.get(jid);
    return tab?.status === 'processing';
  }

  /** Get the scoop context for a JID */
  getScoopContext(jid: string): ScoopContext | undefined {
    return this.contexts.get(jid);
  }

  /** Clear all queued messages for a scoop (removes from both IndexedDB and in-memory queue). */
  async clearQueuedMessages(jid: string): Promise<void> {
    const queue = this.messageQueues.get(jid);
    if (queue && queue.length > 0) {
      // Remove each queued message from IndexedDB
      for (const msg of queue) {
        await db.deleteMessage(msg.id);
      }
      // Clear the in-memory queue
      this.messageQueues.set(jid, []);
    }
  }

  /** Delete a queued message by ID (removes from both IndexedDB and in-memory queue). */
  async deleteQueuedMessage(jid: string, messageId: string): Promise<void> {
    // Remove from in-memory queue
    const queue = this.messageQueues.get(jid);
    if (queue) {
      const idx = queue.findIndex((m) => m.id === messageId);
      if (idx !== -1) queue.splice(idx, 1);
    }
    // Remove from IndexedDB
    await db.deleteMessage(messageId);
  }

  /** Get all messages for a scoop */
  async getMessagesForScoop(jid: string): Promise<ChannelMessage[]> {
    return db.getMessagesForScoop(jid);
  }

  /** Wait for a tab to become ready, or timeout */
  private async waitForTabReady(jid: string, timeoutMs: number = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const tab = this.tabs.get(jid);
      if (!tab) return false;
      if (tab.status === 'ready' || tab.status === 'processing') {
        return true;
      }
      if (tab.status === 'error') {
        return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    log.warn('Timed out waiting for tab to become ready', { jid });
    return false;
  }

  /** Send a prompt to a scoop */
  async sendPrompt(
    jid: string,
    text: string,
    senderId: string,
    senderName: string,
    images: ImageContent[] = []
  ): Promise<void> {
    let context = this.contexts.get(jid);

    // Create context if needed
    if (!context) {
      await this.createScoopTab(jid);
      context = this.contexts.get(jid);
    }

    let tab = this.tabs.get(jid);
    if (tab?.status === 'initializing') {
      log.debug('Context initializing, waiting to send message', { jid });
      const ready = await this.waitForTabReady(jid);
      if (!ready) {
        log.error('Context did not become ready in time, dropping prompt', { jid });
        return;
      }
      context = this.contexts.get(jid);
      tab = this.tabs.get(jid);
    }

    if (!context) {
      log.error('Context not found after creation', { jid });
      return;
    }

    // Cancel idle timer — this scoop has started work
    this.idleTimers.clear(jid);

    // Update status and clear response buffer for fresh accumulation
    this.completionService.clearResponse(jid);
    if (tab) {
      tab.status = 'processing';
      tab.lastActivity = new Date().toISOString();
      this.tabs.set(jid, tab);
      this.callbacks.onStatusChange(jid, 'processing');
      this.dispatchScoopEvent(jid, 'onStatusChange', 'processing');
    }

    log.debug('Prompt sent to scoop', { jid, textLength: text.length, imageCount: images.length });

    // Send to the scoop context
    await context.prompt(text, images);
  }

  /** Process queued messages for a scoop */
  private async processScoopQueue(jid: string): Promise<void> {
    const queue = this.messageQueues.get(jid);
    if (!queue || queue.length === 0) {
      log.debug('processScoopQueue: empty queue', { jid });
      return;
    }

    const tab = this.tabs.get(jid);
    if (tab?.status !== 'ready') {
      log.debug('processScoopQueue: tab not ready', { jid, status: tab?.status ?? 'no-tab' });
      return;
    }

    // Get all messages since last agent interaction.
    // Exclude messages from this scoop's own assistant (prevents processing own responses).
    // Use the scoop's assistantLabel, not the global config name, so cone→scoop relays aren't filtered.
    const scoop = this.scoops.get(jid);
    const excludeName = scoop?.assistantLabel ?? jid;
    const since = this.lastAgentTimestamp.get(jid) ?? '';
    const messages = await db.getMessagesSince(jid, since, excludeName);

    log.debug('processScoopQueue: DB query', {
      jid,
      scoopName: scoop?.name,
      excludeName,
      since,
      dbMessageCount: messages.length,
      queueLength: queue.length,
    });

    if (messages.length === 0) {
      log.debug('processScoopQueue: no messages from DB, clearing queue', { jid });
      this.messageQueues.set(jid, []);
      return;
    }

    // Format messages
    const formatted = messages
      .map((m) => {
        const date = new Date(m.timestamp);
        const time = date.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
        return `[${time}] ${m.senderName}: ${formatPromptWithAttachments(m.content, m.attachments)}`;
      })
      .join('\n');
    const images = messages.flatMap((m) => imageContentFromAttachments(m.attachments));

    // Clear queue and update high-water mark
    this.messageQueues.set(jid, []);

    const lastMsg = messages[messages.length - 1];
    this.lastAgentTimestamp.set(jid, lastMsg.timestamp);
    await db.setState(`lastAgentTs_${jid}`, lastMsg.timestamp);

    await this.sendPrompt(jid, formatted, lastMsg.senderId, lastMsg.senderName, images);
  }

  /** Start the message polling loop */
  private startMessageLoop(): void {
    if (this.pollInterval) return;

    // `setInterval` (no `window.` prefix) so this works in both page and
    // DedicatedWorker contexts. The standalone runtime runs the orchestrator
    // in a worker; `window` is undefined there.
    this.pollInterval = setInterval(() => {
      for (const jid of this.scoops.keys()) {
        const tab = this.tabs.get(jid);
        if (tab?.status === 'ready') {
          this.processScoopQueue(jid).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            log.error('Message queue processing failed', { jid, error: message });
            this.callbacks.onError(jid, `Queue processing failed: ${message}`);
          });
        }
      }
    }, 2000);
  }

  /** Stop the message polling loop */
  stopMessageLoop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /** Update the model on all active scoop contexts (e.g., when the user changes the model dropdown). */
  updateModel(): void {
    for (const context of this.contexts.values()) {
      context.updateModel();
    }
    log.info('Model updated on all active contexts', { contextCount: this.contexts.size });
  }

  /**
   * Update a single scoop's reasoning / thinking level. Mutates the live
   * agent (`agent.state.thinkingLevel`) for the next turn AND persists the
   * value into `scoop.config.thinkingLevel` on disk so it survives reloads.
   *
   * Returns the level actually applied after model-aware resolution
   * (xhigh→high clamp on unsupported models, off on non-reasoning models).
   * Returns `null` when no scoop with the given jid is registered, or the
   * scoop has no live context (initialization failed / not yet ready).
   */
  async setScoopThinkingLevel(
    jid: string,
    level: ThinkingLevel | undefined
  ): Promise<ThinkingLevel | null> {
    const scoop = this.scoops.get(jid);
    if (!scoop) return null;

    const context = this.contexts.get(jid);
    const applied = context ? context.setThinkingLevel(level) : null;

    // Persist the requested level (not the resolved/clamped one): on a
    // model swap later, we want the user's stated preference re-resolved
    // against the new model, not the stale clamped value.
    if (level === undefined) {
      if (scoop.config && scoop.config.thinkingLevel !== undefined) {
        const { thinkingLevel: _omit, ...rest } = scoop.config;
        scoop.config = rest;
      }
    } else {
      scoop.config = { ...(scoop.config ?? {}), thinkingLevel: level };
    }

    try {
      await db.saveScoop(scoop);
    } catch (err) {
      log.warn('Failed to persist thinkingLevel', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return applied;
  }

  /** Reload skills on all active scoop contexts (cone + scoops). */
  async reloadAllSkills(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [jid, context] of this.contexts) {
      const tab = this.tabs.get(jid);
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

  /** Stop a specific scoop */
  stopScoop(jid: string): void {
    const context = this.contexts.get(jid);
    if (context) {
      context.stop();
    }
  }

  /** Collect cost data from all active and dropped scoops for the `cost` shell command. */
  getSessionCosts(): ReturnType<ScoopCostTracker['getSessionCosts']> {
    return this.costTracker.getSessionCosts();
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

    for (const jid of this.contexts.keys()) {
      await this.destroyScoopTab(jid);
    }

    // Drop the sudoers live-reload watcher subscription.
    this.sudoManager?.dispose();
    this.sudoManager = null;

    log.info('Orchestrator shutdown');
  }
}
