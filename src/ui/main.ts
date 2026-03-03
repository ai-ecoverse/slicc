/**
 * Main entry point for the Browser Coding Agent UI.
 *
 * Bootstraps the layout, checks for API key, initializes the
 * filesystem + shell + browser API, creates the agent with all
 * tools, and wires the pi-style AgentHandle to the Chat UI.
 */

import { Layout } from './layout.js';
import { getApiKey, showApiKeyDialog } from './api-key-dialog.js';
import type { AgentHandle, AgentEvent as UIAgentEvent } from './types.js';
import { Agent, adaptTools, createLogger, getModel } from '../core/index.js';
import type { AgentEvent as CoreAgentEvent, AssistantMessage, AssistantMessageEvent, TextContent, Model } from '../core/index.js';
import { createFileTools, createBashTool, createBrowserTool, createSearchTools } from '../tools/index.js';
import { BrowserAPI } from '../cdp/index.js';

const log = createLogger('main');

const DEFAULT_MODEL_ID = 'claude-opus-4-6';

/** Resolve a model ID string to a pi-ai Model object. */
function resolveModel(modelId: string): Model<any> {
  try {
    return getModel('anthropic', modelId as any);
  } catch {
    // Fallback to default if the model ID isn't in the registry
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
  let messageCounter = 0;

  return (event: CoreAgentEvent) => {
    log.debug('Event adapter received', { type: event.type });
    switch (event.type) {
      case 'message_start': {
        if (event.message.role === 'assistant') {
          currentMessageId = `msg-${++messageCounter}`;
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
            emit({ type: 'error', error: (last as AssistantMessage).errorMessage! });
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

  // Build the layout
  const layout = new Layout(app);

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

  // Initialize the BrowserAPI
  const browser = new BrowserAPI();

  // Create tools (only include tools for subsystems that initialized)
  const legacyTools = [
    ...(fs ? createFileTools(fs) : []),
    ...(shell ? [createBashTool(shell)] : []),
    createBrowserTool(browser),
    ...(fs ? createSearchTools(fs) : []),
  ];
  const tools = adaptTools(legacyTools);
  log.info('Tools ready', tools.map((t) => t.name));

  // Create the pi-style agent
  const selectedModelId = localStorage.getItem('selected-model') || DEFAULT_MODEL_ID;
  const model = resolveModel(selectedModelId);

  const agent = new Agent({
    initialState: {
      model,
      tools,
      systemPrompt: `You are a helpful coding assistant running in a browser-based development environment.
You have access to a virtual filesystem, a shell, and browser automation tools.
Use the tools available to help the user with their tasks.`,
    },
    getApiKey: () => apiKey,
  });
  log.info('Agent created');

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
      } catch {
        // Don't let one listener break others
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
