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
import { createCompactContext } from '../core/context-compaction.js';
import type {
  AgentEvent as CoreAgentEvent,
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ImageContent,
  Model,
} from '../core/index.js';
import { isContextOverflow, streamSimple } from '@mariozechner/pi-ai';
import type { AssistantMessage as PiAssistantMessage } from '@mariozechner/pi-ai';
import type { SessionStore } from '../core/session.js';
import { createFileTools, createBashTool } from '../tools/index.js';
import type { BrowserAPI } from '../cdp/index.js';
import {
  getApiKey,
  resolveCurrentModel,
  resolveModelById,
  getSelectedProvider,
} from '../ui/provider-settings.js';
import { loadSkills, formatSkillsForPrompt, createDefaultSkills, type Skill } from './skills.js';
import {
  createScoopManagementTools,
  type ScoopManagementToolsConfig,
} from './scoop-management-tools.js';
import { getAdobeSessionId } from './llm-session-id.js';
import { fetchSecretEnvVars } from '../core/secret-env.js';

const log = createLogger('scoop-context');

/** Detect API errors caused by invalid/oversized images. */
export function isImageProcessingError(msg: string): boolean {
  return (
    /image exceeds.*maximum/i.test(msg) ||
    /Could not process image/i.test(msg) ||
    /invalid.*image/i.test(msg) ||
    /image.*too (large|big)/i.test(msg)
  );
}

/**
 * Detect errors that are unlikely to succeed on retry.
 * These include authentication failures, invalid model IDs, and permanent API errors.
 */
export function isNonRetryableError(msg: string): boolean {
  return (
    // HTTP 4xx errors (except 429 rate limit which is retryable)
    /\b(401|403|404|405|410|422)\b/.test(msg) ||
    // Authentication / authorization failures
    /unauthorized|forbidden|authentication.*failed|invalid.*api.?key/i.test(msg) ||
    // Invalid model errors
    /model.*not.*found|invalid.*model|unknown.*model|does.*not.*exist/i.test(msg) ||
    // Account/billing issues
    /insufficient.*quota|billing|payment.*required|account.*suspended/i.test(msg) ||
    // Malformed request (won't succeed on retry)
    /invalid.*request|malformed|bad.*request/i.test(msg)
  );
}

/**
 * Detect transient errors that may succeed on retry.
 * Includes rate limits, server errors, and network issues.
 */
export function isRetryableError(msg: string): boolean {
  return (
    // Rate limiting
    /\b429\b|rate.*limit|too.*many.*requests|quota.*exceeded/i.test(msg) ||
    // Server errors (5xx)
    /\b(500|502|503|504)\b|internal.*server|bad.*gateway|service.*unavailable|gateway.*timeout/i.test(
      msg
    ) ||
    // Network issues
    /network.*error|connection.*refused|timeout|econnreset|socket.*hang.*up/i.test(msg) ||
    // Temporary overload
    /overloaded|temporarily.*unavailable|try.*again/i.test(msg)
  );
}

/**
 * Sleep for `ms` milliseconds, resolving early when the given AbortSignal fires.
 * Returns `true` if the sleep was aborted, `false` if it completed normally.
 * Exposed for testing the retry loop's cooperative cancellation.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ScoopContextCallbacks {
  onResponse: (text: string, isPartial: boolean) => void;
  onResponseDone: () => void;
  onError: (error: string) => void;
  /**
   * Called when a fatal error occurs that cannot be recovered via retry.
   * Unlike `onError`, this MUST bypass scoop_mute and notify the cone
   * immediately so the user is aware the scoop is dead.
   */
  onFatalError?: (error: string) => void;
  onStatusChange: (status: 'initializing' | 'ready' | 'processing' | 'error') => void;
  /** Called when a tool starts executing */
  onToolStart?: (toolName: string, toolInput: unknown) => void;
  /** Called when a tool finishes executing */
  onToolEnd?: (toolName: string, result: string, isError: boolean) => void;
  /** Called when a tool requests UI interaction */
  onToolUI?: (toolName: string, requestId: string, html: string) => void;
  /** Called when tool UI interaction is complete */
  onToolUIDone?: (requestId: string) => void;
  /** Called when agent uses send_message tool */
  onSendMessage: (text: string, sender?: string) => void;
  /** Get all scoops (for cone) */
  getScoops: () => RegisteredScoop[];
  /** Get tab state for a scoop by JID (cone only). */
  getScoopTabState?: (jid: string) => import('./types.js').ScoopTabState | undefined;
  /** Feed a prompt to a specific scoop (cone only). */
  onFeedScoop?: (scoopJid: string, prompt: string) => Promise<void>;
  /** Create a new scoop (cone only) */
  onScoopScoop?: (scoop: Omit<RegisteredScoop, 'jid'>) => Promise<RegisteredScoop>;
  /** Drop/remove a scoop (cone only) */
  onDropScoop?: (scoopJid: string) => Promise<void>;
  /** Mute scoops so their completions are not forwarded to the cone (cone only). */
  onMuteScoops?: (jids: readonly string[]) => void;
  /** Unmute scoops; returns any stashed completions so the caller can
   *  fold them into its tool result (cone only). */
  onUnmuteScoops?: (
    jids: readonly string[]
  ) => Promise<
    Array<{ jid: string; summary: string; timestamp: string; notificationPath: string | null }>
  >;
  /** Wait for a batch of scoops to complete (cone only). */
  onWaitForScoops?: (
    jids: readonly string[],
    timeoutMs?: number
  ) => Promise<Array<{ jid: string; summary: string | null; timedOut: boolean }>>;
  /** Get global CLAUDE.md content (shared across all scoops) */
  getGlobalMemory: () => Promise<string>;
  /** Update global CLAUDE.md (cone only) */
  setGlobalMemory?: (content: string) => Promise<void>;
  /** BrowserAPI provider for browser automation commands */
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
  private disposed = false;
  private didStreamDeltas = false;
  private unsubscribe: (() => void) | null = null;
  /** Aborts the in-flight prompt() retry loop and any pending backoff sleep. */
  private promptAbortController: AbortController | null = null;

  private sessionStore: SessionStore | null = null;
  private sessionId: string;
  private sessionCreatedAt: number = 0;
  private isRecovering: 'overflow' | 'image' | false = false;
  private coneJid: string | undefined;

  private skillsFs: VirtualFS | null = null;
  private skillsDir: string = '/workspace/skills';

  constructor(
    scoop: RegisteredScoop,
    callbacks: ScoopContextCallbacks,
    fs: VirtualFS | RestrictedFS,
    sessionStore?: SessionStore,
    skillsFs?: VirtualFS,
    coneJid?: string
  ) {
    this.scoop = scoop;
    this.callbacks = callbacks;
    this.fs = fs;
    this.sessionStore = sessionStore ?? null;
    this.skillsFs = skillsFs ?? null;
    this.coneJid = coneJid;
    // Internal persistence key — stable across days/restarts so saved
    // conversations can be restored by `SessionStore.load`. The outgoing
    // Adobe `X-Session-Id` is computed separately in `init()`.
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
      const browser = this.callbacks.getBrowserAPI();

      // Always load skills from the cone's /workspace/skills/ directory.
      // Scoops now have read access to /workspace/ via RestrictedFS ACL,
      // so no per-scoop skill copying is needed.
      this.skillsDir = '/workspace/skills';

      // Seed bundled defaults only for the cone
      if (this.scoop.isCone) {
        await createDefaultSkills(this.fs as VirtualFS, this.skillsDir);
      }

      const effectiveSkillsFs = (this.skillsFs ?? this.fs) as VirtualFS;

      // Fetch masked secret values from the server to populate shell environment.
      // Real values never leave the server — only deterministic masked values are used.
      const secretEnv = await fetchSecretEnvVars();

      // Pass effectiveSkillsFs for JSH discovery so scoops can find .jsh files from all loaded skills
      this.shell = new WasmShell({
        fs: this.fs as VirtualFS,
        cwd,
        env: Object.keys(secretEnv).length > 0 ? secretEnv : undefined,
        browserAPI: browser,
        jshDiscoveryFs: this.skillsFs ? effectiveSkillsFs : undefined,
        allowedCommands: this.scoop.config?.allowedCommands,
        // Forward this scoop's jid so the `agent` supplemental command can
        // tell the AgentBridge which scoop is the parent of any nested
        // `agent <cwd> ... <prompt>` invocation — used for model inheritance.
        getParentJid: () => this.scoop.jid,
        // Mark non-cone scoops as non-interactive so commands like `mount`
        // that need a human gesture fail fast instead of hanging on a tool
        // UI nobody will see (issue #508).
        isScoop: () => !this.scoop.isCone,
      });
      log.info('WasmShell initialized', { folder: this.scoop.folder });
      const skills = await loadSkills(effectiveSkillsFs, this.skillsDir);

      // Create scoop-management tools (send_message, scoop management)
      const scoopManagementToolsConfig: ScoopManagementToolsConfig = {
        scoop: this.scoop,
        onSendMessage: this.callbacks.onSendMessage,
        getScoops: this.callbacks.getScoops,
        getScoopTabState: this.callbacks.getScoopTabState,
        onFeedScoop: this.callbacks.onFeedScoop,
        onScoopScoop: this.callbacks.onScoopScoop,
        onDropScoop: this.callbacks.onDropScoop,
        onMuteScoops: this.callbacks.onMuteScoops,
        onUnmuteScoops: this.callbacks.onUnmuteScoops,
        onWaitForScoops: this.callbacks.onWaitForScoops,
        onSetGlobalMemory: this.callbacks.setGlobalMemory,
        getGlobalMemory: this.callbacks.getGlobalMemory,
      };
      const scoopManagementTools = createScoopManagementTools(scoopManagementToolsConfig);

      // Create tools (browser automation and search are now via shell commands through bash)
      const legacyTools = [
        ...createFileTools(this.fs as VirtualFS),
        createBashTool(this.shell),
        ...scoopManagementTools,
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
            const underlying =
              'getUnderlyingFS' in this.fs
                ? (this.fs as RestrictedFS).getUnderlyingFS()
                : (this.fs as VirtualFS);
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

      const model = this.scoop.config?.modelId
        ? resolveModelById(this.scoop.config.modelId)
        : resolveCurrentModel();
      const label = this.scoop.isCone ? 'Cone' : `Scoop "${this.scoop.name}"`;
      console.log(`[model] ${label} using model: ${model.id} (provider: ${model.provider})`);

      const systemPrompt = this.buildSystemPrompt(globalMemory, scoopMemory, skills);

      // Restore agent messages from previous session
      let restoredMessages: AgentMessage[] = [];
      if (this.sessionStore) {
        try {
          const saved = await this.sessionStore.load(this.sessionId);
          if (saved) {
            restoredMessages = saved.messages;
            this.sessionCreatedAt = saved.createdAt;
            log.info('Restored agent session', {
              folder: this.scoop.folder,
              messageCount: restoredMessages.length,
            });
          }
        } catch (err) {
          log.error('Failed to restore agent session', {
            folder: this.scoop.folder,
            error: err instanceof Error ? err.message : String(err),
          });
          this.callbacks.onError(`Conversation history could not be restored. Starting fresh.`);
        }
      }

      const compactFn = createCompactContext({
        model,
        getApiKey: () => getApiKey() ?? undefined,
      });

      // Compute the Adobe session identifier once per init. It is a
      // daily-rotating random UUID for the cone, and `<uuid>/<hash(folder, uuid)>`
      // for scoops — salted with the UUID so the scoop folder name never
      // reaches the provider. Only sent as the `X-Session-Id` header for the
      // Adobe proxy; other providers receive no such header.
      const adobeSessionId = await getAdobeSessionId(this.scoop, this.coneJid);
      const streamWithSessionId: typeof streamSimple = (m, ctx, opts) => {
        if (m.provider !== 'adobe') return streamSimple(m, ctx, opts);
        return streamSimple(m, ctx, {
          ...opts,
          headers: { ...opts?.headers, 'X-Session-Id': adobeSessionId },
        });
      };

      // Guard: dispose() may have run while init() was awaiting above.
      if (this.disposed) return;

      this.agent = new Agent({
        initialState: {
          model,
          tools,
          systemPrompt,
          messages: restoredMessages,
        },
        getApiKey: () => getApiKey() ?? undefined,
        transformContext: compactFn,
        streamFn: streamWithSessionId,
      });

      // Subscribe to agent events
      this.unsubscribe = this.agent.subscribe((event) => this.handleAgentEvent(event));

      this.setStatus('ready');
      log.info('ScoopContext initialized', { folder: this.scoop.folder, toolCount: tools.length });
    } catch (err) {
      if (this.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      log.error('ScoopContext init failed', { folder: this.scoop.folder, error: message });
      this.setStatus('error');
      this.callbacks.onError(`Failed to initialize: ${message}`);
    }
  }

  /** Send a prompt to this scoop's agent. If already processing, queues it via followUp(). */
  async prompt(text: string, images: ImageContent[] = []): Promise<void> {
    if (!this.agent) {
      this.callbacks.onError('Agent not initialized');
      return;
    }

    // Check both our flag AND the agent's internal state to avoid race conditions.
    // If the agent is streaming (tool executing, etc), use followUp() to queue.
    const agentIsStreaming = this.agent.state?.isStreaming ?? false;
    if (this.isProcessing || agentIsStreaming) {
      log.info('Queueing prompt via followUp while processing', {
        folder: this.scoop.folder,
        isProcessing: this.isProcessing,
        agentIsStreaming,
      });
      // Use pi-agent-core's followUp() to queue message for after current turn
      this.agent.followUp({
        role: 'user',
        content: [{ type: 'text', text }, ...images],
        timestamp: Date.now(),
      });
      return;
    }

    // Capture agent reference to avoid null access if dispose() runs mid-retry
    const agent = this.agent;

    // Replace any stale controller from a previous aborted run and capture
    // the signal locally so stop()/dispose() can interrupt backoff sleeps.
    this.promptAbortController?.abort();
    const abortController = new AbortController();
    this.promptAbortController = abortController;
    const abortSignal = abortController.signal;

    this.isProcessing = true;
    this.setStatus('processing');

    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 1000;
    let lastError: Error | null = null;

    try {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // Check disposal / cancellation before each attempt
        if (this.disposed || abortSignal.aborted) return;

        // Reset streaming state for each attempt to avoid stale state from previous attempts
        this.didStreamDeltas = false;

        try {
          await agent.prompt(text, images);
          // Success - exit retry loop
          lastError = null;
          break;
        } catch (err) {
          // Check disposal / cancellation after await
          if (this.disposed || abortSignal.aborted) return;

          lastError = err instanceof Error ? err : new Error(String(err));
          const message = lastError.message;

          // Check if this is a non-retryable error (4xx auth/model errors, etc.)
          if (isNonRetryableError(message)) {
            log.error('Non-retryable agent error', {
              folder: this.scoop.folder,
              error: message,
              attempt,
            });
            // Fatal error - notify cone immediately, bypassing mute
            this.setStatus('error');
            if (this.callbacks.onFatalError) {
              this.callbacks.onFatalError(
                `Scoop "${this.scoop.name}" failed with unrecoverable error: ${message}`
              );
            } else {
              this.callbacks.onError(message);
            }
            return;
          }

          // Check if this is a retryable error
          if (isRetryableError(message) && attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff
            log.warn('Retryable agent error, will retry', {
              folder: this.scoop.folder,
              error: message,
              attempt,
              maxRetries: MAX_RETRIES,
              delayMs: delay,
            });
            // Abortable backoff — stop()/dispose() cancels immediately
            const aborted = await abortableSleep(delay, abortSignal);
            if (aborted || this.disposed) return;
            continue;
          }

          // Unknown error type or final retry - log and continue to failure handling
          log.error('Agent error', {
            folder: this.scoop.folder,
            error: message,
            attempt,
            isRetryable: isRetryableError(message),
          });

          // If we've exhausted retries, break out
          if (attempt === MAX_RETRIES) {
            break;
          }

          // For unknown errors, also apply abortable exponential backoff
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          const aborted = await abortableSleep(delay, abortSignal);
          if (aborted || this.disposed) return;
        }
      }

      // If we exited the loop with an error, handle final failure
      if (lastError && !this.disposed && !abortSignal.aborted) {
        const message = lastError.message;
        log.error('Agent error after retries exhausted', {
          folder: this.scoop.folder,
          error: message,
          maxRetries: MAX_RETRIES,
        });
        // Treat exhausted retries as fatal - notify cone bypassing mute
        this.setStatus('error');
        if (this.callbacks.onFatalError) {
          this.callbacks.onFatalError(
            `Scoop "${this.scoop.name}" failed after ${MAX_RETRIES} attempts: ${message}`
          );
        } else {
          this.callbacks.onError(message);
        }
        return;
      }

      if (!this.disposed && !abortSignal.aborted) {
        this.setStatus('ready');
      }
    } finally {
      this.isProcessing = false;
      // Only clear the reference if it's still ours — a later prompt() may
      // have already installed a new controller.
      if (this.promptAbortController === abortController) {
        this.promptAbortController = null;
      }
    }
  }

  /** Stop the current agent operation and clear any queued prompts */
  stop(): void {
    // Abort before touching the agent so any pending backoff sleep resolves
    // and the retry loop exits on its next disposal/abort check.
    this.promptAbortController?.abort();
    this.agent?.clearAllQueues?.();
    this.agent?.abort?.();
    this.isProcessing = false;
    this.setStatus('ready');
  }

  /** Clear the agent's in-memory conversation history (used by clear-chat). */
  clearMessages(): void {
    if (this.agent) {
      this.agent.state.messages = [];
    }
  }

  /** Get the agent's current in-memory messages (for diagnostics). */
  getAgentMessages(): AgentMessage[] {
    return this.agent?.state?.messages ? structuredClone(this.agent.state.messages) : [];
  }

  /** Get the session ID used for agent-sessions DB persistence. */
  getSessionId(): string {
    return this.sessionId;
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
    this.agent.state.model = model;
    log.info('Model updated on running agent', { folder: this.scoop.folder, model: model.id });
  }

  /** Hot-reload skills from VFS and update the agent's system prompt. */
  async reloadSkills(): Promise<void> {
    if (!this.agent) return;

    const effectiveSkillsFs = (this.skillsFs ?? this.fs) as VirtualFS;
    const skills = await loadSkills(effectiveSkillsFs, this.skillsDir);

    // Re-read memories for prompt rebuild
    let scoopMemory = '';
    const memoryPath = this.scoop.isCone
      ? '/workspace/CLAUDE.md'
      : `/scoops/${this.scoop.folder}/CLAUDE.md`;
    try {
      const content = await this.fs!.readFile(memoryPath, { encoding: 'utf-8' });
      scoopMemory = typeof content === 'string' ? content : new TextDecoder().decode(content);
    } catch {
      /* no memory file -- expected for fresh scoops */
    }

    const globalMemory = await this.callbacks.getGlobalMemory();

    const newPrompt = this.buildSystemPrompt(globalMemory, scoopMemory, skills);
    this.agent.state.systemPrompt = newPrompt;

    log.info('Skills reloaded', {
      folder: this.scoop.folder,
      skillCount: skills.length,
    });
  }

  /** Cleanup */
  dispose(): void {
    this.disposed = true;
    // Cancel any in-flight retry loop / backoff sleep before tearing down the agent.
    this.promptAbortController?.abort();
    this.promptAbortController = null;
    this.agent?.clearAllQueues?.();
    this.agent?.abort?.();
    this.unsubscribe?.();
    this.shell?.dispose();
    this.agent = null;
    this.shell = null;
    this.fs = null;
  }

  private setStatus(status: 'initializing' | 'ready' | 'processing' | 'error'): void {
    if (this.disposed) return;
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  private handleAgentEvent(event: CoreAgentEvent): void {
    if (this.disposed) return;
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

      case 'tool_execution_update': {
        // Handle tool UI requests from onUpdate
        const partialResult = event.partialResult as {
          content?: Array<{ type: string; requestId?: string; html?: string }>;
        };
        for (const c of partialResult?.content ?? []) {
          if (c.type === 'tool_ui' && c.requestId && c.html) {
            this.callbacks.onToolUI?.(event.toolName, c.requestId, c.html);
          } else if (c.type === 'tool_ui_done' && c.requestId) {
            this.callbacks.onToolUIDone?.(c.requestId);
          }
        }
        break;
      }

      case 'tool_execution_end': {
        const result = event.result as {
          content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        };
        const parts: string[] = [];
        for (const c of result?.content ?? []) {
          if (c.type === 'text' && c.text) parts.push(c.text);
          if (c.type === 'image' && c.data && c.mimeType)
            parts.push(`<img:data:${c.mimeType};base64,${c.data}>`);
        }
        this.callbacks.onToolEnd?.(event.toolName, parts.join('\n'), event.isError);
        break;
      }

      case 'message_end': {
        if (event.message.role === 'assistant') {
          const msg = event.message as AssistantMessage;
          const fullText = msg.content
            .filter((c): c is TextContent => c.type === 'text')
            .map((c) => c.text)
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

        if (messages.length > 0) {
          const last = messages[messages.length - 1];
          if (last.role === 'assistant' && (last as AssistantMessage).errorMessage) {
            const errorMsg = (last as AssistantMessage).errorMessage!;
            // Check for image processing error first, then context overflow.
            // Skip persistence — recovery will re-prompt and a subsequent
            // agent_end will save the repaired history.
            if (!this.isRecovering && isImageProcessingError(errorMsg)) {
              this.recoverFromImageError(messages);
              break;
            }
            if (!this.isRecovering && isContextOverflow(last as PiAssistantMessage)) {
              this.recoverFromOverflow(messages);
              break;
            }
            // Already recovering (either type) — surface error, reset flag
            this.isRecovering = false;
            this.callbacks.onError(errorMsg);
          } else {
            // Successful completion — reset recovery flag
            this.isRecovering = false;
          }
        }

        // Persist session after recovery checks pass. Use the agent's full
        // accumulated state, not event.messages (which only contains the
        // current prompt cycle's messages).
        const persistMessages = this.agent?.state?.messages ?? event.messages;
        if (this.sessionStore && persistMessages.length > 0) {
          this.sessionStore
            .save({
              id: this.sessionId,
              messages: persistMessages,
              config: {},
              createdAt: this.sessionCreatedAt || Date.now(),
              updatedAt: Date.now(),
            })
            .catch((err) => {
              log.error('Failed to save agent session', {
                folder: this.scoop.folder,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }
        break;
      }
    }
  }

  /**
   * Recover from a context overflow error by trimming oversized messages
   * and re-prompting the agent with an explanation.
   *
   * Strategy: remove the error assistant message, find and replace oversized
   * content (>10K estimated tokens) in recent messages with placeholders,
   * then re-prompt so transformContext (compaction) runs on the next attempt.
   */
  private recoverFromOverflow(messages: AgentMessage[]): void {
    if (!this.agent) return;

    log.warn('Context overflow detected, attempting recovery', {
      folder: this.scoop.folder,
      messageCount: messages.length,
    });

    this.isRecovering = 'overflow';

    // Notify the user that recovery is in progress
    this.callbacks.onResponse(
      'Context window exceeded — recovering by trimming oversized messages...',
      false
    );

    try {
      // Remove the error assistant message (last message)
      const trimmed = messages.slice(0, -1);

      // Walk backward through recent messages and replace oversized content.
      // 10K tokens ≈ 40K chars — anything larger is a candidate for replacement.
      const TOKEN_THRESHOLD = 10000;
      const CHAR_THRESHOLD = TOKEN_THRESHOLD * 4;
      let replaced = 0;

      for (let i = trimmed.length - 1; i >= 0 && replaced < 5; i--) {
        const msg = trimmed[i] as any;
        if (!Array.isArray(msg.content)) continue;

        let msgSize = 0;
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) msgSize += block.text.length;
          if (block.type === 'image' && block.data) msgSize += block.data.length;
        }

        if (msgSize > CHAR_THRESHOLD) {
          const role = msg.role === 'toolResult' ? 'tool result' : msg.role;
          const placeholder = {
            type: 'text' as const,
            text: `[Content removed: ${role} was too large for context window (${Math.round(msgSize / 1000)}K chars). The operation completed but output could not be retained.]`,
          };

          // For assistant messages, preserve ToolCall blocks — they're small and
          // must stay paired with subsequent toolResult messages. Only replace
          // text/image/thinking content blocks.
          if (msg.role === 'assistant') {
            const toolCalls = msg.content.filter((block: any) => block.type === 'toolCall');
            trimmed[i] = {
              ...msg,
              content: [placeholder, ...toolCalls],
            };
          } else {
            trimmed[i] = {
              ...msg,
              content: [placeholder],
            };
          }
          replaced++;
          log.info('Replaced oversized message', {
            index: i,
            role: msg.role,
            size: msgSize,
            preservedToolCalls:
              msg.role === 'assistant'
                ? msg.content.filter((b: any) => b.type === 'toolCall').length
                : 0,
          });
        }
      }

      // Replace the agent's message history with the trimmed version
      this.agent.state.messages = trimmed;

      // Re-prompt with an explanation so the agent can adapt
      const explanation =
        replaced > 0
          ? `[System: Context overflow recovered. ${replaced} oversized message(s) were replaced with placeholders to fit within the context window. The conversation continues — you may need to re-read files or re-run commands if their output was removed.]`
          : `[System: Context overflow recovered. Older messages were trimmed. The conversation continues — compaction will summarize history on the next turn.]`;

      this.agent.prompt(explanation).catch((err) => {
        log.error('Recovery re-prompt failed', {
          folder: this.scoop.folder,
          error: err instanceof Error ? err.message : String(err),
        });
        this.isRecovering = false;
        this.callbacks.onError(
          `Context overflow recovery failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    } catch (err) {
      log.error('Recovery failed', {
        folder: this.scoop.folder,
        error: err instanceof Error ? err.message : String(err),
      });
      this.isRecovering = false;
      this.callbacks.onError(
        `Context overflow recovery failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Recover from an image processing error by stripping ImageContent blocks
   * from recent messages and re-prompting the agent.
   */
  private recoverFromImageError(messages: AgentMessage[]): void {
    if (!this.agent) return;

    log.warn('Image processing error detected, attempting recovery', {
      folder: this.scoop.folder,
      messageCount: messages.length,
    });

    this.isRecovering = 'image';

    this.callbacks.onResponse(
      'Image rejected by API — removing problematic images and continuing...',
      false
    );

    try {
      // Remove the error assistant message (last)
      const trimmed = messages.slice(0, -1);

      // Walk backward through last 10 messages, strip all ImageContent blocks
      let stripped = 0;
      const limit = Math.max(0, trimmed.length - 10);

      for (let i = trimmed.length - 1; i >= limit; i--) {
        const msg = trimmed[i] as any;
        if (!Array.isArray(msg.content)) continue;

        const hasImages = msg.content.some((block: any) => block.type === 'image');
        if (!hasImages) continue;

        // Remove image blocks, keep text blocks
        const filtered = msg.content.filter((block: any) => block.type !== 'image');

        if (filtered.length === 0) {
          // All content was images — replace with placeholder
          trimmed[i] = {
            ...msg,
            content: [{ type: 'text' as const, text: '[Image removed: rejected by API]' }],
          };
        } else {
          trimmed[i] = { ...msg, content: filtered };
        }
        stripped++;
      }

      this.agent.state.messages = trimmed;

      const explanation = `[System: An image was rejected by the API and has been removed from the conversation (${stripped} message(s) affected). The conversation continues without the image.]`;

      this.agent.prompt(explanation).catch((err) => {
        log.error('Image recovery re-prompt failed', {
          folder: this.scoop.folder,
          error: err instanceof Error ? err.message : String(err),
        });
        this.isRecovering = false;
        this.callbacks.onError(
          `Image error recovery failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    } catch (err) {
      log.error('Image recovery failed', {
        folder: this.scoop.folder,
        error: err instanceof Error ? err.message : String(err),
      });
      this.isRecovering = false;
      this.callbacks.onError(
        `Image error recovery failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async ensureDirectoryStructure(): Promise<void> {
    if (!this.fs) return;

    const dirs = this.scoop.isCone
      ? ['/workspace', '/shared', '/scoops', '/home', '/tmp', '/mnt']
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

    // Create default CLAUDE.md if missing. Best-effort: scoops with
    // pure-replace `writablePaths: []` (or no overlap with the memory
    // path) have no writable location for this file, and that's a
    // legitimate configuration — a read-only / audit-style scoop
    // simply runs without a persisted memory file. Swallowing the
    // EACCES keeps init on the happy path for zero-write sandboxes.
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
      try {
        await this.fs.writeFile(memoryPath, defaultMemory);
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === 'EACCES') {
          log.debug('Skipping default memory write (sandbox is read-only)', {
            folder: this.scoop.folder,
            path: memoryPath,
          });
        } else {
          throw err;
        }
      }
    }
  }

  private buildSystemPrompt(
    globalMemory: string,
    scoopMemory: string,
    skills: import('./skills.js').Skill[]
  ): string {
    const assistantName = this.scoop.config?.assistantName || this.scoop.assistantLabel;

    const basePrompt = `# ${assistantName}

You are ${assistantName}, ${this.scoop.isCone ? 'the main assistant (cone)' : 'a scoop assistant'} in SLICC (Self-Licking Ice Cream Cone).

## Your Capabilities

You have access to:
- A virtual filesystem at ${this.scoop.isCone ? '/' : `/scoops/${this.scoop.folder}/workspace`} (your working directory)
- A bash shell for running commands (via the bash tool)
- File reading, writing, and editing tools
- Use shell commands like \`rg\`, \`grep\`, and \`find\` through the bash tool for search
- **send_message**: Send messages immediately while working (for progress updates)
- **schedule_task**: Schedule recurring or one-time tasks
- **list_tasks**, **pause_task**, **resume_task**, **cancel_task**: Manage scheduled tasks

${
  this.scoop.isCone
    ? `
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

**You will automatically receive a notification when a scoop finishes.** The notification includes a VFS path to the full output, the total line count, and the first 1000 characters.
You do NOT need to schedule polling tasks or check for completion markers — just delegate and wait. You will be
prompted again when they are done, and you can decide whether to inspect the saved file before acting on the result.
`
    : `
You are a scoop with restricted filesystem access:
- Your workspace: /scoops/${this.scoop.folder}/
- Shared directory: /shared/ (read-write for all scoops)
- Stay focused on your assigned tasks.
`
}

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
