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
 * Extracted from `Orchestrator` so the lifecycle maps (`tabs`, `contexts`,
 * `scoopObservers`) live next to the methods that mutate them. Everything
 * else — scoop registry, callbacks, memory store, completion service, sudo
 * pieces, idle timers, message router — is reached through
 * {@link ScoopLifecycleDeps}, so this module stays free of orchestrator
 * coupling.
 */

import type { Api, Model } from '@earendil-works/pi-ai';
import { createLogger } from '../core/logger.js';
import type { SessionStore } from '../core/session.js';
import type { ImageContent } from '../core/types.js';
import type { VirtualFS } from '../fs/index.js';
import { RestrictedFS } from '../fs/restricted-fs.js';
import type { ProcessManager } from '../kernel/process-manager.js';
import type { SudoDecision, SudoRequest } from '../sudo/index.js';
import type { SudoManager } from '../sudo/sudo-manager.js';
import { ScoopContext, type ScoopContextCallbacks } from './scoop-context.js';
import { emitScoopLifecycle } from './scoop-telemetry-hook.js';
import type { ChannelMessage, RegisteredScoop, ScoopTabState, ThinkingLevel } from './types.js';

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
    state: 'summarizing' | 'extracting-memory' | 'idle'
  ): void;
  onError(scoopJid: string, error: string): void;
  getBrowserAPI(): ReturnType<ScoopContextCallbacks['getBrowserAPI']>;
  onToolStart?(scoopJid: string, toolName: string, toolInput: unknown): void;
  onToolEnd?(scoopJid: string, toolName: string, result: string, isError: boolean): void;
  onToolUI?(scoopJid: string, toolName: string, requestId: string, html: string): void;
  onToolUIDone?(scoopJid: string, requestId: string): void;
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
  /** Shared VFS (or null before init). */
  getSharedFs(): VirtualFS | null;
  /** Live SessionStore (or null before init). Threaded into every new `ScoopContext`. */
  getSessionStore(): SessionStore | null;
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
    forgetScoop(jid: string, reason: string): void;
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
    appendConeMemory(
      bullets: string,
      meta: {
        source: string;
        model?: Model<Api>;
        apiKey?: string;
        headers?: Record<string, string>;
        signal?: AbortSignal;
      }
    ): Promise<void>;
    enqueueSudoRequest(scoopJid: string, request: SudoRequest): Promise<SudoDecision>;
    resolveActionableLick(
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
    }>;
    listPendingSudoRequests(): ReturnType<NonNullable<ScoopContextCallbacks['onListSudoRequests']>>;
  };
  /** Routes the synthesized cone-facing fatal-error notification through the message router. */
  handleMessage(msg: ChannelMessage): Promise<void>;
}

export class ScoopLifecycleManager {
  private tabs: Map<string, ScoopTabState> = new Map();
  private contexts: Map<string, ScoopContext> = new Map();
  private scoopObservers: Map<string, Set<ScoopObserver>> = new Map();

  constructor(private deps: ScoopLifecycleDeps) {}

  /** Live contexts view. */
  getContexts(): Map<string, ScoopContext> {
    return this.contexts;
  }

  /** Live context for a single jid (or `undefined`). */
  getContext(jid: string): ScoopContext | undefined {
    return this.contexts.get(jid);
  }

  /** Live tab state for a single jid (or `undefined`). */
  getTab(jid: string): ScoopTabState | undefined {
    return this.tabs.get(jid);
  }

  /**
   * Subscribe to events for a single scoop. Returns an unsubscribe function
   * that MUST be called when the caller is done observing — the observer
   * set holds strong references and leaks otherwise.
   */
  observe(jid: string, observer: ScoopObserver): () => void {
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

  private dispatch<K extends keyof ScoopObserver>(
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

  /**
   * Seed (or reload) the per-scoop sudoers file from `ScoopConfig`. Missing
   * file: seed from config. Existing file: reload into the in-memory cache
   * (overwriting on every boot would wipe any "Always" grants added
   * mid-session). Best-effort: a failed seed is logged and the scoop boots
   * with whatever policy is already on disk.
   */
  private async ensureSudoersLoaded(scoop: RegisteredScoop): Promise<void> {
    const sudoManager = this.deps.getSudoManager();
    const sharedFs = this.deps.getSharedFs();
    if (!sudoManager || !sharedFs) return;
    try {
      const path = `/scoops/${scoop.folder}/etc/sudoers`;
      if (await sharedFs.exists(path)) {
        await sudoManager.reloadScoopPolicyByFolder(scoop.folder);
      } else {
        await sudoManager.seedScoopSudoers(scoop.folder, scoop.config);
      }
    } catch (err) {
      log.warn('Failed to seed per-scoop sudoers; continuing with existing policy', {
        folder: scoop.folder,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Create and initialize a scoop context. */
  async createTab(jid: string): Promise<void> {
    const scoop = this.deps.getScoops().get(jid);
    if (!scoop) throw new Error(`Scoop not found: ${jid}`);

    if (this.contexts.has(jid)) {
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
    const fs = scoop.isCone
      ? sharedFs
      : new RestrictedFS(
          sharedFs,
          scoop.config?.writablePaths ? [...scoop.config.writablePaths] : [],
          scoop.config?.visiblePaths ? [...scoop.config.visiblePaths] : [],
          'sudo-delegated'
        );

    if (!scoop.isCone) {
      await this.ensureSudoersLoaded(scoop);
    }

    const contextCallbacks = this.buildContextCallbacks(jid, scoop);

    const coneJid = Array.from(this.deps.getScoops().values()).find((s) => s.isCone)?.jid;
    const context = new ScoopContext(
      scoop,
      contextCallbacks,
      fs,
      this.deps.getSessionStore() ?? undefined,
      sharedFs ?? undefined,
      coneJid,
      this.deps.getProcessManager() ?? undefined,
      this.deps.getSudoManager()
    );

    this.contexts.set(jid, context);
    this.tabs.set(jid, {
      jid,
      contextId,
      status: 'initializing',
      lastActivity: new Date().toISOString(),
    });

    await context.init();

    const initTab = this.tabs.get(jid);
    if (initTab && initTab.status === 'initializing') {
      initTab.status = 'ready';
      this.tabs.set(jid, initTab);
      this.deps.callbacks.onStatusChange(jid, 'ready');
      this.dispatch(jid, 'onStatusChange', 'ready');
    }

    const scoopForTimer = this.deps.getScoops().get(jid);
    if (scoopForTimer && !scoopForTimer.isCone) {
      this.deps.idleTimers.start(jid);
    }

    log.info('Scoop context created', { jid, contextId });
  }

  /** Destroy a scoop context. */
  destroyTab(jid: string): void {
    this.deps.idleTimers.clear(jid);
    const context = this.contexts.get(jid);
    if (context) {
      context.dispose();
      this.contexts.delete(jid);
      this.tabs.delete(jid);
      // Drop any lingering per-scoop observers alongside the context so
      // the shutdown / reset paths (which call us directly, bypassing
      // `unregisterScoop`) also reclaim them.
      this.scoopObservers.delete(jid);
      log.info('Scoop context destroyed', { jid });
    }
  }

  /** Drop the observer set for a scoop. Used by `unregisterScoop`. */
  forgetObservers(jid: string): void {
    this.scoopObservers.delete(jid);
  }

  /** Live tabs view; the message router reads through this. */
  getTabsMap(): Map<string, ScoopTabState> {
    return this.tabs;
  }

  /** Write back a tab record. Used by `sendPrompt` to flip `processing`. */
  setTab(jid: string, tab: ScoopTabState): void {
    this.tabs.set(jid, tab);
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
    const existing = this.tabs.get(jid);
    this.tabs.set(jid, {
      jid,
      contextId: existing?.contextId ?? `scoop-error-${jid}`,
      status: 'error',
      error: message,
      lastActivity: new Date().toISOString(),
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
    for (const [jid, ctx] of this.contexts.entries()) {
      this.deps.idleTimers.clear(jid);
      ctx.stop();
      this.contexts.delete(jid);
    }
  }

  /** Destroy every live context. Used by `shutdown`. */
  async destroyAllTabs(): Promise<void> {
    for (const jid of Array.from(this.contexts.keys())) {
      this.destroyTab(jid);
    }
  }

  /** Wait for a tab to become ready, or timeout. */
  private async waitForTabReady(jid: string, timeoutMs: number = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const tab = this.tabs.get(jid);
      if (!tab) return false;
      if (tab.status === 'ready' || tab.status === 'processing') return true;
      if (tab.status === 'error') return false;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    log.warn('Timed out waiting for tab to become ready', { jid });
    return false;
  }

  /** Send a prompt to a scoop, creating its tab if necessary. */
  async sendPrompt(
    jid: string,
    text: string,
    _senderId: string,
    _senderName: string,
    images: ImageContent[] = []
  ): Promise<void> {
    let context = this.contexts.get(jid);

    if (!context) {
      await this.createTab(jid);
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

    this.deps.idleTimers.clear(jid);

    this.deps.completionService.clearResponse(jid);
    if (tab) {
      tab.status = 'processing';
      tab.lastActivity = new Date().toISOString();
      this.tabs.set(jid, tab);
      this.deps.callbacks.onStatusChange(jid, 'processing');
      this.dispatch(jid, 'onStatusChange', 'processing');
    }

    log.debug('Prompt sent to scoop', { jid, textLength: text.length, imageCount: images.length });

    await context.prompt(text, images);
  }

  /**
   * Register a scoop: persist, add to the live registry, prime its message
   * queue, then create its runtime. On init failure, fully roll back so no
   * half-registered scoop is left behind.
   */
  async register(scoop: RegisteredScoop): Promise<void> {
    const scoops = this.deps.getScoops();
    await this.deps.db.saveScoop(scoop);
    scoops.set(scoop.jid, scoop);
    this.deps.messageRouter.ensureQueue(scoop.jid);
    log.info('Scoop registered', { jid: scoop.jid, name: scoop.name });
    try {
      await this.createTab(scoop.jid);
      // Cones are tracked separately via boot-time `createTab` (not
      // `register`), so this only fires for runtime-spawned sub-scoops.
      if (!scoop.isCone) emitScoopLifecycle('spawn', scoop.folder);
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

  /** Unregister a scoop. Throws if the scoop has active licks (webhooks/cron tasks). */
  async unregister(jid: string): Promise<void> {
    const scoops = this.deps.getScoops();
    const scoop = scoops.get(jid);
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

    this.deps.idleTimers.clear(jid);
    this.destroyTab(jid);
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
    this.scoopObservers.delete(jid);
    this.deps.completionService.forgetScoop(jid, 'unregister');
    const sudoFailed = this.deps.approvalRouter.failScoop(jid);
    if (sudoFailed > 0) {
      log.info('Failed-closed pending sudo requests for unregistered scoop', {
        jid,
        count: sudoFailed,
      });
    }
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

  /** Update the model on every active scoop context. */
  updateModelOnAll(): void {
    for (const context of this.contexts.values()) {
      context.updateModel();
    }
    log.info('Model updated on all active contexts', { contextCount: this.contexts.size });
  }

  /** Reload skills on every ready / processing scoop context. */
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

  /**
   * Update a single scoop's reasoning / thinking level. Mutates the live
   * agent for the next turn AND persists the value into
   * `scoop.config.thinkingLevel` on disk so it survives reloads. Returns
   * the level actually applied after model-aware resolution.
   */
  async setThinkingLevel(
    jid: string,
    level: ThinkingLevel | undefined,
    effortOverride?: string
  ): Promise<ThinkingLevel | null> {
    const scoop = this.deps.getScoops().get(jid);
    if (!scoop) return null;

    const context = this.contexts.get(jid);
    const applied = context ? context.setThinkingLevel(level, effortOverride) : null;

    // Persist the requested level (not the resolved/clamped one): on a
    // model swap later, we want the user's stated preference re-resolved
    // against the new model, not the stale clamped value.
    if (level === undefined) {
      if (scoop.config && scoop.config.thinkingLevel !== undefined) {
        const { thinkingLevel: _omit, effortOverride: _omit2, ...rest } = scoop.config;
        scoop.config = rest;
      }
    } else {
      scoop.config = {
        ...(scoop.config ?? {}),
        thinkingLevel: level,
        effortOverride,
      };
    }

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
   * top-level callbacks; cone-only capabilities (scoop management, memory
   * writes) are gated on `scoop.isCone`.
   */
  private buildContextCallbacks(jid: string, scoop: RegisteredScoop): ScoopContextCallbacks {
    const { callbacks, completionService, cone } = this.deps;
    const scoops = () => this.deps.getScoops();
    return {
      onResponse: (text, isPartial) => {
        if (!scoops().has(jid)) return;

        callbacks.onResponse(jid, text, isPartial);
        this.dispatch(jid, 'onResponse', text, isPartial);
        // Accumulate response text for routing back to cone. Both partial
        // (streaming deltas) and full (non-streaming) variants are buffered
        // since models without streaming emit isPartial=false with the full
        // text.
        if (!scoop.isCone) {
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
        const tab = this.tabs.get(jid);
        if (tab) {
          tab.lastActivity = new Date().toISOString();
          this.tabs.set(jid, tab);
        }
        callbacks.onResponseDone(jid);
      },
      onError: (error) => {
        if (!scoops().has(jid)) return;

        const tab = this.tabs.get(jid);
        if (tab) {
          tab.status = 'error';
          tab.error = error;
          this.tabs.set(jid, tab);
        }
        emitScoopLifecycle('error', scoop.folder, error);
        callbacks.onError(jid, error);
        callbacks.onStatusChange(jid, 'error');
        this.dispatch(jid, 'onError', error);
        this.dispatch(jid, 'onStatusChange', 'error');
      },
      onFatalError: (error) => this.handleFatalError(jid, error),
      onStatusChange: (status) => {
        if (!scoops().has(jid)) return;

        const tab = this.tabs.get(jid);
        if (tab) {
          tab.status = status;
          tab.lastActivity = new Date().toISOString();
          this.tabs.set(jid, tab);
        }
        callbacks.onStatusChange(jid, status);
        this.dispatch(jid, 'onStatusChange', status);

        // When a non-cone scoop finishes, route its response to the cone
        // with a VFS path + preview so the cone can decide how to follow up.
        if (status === 'ready' && !scoop.isCone) {
          void completionService.notifyCompletion(jid);
        }
      },
      onCompactionStateChange: (state) => {
        callbacks.onCompactionStateChange?.(jid, state);
      },
      onToolStart: (toolName, toolInput) => {
        callbacks.onToolStart?.(jid, toolName, toolInput);
      },
      onToolEnd: (toolName, result, isError) => {
        callbacks.onToolEnd?.(jid, toolName, result, isError);
      },
      onToolUI: (toolName, requestId, html) => {
        callbacks.onToolUI?.(jid, toolName, requestId, html);
      },
      onToolUIDone: (requestId) => {
        callbacks.onToolUIDone?.(jid, requestId);
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
      getScoopTabState: scoop.isCone ? (j: string) => this.tabs.get(j) : undefined,
      onFeedScoop: scoop.isCone
        ? (scoopJid, prompt) => cone.delegateToScoop(scoopJid, prompt, scoop.assistantLabel)
        : undefined,
      onScoopScoop: scoop.isCone
        ? async (newScoop) => {
            const fullScoop: RegisteredScoop = {
              ...newScoop,
              jid: `scoop_${newScoop.folder}_${Date.now()}`,
              // Record the creating cone's JID so transcript export can
              // reconstruct the delegation chain. originToolCallId is not
              // available in this path (ToolDefinition has no toolCallId).
              parentJid: scoop.jid,
            };
            await cone.registerScoop(fullScoop);
            return fullScoop;
          }
        : undefined,
      onDropScoop: scoop.isCone
        ? async (scoopJid) => {
            await cone.unregisterScoop(scoopJid);
          }
        : undefined,
      onMuteScoops: scoop.isCone ? (jids) => cone.muteScoops(jids) : undefined,
      onUnmuteScoops: scoop.isCone ? (jids) => cone.unmuteScoops(jids) : undefined,
      onScheduleScoopWait: scoop.isCone
        ? (jids, timeoutMs) => cone.scheduleScoopWait(jids, timeoutMs)
        : undefined,
      getGlobalMemory: () => cone.getGlobalMemory(),
      setGlobalMemory: scoop.isCone ? (content) => cone.setGlobalMemory(content) : undefined,
      appendConeMemory: scoop.isCone
        ? (bullets, meta) => cone.appendConeMemory(bullets, meta)
        : undefined,
      // Sudo escalation wiring — symmetrical to the brokers but exposed as
      // tools. Scoops get `onSudoRequest` (routes through the pending-request
      // registry); the cone gets `onSudoResolve` + `onListSudoRequests` to
      // drain it. The cone keeps the user broker for its own FS / shell gate.
      onSudoRequest: scoop.isCone ? undefined : (request) => cone.enqueueSudoRequest(jid, request),
      onSudoResolve: scoop.isCone
        ? (id, decision) => cone.resolveActionableLick(id, decision)
        : undefined,
      onListSudoRequests: scoop.isCone ? () => cone.listPendingSudoRequests() : undefined,
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

    const tab = this.tabs.get(jid);
    if (tab) {
      tab.status = 'error';
      tab.error = error;
      this.tabs.set(jid, tab);
    }
    this.deps.callbacks.onError(jid, error);
    this.deps.callbacks.onStatusChange(jid, 'error');
    this.dispatch(jid, 'onError', error);
    this.dispatch(jid, 'onStatusChange', 'error');

    if (scoopRecord.isCone) return;

    // Force-unmute, drop any partial response, and release any pending
    // waiters so the error notification reaches the cone and `scoop_wait`
    // callers unblock instead of stalling.
    this.deps.completionService.forgetScoop(jid, 'fatal-error');

    const cone = Array.from(scoops.values()).find((s) => s.isCone);
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
