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

import type { RegisteredScoop, ChannelMessage, ScoopTabState, ScheduledTask } from './types.js';
import * as db from './db.js';
import { createLogger } from '../core/logger.js';
import { ScoopContext, type ScoopContextCallbacks } from './scoop-context.js';
import { TaskScheduler } from './scheduler.js';
import { VirtualFS } from '../fs/index.js';
import { RestrictedFS } from '../fs/restricted-fs.js';
import type { BrowserAPI } from '../cdp/index.js';
import { createDefaultSharedFiles, createDefaultSkills } from './skills.js';
import { buildActiveLicksError, type LickManager } from './lick-manager.js';
import { SessionStore } from '../core/session.js';
import { trackChatSend } from '../ui/telemetry.js';

const log = createLogger('orchestrator');

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
    await this.ensureRootStructure();

    const savedScoops = await db.getAllScoops();

    for (const scoop of Object.values(savedScoops)) {
      // Sanitize legacy cone records (may have trigger: '@Andy' from old groups code)
      if (scoop.isCone) {
        scoop.trigger = undefined;
        scoop.requiresTrigger = false;
        scoop.assistantLabel = scoop.assistantLabel || 'sliccy';
      }
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

    // Start polling for pending messages
    this.startMessageLoop();
  }

  /** Ensure root directory structure exists on the shared FS */
  private async ensureRootStructure(): Promise<void> {
    if (!this.sharedFs) return;
    const dirs = ['/workspace', '/shared', '/scoops', '/home', '/tmp'];
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

  /** Set the LickManager for guarding scoop removal against active licks */
  setLickManager(lickManager: LickManager): void {
    this.lickManager = lickManager;
  }

  /** Register a new scoop. Initialization is non-blocking — the scoop
   *  starts as 'initializing' and becomes 'ready' in the background.
   *  `sendPrompt` already handles this by waiting for 'ready' status. */
  async registerScoop(scoop: RegisteredScoop): Promise<void> {
    await db.saveScoop(scoop);
    this.scoops.set(scoop.jid, scoop);
    this.messageQueues.set(scoop.jid, []);
    log.info('Scoop registered', { jid: scoop.jid, name: scoop.name });

    // Fire-and-forget: init runs in background. sendPrompt waits if needed.
    this.createScoopTab(scoop.jid).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Scoop init failed', { jid: scoop.jid, error: msg });
    });
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
      ctx.stop();
      this.contexts.delete(jid);
    }
    // Re-create the VFS with wipe: true
    this.sharedFs = await VirtualFS.create({ dbName: 'slicc-fs', wipe: true });
    await this.ensureRootStructure();
    await this.ensureGlobalMemory();
    await createDefaultSkills(this.sharedFs).catch((err) => {
      log.warn('Failed to re-seed default skills', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
    // Bypass trigger check for lick messages (webhook/cron - they're explicitly routed to this scoop)
    const isLick = message.channel === 'webhook' || message.channel === 'cron';
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

    // Create the appropriate filesystem for this scoop
    const fs = scoop.isCone
      ? this.sharedFs // Cone gets unrestricted access
      : new RestrictedFS(this.sharedFs, [`/scoops/${scoop.folder}/`, '/shared/']);

    // Create the scoop context with full callbacks
    const contextCallbacks: ScoopContextCallbacks = {
      onResponse: (text, isPartial) => {
        this.callbacks.onResponse(jid, text, isPartial);
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
        const tab = this.tabs.get(jid);
        if (tab) {
          tab.status = 'error';
          tab.error = error;
          this.tabs.set(jid, tab);
        }
        this.callbacks.onError(jid, error);
        this.callbacks.onStatusChange(jid, 'error');
      },
      onStatusChange: (status) => {
        const tab = this.tabs.get(jid);
        if (tab) {
          tab.status = status;
          tab.lastActivity = new Date().toISOString();
          this.tabs.set(jid, tab);
        }
        this.callbacks.onStatusChange(jid, status);

        // When a non-cone scoop finishes, route its response to the cone
        // so the cone's agent can react (e.g., move files, report to user).
        if (status === 'ready' && !scoop.isCone) {
          const responseText = this.scoopResponseBuffer.get(jid);
          this.scoopResponseBuffer.delete(jid);
          if (responseText) {
            const cone = Array.from(this.scoops.values()).find((s) => s.isCone);
            if (cone) {
              const summary =
                responseText.length > 2000
                  ? responseText.slice(0, 2000) + '\n... (truncated)'
                  : responseText;
              const notifyMsg: ChannelMessage = {
                id: `scoop-done-${jid}-${Date.now()}`,
                chatJid: cone.jid,
                senderId: scoop.folder,
                senderName: scoop.assistantLabel,
                content: `[@${scoop.assistantLabel} completed]:\n${summary}`,
                timestamp: new Date().toISOString(),
                fromAssistant: false,
                channel: 'scoop-notify',
              };
              log.info('Routing scoop completion to cone', {
                scoop: scoop.folder,
                responseLength: responseText.length,
              });
              this.handleMessage(notifyMsg).catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                log.error('Failed to route scoop completion to cone', {
                  scoop: scoop.folder,
                  error: msg,
                });
                this.callbacks.onError(
                  cone.jid,
                  `Scoop ${scoop.folder} completed but notification failed: ${msg}`
                );
              });
            }
          }
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
        this.callbacks.onSendMessage(jid, `${sender ? `[${sender}] ` : ''}${text}`);
      },
      getScoops: () => this.getScoops(),
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
    }

    log.info('Scoop context created', { jid, contextId });
  }

  /** Destroy a scoop context */
  async destroyScoopTab(jid: string): Promise<void> {
    const context = this.contexts.get(jid);
    if (context) {
      context.dispose();
      this.contexts.delete(jid);
      this.tabs.delete(jid);
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

    // Update status and clear response buffer for fresh accumulation
    this.scoopResponseBuffer.delete(jid);
    if (tab) {
      tab.status = 'processing';
      tab.lastActivity = new Date().toISOString();
      this.tabs.set(jid, tab);
      this.callbacks.onStatusChange(jid, 'processing');
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

  /** Cleanup */
  async shutdown(): Promise<void> {
    this.stopMessageLoop();

    // Stop the scheduler
    this.scheduler?.stop();
    this.scheduler = null;

    for (const jid of this.contexts.keys()) {
      await this.destroyScoopTab(jid);
    }

    log.info('Orchestrator shutdown');
  }
}
