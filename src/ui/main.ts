/**
 * Main entry point for the Browser Coding Agent UI.
 *
 * Bootstraps the layout, checks for API key, initializes the
 * filesystem + shell + browser API, creates the agent with all
 * tools, and wires the pi-style AgentHandle to the Chat UI.
 */

import { Layout } from './layout.js';
import {
  getApiKey,
  getSelectedProvider,
  getBaseUrl,
  showProviderSettings,
  resolveCurrentModel,
} from './provider-settings.js';
import type { AgentHandle, AgentEvent as UIAgentEvent } from './types.js';
import { Agent, adaptTools, createLogger, getModel } from '../core/index.js';
import type { AgentEvent as CoreAgentEvent, AssistantMessage, AssistantMessageEvent, TextContent, Model } from '../core/index.js';
import { createFileTools, createBashTool, createBrowserTool } from '../tools/index.js';
import { BrowserAPI, DebuggerClient } from '../cdp/index.js';
import { Orchestrator } from '../groups/index.js';
import type { RegisteredGroup, ChannelMessage } from '../groups/types.js';

const log = createLogger('main');

const DEFAULT_MODEL_ID = 'claude-sonnet-4-20250514';

/** Resolve a model ID using the new provider settings. */
function resolveModel(modelId?: string): Model<any> {
  try {
    // Use resolveCurrentModel which handles provider + baseUrl
    if (!modelId) {
      return resolveCurrentModel();
    }
    // If a specific modelId is requested, get it from the selected provider
    const providerId = getSelectedProvider();
    let model = getModel(providerId as any, modelId as any);
    const baseUrl = getBaseUrl();
    if (baseUrl) {
      model = { ...model, baseUrl };
    }
    return model;
  } catch (err) {
    log.error('Failed to resolve model, falling back to default', {
      modelId,
      provider: getSelectedProvider(),
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

  // Check for API key (first-run provider settings dialog)
  let apiKey = getApiKey();
  if (!apiKey) {
    await showProviderSettings();
    apiKey = getApiKey();
    if (!apiKey) {
      throw new Error('API key required');
    }
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
  ];
  const tools = adaptTools(legacyTools);
  log.info('Tools ready', tools.map((t) => t.name));

  // Create the pi-style agent
  const model = resolveCurrentModel();

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
  log.info('Agent created', { provider: getSelectedProvider(), model: model.id });

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

  // Track currently selected group for routing
  let selectedGroup: RegisteredGroup | null = null;
  
  // Track current message ID per group (unique per response)
  const groupCurrentMessageId = new Map<string, string>();

  // Initialize the group orchestrator
  const orchestrator = new Orchestrator(
    layout.getIframeContainer(),
    {
      onResponse: (groupJid, text, isPartial) => {
        log.debug('Group response', { groupJid, textLength: text.length, isPartial });
        // Route to chat UI if this is the selected group
        if (selectedGroup?.jid === groupJid) {
          // Start a new message if we don't have one
          let messageId = groupCurrentMessageId.get(groupJid);
          if (!messageId) {
            messageId = `group-${groupJid}-${Date.now()}`;
            groupCurrentMessageId.set(groupJid, messageId);
            emitToUI({ type: 'message_start', messageId });
          }
          
          if (isPartial) {
            emitToUI({ type: 'content_delta', messageId, text });
          } else {
            // Full response
            emitToUI({ type: 'content_delta', messageId, text });
            emitToUI({ type: 'content_done', messageId });
          }
        }
      },
      onResponseDone: (groupJid) => {
        log.debug('Group response done', { groupJid });
        if (selectedGroup?.jid === groupJid) {
          const messageId = groupCurrentMessageId.get(groupJid);
          if (messageId) {
            emitToUI({ type: 'content_done', messageId });
            emitToUI({ type: 'turn_end', messageId });
            // Clear for next message
            groupCurrentMessageId.delete(groupJid);
          }
        }
      },
      onSendMessage: (targetJid, text) => {
        log.debug('Send message requested', { targetJid, textLength: text.length });
        // Route to the target group
        const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const msg: ChannelMessage = {
          id: msgId,
          chatJid: targetJid,
          senderId: 'assistant',
          senderName: 'sliccy',
          content: text,
          timestamp: new Date().toISOString(),
          fromAssistant: true,
          channel: 'web',
        };
        orchestrator.handleMessage(msg);
        // Also render this message into the chat UI for the currently selected group
        if (selectedGroup?.jid === targetJid) {
          emitToUI({ type: 'message_start', messageId: msgId });
          emitToUI({ type: 'content_delta', messageId: msgId, text });
          emitToUI({ type: 'content_done', messageId: msgId });
        }
      },
      onStatusChange: (groupJid, status) => {
        layout.panels.groups.updateGroupStatus(groupJid, status);
      },
      onError: (groupJid, error) => {
        log.error('Group error', { groupJid, error });
        if (selectedGroup?.jid === groupJid) {
          emitToUI({ type: 'error', error });
        }
      },
      getBrowserAPI: () => browser,
      onToolStart: (groupJid, toolName, toolInput) => {
        if (selectedGroup?.jid === groupJid) {
          const messageId = groupCurrentMessageId.get(groupJid);
          if (messageId) {
            emitToUI({ type: 'tool_use_start', messageId, toolName, toolInput });
          }
        }
      },
      onToolEnd: (groupJid, toolName, result, isError) => {
        if (selectedGroup?.jid === groupJid) {
          const messageId = groupCurrentMessageId.get(groupJid);
          if (messageId) {
            emitToUI({ type: 'tool_result', messageId, toolName, result, isError });
          }
        }
      },
    },
  );

  await orchestrator.init();
  layout.panels.groups.setOrchestrator(orchestrator);
  layout.panels.memory.setOrchestrator(orchestrator);

  // Create main group if it doesn't exist
  const groups = orchestrator.getGroups();
  const hasMain = groups.some((g) => g.isMain);
  if (!hasMain) {
    const mainGroup = await layout.panels.groups.createGroup('Main', true);
    selectedGroup = mainGroup;
    log.info('Created main group');
  } else {
    // Select the main group by default
    selectedGroup = groups.find((g) => g.isMain) ?? groups[0];
  }

  // Set initial group for memory panel
  if (selectedGroup) {
    layout.panels.memory.setSelectedGroup(selectedGroup.jid);
  }

  // Wire group selection to chat and memory panel
  layout.onGroupSelect = async (group) => {
    log.info('Group selected', { jid: group.jid, name: group.name });
    selectedGroup = group;
    // Create the group's iframe if not already running
    orchestrator.createGroupTab(group.jid);
    // Update memory panel
    layout.panels.memory.setSelectedGroup(group.jid);
    // Load and display message history for this group
    await loadGroupChatHistory(group.jid);
  };

  // Load chat history for a group
  async function loadGroupChatHistory(jid: string): Promise<void> {
    const messages = await orchestrator.getMessagesForGroup(jid);
    // Clear current chat and load history
    layout.panels.chat.clear();
    for (const msg of messages) {
      const messageId = msg.id;
      if (msg.fromAssistant) {
        emitToUI({ type: 'message_start', messageId });
        emitToUI({ type: 'content_delta', messageId, text: msg.content });
        emitToUI({ type: 'content_done', messageId });
      } else {
        // User message - add directly to chat panel
        layout.panels.chat.addUserMessage(msg.content);
      }
    }
  }

  // Create a group-aware agent handle that routes to orchestrator
  const groupAgentHandle: AgentHandle = {
    sendMessage(text: string): void {
      if (!selectedGroup) {
        emitToUI({ type: 'error', error: 'No group selected' });
        return;
      }
      
      // Create a message and route through orchestrator
      const msg: ChannelMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chatJid: selectedGroup.jid,
        senderId: 'user',
        senderName: 'User',
        content: text,
        timestamp: new Date().toISOString(),
        fromAssistant: false,
        channel: 'web',
      };
      
      // Store and route the message
      orchestrator.handleMessage(msg);
      
      // Also create the group tab if needed
      orchestrator.createGroupTab(selectedGroup.jid);
    },

    onEvent(callback: (event: UIAgentEvent) => void): () => void {
      eventListeners.add(callback);
      return () => eventListeners.delete(callback);
    },

    stop(): void {
      // Stop the current group's processing via the orchestrator
      if (selectedGroup) {
        orchestrator.getGroupContext(selectedGroup.jid)?.stop();
      }
    },
  };

  // Use the group-aware agent handle instead of the direct agent handle
  layout.panels.chat.setAgent(groupAgentHandle);

  // Initialize the selected group's tab
  if (selectedGroup) {
    orchestrator.createGroupTab(selectedGroup.jid);
  }

  // Note: Task scheduler is now managed by the orchestrator
  log.info('Orchestrator initialized with integrated scheduler', { groupCount: orchestrator.getGroups().length });

  // ---------------------------------------------------------------------------
  // Webhook event listener — connects to CLI server's /webhooks-ws endpoint
  // Injects webhook events into the agent conversation as tool results
  // ---------------------------------------------------------------------------
  if (!isExtension) {
    // Only in CLI mode (webhooks require the CLI server)
    const wsUrl = `ws://${window.location.host}/webhooks-ws`;
    let webhookWs: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    function connectWebhookWs(): void {
      if (webhookWs?.readyState === WebSocket.OPEN) return;

      webhookWs = new WebSocket(wsUrl);

      webhookWs.onopen = () => {
        log.info('Webhook WebSocket connected');
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      };

      webhookWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'webhook') {
            log.info('Webhook event received', { webhookName: data.webhookName, webhookId: data.webhookId });

            // Format the webhook payload for the agent
            const webhookContent = `Webhook "${data.webhookName}" received at ${data.timestamp}:\n\`\`\`json\n${JSON.stringify(data.body, null, 2)}\n\`\`\``;

            // Inject as a user message to the main agent
            // This allows the agent to process the webhook data
            if (selectedGroup?.isMain) {
              const msg: ChannelMessage = {
                id: `webhook-${data.webhookId}-${Date.now()}`,
                chatJid: selectedGroup.jid,
                senderId: 'webhook',
                senderName: `webhook:${data.webhookName}`,
                content: webhookContent,
                timestamp: data.timestamp,
                fromAssistant: false,
                channel: 'webhook',
              };
              orchestrator.handleMessage(msg);
              log.debug('Webhook message injected into orchestrator');
            }
          }
        } catch (err) {
          log.warn('Failed to parse webhook event', { error: err instanceof Error ? err.message : String(err) });
        }
      };

      webhookWs.onclose = () => {
        log.debug('Webhook WebSocket closed, reconnecting in 3s...');
        webhookWs = null;
        reconnectTimer = window.setTimeout(connectWebhookWs, 3000);
      };

      webhookWs.onerror = (err) => {
        log.warn('Webhook WebSocket error', { error: String(err) });
      };
    }

    // Start the webhook connection
    connectWebhookWs();
  }
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
