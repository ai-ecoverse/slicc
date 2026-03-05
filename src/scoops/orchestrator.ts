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

import type {
  RegisteredScoop,
  ChannelMessage,
  ScoopTabState,
  ScheduledTask,
} from './types.js';
import * as db from './db.js';
import { createLogger } from '../core/logger.js';
import { ScoopContext, type ScoopContextCallbacks } from './scoop-context.js';
import { TaskScheduler } from './scheduler.js';
import { VirtualFS } from '../fs/index.js';
import { RestrictedFS } from '../fs/restricted-fs.js';
import type { BrowserAPI } from '../cdp/index.js';

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
  /** Get the browser API for browser tool */
  getBrowserAPI: () => BrowserAPI;
  /** Called when a tool starts executing */
  onToolStart?: (scoopJid: string, toolName: string, toolInput: unknown) => void;
  /** Called when a tool finishes executing */
  onToolEnd?: (scoopJid: string, toolName: string, result: string, isError: boolean) => void;
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

  constructor(
    container: HTMLElement,
    callbacks: OrchestratorCallbacks,
    config: AssistantConfig = { name: 'sliccy', triggerPattern: /^@sliccy\b/i },
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
        await this.sendPrompt(scoop.jid, `[SCHEDULED TASK]\n\n${task.prompt}`, 'scheduler', 'Scheduled Task');
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

    try {
      const content = await this.sharedFs.readFile('/shared/CLAUDE.md', { encoding: 'utf-8' });
      this.globalMemoryCache = typeof content === 'string' ? content : new TextDecoder().decode(content);
    } catch {
      // Create default global memory
      const defaultContent = `# sliccy

You are a helpful coding assistant running in a browser-based development environment called SLICC (Self-Licking Ice Cream Cone).

## What You Can Do

- Answer questions and have conversations
- Read and write files in your virtual workspace
- Run bash commands in a sandboxed shell
- Automate browser interactions
- Schedule tasks to run later or on a recurring basis

## Memory

When you learn something important:
- Create files for structured data
- Update this file for global preferences
- Each scoop also has its own CLAUDE.md for scoop-specific context
`;
      await this.sharedFs.writeFile('/shared/CLAUDE.md', defaultContent);
      this.globalMemoryCache = defaultContent;
      log.info('Created default global memory');
    }
  }

  /** Get global memory content */
  async getGlobalMemory(): Promise<string> {
    if (this.globalMemoryCache) return this.globalMemoryCache;

    if (this.sharedFs) {
      try {
        const content = await this.sharedFs.readFile('/shared/CLAUDE.md', { encoding: 'utf-8' });
        this.globalMemoryCache = typeof content === 'string' ? content : new TextDecoder().decode(content);
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

  /** Register a new scoop */
  async registerScoop(scoop: RegisteredScoop): Promise<void> {
    await db.saveScoop(scoop);
    this.scoops.set(scoop.jid, scoop);
    this.messageQueues.set(scoop.jid, []);
    log.info('Scoop registered', { jid: scoop.jid, name: scoop.name });

    // Auto-initialize the scoop context
    await this.createScoopTab(scoop.jid);
  }

  /** Unregister a scoop */
  async unregisterScoop(jid: string): Promise<void> {
    await this.destroyScoopTab(jid);
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

  /** Clear all messages from the orchestrator DB and reset timestamps. */
  async clearAllMessages(): Promise<void> {
    await db.clearAllMessages();
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

    log.info('Delegating to scoop', { scoopJid, scoopName: scoop.name, promptLength: prompt.length });
    await this.sendPrompt(scoopJid, prompt, 'cone', senderName);
  }

  /** Route a message to the scoop specified by message.chatJid */
  private async routeToScoop(message: ChannelMessage): Promise<void> {
    const scoop = this.scoops.get(message.chatJid);
    if (!scoop) {
      log.info('routeToScoop: unregistered target', { chatJid: message.chatJid });
      return;
    }

    // Check trigger requirement using the scoop's own trigger
    if (!scoop.isCone && scoop.requiresTrigger && scoop.trigger) {
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

    // Process immediately if tab is ready
    const tab = this.tabs.get(message.chatJid);
    log.info('routeToScoop: queued', {
      chatJid: message.chatJid,
      scoopName: scoop.name,
      tabStatus: tab?.status ?? 'no-tab',
      queueLength: queue.length,
    });
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
        // Accumulate response text for routing back to cone
        if (!scoop.isCone && isPartial) {
          const buf = this.scoopResponseBuffer.get(jid) ?? '';
          this.scoopResponseBuffer.set(jid, buf + text);
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
            const cone = Array.from(this.scoops.values()).find(s => s.isCone);
            if (cone) {
              const summary = responseText.length > 2000
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
              log.info('Routing scoop completion to cone', { scoop: scoop.folder, responseLength: responseText.length });
              this.handleMessage(notifyMsg);
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
      // NanoClaw tools callbacks
      onSendMessage: (text, sender) => {
        this.callbacks.onSendMessage(jid, `${sender ? `[${sender}] ` : ''}${text}`);
      },
      onScheduleTask: async (task) => {
        if (!this.scheduler) throw new Error('Scheduler not initialized');
        return this.scheduler.createTask(task.groupFolder, task.prompt, task.scheduleType, task.scheduleValue);
      },
      onListTasks: async () => {
        return db.getAllTasks();
      },
      onPauseTask: async (taskId) => {
        if (!this.scheduler) return false;
        return this.scheduler.pauseTask(taskId);
      },
      onResumeTask: async (taskId) => {
        if (!this.scheduler) return false;
        return this.scheduler.resumeTask(taskId);
      },
      onCancelTask: async (taskId) => {
        if (!this.scheduler) return false;
        return this.scheduler.deleteTask(taskId);
      },
      getScoops: () => this.getScoops(),
      onDelegateToScoop: scoop.isCone ? (scoopJid, prompt) => this.delegateToScoop(scoopJid, prompt, scoop.assistantLabel) : undefined,
      onRegisterScoop: scoop.isCone ? async (newScoop) => {
        const fullScoop: RegisteredScoop = {
          ...newScoop,
          jid: `scoop_${newScoop.folder}_${Date.now()}`,
        };
        await this.registerScoop(fullScoop);
        return fullScoop;
      } : undefined,
      getGlobalMemory: () => this.getGlobalMemory(),
      setGlobalMemory: scoop.isCone ? (content) => this.setGlobalMemory(content) : undefined,
      getBrowserAPI: () => this.callbacks.getBrowserAPI(),
    };

    const context = new ScoopContext(scoop, contextCallbacks, fs);

    this.contexts.set(jid, context);
    this.tabs.set(jid, {
      jid,
      contextId,
      status: 'initializing',
      lastActivity: new Date().toISOString(),
    });

    // Initialize the context
    await context.init();

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

  /** Get the scoop context for a JID */
  getScoopContext(jid: string): ScoopContext | undefined {
    return this.contexts.get(jid);
  }

  /** Get all messages for a scoop */
  async getMessagesForScoop(jid: string): Promise<ChannelMessage[]> {
    return db.getMessagesForGroup(jid);
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
      log.info('processScoopQueue: empty queue', { jid });
      return;
    }

    const tab = this.tabs.get(jid);
    if (tab?.status !== 'ready') {
      log.info('processScoopQueue: tab not ready', { jid, status: tab?.status ?? 'no-tab' });
      return;
    }

    // Get all messages since last agent interaction.
    // Exclude messages from this scoop's own assistant (prevents processing own responses).
    // Use the scoop's assistantLabel, not the global config name, so cone→scoop relays aren't filtered.
    const scoop = this.scoops.get(jid);
    const excludeName = scoop?.assistantLabel ?? jid;
    const since = this.lastAgentTimestamp.get(jid) ?? '';
    const messages = await db.getMessagesSince(jid, since, excludeName);

    log.info('processScoopQueue: DB query', {
      jid,
      scoopName: scoop?.name,
      excludeName,
      since,
      dbMessageCount: messages.length,
      queueLength: queue.length,
    });

    if (messages.length === 0) {
      log.info('processScoopQueue: no messages from DB, clearing queue', { jid });
      this.messageQueues.set(jid, []);
      return;
    }

    // Format messages
    const formatted = messages.map((m) => {
      const date = new Date(m.timestamp);
      const time = date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      return `[${time}] ${m.senderName}: ${m.content}`;
    }).join('\n');

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
          this.processScoopQueue(jid);
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
