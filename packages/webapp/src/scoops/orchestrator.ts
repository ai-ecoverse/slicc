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

import {
  CURRENT_SCOOP_CONFIG_VERSION,
  type RegisteredScoop,
  type ChannelMessage,
  type ScoopTabState,
  type ScheduledTask,
} from './types.js';
import * as db from './db.js';
import { createLogger } from '../core/logger.js';
import { ScoopContext, type ScoopContextCallbacks } from './scoop-context.js';
import { TaskScheduler } from './scheduler.js';
import { VirtualFS, FsWatcher } from '../fs/index.js';
import { RestrictedFS } from '../fs/restricted-fs.js';
import type { BrowserAPI } from '../cdp/index.js';
import { createDefaultSharedFiles, createDefaultSkills } from './skills.js';
import { buildActiveLicksError, type LickManager } from './lick-manager.js';
import { SessionStore } from '../core/session.js';
import { trackChatSend } from '../ui/telemetry.js';
import {
  registerSessionCostsProvider,
  type ScoopCostData,
} from '../shell/supplemental-commands/cost-command.js';
import type { AssistantMessage } from '../core/types.js';

const log = createLogger('orchestrator');

/** Time in ms to wait before notifying cone that a scoop hasn't started work. */
export const SCOOP_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const SCOOP_NOTIFICATION_DIR = '/shared/scoop-notifications';
const SCOOP_NOTIFICATION_PREVIEW_CHARS = 1000;

function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\r\n/g, '\n').split('\n').length;
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

export class Orchestrator {
  private scoops: Map<string, RegisteredScoop> = new Map();
  private tabs: Map<string, ScoopTabState> = new Map();
  private contexts: Map<string, ScoopContext> = new Map();
  private messageQueues: Map<string, ChannelMessage[]> = new Map();
  private lastAgentTimestamp: Map<string, string> = new Map();
  private container: HTMLElement;
  private callbacks: OrchestratorCallbacks;
  private config: AssistantConfig;
  private pollInterval: number | null = null;
  private scheduler: TaskScheduler | null = null;
  private globalMemoryCache: string = '';
  private sharedFs: VirtualFS | null = null;
  /** Accumulates response text per scoop for routing back to cone on completion. */
  private scoopResponseBuffer: Map<string, string> = new Map();
  private lickManager: LickManager | null = null;
  private sessionStore: SessionStore | null = null;
  private fsWatcher: FsWatcher | null = null;
  /** Tracks idle timers for scoops that haven't started work after becoming ready. */
  private idleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Preserves cost data for scoops that have been dropped. */
  private droppedScoopCosts: ScoopCostData[] = [];
  /**
   * Per-scoop event observers. The `agent` shell command (`agent-bridge.ts`)
   * uses this to await a sub-scoop's completion without having to own its
   * own `ScoopContext`: it subscribes, calls `sendPrompt`, and watches for
   * status / send_message / error events on the one jid it cares about.
   */
  private scoopObservers: Map<string, Set<ScoopObserver>> = new Map();

  constructor(
    container: HTMLElement,
    callbacks: OrchestratorCallbacks,
    config: AssistantConfig = { name: 'sliccy', triggerPattern: /^@sliccy\b/i }
  ) {
    this.container = container;
    this.callbacks = callbacks;
    this.config = config;
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
    await this.ensureGlobalMemory();

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

  /** Ensure global memory exists with default content */
  private async ensureGlobalMemory(): Promise<void> {
    if (!this.sharedFs) return;

    // Create default shared files (including /shared/CLAUDE.md) from bundled defaults
    await createDefaultSharedFiles(this.sharedFs);

    try {
      const content = await this.sharedFs.readFile('/shared/CLAUDE.md', { encoding: 'utf-8' });
      this.globalMemoryCache =
        typeof content === 'string' ? content : new TextDecoder().decode(content);
    } catch {
      // No global memory file - this shouldn't happen after createDefaultSharedFiles
      log.warn('Global memory file not found after creating defaults');
    }
  }

  /** Get global memory content */
  async getGlobalMemory(): Promise<string> {
    if (this.globalMemoryCache) return this.globalMemoryCache;

    if (this.sharedFs) {
      try {
        const content = await this.sharedFs.readFile('/shared/CLAUDE.md', { encoding: 'utf-8' });
        this.globalMemoryCache =
          typeof content === 'string' ? content : new TextDecoder().decode(content);
      } catch {
        // No global memory yet
      }
    }

    return this.globalMemoryCache;
  }

  /** Update global memory */
  async setGlobalMemory(content: string): Promise<void> {
    if (!this.sharedFs) return;
    await this.sharedFs.writeFile('/shared/CLAUDE.md', content);
    this.globalMemoryCache = content;
    log.info('Global memory updated');
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

  /** Set the LickManager for guarding scoop removal against active licks */
  setLickManager(lickManager: LickManager): void {
    this.lickManager = lickManager;
    (globalThis as any).__slicc_lick_handler = (event: any) => {
      this.lickManager?.emitEvent(event);
    };
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
   * Scoop-completion side effect: forward the scoop's buffered response
   * to the cone as a `scoop-notify` message that points at a VFS file
   * containing the full output, so the cone can decide whether to read
   * the file or act on the preview alone. Always clears the response
   * buffer (bounded memory) regardless of whether a notify was actually
   * sent.
   *
   * Suppressed entirely when `RegisteredScoop.notifyOnComplete === false`.
   * Ephemeral scoops spawned via the `agent` supplemental shell command
   * set that flag because the caller already drains output through an
   * `observeScoop` subscription — the extra cone turn would be both
   * duplicative and billed as a second API call for what the user
   * intended as a self-contained shell invocation.
   *
   * Extracted from the scoop's `onStatusChange` callback so tests can
   * exercise the gate without standing up a full ScoopContext.
   */
  private async maybeNotifyConeOnScoopComplete(jid: string): Promise<void> {
    const scoop = this.scoops.get(jid);
    if (!scoop || scoop.isCone) return;

    const responseText = this.scoopResponseBuffer.get(jid);
    this.scoopResponseBuffer.delete(jid);
    if (!responseText) return;
    if (scoop.notifyOnComplete === false) return;

    const cone = Array.from(this.scoops.values()).find((s) => s.isCone);
    if (!cone) return;

    try {
      const notificationPath = await this.writeScoopCompletionArtifact(scoop, responseText);
      const lineCount = countTextLines(responseText);
      const preview = responseText.slice(0, SCOOP_NOTIFICATION_PREVIEW_CHARS);
      const notifyMsg: ChannelMessage = {
        id: `scoop-done-${jid}-${Date.now()}`,
        chatJid: cone.jid,
        senderId: scoop.folder,
        senderName: scoop.assistantLabel,
        content: this.formatScoopCompletionNotification(
          scoop.assistantLabel,
          notificationPath,
          lineCount,
          preview
        ),
        timestamp: new Date().toISOString(),
        fromAssistant: false,
        channel: 'scoop-notify',
      };
      log.info('Routing scoop completion to cone', {
        scoop: scoop.folder,
        responseLength: responseText.length,
        lineCount,
        notificationPath,
      });
      await this.handleMessage(notifyMsg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to route scoop completion to cone', {
        scoop: scoop.folder,
        error: msg,
      });
      this.callbacks.onError(
        cone.jid,
        `Scoop ${scoop.folder} completed but notification failed: ${msg}`
      );
    }
  }

  private async writeScoopCompletionArtifact(
    scoop: RegisteredScoop,
    responseText: string
  ): Promise<string> {
    if (!this.sharedFs) throw new Error('Shared filesystem not initialized');

    await this.sharedFs.mkdir(SCOOP_NOTIFICATION_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = Math.random().toString(36).slice(2, 8);
    const path = `${SCOOP_NOTIFICATION_DIR}/${timestamp}-${scoop.folder}-${suffix}.md`;
    await this.sharedFs.writeFile(path, responseText);
    return path;
  }

  private formatScoopCompletionNotification(
    assistantLabel: string,
    notificationPath: string,
    lineCount: number,
    preview: string
  ): string {
    return [
      `[@${assistantLabel} completed]`,
      `VFS path: ${notificationPath}`,
      `Total lines: ${lineCount}`,
      `Preview (up to ${SCOOP_NOTIFICATION_PREVIEW_CHARS} chars):`,
      preview,
    ].join('\n');
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
    } catch (err) {
      log.error('Scoop init failed', {
        jid: scoop.jid,
        name: scoop.name,
        error: err instanceof Error ? err.message : String(err),
      });
      // Best-effort rollback — leave no half-registered scoop behind.
      await this.destroyScoopTab(scoop.jid).catch(() => {});
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
    this.snapshotScoopCost(jid);

    this.clearIdleTimer(jid);
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
    this.scoopResponseBuffer.delete(jid);
    // Defensive observer cleanup — subscribers are expected to call their
    // unsubscribe, but if they never get the chance (uncaught exception
    // before `finally`, bridge crash mid-spawn, etc.) the set would
    // otherwise linger and could fire against stale handlers if the jid
    // were ever reused. Dropping the whole key is safe because every
    // legitimate observer for this scoop is about to lose its relevance
    // anyway: the scoop's context has been destroyed.
    this.scoopObservers.delete(jid);
    log.info('Scoop unregistered', { jid });
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
      this.clearIdleTimer(jid);
      ctx.stop();
      this.contexts.delete(jid);
    }
    // Re-create the VFS with wipe: true
    this.sharedFs = await VirtualFS.create({ dbName: 'slicc-fs', wipe: true });
    if (this.fsWatcher) {
      this.sharedFs.setWatcher(this.fsWatcher);
    }
    await this.ensureRootStructure();
    await this.ensureGlobalMemory();
    await createDefaultSkills(this.sharedFs).catch((err) => {
      log.warn('Failed to re-seed default skills', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.droppedScoopCosts = [];
    log.info('Filesystem reset and defaults re-seeded');
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
    this.droppedScoopCosts = [];
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

    // Telemetry: track chat sends
    const scoop = this.scoops.get(message.chatJid);
    const scoopName = scoop?.isCone ? 'cone' : (scoop?.name ?? 'unknown');
    trackChatSend(scoopName, localStorage.getItem('selected-model') ?? 'unknown');

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
    const fs = scoop.isCone
      ? this.sharedFs
      : new RestrictedFS(
          this.sharedFs,
          scoop.config?.writablePaths ? [...scoop.config.writablePaths] : [],
          scoop.config?.visiblePaths ? [...scoop.config.visiblePaths] : []
        );

    // Create the scoop context with full callbacks
    const contextCallbacks: ScoopContextCallbacks = {
      onResponse: (text, isPartial) => {
        if (!this.scoops.has(jid)) return;

        this.callbacks.onResponse(jid, text, isPartial);
        this.dispatchScoopEvent(jid, 'onResponse', text, isPartial);
        // Accumulate response text for routing back to cone.
        // Accumulate both partial (streaming deltas) and full (non-streaming) responses,
        // since models that don't stream emit isPartial=false with the full text.
        if (!scoop.isCone) {
          if (isPartial) {
            const buf = this.scoopResponseBuffer.get(jid) ?? '';
            this.scoopResponseBuffer.set(jid, buf + text);
          } else {
            // Full response — replace buffer (text is the complete output)
            this.scoopResponseBuffer.set(jid, text);
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
        this.callbacks.onError(jid, error);
        this.callbacks.onStatusChange(jid, 'error');
        this.dispatchScoopEvent(jid, 'onError', error);
        this.dispatchScoopEvent(jid, 'onStatusChange', 'error');
      },
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
          void this.maybeNotifyConeOnScoopComplete(jid);
        }
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
      getGlobalMemory: () => this.getGlobalMemory(),
      setGlobalMemory: scoop.isCone ? (content) => this.setGlobalMemory(content) : undefined,
      getBrowserAPI: () => this.callbacks.getBrowserAPI(),
    };

    const context = new ScoopContext(
      scoop,
      contextCallbacks,
      fs,
      this.sessionStore ?? undefined,
      this.sharedFs ?? undefined
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
      this.startIdleTimer(jid);
    }

    log.info('Scoop context created', { jid, contextId });
  }

  /** Destroy a scoop context */
  async destroyScoopTab(jid: string): Promise<void> {
    this.clearIdleTimer(jid);
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
  async sendPrompt(jid: string, text: string, senderId: string, senderName: string): Promise<void> {
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
    this.clearIdleTimer(jid);

    // Update status and clear response buffer for fresh accumulation
    this.scoopResponseBuffer.delete(jid);
    if (tab) {
      tab.status = 'processing';
      tab.lastActivity = new Date().toISOString();
      this.tabs.set(jid, tab);
      this.callbacks.onStatusChange(jid, 'processing');
      this.dispatchScoopEvent(jid, 'onStatusChange', 'processing');
    }

    log.debug('Prompt sent to scoop', { jid, textLength: text.length });

    // Send to the scoop context
    await context.prompt(text);
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
        return `[${time}] ${m.senderName}: ${m.content}`;
      })
      .join('\n');

    // Clear queue and update high-water mark
    this.messageQueues.set(jid, []);

    const lastMsg = messages[messages.length - 1];
    this.lastAgentTimestamp.set(jid, lastMsg.timestamp);
    await db.setState(`lastAgentTs_${jid}`, lastMsg.timestamp);

    await this.sendPrompt(jid, formatted, lastMsg.senderId, lastMsg.senderName);
  }

  /** Start the message polling loop */
  private startMessageLoop(): void {
    if (this.pollInterval) return;

    this.pollInterval = window.setInterval(() => {
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

  /** Build cost data for a single scoop from its context's messages. Returns null if no usage. */
  private buildScoopCost(scoop: RegisteredScoop, context: ScoopContext): ScoopCostData | null {
    const messages = context.getAgentMessages();
    const assistantMsgs = messages.filter((m): m is AssistantMessage => m.role === 'assistant');
    if (assistantMsgs.length === 0) return null;

    const aggregated = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const modelCounts = new Map<string, number>();
    for (const msg of assistantMsgs) {
      aggregated.input += msg.usage.input;
      aggregated.output += msg.usage.output;
      aggregated.cacheRead += msg.usage.cacheRead;
      aggregated.cacheWrite += msg.usage.cacheWrite;
      aggregated.totalTokens += msg.usage.totalTokens;
      aggregated.cost.input += msg.usage.cost.input;
      aggregated.cost.output += msg.usage.cost.output;
      aggregated.cost.cacheRead += msg.usage.cost.cacheRead;
      aggregated.cost.cacheWrite += msg.usage.cost.cacheWrite;
      aggregated.cost.total += msg.usage.cost.total;
      modelCounts.set(msg.model, (modelCounts.get(msg.model) ?? 0) + 1);
    }

    let topModel = '';
    let topCount = 0;
    for (const [model, count] of modelCounts) {
      if (count > topCount) {
        topModel = model;
        topCount = count;
      }
    }

    // Calculate active time based on 15-minute intervals
    const timestamps = assistantMsgs.map((m) => m.timestamp).sort((a, b) => a - b);
    const firstActivity = timestamps[0];
    const lastActivity = timestamps[timestamps.length - 1];

    // Round activity time to 15-minute intervals
    const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
    const timespanMs = lastActivity - firstActivity;
    // Calculate number of 15-minute intervals, rounding up (at least 1 interval if there's any activity)
    const intervals = Math.max(1, Math.ceil(timespanMs / FIFTEEN_MINUTES_MS));
    const activeTimeMs = intervals * FIFTEEN_MINUTES_MS;

    return {
      name: scoop.assistantLabel,
      type: scoop.isCone ? 'cone' : 'scoop',
      model: topModel,
      usage: aggregated,
      turns: assistantMsgs.length,
      firstActivity,
      lastActivity,
      activeTimeMs,
    };
  }

  /** Snapshot a scoop's cost data before it is destroyed. */
  private snapshotScoopCost(jid: string): void {
    const scoop = this.scoops.get(jid);
    const context = this.contexts.get(jid);
    if (!scoop || !context) return;
    const costData = this.buildScoopCost(scoop, context);
    if (costData) {
      this.droppedScoopCosts.push(costData);
    }
  }

  /** Collect cost data from all active and dropped scoops for the `cost` shell command. */
  getSessionCosts(): ScoopCostData[] {
    const results: ScoopCostData[] = [];
    for (const scoop of this.scoops.values()) {
      const context = this.contexts.get(scoop.jid);
      if (!context) continue;
      const costData = this.buildScoopCost(scoop, context);
      if (costData) results.push(costData);
    }
    // Include costs from scoops that were dropped during this session
    results.push(...this.droppedScoopCosts);
    return results;
  }

  /** Start an idle timer for a scoop. If the scoop doesn't start processing within
   *  SCOOP_IDLE_TIMEOUT_MS, send a notification to the cone. */
  private startIdleTimer(jid: string): void {
    this.clearIdleTimer(jid);
    // Guard: don't start if the scoop is already processing (e.g. auto-feed race)
    const currentTab = this.tabs.get(jid);
    if (currentTab?.status === 'processing') return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(jid);
      const scoop = this.scoops.get(jid);
      if (!scoop || scoop.isCone) return;

      // Only notify if still in ready state (never processed)
      const tab = this.tabs.get(jid);
      if (tab?.status !== 'ready') return;

      const cone = Array.from(this.scoops.values()).find((s) => s.isCone);
      if (!cone) return;

      const notifyMsg: ChannelMessage = {
        id: `scoop-idle-${jid}-${Date.now()}`,
        chatJid: cone.jid,
        senderId: scoop.folder,
        senderName: scoop.assistantLabel,
        content: `[@${scoop.assistantLabel} idle]: Scoop "${scoop.name}" has been ready for 2 minutes without receiving any work. This is expected if the scoop is waiting for webhooks or cron tasks. If you intended to delegate work, use feed_scoop to send a prompt.`,
        timestamp: new Date().toISOString(),
        fromAssistant: false,
        channel: 'scoop-idle',
      };
      log.info('Scoop idle timeout', { jid, scoop: scoop.folder });
      this.handleMessage(notifyMsg).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Failed to send idle notification', { jid, error: msg });
      });
    }, SCOOP_IDLE_TIMEOUT_MS);
    this.idleTimers.set(jid, timer);
  }

  /** Clear an idle timer for a scoop. */
  private clearIdleTimer(jid: string): void {
    const timer = this.idleTimers.get(jid);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(jid);
    }
  }

  /** Cleanup */
  async shutdown(): Promise<void> {
    this.stopMessageLoop();

    // Clear all idle timers
    for (const jid of this.idleTimers.keys()) {
      this.clearIdleTimer(jid);
    }

    // Stop the scheduler
    this.scheduler?.stop();
    this.scheduler = null;

    for (const jid of this.contexts.keys()) {
      await this.destroyScoopTab(jid);
    }

    log.info('Orchestrator shutdown');
  }
}
