/**
 * Main entry point for the Browser Coding Agent UI.
 *
 * Bootstraps the layout, checks for API key, initializes the
 * filesystem + shell + browser API, creates the agent with all
 * tools, and wires the pi-style AgentHandle to the Chat UI.
 */

import { Layout } from './layout.js';
import { getApiKey, getProvider, getAzureResource, getBedrockRegion, showApiKeyDialog } from './api-key-dialog.js';
import type { ApiProvider } from './api-key-dialog.js';
import type { AgentHandle, AgentEvent as UIAgentEvent } from './types.js';
import { Agent, adaptTools, createLogger, getModel } from '../core/index.js';
import type { AgentEvent as CoreAgentEvent, AssistantMessage, AssistantMessageEvent, TextContent, Model } from '../core/index.js';
import { createFileTools, createBashTool, createBrowserTool, createSearchTools, createJavaScriptTool } from '../tools/index.js';
import { BrowserAPI, DebuggerClient } from '../cdp/index.js';

const log = createLogger('main');

const DEFAULT_MODEL_ID = 'claude-opus-4-6';

/** Resolve a model ID and override baseUrl for Azure/Bedrock providers. */
function resolveModel(modelId: string): Model<any> {
  try {
    let model = getModel('anthropic', modelId as any);
    const provider = getProvider();
    if (provider === 'azure') {
      const resource = getAzureResource();
      if (resource) {
        // Azure AI Foundry: resource name → https://{name}.services.ai.azure.com/anthropic
        const baseUrl = resource.includes('://')
          ? resource  // full URL provided
          : `https://${resource}.services.ai.azure.com/anthropic`;
        model = { ...model, baseUrl };
      }
    } else if (provider === 'bedrock') {
      const endpoint = getBedrockRegion();
      if (endpoint) {
        const baseUrl = endpoint.startsWith('https://') ? endpoint : `https://${endpoint}`;
        model = { ...model, baseUrl };
      }
    }
    return model;
  } catch (err) {
    log.error('Failed to resolve model, falling back to default', {
      modelId,
      provider: getProvider(),
      error: err instanceof Error ? err.message : String(err),
    });
    return getModel('anthropic', DEFAULT_MODEL_ID as any);
  }
}

/**
 * Adapt pi-style AgentEvent stream to UI AgentEvent stream.
 *
 * Pi's agent loop emits fine-grained events (message_start, message_update,
 * message_end, tool_execution_start/end, turn_start/end, agent_start/end).
 * The UI expects a simpler event stream (message_start, content_delta,
 * tool_use_start, tool_result, turn_end, error).
 */
function createEventAdapter(
  emit: (event: UIAgentEvent) => void,
): (event: CoreAgentEvent) => void {
  let currentMessageId = '';
  // Use timestamp+random to avoid ID collisions with restored session messages
  const sessionPrefix = Date.now().toString(36);
  let messageCounter = 0;

  return (event: CoreAgentEvent) => {
    log.debug('Event adapter received', { type: event.type });
    switch (event.type) {
      case 'message_start': {
        if (event.message.role === 'assistant') {
          currentMessageId = `msg-${sessionPrefix}-${++messageCounter}`;
          emit({ type: 'message_start', messageId: currentMessageId });
        }
        break;
      }

      case 'message_update': {
        // Extract text deltas from the assistant message event
        const ame = event.assistantMessageEvent as AssistantMessageEvent;
        if (ame.type === 'text_delta') {
          emit({
            type: 'content_delta',
            messageId: currentMessageId,
            text: ame.delta,
          });
        }
        break;
      }

      case 'message_end': {
        if (event.message.role === 'assistant') {
          emit({ type: 'content_done', messageId: currentMessageId });
        }
        break;
      }

      case 'tool_execution_start': {
        emit({
          type: 'tool_use_start',
          messageId: currentMessageId,
          toolName: event.toolName,
          toolInput: event.args,
        });
        break;
      }

      case 'tool_execution_end': {
        // Extract text content from tool result
        const result = event.result as { content: (TextContent | { type: 'image'; data: string; mimeType: string })[] };
        const textContent = result?.content
          ?.filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n') ?? '';

        emit({
          type: 'tool_result',
          messageId: currentMessageId,
          toolName: event.toolName,
          result: textContent,
          isError: event.isError,
        });

        // Check for screenshot results
        if (event.toolName === 'browser' && textContent.includes('Screenshot captured')) {
          // Screenshots are in the text result
        }
        break;
      }

      case 'turn_end': {
        emit({ type: 'turn_end', messageId: currentMessageId });
        break;
      }

      case 'agent_end': {
        // Check if the last message has an error
        const messages = event.messages;
        if (messages.length > 0) {
          const last = messages[messages.length - 1];
          if (last.role === 'assistant' && (last as AssistantMessage).errorMessage) {
            const err = (last as AssistantMessage).errorMessage!;
            log.error('Agent error', err);
            emit({ type: 'error', error: err });
          }
        }
        break;
      }

      // agent_start, turn_start — no UI equivalent
      default:
        break;
    }
  };
}

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app element not found');

  // Check for API key (first-run dialog)
  let apiKey = getApiKey();
  if (!apiKey) {
    apiKey = await showApiKeyDialog();
  }

  // Build the layout — tabbed in extension mode, split panels in standalone
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  const layout = new Layout(app, isExtension);

  // Initialize session persistence
  await layout.panels.chat.initSession();
  log.info('Session initialized');

  // Initialize subsystems with error isolation — agent should work even if
  // the virtual filesystem or shell fail to initialize.
  let fs: import('../fs/index.js').VirtualFS | null = null;
  let shell: import('../shell/index.js').WasmShell | null = null;

  try {
    const { VirtualFS } = await import('../fs/index.js');
    fs = await VirtualFS.create();
    log.info('VirtualFS ready');
  } catch (e) {
    log.error('VirtualFS init failed', e);
  }

  try {
    const { WasmShell } = await import('../shell/index.js');
    if (fs) {
      shell = new WasmShell({ fs });
      log.info('WasmShell ready');
    } else {
      log.warn('Skipping shell — no filesystem');
    }
  } catch (e) {
    log.error('WasmShell init failed', e);
  }

  if (shell) {
    try {
      await layout.panels.terminal.mountShell(shell);
      log.info('Terminal mounted');
    } catch (e) {
      log.warn('Failed to mount shell to terminal', e);
    }
  }

  if (fs) {
    layout.panels.fileBrowser.setFs(fs);
    log.info('File browser wired to VFS');
  }

  // Initialize the BrowserAPI — use chrome.debugger in extension mode, WebSocket in CLI mode
  const browser = isExtension
    ? new BrowserAPI(new DebuggerClient())
    : new BrowserAPI();

  // Create tools (only include tools for subsystems that initialized)
  const legacyTools = [
    ...(fs ? createFileTools(fs) : []),
    ...(shell ? [createBashTool(shell)] : []),
    createBrowserTool(browser, fs),
    ...(fs ? createSearchTools(fs) : []),
    ...(fs ? [createJavaScriptTool(fs)] : []),
  ];
  const tools = adaptTools(legacyTools);
  log.info('Tools ready', tools.map((t) => t.name));

  // Create the pi-style agent
  const selectedModelId = localStorage.getItem('selected-model') || DEFAULT_MODEL_ID;
  const model = resolveModel(selectedModelId);

  // Context compaction: truncate oversized tool results and drop old messages when near token limit.
  // Rough estimate: 1 token ≈ 4 chars for English text.
  const MAX_RESULT_CHARS = 8000; // ~2000 tokens per tool result max
  const MAX_CONTEXT_CHARS = 600000; // ~150K tokens — leave headroom below the 200K limit

  async function compactContext(messages: import('../core/index.js').AgentMessage[]): Promise<import('../core/index.js').AgentMessage[]> {
    // Step 1: truncate oversized content in tool result messages
    const truncated = messages.map((msg) => {
      if (msg.role === 'toolResult' && Array.isArray((msg as any).content)) {
        const content = (msg as any).content as Array<{ type: 'text'; text?: string }>;
        const needsTruncation = content.some((c) => c.type === 'text' && c.text && c.text.length > MAX_RESULT_CHARS);
        if (needsTruncation) {
          return {
            ...msg,
            content: content.map((c) =>
              c.type === 'text' && c.text && c.text.length > MAX_RESULT_CHARS
                ? { ...c, text: c.text.slice(0, MAX_RESULT_CHARS) + '\n... (truncated)' }
                : c,
            ),
          } as typeof msg;
        }
      }
      return msg;
    });

    // Step 2: estimate total size and drop older messages if too large
    const estimateSize = (msgs: typeof truncated): number => {
      return msgs.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
    };

    let result = truncated;
    let totalChars = estimateSize(result);

    // Keep dropping oldest non-system messages until under limit (preserve first 2 and last 10)
    // Safety limit to prevent infinite loop if compaction can't reduce size enough
    let compactionRounds = 0;
    while (totalChars > MAX_CONTEXT_CHARS && result.length > 12 && compactionRounds < 50) {
      compactionRounds++;
      const compactedMsg = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: '[Earlier conversation messages were compacted to save context space]' }],
      };
      result = [result[0], result[1], compactedMsg as any, ...result.slice(result.length - 10)];
      totalChars = estimateSize(result);
    }
    if (compactionRounds >= 50) {
      log.warn('Context compaction hit iteration limit', { finalChars: totalChars, finalMessages: result.length });
    }

    if (totalChars !== estimateSize(messages)) {
      log.info('Context compacted', {
        originalMessages: messages.length,
        compactedMessages: result.length,
        originalChars: estimateSize(messages),
        compactedChars: totalChars,
      });
    }

    return result;
  }

  const agent = new Agent({
    initialState: {
      model,
      tools,
      systemPrompt: `You are a helpful coding assistant running in a browser-based development environment.
You have access to a virtual filesystem, a shell, and browser automation tools.
Use the tools available to help the user with their tasks.`,
    },
    getApiKey: () => apiKey,
    transformContext: compactContext,
  });
  log.info('Agent created', { provider: getProvider(), model: model.id });

  // Wire model picker changes to agent
  layout.onModelChange = (modelId) => {
    agent.setModel(resolveModel(modelId));
  };

  // Build the real AgentHandle that bridges agent core ↔ chat UI
  const eventListeners = new Set<(event: UIAgentEvent) => void>();

  const emitToUI = (event: UIAgentEvent): void => {
    log.debug('Emit to UI', { type: event.type, listenerCount: eventListeners.size });
    for (const cb of eventListeners) {
      try {
        cb(event);
      } catch (err) {
        log.error('Listener error', { eventType: event.type, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  // Wire the event adapter: pi agent events → UI events
  const adapter = createEventAdapter(emitToUI);
  agent.subscribe(adapter);

  const agentHandle: AgentHandle = {
    sendMessage(text: string): void {
      // Fire-and-forget: the UI's sendMessage is void, but Agent's prompt is async.
      // Errors are communicated via the event system.
      agent.prompt(text).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        emitToUI({ type: 'error', error: message });
      });
    },

    onEvent(callback: (event: UIAgentEvent) => void): () => void {
      eventListeners.add(callback);
      return () => eventListeners.delete(callback);
    },

    stop(): void {
      agent.abort();
    },
  };

  layout.panels.chat.setAgent(agentHandle);
  log.info('Agent wired to chat UI — ready');
}

main().catch((err) => {
  log.error('Fatal error', err);
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = `
      <div style="padding: 2rem; text-align: center;">
        <h1 style="color: #e94560;">Failed to start</h1>
        <p style="color: #a0a0b0;">${err.message}</p>
      </div>
    `;
  }
});
