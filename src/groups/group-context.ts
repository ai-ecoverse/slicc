/**
 * Group Context - manages an isolated agent instance for a group.
 * 
 * Each group gets:
 * - Its own VirtualFS (separate IndexedDB database)
 * - Its own WasmShell
 * - Its own Agent instance
 * - Its own session history
 * 
 * This provides data isolation without the complexity of iframes.
 */

import type { RegisteredGroup } from './types.js';
import { VirtualFS } from '../fs/index.js';
import { WasmShell } from '../shell/index.js';
import { Agent, adaptTools, createLogger } from '../core/index.js';
import type { AgentEvent as CoreAgentEvent, AssistantMessage, AssistantMessageEvent, TextContent, Model } from '../core/index.js';
import { createFileTools, createBashTool, createSearchTools } from '../tools/index.js';
import { getApiKey, getProvider, getAzureResource } from '../ui/api-key-dialog.js';

const log = createLogger('group-context');

export interface GroupContextCallbacks {
  onResponse: (text: string, isPartial: boolean) => void;
  onResponseDone: () => void;
  onError: (error: string) => void;
  onStatusChange: (status: 'initializing' | 'ready' | 'processing' | 'error') => void;
}

export class GroupContext {
  private group: RegisteredGroup;
  private callbacks: GroupContextCallbacks;
  private fs: VirtualFS | null = null;
  private shell: WasmShell | null = null;
  private agent: Agent | null = null;
  private status: 'initializing' | 'ready' | 'processing' | 'error' = 'initializing';
  private isProcessing = false;
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
      this.shell = new WasmShell({ fs: this.fs, cwd: '/workspace/group' });
      log.info('WasmShell initialized', { folder: this.group.folder });

      // Create tools
      const legacyTools = [
        ...createFileTools(this.fs),
        createBashTool(this.shell),
        ...createSearchTools(this.fs),
      ];
      const tools = adaptTools(legacyTools);

      // Load group memory
      let groupMemory = '';
      try {
        const content = await this.fs.readFile('/workspace/group/CLAUDE.md', { encoding: 'utf-8' });
        groupMemory = typeof content === 'string' ? content : new TextDecoder().decode(content);
      } catch {
        // No memory file yet
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

      const systemPrompt = this.buildSystemPrompt(groupMemory);

      this.agent = new Agent({
        initialState: {
          model,
          tools,
          systemPrompt,
        },
        getApiKey: () => apiKey,
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
          this.callbacks.onResponse(ame.delta, true);
        }
        break;
      }

      case 'message_end': {
        if (event.message.role === 'assistant') {
          const content = event.message.content;
          const fullText = content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
          
          if (fullText && !this.isProcessing) {
            // Only emit full text if we haven't been streaming
            this.callbacks.onResponse(fullText, false);
          }
        }
        break;
      }

      case 'turn_end': {
        this.callbacks.onResponseDone();
        break;
      }

      case 'agent_end': {
        const messages = event.messages;
        if (messages.length > 0) {
          const last = messages[messages.length - 1];
          if (last.role === 'assistant' && (last as AssistantMessage).errorMessage) {
            this.callbacks.onError((last as AssistantMessage).errorMessage!);
          }
        }
        break;
      }
    }
  }

  private async ensureDirectoryStructure(): Promise<void> {
    if (!this.fs) return;

    const dirs = [
      '/workspace',
      '/workspace/group',
      '/workspace/global',
      '/home',
      '/home/user',
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
      await this.fs.readFile('/workspace/group/CLAUDE.md');
    } catch {
      const defaultMemory = `# ${this.group.name} Memory

Group: ${this.group.name}
Folder: ${this.group.folder}
Created: ${new Date().toISOString()}
${this.group.isMain ? 'Role: Main/Admin group' : ''}

## Preferences
(Add preferences here)

## Context
(Add important context here)
`;
      await this.fs.writeFile('/workspace/group/CLAUDE.md', defaultMemory);
    }
  }

  private buildSystemPrompt(memory: string): string {
    const basePrompt = `You are ${this.group.isMain ? 'the main assistant' : 'a helpful assistant'} in the "${this.group.name}" group.

You have access to:
- A virtual filesystem at /workspace/group (your working directory)
- A bash shell for running commands (via the bash tool)
- File reading, writing, and editing tools
- Search tools (grep, find)

Your memory and preferences are stored in /workspace/group/CLAUDE.md. You can read and update this file to remember important information.

${this.group.isMain ? `
As the main assistant, you have elevated privileges:
- You can manage other groups
- You can schedule tasks
- You can access global settings
` : `
You are in a group context. Stay focused on this group's needs.
`}

${this.group.config?.systemPromptAppend ?? ''}`;

    if (memory) {
      return `${basePrompt}

---
GROUP MEMORY (loaded from CLAUDE.md):
${memory}
---`;
    }

    return basePrompt;
  }
}
