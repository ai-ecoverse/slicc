/**
 * Orchestrator - manages group contexts and routes messages.
 * 
 * Each group runs in its own GroupContext with:
 * - Isolated IndexedDB for VirtualFS
 * - Own agent instance
 * - Own shell instance
 * 
 * The orchestrator:
 * - Creates/destroys group contexts
 * - Routes incoming messages to the right group
 * - Handles responses from groups
 * - Manages the message queue per group
 */

import type {
  RegisteredGroup,
  ChannelMessage,
  GroupTabState,
  ScheduledTask,
} from './types.js';
import * as db from './db.js';
import { createLogger } from '../core/logger.js';
import { GroupContext, type GroupContextCallbacks } from './group-context.js';
import { TaskScheduler } from './scheduler.js';
import { VirtualFS } from '../fs/index.js';
import type { BrowserAPI } from '../cdp/index.js';

const log = createLogger('orchestrator');

export interface OrchestratorCallbacks {
  /** Called when a group sends a response */
  onResponse: (groupJid: string, text: string, isPartial: boolean) => void;
  /** Called when a group finishes responding */
  onResponseDone: (groupJid: string) => void;
  /** Called when a group wants to send a message to another group/channel */
  onSendMessage: (targetJid: string, text: string) => void;
  /** Called when group status changes */
  onStatusChange: (groupJid: string, status: GroupTabState['status']) => void;
  /** Called on error */
  onError: (groupJid: string, error: string) => void;
  /** Get the browser API for browser tool */
  getBrowserAPI: () => BrowserAPI;
  /** Called when a tool starts executing */
  onToolStart?: (groupJid: string, toolName: string, toolInput: unknown) => void;
  /** Called when a tool finishes executing */
  onToolEnd?: (groupJid: string, toolName: string, result: string, isError: boolean) => void;
}

export interface AssistantConfig {
  name: string;
  triggerPattern: RegExp;
}

export class Orchestrator {
  private groups: Map<string, RegisteredGroup> = new Map();
  private tabs: Map<string, GroupTabState> = new Map();
  private contexts: Map<string, GroupContext> = new Map();
  private messageQueues: Map<string, ChannelMessage[]> = new Map();
  private lastAgentTimestamp: Map<string, string> = new Map();
  private container: HTMLElement;
  private callbacks: OrchestratorCallbacks;
  private config: AssistantConfig;
  private pollInterval: number | null = null;
  private scheduler: TaskScheduler | null = null;
  private globalMemoryCache: string = '';
  private globalFs: VirtualFS | null = null;

  constructor(
    container: HTMLElement,
    callbacks: OrchestratorCallbacks,
    config: AssistantConfig = { name: 'sliccy', triggerPattern: /^@sliccy\b/i },
  ) {
    this.container = container;
    this.callbacks = callbacks;
    this.config = config;
  }

  /** Initialize orchestrator and load saved groups */
  async init(): Promise<void> {
    await db.initDB();
    const savedGroups = await db.getAllGroups();
    
    for (const group of Object.values(savedGroups)) {
      this.groups.set(group.jid, group);
      this.messageQueues.set(group.jid, []);
      
      // Restore last agent timestamp from state
      const ts = await db.getState(`lastAgentTs_${group.jid}`);
      if (ts) this.lastAgentTimestamp.set(group.jid, ts);
    }

    // Initialize global VFS for shared memory
    this.globalFs = await VirtualFS.create({ backend: 'indexeddb', dbName: 'slicc-fs-global' });
    await this.ensureGlobalMemory();

    // Initialize task scheduler
    this.scheduler = new TaskScheduler({
      onTaskRun: async (task, group) => {
        log.info('Running scheduled task', { taskId: task.id, group: group.name });
        await this.sendPrompt(group.jid, `[SCHEDULED TASK]\n\n${task.prompt}`, 'scheduler', 'Scheduled Task');
      },
      getGroup: (folder) => {
        for (const g of this.groups.values()) {
          if (g.folder === folder) return g;
        }
        return undefined;
      },
    });
    this.scheduler.start();

    log.info('Orchestrator initialized', { groupCount: this.groups.size });

    // Start polling for pending messages
    this.startMessageLoop();
  }

  /** Ensure global memory exists with default content */
  private async ensureGlobalMemory(): Promise<void> {
    if (!this.globalFs) return;

    try {
      await this.globalFs.mkdir('/workspace', { recursive: true });
    } catch {
      // Already exists
    }

    try {
      const content = await this.globalFs.readFile('/workspace/CLAUDE.md', { encoding: 'utf-8' });
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
- Each group also has its own CLAUDE.md for group-specific context
`;
      await this.globalFs.writeFile('/workspace/CLAUDE.md', defaultContent);
      this.globalMemoryCache = defaultContent;
      log.info('Created default global memory');
    }
  }

  /** Get global memory content */
  async getGlobalMemory(): Promise<string> {
    if (this.globalMemoryCache) return this.globalMemoryCache;
    
    if (this.globalFs) {
      try {
        const content = await this.globalFs.readFile('/workspace/CLAUDE.md', { encoding: 'utf-8' });
        this.globalMemoryCache = typeof content === 'string' ? content : new TextDecoder().decode(content);
      } catch {
        // No global memory yet
      }
    }
    
    return this.globalMemoryCache;
  }

  /** Update global memory */
  async setGlobalMemory(content: string): Promise<void> {
    if (!this.globalFs) return;
    await this.globalFs.writeFile('/workspace/CLAUDE.md', content);
    this.globalMemoryCache = content;
    log.info('Global memory updated');
  }

  /** Register a new group */
  async registerGroup(group: RegisteredGroup): Promise<void> {
    await db.saveGroup(group);
    this.groups.set(group.jid, group);
    this.messageQueues.set(group.jid, []);
    log.info('Group registered', { jid: group.jid, name: group.name });
  }

  /** Unregister a group */
  async unregisterGroup(jid: string): Promise<void> {
    await this.destroyGroupTab(jid);
    await db.deleteGroup(jid);
    this.groups.delete(jid);
    this.messageQueues.delete(jid);
    this.lastAgentTimestamp.delete(jid);
    log.info('Group unregistered', { jid });
  }

  /** Get all registered groups */
  getGroups(): RegisteredGroup[] {
    return Array.from(this.groups.values());
  }

  /** Get group by JID */
  getGroup(jid: string): RegisteredGroup | undefined {
    return this.groups.get(jid);
  }

  /** Handle incoming message from a channel */
  async handleMessage(message: ChannelMessage): Promise<void> {
    // Store the message
    await db.saveMessage(message);

    const group = this.groups.get(message.chatJid);
    if (!group) {
      log.debug('Message for unregistered group', { chatJid: message.chatJid });
      return;
    }

    // Check trigger requirement
    if (!group.isMain && group.requiresTrigger) {
      if (!this.config.triggerPattern.test(message.content.trim())) {
        log.debug('Message without trigger, ignoring', { chatJid: message.chatJid });
        return;
      }
    }

    // Queue the message
    const queue = this.messageQueues.get(message.chatJid) ?? [];
    queue.push(message);
    this.messageQueues.set(message.chatJid, queue);

    // Process immediately if tab is ready
    const tab = this.tabs.get(message.chatJid);
    if (tab?.status === 'ready') {
      await this.processGroupQueue(message.chatJid);
    }
  }

  /** Create and initialize a group context */
  async createGroupTab(jid: string): Promise<void> {
    const group = this.groups.get(jid);
    if (!group) throw new Error(`Group not found: ${jid}`);

    if (this.contexts.has(jid)) {
      log.debug('Context already exists', { jid });
      return;
    }

    const contextId = `group-${group.folder}-${Date.now()}`;
    
    // Create the group context with full callbacks
    const contextCallbacks: GroupContextCallbacks = {
      onResponse: (text, isPartial) => {
        this.callbacks.onResponse(jid, text, isPartial);
      },
      onResponseDone: () => {
        const tab = this.tabs.get(jid);
        if (tab) {
          tab.status = 'ready';
          tab.lastActivity = new Date().toISOString();
          this.tabs.set(jid, tab);
        }
        this.callbacks.onResponseDone(jid);
        this.callbacks.onStatusChange(jid, 'ready');
        
        // Update last agent timestamp
        this.lastAgentTimestamp.set(jid, new Date().toISOString());
        db.setState(`lastAgentTs_${jid}`, new Date().toISOString());
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
      },
      onToolStart: (toolName, toolInput) => {
        this.callbacks.onToolStart?.(jid, toolName, toolInput);
      },
      onToolEnd: (toolName, result, isError) => {
        this.callbacks.onToolEnd?.(jid, toolName, result, isError);
      },
      // NanoClaw tools callbacks
      onSendMessage: (text, sender) => {
        // Send message immediately through the channel
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
      getGroups: () => this.getGroups(),
      onRegisterGroup: group.isMain ? async (newGroup) => {
        const fullGroup: RegisteredGroup = {
          ...newGroup,
          jid: `web_${newGroup.folder}_${Date.now()}`,
        };
        await this.registerGroup(fullGroup);
        return fullGroup;
      } : undefined,
      getGlobalMemory: () => this.getGlobalMemory(),
      setGlobalMemory: group.isMain ? (content) => this.setGlobalMemory(content) : undefined,
      getBrowserAPI: () => this.callbacks.getBrowserAPI(),
    };

    const context = new GroupContext(group, contextCallbacks);

    this.contexts.set(jid, context);
    this.tabs.set(jid, {
      jid,
      iframeId: contextId,
      status: 'initializing',
      lastActivity: new Date().toISOString(),
    });

    // Initialize the context
    await context.init();

    log.info('Group context created', { jid, contextId });
  }

  /** Destroy a group context */
  async destroyGroupTab(jid: string): Promise<void> {
    const context = this.contexts.get(jid);
    if (context) {
      context.dispose();
      this.contexts.delete(jid);
      this.tabs.delete(jid);
      log.info('Group context destroyed', { jid });
    }
  }

  /** Get the group context for a JID */
  getGroupContext(jid: string): GroupContext | undefined {
    return this.contexts.get(jid);
  }

  /** Send a prompt to a group */
  async sendPrompt(jid: string, text: string, senderId: string, senderName: string): Promise<void> {
    let context = this.contexts.get(jid);
    
    // Create context if needed
    if (!context) {
      await this.createGroupTab(jid);
      context = this.contexts.get(jid);
    }

    const tab = this.tabs.get(jid);
    if (tab?.status === 'initializing') {
      // Queue the message, it will be sent when ready
      log.debug('Context initializing, message queued', { jid });
      return;
    }

    if (!context) {
      log.error('Context not found after creation', { jid });
      return;
    }

    // Update status
    if (tab) {
      tab.status = 'processing';
      tab.lastActivity = new Date().toISOString();
      this.tabs.set(jid, tab);
      this.callbacks.onStatusChange(jid, 'processing');
    }

    log.debug('Prompt sent to group', { jid, textLength: text.length });

    // Send to the group context
    await context.prompt(text);
  }

  /** Process queued messages for a group */
  private async processGroupQueue(jid: string): Promise<void> {
    const queue = this.messageQueues.get(jid);
    if (!queue || queue.length === 0) return;

    const tab = this.tabs.get(jid);
    if (tab?.status !== 'ready') return;

    // Get all messages since last agent interaction
    const since = this.lastAgentTimestamp.get(jid) ?? '';
    const messages = await db.getMessagesSince(jid, since, this.config.name);

    if (messages.length === 0) {
      this.messageQueues.set(jid, []);
      return;
    }

    // Format messages like NanoClaw does
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

    // Clear queue and send
    this.messageQueues.set(jid, []);
    
    const lastMsg = messages[messages.length - 1];
    await this.sendPrompt(jid, formatted, lastMsg.senderId, lastMsg.senderName);
  }

  /** Start the message polling loop */
  private startMessageLoop(): void {
    if (this.pollInterval) return;

    this.pollInterval = window.setInterval(() => {
      for (const jid of this.groups.keys()) {
        const tab = this.tabs.get(jid);
        if (tab?.status === 'ready') {
          this.processGroupQueue(jid);
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

  /** Cleanup */
  async shutdown(): Promise<void> {
    this.stopMessageLoop();
    
    for (const jid of this.contexts.keys()) {
      await this.destroyGroupTab(jid);
    }

    log.info('Orchestrator shutdown');
  }
}
