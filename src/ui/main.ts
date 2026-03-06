/**
 * Main entry point for the Browser Coding Agent UI.
 *
 * Bootstraps the layout, checks for API key, initializes the
 * orchestrator with cone + scoops, and wires events to the Chat UI.
 * Always uses cone+orchestrator mode — no direct agent path.
 */

import { Layout } from './layout.js';
import { getApiKey, showProviderSettings } from './provider-settings.js';
import type { AgentHandle, AgentEvent as UIAgentEvent, ChatMessage, ToolCall } from './types.js';
import { createLogger } from '../core/index.js';
import { BrowserAPI, DebuggerClient } from '../cdp/index.js';
import { Orchestrator } from '../scoops/index.js';
import type { RegisteredScoop, ChannelMessage } from '../scoops/types.js';

const log = createLogger('main');

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app element not found');

  // Register preview service worker (serves VFS content at /preview/*)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/preview-sw.js', { scope: '/preview/' })
      .then(() => log.info('Preview SW registered'))
      .catch(err => log.warn('Preview SW registration failed', err));
  }

  // Check for API key (first-run dialog)
  let apiKey = getApiKey();
  if (!apiKey) {
    await showProviderSettings();
    apiKey = getApiKey();
  }

  // Build the layout — tabbed in extension mode, split panels in standalone
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  const layout = new Layout(app, isExtension);

  // Initialize session persistence — use 'session-cone' from the start
  // so it matches the contextId used in switchToContext()
  await layout.panels.chat.initSession('session-cone');
  log.info('Session initialized');

  // Initialize the BrowserAPI
  const browser = isExtension
    ? new BrowserAPI(new DebuggerClient())
    : new BrowserAPI();

  // Event system for UI
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

  // Track currently selected scoop for routing
  let selectedScoop: RegisteredScoop | null = null;

  // Track current message ID per scoop (unique per response)
  const scoopCurrentMessageId = new Map<string, string>();

  // ── Per-scoop message buffers ──────────────────────────────────────
  // Captures ALL scoop events (tool calls, content, etc.) regardless of
  // which scoop is currently selected. When switching views, we load from
  // the buffer so nothing is lost.
  const scoopMessageBuffers = new Map<string, ChatMessage[]>();

  function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** Get or create buffer for a scoop. */
  function getBuffer(jid: string): ChatMessage[] {
    let buf = scoopMessageBuffers.get(jid);
    if (!buf) { buf = []; scoopMessageBuffers.set(jid, buf); }
    return buf;
  }

  /** Get the current (last) assistant message in a buffer, or create one. */
  function getOrCreateAssistantMsg(jid: string): ChatMessage {
    const buf = getBuffer(jid);
    let msgId = scoopCurrentMessageId.get(jid);
    if (msgId) {
      const existing = buf.find(m => m.id === msgId);
      if (existing) return existing;
    }
    // Create new assistant message
    msgId = `scoop-${jid}-${uid()}`;
    scoopCurrentMessageId.set(jid, msgId);
    const msg: ChatMessage = { id: msgId, role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [], isStreaming: true };
    buf.push(msg);
    // Emit to UI if this is the selected scoop
    if (selectedScoop?.jid === jid) {
      emitToUI({ type: 'message_start', messageId: msgId });
    }
    return msg;
  }

  // Initialize the orchestrator (always — no direct agent mode)
  const orchestrator = new Orchestrator(
    layout.getIframeContainer(),
    {
      onResponse: (scoopJid, text, isPartial) => {
        // Always buffer
        const msg = getOrCreateAssistantMsg(scoopJid);
        if (isPartial) {
          msg.content += text;
        } else {
          msg.content = text;
          msg.isStreaming = false;
        }
        // Emit to UI if selected
        if (selectedScoop?.jid === scoopJid) {
          emitToUI({ type: 'content_delta', messageId: msg.id, text });
          if (!isPartial) {
            emitToUI({ type: 'content_done', messageId: msg.id });
          }
        }
      },
      onResponseDone: (scoopJid) => {
        // Per-turn: finalize message, clear ID so next turn creates a new one
        const buf = getBuffer(scoopJid);
        const msgId = scoopCurrentMessageId.get(scoopJid);
        if (msgId) {
          const msg = buf.find(m => m.id === msgId);
          if (msg) msg.isStreaming = false;
          if (selectedScoop?.jid === scoopJid) {
            emitToUI({ type: 'content_done', messageId: msgId });
          }
          scoopCurrentMessageId.delete(scoopJid);
        }
      },
      onSendMessage: (targetJid, text) => {
        log.debug('Send message requested', { targetJid, textLength: text.length });
        const msgId = `msg-${uid()}`;
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
        // Buffer as a system-like message for the source scoop
        const buf = getBuffer(targetJid);
        buf.push({ id: msgId, role: 'assistant', content: text, timestamp: Date.now() });
        if (selectedScoop?.jid === targetJid) {
          emitToUI({ type: 'message_start', messageId: msgId });
          emitToUI({ type: 'content_delta', messageId: msgId, text });
          emitToUI({ type: 'content_done', messageId: msgId });
        }
      },
      onStatusChange: (scoopJid, status) => {
        layout.panels.scoops.updateScoopStatus(scoopJid, status);
        layout.updateScoopSwitcherStatus?.(scoopJid, status);

        if (selectedScoop?.jid === scoopJid) {
          if (status === 'processing') {
            layout.panels.chat.setProcessing(true);
          } else if (status === 'ready') {
            layout.panels.chat.setProcessing(false);
            const messageId = scoopCurrentMessageId.get(scoopJid) ?? `done-${scoopJid}-${uid()}`;
            scoopCurrentMessageId.delete(scoopJid);
            emitToUI({ type: 'turn_end', messageId });
          }
        }
      },
      onError: (scoopJid, error) => {
        log.error('Scoop error', { scoopJid, error });
        if (selectedScoop?.jid === scoopJid) {
          emitToUI({ type: 'error', error });
        }
      },
      getBrowserAPI: () => browser,
      onToolStart: (scoopJid, toolName, toolInput) => {
        // Hide infrastructure tools from the chat (their output is shown elsewhere)
        const hiddenTools = new Set(['send_message', 'list_scoops', 'list_tasks']);
        if (hiddenTools.has(toolName)) return;

        // Always buffer tool calls
        const msg = getOrCreateAssistantMsg(scoopJid);
        if (!msg.toolCalls) msg.toolCalls = [];
        msg.toolCalls.push({ id: uid(), name: toolName, input: toolInput });
        // Emit to UI if selected
        if (selectedScoop?.jid === scoopJid) {
          emitToUI({ type: 'tool_use_start', messageId: msg.id, toolName, toolInput });
        }
      },
      onToolEnd: (scoopJid, toolName, result, isError) => {
        const hiddenTools = new Set(['send_message', 'list_scoops', 'list_tasks']);
        if (hiddenTools.has(toolName)) return;

        // Always buffer tool results
        const buf = getBuffer(scoopJid);
        const msgId = scoopCurrentMessageId.get(scoopJid);
        if (msgId) {
          const msg = buf.find(m => m.id === msgId);
          if (msg?.toolCalls) {
            const tc = [...msg.toolCalls].reverse().find(t => t.name === toolName && t.result === undefined);
            if (tc) { tc.result = result; tc.isError = isError; }
          }
        }
        // Emit to UI if selected
        if (selectedScoop?.jid === scoopJid && msgId) {
          emitToUI({ type: 'tool_result', messageId: msgId, toolName, result, isError });
        }
      },
    },
  );

  await orchestrator.init();
  layout.panels.scoops.setOrchestrator(orchestrator);
  layout.panels.memory.setOrchestrator(orchestrator);
  layout.setScoopSwitcherOrchestrator?.(orchestrator);

  // Wire shared FS to file browser and terminal
  const sharedFs = orchestrator.getSharedFS();
  if (sharedFs) {
    layout.panels.fileBrowser.setFs(sharedFs);
    log.info('File browser wired to shared VFS');

    try {
      const { WasmShell } = await import('../shell/index.js');
      const shell = new WasmShell({ fs: sharedFs });
      await layout.panels.terminal.mountShell(shell);
      log.info('Terminal mounted with shared VFS');
    } catch (e) {
      log.warn('Failed to mount shell to terminal', e);
    }
  }

  // Create cone if it doesn't exist
  const scoops = orchestrator.getScoops();
  const hasCone = scoops.some((s) => s.isCone);
  if (!hasCone) {
    const cone = await layout.panels.scoops.createScoop('Cone', true);
    selectedScoop = cone;
    log.info('Created cone');
  } else {
    selectedScoop = scoops.find((s) => s.isCone) ?? scoops[0];
  }

  // Set initial scoop for memory panel
  if (selectedScoop) {
    layout.panels.memory.setSelectedScoop(selectedScoop.jid);
  }

  // Build the cone agent handle — all user input routes through orchestrator
  const coneAgentHandle: AgentHandle = {
    sendMessage(text: string): void {
      if (!selectedScoop) {
        emitToUI({ type: 'error', error: 'No scoop selected' });
        return;
      }

      const msg: ChannelMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chatJid: selectedScoop.jid,
        senderId: 'user',
        senderName: 'User',
        content: text,
        timestamp: new Date().toISOString(),
        fromAssistant: false,
        channel: 'web',
      };

      // Buffer the user message for this scoop
      getBuffer(selectedScoop.jid).push({
        id: msg.id, role: 'user', content: text, timestamp: Date.now(),
      });

      orchestrator.handleMessage(msg);
      orchestrator.createScoopTab(selectedScoop.jid);
    },

    onEvent(callback: (event: UIAgentEvent) => void): () => void {
      eventListeners.add(callback);
      return () => eventListeners.delete(callback);
    },

    stop(): void {
      if (selectedScoop) {
        orchestrator.stopScoop(selectedScoop.jid);
      }
    },
  };

  layout.panels.chat.setAgent(coneAgentHandle);
  log.info('Cone agent handle wired to chat UI');

  // Wire model picker changes
  layout.onModelChange = (modelId) => {
    // Model changes are picked up by scoop-context on next init
    localStorage.setItem('selected-model', modelId);
  };

  // Wire clear chat to also clear orchestrator messages + buffers
  layout.onClearChat = async () => {
    await orchestrator.clearAllMessages();
    scoopMessageBuffers.clear();
  };

  // Wire scoop selection
  const handleScoopSelect = async (scoop: RegisteredScoop) => {
    log.info('Scoop selected', { jid: scoop.jid, name: scoop.name });
    selectedScoop = scoop;
    orchestrator.createScoopTab(scoop.jid);

    // Update memory panel
    layout.panels.memory.setSelectedScoop(scoop.jid);

    // Switch chat context. Load from per-scoop message buffer (has full tool call detail)
    // falling back to SessionStore, then orchestrator DB.
    const contextId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
    const buffer = scoopMessageBuffers.get(scoop.jid);

    if (buffer && buffer.length > 0) {
      // Load from in-memory buffer (has tool calls captured during this session)
      await layout.panels.chat.switchToContext(contextId, !scoop.isCone);
      layout.panels.chat.loadMessages(buffer);
    } else {
      // No buffer — load from SessionStore (persisted from previous sessions)
      await layout.panels.chat.switchToContext(contextId, !scoop.isCone);

      // If still empty, fall back to orchestrator DB (simple text, no tool calls)
      if (layout.panels.chat.getMessages().length === 0) {
        const messages = await orchestrator.getMessagesForScoop(scoop.jid);
        for (const msg of messages) {
          if (msg.fromAssistant) {
            emitToUI({ type: 'message_start', messageId: msg.id });
            emitToUI({ type: 'content_delta', messageId: msg.id, text: msg.content });
            emitToUI({ type: 'content_done', messageId: msg.id });
          } else {
            layout.panels.chat.addUserMessage(msg.content);
          }
        }
      }
    }

    // If switching back to cone and it's currently processing (e.g., handling
    // a scoop notification), re-lock the input. switchToContext resets streaming
    // state, but we need to reflect the cone's actual status.
    if (scoop.isCone && orchestrator.isProcessing(scoop.jid)) {
      layout.panels.chat.setProcessing(true);
    }
  };

  layout.onScoopSelect = handleScoopSelect;

  // Initialize the selected scoop's tab
  if (selectedScoop) {
    orchestrator.createScoopTab(selectedScoop.jid);
  }

  log.info('Orchestrator initialized — cone+scoops ready', { scoopCount: orchestrator.getScoops().length });
}

main().catch((err) => {
  log.error('Fatal error', err);
  const app = document.getElementById('app');
  if (app) {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'padding: 2rem; text-align: center;';
    const h1 = document.createElement('h1');
    h1.style.color = '#e94560';
    h1.textContent = 'Failed to start';
    const p = document.createElement('p');
    p.style.color = '#a0a0b0';
    p.textContent = err.message;
    errorDiv.appendChild(h1);
    errorDiv.appendChild(p);
    while (app.firstChild) app.removeChild(app.firstChild);
    app.appendChild(errorDiv);
  }
});
