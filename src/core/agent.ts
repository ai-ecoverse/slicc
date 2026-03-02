/**
 * Agent — pi-style agent that uses the agent loop.
 *
 * Manages state, message queues, and the agent loop lifecycle.
 * Ported from pi-mono's Agent class, simplified for browser use.
 */

import { agentLoop, agentLoopContinue } from './agent-loop.js';
import { createLogger } from './logger.js';
import { createAnthropicStreamFn } from './stream.js';
import { SessionStore } from './session.js';
import type {
  AgentConfig,
  AgentContext,
  AgentEvent,
  AgentEventListener,
  AgentLoopConfig,
  AgentMessage,
  AgentState,
  AgentTool,
  ImageContent,
  Message,
  SessionData,
  StreamFn,
  TextContent,
} from './types.js';

const log = createLogger('agent');

const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_SYSTEM_PROMPT = `You are a helpful coding assistant running in a browser-based development environment.
You have access to a virtual filesystem, a shell, and browser automation tools.
Use the tools available to help the user with their tasks.`;

/** Default convertToLlm: Keep only LLM-compatible messages, filtering empty content. */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult')
    .map((m) => {
      // Clean up assistant messages: remove empty text content blocks
      if (m.role === 'assistant' && Array.isArray((m as any).content)) {
        const content = (m as any).content.filter((block: any) => {
          if (block.type === 'text' && (!block.text || block.text.trim() === '')) {
            return false;
          }
          return true;
        });
        // If all content blocks were empty, skip this message entirely
        if (content.length === 0) return null;
        return { ...m, content };
      }
      return m;
    })
    .filter(Boolean) as Message[];
}

export interface AgentOptions {
  /** Agent configuration (API key, model, etc.). */
  config: AgentConfig;
  /** Tools available to the agent. */
  tools?: AgentTool[];
  /** Custom system prompt. */
  systemPrompt?: string;
  /** Custom convertToLlm function. */
  convertToLlm?: (messages: AgentMessage[]) => Message[];
  /** Custom context transform before convertToLlm. */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** Custom stream function. */
  streamFn?: StreamFn;
}

export class Agent {
  private _state: AgentState;
  private listeners = new Set<AgentEventListener>();
  private abortController?: AbortController;
  private convertToLlm: (messages: AgentMessage[]) => Message[];
  private transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  private steeringQueue: AgentMessage[] = [];
  private followUpQueue: AgentMessage[] = [];
  private streamFn: StreamFn;
  private config: AgentConfig;
  private sessionStore: SessionStore;
  private sessionId: string;
  private runningPrompt?: Promise<void>;
  private resolveRunningPrompt?: () => void;

  constructor(opts: AgentOptions) {
    this.config = opts.config;
    this._state = {
      systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model: opts.config.model ?? DEFAULT_MODEL,
      tools: opts.tools ?? [],
      messages: [],
      isStreaming: false,
      streamMessage: null,
      pendingToolCalls: new Set(),
      error: undefined,
    };
    this.convertToLlm = opts.convertToLlm ?? defaultConvertToLlm;
    this.transformContext = opts.transformContext;
    this.streamFn = opts.streamFn ?? createAnthropicStreamFn({
      maxTokens: opts.config.maxTokens,
      temperature: opts.config.temperature,
    });
    this.sessionStore = new SessionStore();
    this.sessionId = SessionStore.newId();
  }

  // ─── Public API ─────────────────────────────────────────────────────

  get state(): AgentState {
    return this._state;
  }

  /** Subscribe to agent events. Returns an unsubscribe function. */
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Alias for on() — matches pi-mono's API. */
  subscribe(fn: AgentEventListener): () => void {
    return this.on(fn);
  }

  /** Get the current conversation messages. */
  getMessages(): AgentMessage[] {
    return [...this._state.messages];
  }

  /** Get the session ID. */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Send a user message and run the agent loop.
   *
   * Matches the old Agent.sendMessage() API but uses pi's agent loop internally.
   * Returns the final AssistantMessage (for backwards compat with tests).
   */
  async sendMessage(userMessage: string): Promise<AgentMessage> {
    log.info('User message', { length: userMessage.length });

    const userMsg: AgentMessage = {
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    };

    await this._runLoop([userMsg]);

    // Return the last assistant message
    const msgs = this._state.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') return msgs[i];
    }
    throw new Error('No assistant response received');
  }

  /**
   * Send a prompt with an AgentMessage (pi-style API).
   */
  async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
    if (this._state.isStreaming) {
      throw new Error('Agent is already processing a prompt. Use steer() or followUp().');
    }

    let msgs: AgentMessage[];
    if (Array.isArray(input)) {
      msgs = input;
    } else if (typeof input === 'string') {
      const content: (TextContent | ImageContent)[] = [{ type: 'text', text: input }];
      if (images && images.length > 0) content.push(...images);
      msgs = [{ role: 'user', content, timestamp: Date.now() }];
    } else {
      msgs = [input];
    }

    await this._runLoop(msgs);
  }

  /** Queue a steering message (mid-run interruption). */
  steer(m: AgentMessage): void {
    this.steeringQueue.push(m);
  }

  /** Queue a follow-up message (post-completion). */
  followUp(m: AgentMessage): void {
    this.followUpQueue.push(m);
  }

  /** Abort the current request. */
  abort(): void {
    this.abortController?.abort();
  }

  /** Wait for the agent to finish processing. */
  waitForIdle(): Promise<void> {
    return this.runningPrompt ?? Promise.resolve();
  }

  /** Reset the conversation. */
  reset(): void {
    this.abort();
    this._state.messages = [];
    this._state.isStreaming = false;
    this._state.streamMessage = null;
    this._state.pendingToolCalls = new Set();
    this._state.error = undefined;
    this.steeringQueue = [];
    this.followUpQueue = [];
    this.sessionId = SessionStore.newId();
  }

  /** Update the API key. */
  setApiKey(apiKey: string): void {
    this.config.apiKey = apiKey;
    // Recreate stream function with new key
    this.streamFn = createAnthropicStreamFn({
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
    });
  }

  /** Update the system prompt. */
  setSystemPrompt(prompt: string): void {
    this._state.systemPrompt = prompt;
  }

  /** Update the model. */
  setModel(model: string): void {
    this._state.model = model;
    this.config.model = model;
  }

  /** Update the tools. */
  setTools(tools: AgentTool[]): void {
    this._state.tools = tools;
  }

  // ─── Session Persistence ──────────────────────────────────────────────

  async loadSession(id: string): Promise<boolean> {
    const session = await this.sessionStore.load(id);
    if (!session) return false;
    this.sessionId = session.id;
    this._state.messages = session.messages;
    return true;
  }

  async saveSession(): Promise<void> {
    const data: SessionData = {
      id: this.sessionId,
      messages: this._state.messages,
      config: {
        model: this.config.model,
        maxTokens: this.config.maxTokens,
        systemPrompt: this.config.systemPrompt,
        temperature: this.config.temperature,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.sessionStore.save(data);
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private dequeueSteeringMessages(): AgentMessage[] {
    if (this.steeringQueue.length > 0) {
      const first = this.steeringQueue[0];
      this.steeringQueue = this.steeringQueue.slice(1);
      return [first];
    }
    return [];
  }

  private dequeueFollowUpMessages(): AgentMessage[] {
    if (this.followUpQueue.length > 0) {
      const first = this.followUpQueue[0];
      this.followUpQueue = this.followUpQueue.slice(1);
      return [first];
    }
    return [];
  }

  private async _runLoop(messages?: AgentMessage[]): Promise<void> {
    log.debug('Run loop start', { messageCount: messages?.length ?? 0, totalMessages: this._state.messages.length });

    this.runningPrompt = new Promise<void>((resolve) => {
      this.resolveRunningPrompt = resolve;
    });

    this.abortController = new AbortController();
    this._state.isStreaming = true;
    this._state.streamMessage = null;
    this._state.error = undefined;

    const context: AgentContext = {
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages.slice(),
      tools: this._state.tools,
    };

    const config: AgentLoopConfig = {
      model: this._state.model,
      streamFn: this.streamFn,
      apiKey: this.config.apiKey,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      getApiKey: async () => this.config.apiKey,
      getSteeringMessages: async () => this.dequeueSteeringMessages(),
      getFollowUpMessages: async () => this.dequeueFollowUpMessages(),
    };

    try {
      const stream = messages
        ? agentLoop(messages, context, config, this.abortController.signal)
        : agentLoopContinue(context, config, this.abortController.signal);

      for await (const event of stream) {
        // Update internal state
        switch (event.type) {
          case 'message_start':
            this._state.streamMessage = event.message;
            break;
          case 'message_update':
            this._state.streamMessage = event.message;
            break;
          case 'message_end':
            this._state.streamMessage = null;
            this._state.messages.push(event.message);
            break;
          case 'tool_execution_start': {
            const s = new Set(this._state.pendingToolCalls);
            s.add(event.toolCallId);
            this._state.pendingToolCalls = s;
            break;
          }
          case 'tool_execution_end': {
            const s = new Set(this._state.pendingToolCalls);
            s.delete(event.toolCallId);
            this._state.pendingToolCalls = s;
            break;
          }
          case 'agent_end':
            this._state.isStreaming = false;
            this._state.streamMessage = null;
            break;
        }

        // Emit to listeners
        this.emit(event);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error('Run loop error', errorMsg);
      this._state.error = errorMsg;
      this.emit({ type: 'agent_end', messages: [] });
    } finally {
      this._state.isStreaming = false;
      this._state.streamMessage = null;
      this._state.pendingToolCalls = new Set();
      this.abortController = undefined;
      this.resolveRunningPrompt?.();
      this.runningPrompt = undefined;
      this.resolveRunningPrompt = undefined;

      // Auto-save session
      await this.saveSession().catch(() => {});
      log.debug('Session saved', { id: this.sessionId });
    }
  }

  private emit(event: AgentEvent): void {
    log.debug('Emit event', { type: event.type, listenerCount: this.listeners.size });
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let one listener break others
      }
    }
  }
}
