/**
 * Scoop Context - manages an isolated agent instance for a scoop.
 *
 * Each scoop gets:
 * - A restricted filesystem (shared VFS with path ACL)
 * - Its own WasmShell
 * - Its own Agent instance
 * - Its own session history
 * - Skills loaded from VFS
 * - NanoClaw-style tools (send_message, scoop management)
 */

import type { RegisteredScoop } from './types.js';
import type { VirtualFS } from '../fs/index.js';
import type { RestrictedFS } from '../fs/restricted-fs.js';
import { WasmShell } from '../shell/index.js';
import { Agent, adaptTools, createLogger } from '../core/index.js';
import { compactContext } from '../core/context-compaction.js';
import type { AgentEvent as CoreAgentEvent, AgentMessage, AssistantMessage, AssistantMessageEvent, TextContent, Model } from '../core/index.js';
import type { SessionStore } from '../core/session.js';
import { createFileTools, createBashTool, createSearchTools, createBrowserTool, createJavaScriptTool } from '../tools/index.js';
import type { BrowserAPI } from '../cdp/index.js';
import { getApiKey, resolveCurrentModel, getSelectedProvider } from '../ui/provider-settings.js';
import { loadSkills, formatSkillsForPrompt, createDefaultSkills, type Skill } from './skills.js';
import { createNanoClawTools, type NanoClawToolsConfig } from './nanoclaw-tools.js';

const log = createLogger('scoop-context');

export interface ScoopContextCallbacks {
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
  /** Get all scoops (for cone) */
  getScoops: () => RegisteredScoop[];
  /** Feed a prompt to a specific scoop (cone only). */
  onFeedScoop?: (scoopJid: string, prompt: string) => Promise<void>;
  /** Create a new scoop (cone only) */
  onScoopScoop?: (scoop: Omit<RegisteredScoop, 'jid'>) => Promise<RegisteredScoop>;
  /** Drop/remove a scoop (cone only) */
  onDropScoop?: (scoopJid: string) => Promise<void>;
  /** Get global CLAUDE.md content (shared across all scoops) */
  getGlobalMemory: () => Promise<string>;
  /** Update global CLAUDE.md (cone only) */
  setGlobalMemory?: (content: string) => Promise<void>;
  /** Browser API for browser tool */
  getBrowserAPI: () => BrowserAPI;
}

export class ScoopContext {
  private scoop: RegisteredScoop;
  private callbacks: ScoopContextCallbacks;
  private fs: VirtualFS | RestrictedFS | null = null;
  private shell: WasmShell | null = null;
  private agent: Agent | null = null;
  private status: 'initializing' | 'ready' | 'processing' | 'error' = 'initializing';
  private isProcessing = false;
  private didStreamDeltas = false;
  private unsubscribe: (() => void) | null = null;
  private pendingPrompts: string[] = [];
  private sessionStore: SessionStore | null = null;
  private sessionId: string;

  constructor(scoop: RegisteredScoop, callbacks: ScoopContextCallbacks, fs: VirtualFS | RestrictedFS, sessionStore?: SessionStore) {
    this.scoop = scoop;
    this.callbacks = callbacks;
    this.fs = fs;
    this.sessionStore = sessionStore ?? null;
    this.sessionId = scoop.jid;
  }

  /** Initialize the scoop's environment */
  async init(): Promise<void> {
    this.setStatus('initializing');

    try {
      if (!this.fs) throw new Error('Filesystem not provided');

      log.info('Filesystem ready', { folder: this.scoop.folder });

      // Ensure directory structure
      await this.ensureDirectoryStructure();

      // Create shell — cone starts at /, scoops at /scoops/{folder}/workspace
      const cwd = this.scoop.isCone ? '/' : `/scoops/${this.scoop.folder}/workspace`;
      this.shell = new WasmShell({ fs: this.fs as VirtualFS, cwd });
      log.info('WasmShell initialized', { folder: this.scoop.folder });

      // Create default skills if needed
      const skillsDir = this.scoop.isCone
        ? '/workspace/skills'
        : `/scoops/${this.scoop.folder}/workspace/skills`;
      await createDefaultSkills(this.fs as VirtualFS, skillsDir);

      // Load skills from VFS
      const skills = await loadSkills(this.fs as VirtualFS, skillsDir);

      // Create NanoClaw tools (send_message, scoop management)
      const nanoClawToolsConfig: NanoClawToolsConfig = {
        scoop: this.scoop,
        onSendMessage: this.callbacks.onSendMessage,
        getScoops: this.callbacks.getScoops,
        onFeedScoop: this.callbacks.onFeedScoop,
        onScoopScoop: this.callbacks.onScoopScoop,
        onDropScoop: this.callbacks.onDropScoop,
        onSetGlobalMemory: this.callbacks.setGlobalMemory,
        getGlobalMemory: this.callbacks.getGlobalMemory,
      };
      const nanoClawTools = createNanoClawTools(nanoClawToolsConfig);

      // Create tools (including browser and javascript)
      const browser = this.callbacks.getBrowserAPI();
      const legacyTools = [
        ...createFileTools(this.fs as VirtualFS),
        createBashTool(this.shell),
        createBrowserTool(browser, this.fs as VirtualFS),
        ...createSearchTools(this.fs as VirtualFS),
        createJavaScriptTool(this.fs as VirtualFS),
        ...nanoClawTools,
      ];
      const tools = adaptTools(legacyTools);

      // Load scoop memory
      const memoryPath = this.scoop.isCone
        ? '/workspace/CLAUDE.md'
        : `/scoops/${this.scoop.folder}/CLAUDE.md`;
      let scoopMemory = '';
      try {
        const content = await this.fs.readFile(memoryPath, { encoding: 'utf-8' });
        scoopMemory = typeof content === 'string' ? content : new TextDecoder().decode(content);
      } catch {
        // No memory file yet
      }

      // Load global memory and sync it to /shared/CLAUDE.md
      const globalMemory = await this.callbacks.getGlobalMemory();
      if (globalMemory) {
        try {
          // Only cone writes to /shared — scoops read it via their allowed paths
          if (this.scoop.isCone) {
            const underlying = 'getUnderlyingFS' in this.fs
              ? (this.fs as RestrictedFS).getUnderlyingFS()
              : this.fs as VirtualFS;
            await underlying.writeFile('/shared/CLAUDE.md', globalMemory);
          }
        } catch {
          // /shared may not be accessible for restricted scoops, that's fine
        }
      }

      // Create agent
      const apiKey = getApiKey();
      if (!apiKey) {
        const provider = getSelectedProvider();
        throw new Error(`No API key configured for provider "${provider}"`);
      }

      const model = resolveCurrentModel();

      const systemPrompt = this.buildSystemPrompt(globalMemory, scoopMemory, skills);

      // Restore agent messages from previous session
      let restoredMessages: AgentMessage[] = [];
      if (this.sessionStore) {
        try {
          const saved = await this.sessionStore.load(this.sessionId);
          if (saved) {
            restoredMessages = saved.messages;
            log.info('Restored agent session', { folder: this.scoop.folder, messageCount: restoredMessages.length });
          }
        } catch (err) {
          log.warn('Failed to restore agent session', { folder: this.scoop.folder, error: err instanceof Error ? err.message : String(err) });
        }
      }

      this.agent = new Agent({
        initialState: {
          model,
          tools,
          systemPrompt,
          messages: restoredMessages,
        },
        getApiKey: () => apiKey,
        transformContext: compactContext,
      });

      // Subscribe to agent events
      this.unsubscribe = this.agent.subscribe((event) => this.handleAgentEvent(event));

      this.setStatus('ready');
      log.info('ScoopContext initialized', { folder: this.scoop.folder, toolCount: tools.length });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('ScoopContext init failed', { folder: this.scoop.folder, error: message });
      this.setStatus('error');
      this.callbacks.onError(`Failed to initialize: ${message}`);
    }
  }

  /** Send a prompt to this scoop's agent. If already processing, queues it for sequential execution. */
  async prompt(text: string): Promise<void> {
    if (!this.agent) {
      this.callbacks.onError('Agent not initialized');
      return;
    }

    if (this.isProcessing) {
      log.info('Queueing prompt while processing', { folder: this.scoop.folder, queueLength: this.pendingPrompts.length + 1 });
      this.pendingPrompts.push(text);
      return;
    }

    this.isProcessing = true;
    this.didStreamDeltas = false;
    this.setStatus('processing');

    try {
      await this.agent.prompt(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Agent error', { folder: this.scoop.folder, error: message });
      this.callbacks.onError(message);
    } finally {
      // Process next queued prompt if any
      const next = this.pendingPrompts.shift();
      if (next && this.agent) {
        // Stay in processing state, process the next prompt
        this.didStreamDeltas = false;
        try {
          await this.agent.prompt(next);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error('Queued agent error', { folder: this.scoop.folder, error: message });
          this.callbacks.onError(message);
        } finally {
          // Drain remaining queued prompts
          await this.drainQueue();
        }
      } else {
        this.isProcessing = false;
        this.setStatus('ready');
      }
    }
  }

  /** Drain the pending prompt queue sequentially */
  private async drainQueue(): Promise<void> {
    while (this.pendingPrompts.length > 0 && this.agent) {
      const next = this.pendingPrompts.shift()!;
      this.didStreamDeltas = false;
      try {
        await this.agent.prompt(next);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Queued agent error', { folder: this.scoop.folder, error: message });
        this.callbacks.onError(message);
      }
    }
    this.isProcessing = false;
    this.setStatus('ready');
  }

  /** Stop the current agent operation and clear any queued prompts */
  stop(): void {
    this.pendingPrompts.length = 0;
    this.agent?.abort();
    this.isProcessing = false;
    this.setStatus('ready');
  }

  /** Get the scoop's filesystem */
  getFS(): VirtualFS | RestrictedFS | null {
    return this.fs;
  }

  /** Get the scoop's shell */
  getShell(): WasmShell | null {
    return this.shell;
  }

  /** Update the model on the running agent (e.g., when the user changes the model dropdown). */
  updateModel(): void {
    if (!this.agent) return;
    const model = resolveCurrentModel();
    this.agent.setModel(model);
    log.info('Model updated on running agent', { folder: this.scoop.folder, model: model.id });
  }

  /** Cleanup */
  dispose(): void {
    this.unsubscribe?.();
    this.shell?.dispose();
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
        this.callbacks.onResponseDone();
        break;
      }

      case 'agent_end': {
        const messages = event.messages;

        // Persist session (fire-and-forget — subscribe callback is sync)
        if (this.sessionStore && messages.length > 0) {
          this.sessionStore.save({
            id: this.sessionId,
            messages,
            config: {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }).catch((err) => {
            log.error('Failed to save agent session', { folder: this.scoop.folder, error: err instanceof Error ? err.message : String(err) });
          });
        }

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

    const dirs = this.scoop.isCone
      ? ['/workspace', '/shared', '/scoops', '/home', '/home/user', '/tmp']
      : [
          `/scoops/${this.scoop.folder}`,
          `/scoops/${this.scoop.folder}/workspace`,
          `/scoops/${this.scoop.folder}/home`,
          `/scoops/${this.scoop.folder}/tmp`,
          '/shared',
        ];

    for (const dir of dirs) {
      try {
        await this.fs.mkdir(dir, { recursive: true });
      } catch {
        // Directory may already exist
      }
    }

    // Create default CLAUDE.md if missing
    const memoryPath = this.scoop.isCone
      ? '/workspace/CLAUDE.md'
      : `/scoops/${this.scoop.folder}/CLAUDE.md`;
    try {
      await this.fs.readFile(memoryPath);
    } catch {
      const defaultMemory = `# ${this.scoop.assistantLabel} Memory

${this.scoop.isCone ? 'Role: Cone (main orchestrator)' : `Scoop: ${this.scoop.name}`}
Folder: ${this.scoop.folder}
Created: ${new Date().toISOString()}

## Preferences
(Add preferences here)

## Context
(Add important context here)
`;
      await this.fs.writeFile(memoryPath, defaultMemory);
    }
  }

  private buildSystemPrompt(globalMemory: string, scoopMemory: string, skills: import('./skills.js').Skill[]): string {
    const assistantName = this.scoop.config?.assistantName || this.scoop.assistantLabel;

    const basePrompt = `# ${assistantName}

You are ${assistantName}, ${this.scoop.isCone ? 'the main assistant (cone)' : 'a scoop assistant'} in SLICC (Self-Licking Ice Cream Cone).

## Your Capabilities

You have access to:
- A virtual filesystem at ${this.scoop.isCone ? '/' : `/scoops/${this.scoop.folder}/workspace`} (your working directory)
- A bash shell for running commands (via the bash tool)
- File reading, writing, and editing tools
- Search tools (grep, find)
- **send_message**: Send messages immediately while working (for progress updates)
- **schedule_task**: Schedule recurring or one-time tasks
- **list_tasks**, **pause_task**, **resume_task**, **cancel_task**: Manage scheduled tasks

${this.scoop.isCone ? `
As the cone (main assistant), you have elevated privileges:
- **list_scoops**: See all registered scoops
- **register_scoop**: Add new scoops
- **update_global_memory**: Update the global CLAUDE.md shared across all scoops
- Full filesystem access (unrestricted)
- You can schedule tasks for any scoop

## Delegating to Scoops

Use the **delegate_to_scoop** tool to send work to scoops. IMPORTANT:
- The scoop has NO access to your conversation history
- You MUST write a **complete, self-contained prompt** with ALL context, instructions, file paths, URLs, etc.
- If the user says "do the same" or references earlier work, YOU must expand that into explicit instructions
- Use **list_scoops** first to see available scoop names

**You will automatically receive a notification when a scoop finishes.** The notification contains their full response.
You do NOT need to schedule polling tasks or check for completion markers — just delegate and wait. You will be
prompted again with the scoop's results when they are done. Then you can act on those results (move files, etc.).
` : `
You are a scoop with restricted filesystem access:
- Your workspace: /scoops/${this.scoop.folder}/
- Shared directory: /shared/ (read-write for all scoops)
- Stay focused on your assigned tasks.
`}

## Memory

Your memory is organized hierarchically:
- **Global memory** (/shared/CLAUDE.md): Read by all scoops, ${this.scoop.isCone ? 'use update_global_memory tool to modify it' : 'read-only for you'}
- **${this.scoop.isCone ? 'Cone' : 'Scoop'} memory** (${this.scoop.isCone ? '/workspace/CLAUDE.md' : `/scoops/${this.scoop.folder}/CLAUDE.md`}): Your private memory

When you learn something important:
- Use your memory for context-specific notes (edit with write_file or edit_file)
${this.scoop.isCone ? '- Use update_global_memory tool for information that should be shared across all scoops' : ''}

## Communication

When using send_message:
- Use it for progress updates on long tasks
- Use it when you want to send multiple messages
- Your final output is also sent, so don't repeat yourself

${this.scoop.config?.systemPromptAppend ?? ''}`;

    // Build the full prompt with memories and skills
    let fullPrompt = basePrompt;

    // Add global memory first (shared context)
    if (globalMemory) {
      fullPrompt += `

---
GLOBAL MEMORY (shared across all scoops):
${globalMemory}
---`;
    }

    // Add scoop memory
    if (scoopMemory) {
      fullPrompt += `

---
${this.scoop.isCone ? 'CONE' : 'SCOOP'} MEMORY (${this.scoop.name}):
${scoopMemory}
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
