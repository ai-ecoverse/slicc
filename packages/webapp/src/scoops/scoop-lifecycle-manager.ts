/**
 * ScoopLifecycleManager - owns the per-scoop tab/context lifecycle.
 *
 * Specifically: tab + context creation (`createTab`), destruction
 * (`destroyTab`), the per-scoop sudoers seed/reload (`ensureSudoersLoaded`),
 * the {@link ScoopContextCallbacks} factory wired into every new context, the
 * per-scoop observer subscription (`observe` + `dispatch`), and the
 * "unrecoverable scoop failure" handler that escalates a fatal error to the
 * cone (`handleFatalError`).
 *
 * Since #1666 (Phase 2) the manager is a host of {@link LiveWorkUnit}s: one
 * `Map<jid, LiveWorkUnit>` owns each scoop's context, tab record and
 * observers, and `getContexts()` / `getTabsMap()` are derived views kept for
 * the message router, cost tracker and idle timers. `LiveWorkUnit.close()` is
 * the single teardown path. Everything
 * else — scoop registry, callbacks, memory store, completion service, sudo
 * pieces, idle timers, message router — is reached through
 * {@link ScoopLifecycleDeps}, so this module stays free of orchestrator
 * coupling.
 */

import type { ToolProgressEvent } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { SessionStore } from '../core/session.js';
import type { ImageContent } from '../core/types.js';
import type { VirtualFS } from '../fs/index.js';
import { RestrictedFS } from '../fs/restricted-fs.js';
import type { ProcessManager } from '../kernel/process-manager.js';
import type { SudoDecision, SudoRequest } from '../sudo/index.js';
import type { SudoManager } from '../sudo/sudo-manager.js';
import type { TurnGuestGate } from '../sudo/types.js';
import { conversationKeyFor } from '../work-unit/conversation/key.js';
import type { WorkUnitConversationStore } from '../work-unit/conversation/store.js';
import { toDescriptor, workspaceFor } from '../work-unit/descriptor.js';
import { LiveWorkUnit } from '../work-unit/live-unit.js';
import { assertChildPolicyAllowed, isRootUnit, rootOwnerOf, rootsOf } from '../work-unit/policy.js';
import {
  modelFor,
  modelIdFor,
  normalizeScoopRecord,
  setUnitModel,
  setUnitThinking,
  uniqueFolder,
} from '../work-unit/record.js';
import type { AppendConeMemoryMeta } from './cone-memory-store.js';
import { globalSeedModel } from './model-seed.js';
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

/**
 * Per-scoop event observer. Subscribed via {@link ScoopLifecycleManager.observe}
 * so a caller can react to events on a single scoop's lifecycle. Used by the
 * `agent` shell command's bridge to block a bash invocation until a spawned
 * sub-scoop reaches terminal status and to capture the scoop's `send_message`
 * payloads along the way.
 */
export interface ScoopObserver {
  onStatusChange?: (status: ScoopTabState['status']) => void;
  onSendMessage?: (text: string) => void;
  onResponse?: (text: string, isPartial: boolean) => void;
  onError?: (error: string) => void;
}

/**
 * Top-level orchestrator-callback surface the lifecycle manager fans events
 * out to. Matches the relevant subset of `OrchestratorCallbacks`; kept as its
 * own type so this module doesn't pull in the orchestrator's public API.
 */
export interface ScoopLifecycleCallbacks {
  onResponse(scoopJid: string, text: string, isPartial: boolean): void;
  onResponseDone(scoopJid: string): void;
  onSendMessage(targetJid: string, text: string): void;
  onStatusChange(scoopJid: string, status: ScoopTabState['status']): void;
  onCompactionStateChange?(
    scoopJid: string,
    state: 'summarizing' | 'extracting-memory' | 'fallback' | 'idle'
  ): void;
  onError(scoopJid: string, error: string): void;
  getBrowserAPI(): ReturnType<ScoopContextCallbacks['getBrowserAPI']>;
  onToolStart?(scoopJid: string, toolName: string, toolInput: unknown, toolCallId?: string): void;
  onToolEnd?(
    scoopJid: string,
    toolName: string,
    result: string,
    isError: boolean,
    toolCallId?: string
  ): void;
  /**
   * `scoopJid` is the ORIGIN (stream identity); `displayScoopJid` is where the
   * card is rendered when that differs — the owning cone (#2312).
   */
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
  /** Live snapshot of registered scoops. */
  getScoops(): Map<string, RegisteredScoop>;
  /**
   * The unit an interactive request from `jid` is shown to — the root that
   * owns it, or `jid` itself when it IS a root (#2312). Same rule as
   * `findApprover`: a dangling edge falls back to the default root, so a
   * prompt always lands somewhere a user can answer it.
   */
  approverFor(jid: string): RegisteredScoop | undefined;
  /** Shared VFS (or null before init). */
  getSharedFs(): VirtualFS | null;
  /** Live SessionStore (or null before init). Threaded into every new `ScoopContext`. */
  getSessionStore(): SessionStore | null;
  /**
   * Canonical conversation store (#2275), or null before init / on a float
   * that persists nothing. Threaded into every new `ScoopContext` beside the
   * legacy session store — both are written while the migration window is
   * open.
   */
  getConversationStore(): WorkUnitConversationStore | null;
  /** Live ProcessManager (or null when unwired). Threaded into every new `ScoopContext`. */
  getProcessManager(): ProcessManager | null;
  /** Live SudoManager — used for sudoers seeding and threaded into every new `ScoopContext`. */
  getSudoManager(): SudoManager | null;
  /** Top-level orchestrator-callback surface. */
  callbacks: ScoopLifecycleCallbacks;
  /** Idle-timer ops — armed on every `ready` transition for non-cone scoops, cleared on destroy. */
  idleTimers: { start(jid: string): void; clear(jid: string): void };
  /** Completion-service hooks called from inside the callback factory + fatal-error path. */
  completionService: {
    appendResponseChunk(jid: string, chunk: string): void;
    setResponseFull(jid: string, text: string): void;
    notifyCompletion(jid: string): Promise<void> | void;
    forgetScoop(jid: string, reason: 'unregister' | 'fatal-error' | 'close'): void;
    clearResponse(jid: string): void;
  };
  /** Persistent storage for scoop records. Threaded so tests can stub. */
  db: ScoopLifecycleDb;
  /** Resolves the active lick manager (or null when unset) for the active-licks unregister guard. */
  getLickManager(): ScoopLifecycleLickGuard | null;
  /** Builds the error thrown when `unregisterScoop` finds active licks. */
  buildActiveLicksError(
    folder: string,
    webhooks: ReadonlyArray<unknown>,
    cronTasks: ReadonlyArray<unknown>
  ): Error | null;
  /** Per-scoop message-queue + high-water-mark housekeeping. */
  messageRouter: {
    ensureQueue(jid: string): void;
    forgetScoop(jid: string): void;
    flushOnIdle(jid: string): Promise<void>;
  };
  /** Cost-tracker snapshot taken before destroying a scoop's context. */
  costTracker: { snapshot(jid: string): void };
  /** Sudo-approval router — fails-closed pending requests when a scoop is dropped. */
  approvalRouter: { failScoop(jid: string): number };
  /** Cone surface — every cone-only `ScoopContext` callback delegates through these. */
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
      timeoutMs?: number
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
  /** Routes the synthesized cone-facing fatal-error notification through the message router. */
  handleMessage(msg: ChannelMessage): Promise<void>;
}

export class ScoopLifecycleManager {
  /** One owning runtime per scoop jid (#1666). */
  private units: Map<string, LiveWorkUnit> = new Map();

  constructor(private deps: ScoopLifecycleDeps) {}

  /** The live unit for `jid`, or `undefined` when none has been spawned or observed. */
  getUnit(jid: string): LiveWorkUnit | undefined {
    return this.units.get(jid);
  }

  /**
   * Get-or-create the unit record for `jid`. A unit can exist before its
   * context (an observer subscribed ahead of spawn, a boot-time error tab,
   * or a restored record nobody has fed yet) — it simply has no `context` /
   * `tab` yet. Public since #2279: `WorkUnitManager` reaches every
   * registered record through it, there being no adapter left to stand in
   * for a unit that has not spawned.
   */
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

  /**
   * Live contexts view. A per-call snapshot derived from the units — hold the
   * result for the duration of a loop rather than re-reading it per item.
   */
  getContexts(): Map<string, ScoopContext> {
    const out = new Map<string, ScoopContext>();
    for (const [jid, unit] of this.units) {
      if (unit.context) out.set(jid, unit.context as ScoopContext);
    }
    return out;
  }

  /** Live context for a single jid (or `undefined`). */
  getContext(jid: string): ScoopContext | undefined {
    return (this.units.get(jid)?.context as ScoopContext | null | undefined) ?? undefined;
  }

  /** Synchronize live read ACLs after a global or per-scoop policy reload. */
  syncReadGrants(folder?: string): void {
    for (const scoop of this.deps.getScoops().values()) {
      if (folder !== undefined && scoop.folder !== folder) continue;
      // `applyPolicyReadGrants` is a no-op for a full-workspace unit.
      const fs = this.getContext(scoop.jid)?.getFS();
      this.applyPolicyReadGrants(scoop, fs);
    }
  }

  /** Live tab state for a single jid (or `undefined`). */
  getTab(jid: string): ScoopTabState | undefined {
    return this.units.get(jid)?.tab ?? undefined;
  }

  /**
   * Subscribe to events for a single scoop. Returns an unsubscribe function
   * that MUST be called when the caller is done observing — the observer
   * set holds strong references and leaks otherwise.
   */
  observe(jid: string, observer: ScoopObserver): () => void {
    return this.ensureUnit(jid).observe(observer);
  }

  /**
   * Where an interactive request from `jid` is DISPLAYED, when that differs
   * from where it came from — the owning cone for a scoop (#2312).
   * `undefined` for a root (it answers for itself) and whenever nothing is
   * registered, so the card falls back to rendering at its origin rather than
   * being routed into the void.
   */
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

  /**
   * The unit that owns `scoop`, falling back to the default (oldest) root
   * when the recorded parent is gone — a delegated result must land
   * somewhere a user can see it.
   */
  private parentOf(scoop: RegisteredScoop): RegisteredScoop | undefined {
    const scoops = this.deps.getScoops();
    const parent = scoop.parentJid === null ? undefined : scoops.get(scoop.parentJid);
    return parent ?? rootsOf(scoops.values())[0];
  }

  /** The owning root of `scoop` (itself for a root), walking `parentJid`. */
  private rootOf(scoop: RegisteredScoop): RegisteredScoop | undefined {
    const scoops = this.deps.getScoops();
    return rootOwnerOf(scoops.values(), scoop) ?? rootsOf(scoops.values())[0];
  }

  /**
   * Initialize the scoop's sudo policy (#2416): config-derived grants are
   * registered synchronously in memory (authoritative — a stale on-disk file,
   * folder reuse, or a reload race can neither withhold a configured
   * `writablePaths` entry nor retain authority a replacement config revoked),
   * and the on-disk Always-grants file is loaded (legacy generated files are
   * discarded fail-closed). Best-effort: a failure is logged and the scoop
   * boots with whatever policy is already cached.
   */
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

  /** Replace dynamic read ACLs from the scoop's current effective policy. */
  private applyPolicyReadGrants(
    scoop: RegisteredScoop,
    fs: VirtualFS | RestrictedFS | null | undefined
  ): void {
    if (!(fs instanceof RestrictedFS)) return;
    const policy = this.deps.getSudoManager()?.getPolicyForScoop(scoop.folder);
    if (!policy) return;
    fs.setReadGrants(policy.read.filter((rule) => rule.nopasswd).map((rule) => rule.pattern));
  }

  /** Create and initialize a scoop context. */
  async createTab(jid: string): Promise<void> {
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

    // Cone gets unrestricted access; non-cone scoops use a RestrictedFS whose
    // read-only and read-write prefixes come straight from config (pure
    // replace — defaults live in `scoop_scoop` and in the restore backfill,
    // not here). `writeEnforcement: 'sudo-delegated'` lets the outer SudoFS
    // escalate out-of-sandbox writes to the cone instead of dying here with
    // EACCES. Reads stay silently filtered (ENOENT/[]). The symlink-escape
    // EACCES in RestrictedFS stays active in both modes — a
    // `/scoops/<f>/escape` symlink to `/etc/sudoers` is a security
    // invariant, not a policy choice.
    const unitDescriptor = toDescriptor(scoop);
    const fsPolicy = unitDescriptor.policy.filesystem;
    const fs =
      fsPolicy.kind === 'full-workspace'
        ? sharedFs
        : new RestrictedFS(
            sharedFs,
            [...fsPolicy.writablePaths],
            [...fsPolicy.visiblePaths],
            'sudo-delegated'
          );

    if (fsPolicy.kind === 'restricted') {
      await this.ensureSudoersLoaded(scoop);
      this.applyPolicyReadGrants(scoop, fs);
    }

    const contextCallbacks = this.buildContextCallbacks(jid, scoop);

    // Session-id anchor: the owning root of this unit (itself for a root).
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
      this.deps.getConversationStore()
    );

    unit.attachContext(context, contextId);

    await context.init();

    if (unit.tab?.status === 'initializing' && unit.transition('ready')) {
      this.deps.callbacks.onStatusChange(jid, 'ready');
      this.dispatch(jid, 'onStatusChange', 'ready');
      // Probe persisted messages when context init did not emit its own ready
      // callback (for example, a rehydrated idle scoop).
      void Promise.resolve()
        .then(() => this.deps.messageRouter.flushOnIdle(jid))
        .catch((err) => {
          log.warn('Initial idle queue probe failed', {
            jid,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    // The "no work received yet" notifier only makes sense for a delegated
    // unit — somebody is expected to feed it.
    const scoopForTimer = this.deps.getScoops().get(jid);
    if (scoopForTimer && scoopForTimer.parentJid !== null) {
      this.deps.idleTimers.start(jid);
    }

    log.info('Scoop context created', { jid, contextId });
  }

  /** Destroy a scoop context. */
  destroyTab(jid: string): void {
    this.deps.idleTimers.clear(jid);
    const unit = this.units.get(jid);
    if (!unit) return;
    // `teardown()` is the single runtime teardown: stops the turn, disposes
    // the context (realm workers + shell processes), drops observers and
    // releases any `scoop_wait` caller. Shutdown / reset / rollback paths
    // that bypass `unregister` reclaim everything the same way.
    void unit.teardown();
    this.units.delete(jid);
    log.info('Scoop context destroyed', { jid });
  }

  /** Live tabs view. A per-call snapshot, like {@link getContexts}. */
  getTabsMap(): Map<string, ScoopTabState> {
    const out = new Map<string, ScoopTabState>();
    for (const [jid, unit] of this.units) {
      if (unit.tab) out.set(jid, unit.tab);
    }
    return out;
  }

  /**
   * Mark a scoop's tab as errored without a live context. Used by the boot
   * resilience path in `Orchestrator.init()`: a scoop whose context init threw
   * (e.g. a corrupt persisted VFS file) is left with a `{ status: 'error' }`
   * tab so the existing `routeToScoop` retry-on-error path can re-init it on a
   * later `feed_scoop`/lick delivery, and `drop_scoop` still works — instead of
   * a silent no-tab (or stuck `'initializing'`) entry that can never recover.
   */
  markTabError(jid: string, message: string): void {
    const unit = this.ensureUnit(jid);
    unit.transition('error', {
      contextId: unit.tab?.contextId ?? `scoop-error-${jid}`,
      error: message,
    });
  }

  /** Public dispatch — used by `sendPrompt` to fan a status change to observers. */
  dispatchEvent<K extends keyof ScoopObserver>(
    jid: string,
    event: K,
    ...args: Parameters<NonNullable<ScoopObserver[K]>>
  ): void {
    this.dispatch(jid, event, ...args);
  }

  /**
   * Stop every live context and drop it from the registry, without firing
   * the normal `destroyTab` dispose path. Used by `resetFilesystem` — the
   * contexts hold references to the old VFS and must be torn down before
   * the new VFS is swapped in.
   */
  stopAndClearAllContexts(): void {
    for (const unit of this.units.values()) {
      unit.detachContext();
    }
  }

  /** Destroy every live context. Used by `shutdown`. */
  async destroyAllTabs(): Promise<void> {
    for (const jid of Array.from(this.units.keys())) {
      this.destroyTab(jid);
    }
  }

  /** Wait for a tab to become ready, or timeout. */
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

  /**
   * Send a prompt to a scoop, creating its tab if necessary. `options.steer`
   * asks the context to interrupt a running turn with this prompt rather than
   * queue it behind the turn (see `ScoopContext.prompt`).
   */
  async sendPrompt(
    jid: string,
    text: string,
    _senderId: string,
    _senderName: string,
    images: ImageContent[] = [],
    options?: { steer?: boolean; guestGates?: TurnGuestGate[] }
  ): Promise<void> {
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

  /**
   * Register a scoop: persist, add to the live registry, prime its message
   * queue, then create its runtime. On init failure, fully roll back so no
   * half-registered scoop is left behind.
   */
  async register(scoop: RegisteredScoop): Promise<void> {
    const scoops = this.deps.getScoops();
    normalizeScoopRecord(scoop);
    this.inheritModel(scoop);
    // Claim the folder and the registry slot synchronously, BEFORE the first
    // await. `scoop_scoop` already picks a free folder, but two cones creating
    // the same name concurrently would both pass that check while the first
    // record is still inside `saveScoop` — and land in one shared
    // `/scoops/<folder>/` sandbox (#2360). This is the critical section: the
    // roster read and the insert happen in one synchronous run.
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
      // Release the claim: a record that could not be persisted must not
      // linger in the live roster holding its folder.
      scoops.delete(scoop.jid);
      throw err;
    }
    this.deps.messageRouter.ensureQueue(scoop.jid);
    log.info('Scoop registered', { jid: scoop.jid, name: scoop.name });
    try {
      await this.createTab(scoop.jid);
      // Cones are tracked separately via boot-time `createTab` (not
      // `register`), so this only fires for runtime-spawned sub-scoops.
      if (scoop.parentJid !== null) emitScoopLifecycle('spawn', scoop.folder);
    } catch (err) {
      log.error('Scoop init failed', {
        jid: scoop.jid,
        name: scoop.name,
        error: err instanceof Error ? err.message : String(err),
      });
      // Best-effort rollback — leave no half-registered scoop behind.
      // destroyTab is synchronous and is not expected to throw, but guard
      // it anyway: a thrown rollback must not mask the init error.
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
  }

  /**
   * Stamp a new unit's model (#2310) when its creator didn't pass one:
   *
   * - a scoop COPIES its creating unit's model, once, at creation. It is
   *   never retargeted afterwards — a later model change on the cone leaves
   *   every scoop it already spawned exactly where it was.
   * - a root with no creator model (the very first cone of a profile) is
   *   seeded from the global `selected-model` setting, the last job that
   *   setting has.
   *
   * A record that already names a model — including a legacy provider-less
   * `config.modelId` pin — is left alone.
   */
  private inheritModel(scoop: RegisteredScoop): void {
    if (modelIdFor(scoop)) return;
    const parent = scoop.parentJid ? this.deps.getScoops().get(scoop.parentJid) : undefined;
    const model = (parent ? modelFor(parent) : undefined) ?? globalSeedModel();
    if (model) setUnitModel(scoop, model);
  }

  /** Unregister a scoop. Throws if the scoop has active licks (webhooks/cron tasks). */
  async unregister(jid: string): Promise<void> {
    const scoops = this.deps.getScoops();
    const scoop = scoops.get(jid);
    // The last root is never unregistered: every delegated result, lick and
    // approval needs a user-facing unit to land on. Deepest backstop — the
    // panel and the bridge refuse this earlier.
    if (scoop && scoop.parentJid === null && rootsOf(scoops.values()).length <= 1) {
      throw new Error('Cannot drop the last cone');
    }
    const lickManager = this.deps.getLickManager();
    if (scoop && lickManager) {
      // Consult persisted (IndexedDB) lick state — a lick that exists on disk
      // but was never loaded into this worker's in-memory maps must still
      // block the drop, otherwise it becomes a zombie after reload.
      const { webhooks, cronTasks } = await lickManager.getLicksForScoopFromDb(
        scoop.name,
        scoop.folder
      );
      const err = this.deps.buildActiveLicksError(scoop.folder, webhooks, cronTasks);
      if (err) throw err;
    }

    this.deps.costTracker.snapshot(jid);

    // Auto-cleanup any `browser.websocket` subscribers owned by this scoop —
    // keeps the page-side router from forwarding into a dead sink.
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
    // Forget the canonical record too — a dropped unit's conversation is
    // gone from every store, not just the legacy one (#2275).
    if (scoop) void this.deps.getConversationStore()?.delete(conversationKeyFor(scoop));
    this.deps
      .getSessionStore()
      ?.delete(jid)
      .catch((err) => {
        log.warn('Failed to delete agent session', {
          jid,
          error: err instanceof Error ? err.message : String(err),
        });
      });
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
    // Evict the folder's cached sudo policies AFTER pending requests are
    // failed closed — repeated one-shot agents would otherwise grow the
    // per-folder maps for the orchestrator's lifetime (#2455 review).
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
  }

  /**
   * Set ONE unit's model (#2310): persist it on that unit's record and
   * re-resolve its running agent. No other unit is touched — there is no
   * global picker, so changing the selected cone's model can never retarget
   * its scoops or another cone.
   *
   * Returns `false` when the jid is unknown.
   */
  async setModel(jid: string, model: WorkUnitModel | undefined): Promise<boolean> {
    const scoop = this.deps.getScoops().get(jid);
    if (!scoop) return false;
    const previous = scoop.model;
    setUnitModel(scoop, model);
    this.getContext(jid)?.updateModel();
    try {
      await this.deps.db.saveScoop(scoop);
    } catch (err) {
      // A model that never reached disk is not a per-cone choice — it would
      // silently revert on the next reload while the panel (and any follower)
      // showed it as applied. Roll the live unit back and report failure.
      setUnitModel(scoop, previous);
      this.getContext(jid)?.updateModel();
      log.warn('Failed to persist unit model; rolled back', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    return true;
  }

  /**
   * Re-resolve every active context's model against ITS OWN record (#2310).
   * Not a global model change — the provider catalogue moved (an account was
   * added, a token re-issued), so each unit re-reads the model it already
   * has.
   */
  refreshModels(): void {
    const contexts = this.getContexts();
    for (const context of contexts.values()) {
      context.updateModel();
    }
    log.info('Models re-resolved on all active contexts', { contextCount: contexts.size });
  }

  /** Reload skills on every ready / processing scoop context. */
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

  /**
   * Update a single scoop's reasoning / thinking level. Mutates the live
   * agent for the next turn AND persists the value into
   * `scoop.thinking` on disk so it survives reloads. Returns
   * the level actually applied after model-aware resolution.
   */
  async setThinkingLevel(
    jid: string,
    level: ThinkingLevel | undefined,
    effortOverride?: string
  ): Promise<ThinkingLevel | null> {
    const scoop = this.deps.getScoops().get(jid);
    if (!scoop) return null;

    const context = this.getContext(jid);
    const applied = context ? context.setThinkingLevel(level, effortOverride) : null;

    // Persist the requested level (not the resolved/clamped one) on the
    // record, next to the unit's model (#2310): on a model swap later, we
    // want the user's stated preference re-resolved against the new model,
    // not the stale clamped value.
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

  /**
   * Build the {@link ScoopContextCallbacks} wired into a scoop's context by
   * {@link createTab}. Mostly thin per-scoop adapters over the orchestrator's
   * top-level callbacks; privileged capabilities (child management, shared
   * memory writes, approval resolution) are gated on the unit's policy.
   */
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
        // Accumulate response text for routing back to cone. Both partial
        // (streaming deltas) and full (non-streaming) variants are buffered
        // since models without streaming emit isPartial=false with the full
        // text.
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

        // Per-turn callback — DON'T set tab to 'ready' here.
        // The tab stays 'processing' until prompt() resolves (setStatus('ready') in finally).
        // This prevents the message queue from dequeuing during multi-turn.
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

        // When a non-cone scoop finishes, route its response to the cone
        // with a VFS path + preview so the cone can decide how to follow up.
        if (status === 'ready' && reportsToParent) {
          void completionService.notifyCompletion(jid);
        }
      },
      onCompactionStateChange: (state) => {
        callbacks.onCompactionStateChange?.(jid, state);
      },
      onToolStart: (toolName, toolInput, toolCallId) => {
        callbacks.onToolStart?.(jid, toolName, toolInput, toolCallId);
      },
      onToolEnd: (toolName, result, isError, toolCallId) => {
        callbacks.onToolEnd?.(jid, toolName, result, isError, toolCallId);
      },
      // `tool_ui` is an interactive approval / picker card, so it is rendered
      // in the transcript of the unit that can ANSWER it — the owning cone for
      // a scoop, itself for a cone (#2312). The reply travels back by
      // `requestId` alone (`ToolUIActionMsg`), so the pending promise still
      // settles in the scoop that raised it.
      //
      // The originating jid stays FIRST and unchanged: it is the stream
      // identity the rest of the pipeline keys on, and this scoop's own
      // `response_done` / `turn_end` still carry it. The owner rides along as
      // a separate DISPLAY target (`undefined` when it is the scoop itself,
      // i.e. a root) — see `AgentEventMsg.displayScoopJid`.
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
        // Observer gets the raw payload (not the sender-prefixed form) so the
        // `agent` shell command can surface the scoop's send_message text
        // verbatim for stdout.
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
              // Record the creating unit's JID so transcript export can
              // reconstruct the delegation chain. originToolCallId is not
              // available in this path (ToolDefinition has no toolCallId).
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
        ? (jids, timeoutMs) => cone.scheduleScoopWait(jids, timeoutMs)
        : undefined,
      getGlobalMemory: () => cone.getGlobalMemory(),
      setGlobalMemory: policy.canWriteSharedMemory
        ? (content) => cone.setGlobalMemory(content)
        : undefined,
      // The memory file is bound HERE, from the unit's own record — not taken
      // from the caller's meta — so an extra cone's compaction pass can only
      // ever append to its own `CLAUDE.md` (#2271).
      appendConeMemory: policy.canWriteSharedMemory
        ? (bullets, meta) =>
            cone.appendConeMemory(bullets, {
              ...meta,
              memoryPath: workspaceFor(scoop).memoryPath,
            })
        : undefined,
      // Sudo escalation wiring — symmetrical to the brokers but exposed as
      // tools. Scoops get `onSudoRequest` (routes through the pending-request
      // registry); the cone gets `onSudoResolve` + `onListSudoRequests` to
      // drain it. The cone keeps the user broker for its own FS / shell gate.
      onSudoRequest:
        policy.approvalAuthority === 'user'
          ? undefined
          : (request) => cone.enqueueSudoRequest(jid, request),
      // The gate for tool calls in a guest-caused turn. Routed by the DIRECTIVE
      // on the request: a seat gated on the cone or a delegated scoop goes to
      // the approval registry, everything else to the owner's own broker (which
      // is also where the never-persist guard for guest kinds lives).
      approveGuestToolCall: (request) => cone.approveDirectedOrUser(request),
      // A DELEGATED approver is scoped to what was routed to it; a root stays
      // unrestricted (`undefined` = no filter), which is the behaviour cones
      // have always had. Without the scope, marking a scoop as an approver
      // handed it every cone's pending requests to read and settle.
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

  /**
   * Handle an unrecoverable scoop failure (invalid model, auth failure,
   * exhausted retries). Fatal errors bypass mute and always notify the
   * cone immediately so the user is aware the scoop died.
   */
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

    // An interactive root reports to the user directly; a delegated unit
    // escalates to whoever owns it.
    if (toDescriptor(scoopRecord).completion.mode === 'interactive') return;

    // Force-unmute, drop any partial response, and release any pending
    // waiters so the error notification reaches the parent and `scoop_wait`
    // callers unblock instead of stalling.
    this.deps.completionService.forgetScoop(jid, 'fatal-error');

    const cone = this.parentOf(scoopRecord);
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

    try {
      this.deps.callbacks.onIncomingMessage?.(cone.jid, notifyMsg);
    } catch (err) {
      log.warn('onIncomingMessage for scoop-error threw', {
        scoop: scoopRecord.folder,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.deps.handleMessage(notifyMsg).catch((err) => {
      log.error('Failed to route fatal error to cone', {
        scoop: scoopRecord.folder,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
