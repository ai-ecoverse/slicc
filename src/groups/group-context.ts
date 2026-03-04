/**
 * Group Context - manages an isolated agent instance for a group.
 * 
 * Each group gets:
 * - Its own VirtualFS (separate IndexedDB database)
 * - Its own WasmShell
 * - Its own Agent instance
 * - Its own session history
 * - Skills loaded from VFS
 * - NanoClaw-style tools (send_message, schedule_task, etc.)
 * 
 * This provides data isolation without the complexity of iframes.
 */

import type { RegisteredGroup, ScheduledTask } from './types.js';
import { VirtualFS } from '../fs/index.js';
import { WasmShell } from '../shell/index.js';
import { Agent, adaptTools, createLogger } from '../core/index.js';
import type { AgentEvent as CoreAgentEvent, AssistantMessage, AssistantMessageEvent, TextContent, Model } from '../core/index.js';
import { createFileTools, createBashTool, createSearchTools, createBrowserTool, createJavaScriptTool } from '../tools/index.js';
import type { BrowserAPI } from '../cdp/index.js';
import { getApiKey, getProvider, getAzureResource } from '../ui/api-key-dialog.js';
import { loadSkills, formatSkillsForPrompt, createDefaultSkills, type Skill } from './skills.js';
import { createNanoClawTools, type NanoClawToolsConfig } from './nanoclaw-tools.js';

const log = createLogger('group-context');

export interface GroupContextCallbacks {
  onResponse: (text: string, isPartial: boolean) => void;
  onResponseDone: () => void;
  onError: (error: string) => void;
  onStatusChange: (status: 'initializing' | 'ready' | 'processing' | 'error') => void;
  /** Called when a tool starts executing */
  onToolStart?: (toolName: string, toolInput: unknown) => void;
  /** Called when a tool finishes executing */
  onToolEnd?: (toolName: string, result: string, isError: boolean) => void;
  /** Called when agent uses send_message tool */
  onSendMessage: (text: string, sender?: string) => void;
  /** Task scheduling callbacks */
  onScheduleTask: (task: Omit<ScheduledTask, 'id' | 'nextRun' | 'lastRun' | 'createdAt'>) => Promise<ScheduledTask>;
  onListTasks: () => Promise<ScheduledTask[]>;
  onPauseTask: (taskId: string) => Promise<boolean>;
  onResumeTask: (taskId: string) => Promise<boolean>;
  onCancelTask: (taskId: string) => Promise<boolean>;
  /** Get all groups (for main group) */
  getGroups: () => RegisteredGroup[];
  /** Register a new group (main group only) */
  onRegisterGroup?: (group: Omit<RegisteredGroup, 'jid'>) => Promise<RegisteredGroup>;
  /** Get global CLAUDE.md content (shared across all groups) */
  getGlobalMemory: () => Promise<string>;
  /** Update global CLAUDE.md (main group only) */
  setGlobalMemory?: (content: string) => Promise<void>;
  /** Browser API for browser tool */
  getBrowserAPI: () => BrowserAPI;
}

export class GroupContext {
  private group: RegisteredGroup;
  private callbacks: GroupContextCallbacks;
  private fs: VirtualFS | null = null;
  private shell: WasmShell | null = null;
  private agent: Agent | null = null;
  private status: 'initializing' | 'ready' | 'processing' | 'error' = 'initializing';
  private isProcessing = false;
  private didStreamDeltas = false;
  private unsubscribe: (() => void) | null = null;

  constructor(group: RegisteredGroup, callbacks: GroupContextCallbacks) {
    this.group = group;
    this.callbacks = callbacks;
  }

  /** Initialize the group's isolated environment */
  async init(): Promise<void> {
    this.setStatus('initializing');

    try {
      // Create group-specific VirtualFS with isolated IndexedDB
      const dbName = `slicc-fs-${this.group.folder}`;
      this.fs = await VirtualFS.create({ backend: 'indexeddb', dbName });
      log.info('VirtualFS initialized', { folder: this.group.folder });

      // Ensure directory structure
      await this.ensureDirectoryStructure();

      // Create shell
      this.shell = new WasmShell({ fs: this.fs, cwd: '/home/user' });
      log.info('WasmShell initialized', { folder: this.group.folder });

      // Create default skills if needed
      await createDefaultSkills(this.fs);

      // Load skills from VFS
      const skills = await loadSkills(this.fs, '/home/user/.skills');

      // Create NanoClaw tools (send_message, schedule_task, etc.)
      const nanoClawToolsConfig: NanoClawToolsConfig = {
        group: this.group,
        onSendMessage: this.callbacks.onSendMessage,
        onScheduleTask: this.callbacks.onScheduleTask,
        onListTasks: this.callbacks.onListTasks,
        onPauseTask: this.callbacks.onPauseTask,
        onResumeTask: this.callbacks.onResumeTask,
        onCancelTask: this.callbacks.onCancelTask,
        getGroups: this.callbacks.getGroups,
        onRegisterGroup: this.callbacks.onRegisterGroup,
        onSetGlobalMemory: this.callbacks.setGlobalMemory,
        getGlobalMemory: this.callbacks.getGlobalMemory,
      };
      const nanoClawTools = createNanoClawTools(nanoClawToolsConfig);

      // Create tools (including browser and javascript)
      const browser = this.callbacks.getBrowserAPI();
      const legacyTools = [
        ...createFileTools(this.fs),
        createBashTool(this.shell),
        createBrowserTool(browser),
        ...createSearchTools(this.fs),
        createJavaScriptTool(this.fs),
        ...nanoClawTools,
      ];
      const tools = adaptTools(legacyTools);

      // Load group memory
      let groupMemory = '';
      try {
        const content = await this.fs.readFile('/home/user/CLAUDE.md', { encoding: 'utf-8' });
        groupMemory = typeof content === 'string' ? content : new TextDecoder().decode(content);
      } catch {
        // No memory file yet
      }

      // Load global memory and sync it to the group's VFS
      const globalMemory = await this.callbacks.getGlobalMemory();
      if (globalMemory) {
        await this.fs.writeFile('/workspace/global/CLAUDE.md', globalMemory);
      }

      // Create agent
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new Error('No API key configured');
      }

      const { getModel } = await import('../core/index.js');
      const modelId = localStorage.getItem('selected-model') || 'claude-opus-4-6';
      let model = getModel('anthropic', modelId as any);

      // Handle Azure/Bedrock providers
      const provider = getProvider();
      if (provider === 'azure') {
        const resource = getAzureResource();
        if (resource) {
          const baseUrl = resource.includes('://')
            ? resource
            : `https://${resource}.services.ai.azure.com/anthropic`;
          model = { ...model, baseUrl };
        }
      }

      const systemPrompt = this.buildSystemPrompt(globalMemory, groupMemory, skills);

      this.agent = new Agent({
        initialState: {
          model,
          tools,
          systemPrompt,
        },
        getApiKey: () => apiKey,
        // Context compaction: truncate oversized tool results and drop old messages
        transformContext: async (messages) => {
          const MAX_RESULT = 8000;
          const MAX_TOTAL = 600000;
          const truncated = messages.map((msg) => {
            if (msg.role === 'toolResult' && Array.isArray((msg as any).content)) {
              const content = (msg as any).content as Array<{ type: 'text'; text?: string }>;
              const needs = content.some((c) => c.type === 'text' && c.text && c.text.length > MAX_RESULT);
              if (needs) {
                return { ...msg, content: content.map((c) =>
                  c.type === 'text' && c.text && c.text.length > MAX_RESULT
                    ? { ...c, text: c.text.slice(0, MAX_RESULT) + '\n... (truncated)' } : c,
                ) } as typeof msg;
              }
            }
            return msg;
          });
          let result = truncated;
          const size = (msgs: typeof result) => msgs.reduce((s, m) => s + JSON.stringify(m).length, 0);
          let total = size(result);
          let rounds = 0;
          while (total > MAX_TOTAL && result.length > 12 && rounds < 50) {
            rounds++;
            const marker = { role: 'user' as const, content: [{ type: 'text' as const, text: '[Earlier messages compacted]' }] };
            result = [result[0], result[1], marker as any, ...result.slice(result.length - 10)];
            total = size(result);
          }
          return result;
        },
      });

      // Subscribe to agent events
      this.unsubscribe = this.agent.subscribe((event) => this.handleAgentEvent(event));

      this.setStatus('ready');
      log.info('GroupContext initialized', { folder: this.group.folder, toolCount: tools.length });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('GroupContext init failed', { folder: this.group.folder, error: message });
      this.setStatus('error');
      this.callbacks.onError(`Failed to initialize: ${message}`);
    }
  }

  /** Send a prompt to this group's agent */
  async prompt(text: string): Promise<void> {
    if (!this.agent) {
      this.callbacks.onError('Agent not initialized');
      return;
    }

    if (this.isProcessing) {
      this.callbacks.onError('Already processing a request');
      return;
    }

    this.isProcessing = true;
    this.didStreamDeltas = false;
    this.setStatus('processing');

    try {
      await this.agent.prompt(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Agent error', { folder: this.group.folder, error: message });
      this.callbacks.onError(message);
    } finally {
      this.isProcessing = false;
      this.setStatus('ready');
    }
  }

  /** Stop the current agent operation */
  stop(): void {
    this.agent?.abort();
    this.isProcessing = false;
    this.setStatus('ready');
  }

  /** Get the group's filesystem */
  getFS(): VirtualFS | null {
    return this.fs;
  }

  /** Get the group's shell */
  getShell(): WasmShell | null {
    return this.shell;
  }

  /** Cleanup */
  dispose(): void {
    this.unsubscribe?.();
    this.shell?.dispose();
    // VirtualFS doesn't need explicit cleanup
    this.agent = null;
    this.shell = null;
    this.fs = null;
  }

  private setStatus(status: 'initializing' | 'ready' | 'processing' | 'error'): void {
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  private handleAgentEvent(event: CoreAgentEvent): void {
    switch (event.type) {
      case 'message_update': {
        const ame = event.assistantMessageEvent as AssistantMessageEvent;
        if (ame.type === 'text_delta') {
          this.didStreamDeltas = true;
          this.callbacks.onResponse(ame.delta, true);
        }
        break;
      }

      case 'tool_execution_start': {
        this.callbacks.onToolStart?.(event.toolName, event.args);
        break;
      }

      case 'tool_execution_end': {
        const result = event.result as { content: Array<{ type: string; text?: string }> };
        const textContent = result?.content
          ?.filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n') ?? '';
        this.callbacks.onToolEnd?.(event.toolName, textContent, event.isError);
        break;
      }

      case 'message_end': {
        if (event.message.role === 'assistant') {
          const content = event.message.content;
          const fullText = content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
          
          // Only emit full text if we haven't been streaming deltas
          if (fullText && !this.didStreamDeltas) {
            this.callbacks.onResponse(fullText, false);
          }
        }
        break;
      }

      case 'turn_end': {
        // Reset streaming flag for next turn (don't signal UI — agent may continue)
        this.didStreamDeltas = false;
        break;
      }

      case 'agent_end': {
        // Agent is fully done (all turns complete) — signal UI to unlock input
        const messages = event.messages;
        if (messages.length > 0) {
          const last = messages[messages.length - 1];
          if (last.role === 'assistant' && (last as AssistantMessage).errorMessage) {
            this.callbacks.onError((last as AssistantMessage).errorMessage!);
          }
        }
        this.callbacks.onResponseDone();
        break;
      }
    }
  }

  private async ensureDirectoryStructure(): Promise<void> {
    if (!this.fs) return;

    const dirs = [
      '/home',
      '/home/user',
      '/workspace',
      '/workspace/global',
      '/tmp',
    ];

    for (const dir of dirs) {
      try {
        await this.fs.mkdir(dir, { recursive: true });
      } catch {
        // Directory may already exist
      }
    }

    // Create default CLAUDE.md if missing
    try {
      await this.fs.readFile('/home/user/CLAUDE.md');
    } catch {
      const defaultMemory = `# ${this.group.name} Memory

Group: ${this.group.name}
Created: ${new Date().toISOString()}
${this.group.isMain ? 'Role: Main/Admin group' : ''}

## Preferences
(Add preferences here)

## Context
(Add important context here)
`;
      await this.fs.writeFile('/home/user/CLAUDE.md', defaultMemory);
    }
  }

  private buildSystemPrompt(globalMemory: string, groupMemory: string, skills: import('./skills.js').Skill[]): string {
    const assistantName = this.group.config?.assistantName || 'sliccy';
    
    const basePrompt = `# ${assistantName}

You are ${assistantName}, ${this.group.isMain ? 'the main assistant' : 'a helpful assistant'} in the "${this.group.name}" group.

## Your Capabilities

You have access to:
- A virtual filesystem at /home/user (your working directory)
- A bash shell for running commands (via the bash tool)
- File reading, writing, and editing tools
- Search tools (grep, find)
- **send_message**: Send messages immediately while working (for progress updates)
- **schedule_task**: Schedule recurring or one-time tasks
- **list_tasks**, **pause_task**, **resume_task**, **cancel_task**: Manage scheduled tasks

${this.group.isMain ? `
As the main assistant, you have elevated privileges:
- **list_groups**: See all registered groups
- **register_group**: Add new groups
- **update_global_memory**: Update the global CLAUDE.md shared across all groups
- You can schedule tasks for any group
- You have access to global settings
` : `
You are in a group context. Stay focused on this group's needs.
`}

## Memory

Your memory is organized hierarchically:
- **Global memory** (/workspace/global/CLAUDE.md): Read by all groups, ${this.group.isMain ? 'use update_global_memory tool to modify it' : 'read-only for you'}
- **Group memory** (/home/user/CLAUDE.md): Your group's private memory

When you learn something important:
- Use group memory for group-specific context (edit with write_file or edit_file)
${this.group.isMain ? '- Use update_global_memory tool for information that should be shared across all groups' : ''}

## Communication

When using send_message:
- Use it for progress updates on long tasks
- Use it when you want to send multiple messages
- Your final output is also sent, so don't repeat yourself

${this.group.config?.systemPromptAppend ?? ''}`;

    // Build the full prompt with memories and skills
    let fullPrompt = basePrompt;

    // Add global memory first (shared context)
    if (globalMemory) {
      fullPrompt += `

---
GLOBAL MEMORY (shared across all groups):
${globalMemory}
---`;
    }

    // Add group memory
    if (groupMemory) {
      fullPrompt += `

---
GROUP MEMORY (${this.group.name}):
${groupMemory}
---`;
    }

    // Add skills
    const skillsSection = formatSkillsForPrompt(skills);
    if (skillsSection) {
      fullPrompt += skillsSection;
    }

    return fullPrompt;
  }
}
