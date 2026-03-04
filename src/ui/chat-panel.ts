/**
 * Chat Panel — message list + input area with streaming support.
 *
 * Displays user messages, assistant messages, and tool results.
 * Connects to an AgentHandle for sending messages and receiving events.
 */

import type { AgentHandle, AgentEvent, ChatMessage, ToolCall } from './types.js';
import { renderMessageContent, renderToolInput, escapeHtml } from './message-renderer.js';
import { SessionStore } from './session-store.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('chat-panel');

/** Generate a simple unique ID. */
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export class ChatPanel {
  private container: HTMLElement;
  private messagesEl!: HTMLElement;
  private textarea!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private messages: ChatMessage[] = [];
  private agent: AgentHandle | null = null;
  private unsubscribe: (() => void) | null = null;
  private isStreaming = false;
  private currentStreamId: string | null = null;
  private sessionStore: SessionStore;
  private sessionId: string;
  private terminalOutputCallback: ((text: string) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.sessionStore = new SessionStore();
    this.sessionId = 'default';
    this.render();
  }

  /** Wire up the agent handle. Can be called after construction. */
  setAgent(agent: AgentHandle): void {
    // Unsubscribe from previous agent
    this.unsubscribe?.();
    this.agent = agent;
    this.unsubscribe = agent.onEvent((ev) => this.handleAgentEvent(ev));
  }

  /** Set a callback for terminal output events. */
  onTerminalOutput(cb: (text: string) => void): void {
    this.terminalOutputCallback = cb;
  }

  /** Initialize session persistence and restore messages. */
  async initSession(sessionId?: string): Promise<void> {
    await this.sessionStore.init();
    this.sessionId = sessionId ?? 'default';

    const session = await this.sessionStore.load(this.sessionId);
    if (session && session.messages.length > 0) {
      // Clear stale streaming state from previous session
      this.messages = session.messages.map((m) => ({
        ...m,
        isStreaming: false,
      }));
      this.renderMessages();
    }
  }

  /** Clear the current session and reset messages. */
  async clearSession(): Promise<void> {
    this.messages = [];
    this.renderMessages();
    await this.sessionStore.delete(this.sessionId);
  }

  /** Get current messages. */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  private render(): void {
    this.container.innerHTML = '';
    this.container.classList.add('chat');

    // Messages area
    this.messagesEl = document.createElement('div');
    this.messagesEl.className = 'chat__messages';
    this.container.appendChild(this.messagesEl);

    // Input area
    const inputArea = document.createElement('div');
    inputArea.className = 'chat__input-area';

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'chat__textarea';
    this.textarea.placeholder = 'Type a message... (Enter to send)';
    this.textarea.rows = 1;

    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'chat__send-btn';
    this.sendBtn.innerHTML = '&#9654;'; // ▶
    this.sendBtn.title = 'Send message';

    this.stopBtn = document.createElement('button');
    this.stopBtn.className = 'chat__stop-btn';
    this.stopBtn.innerHTML = '&#9632;'; // ■
    this.stopBtn.title = 'Stop generation';
    this.stopBtn.style.display = 'none';

    inputArea.appendChild(this.textarea);
    inputArea.appendChild(this.sendBtn);
    inputArea.appendChild(this.stopBtn);
    this.container.appendChild(inputArea);

    // Event listeners
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.textarea.addEventListener('input', () => {
      // Auto-resize textarea
      this.textarea.style.height = 'auto';
      this.textarea.style.height = Math.min(this.textarea.scrollHeight, 120) + 'px';
    });

    this.sendBtn.addEventListener('click', () => this.sendMessage());
    this.stopBtn.addEventListener('click', () => {
      this.agent?.stop();
      this.setStreamingState(false);
    });
  }

  private sendMessage(): void {
    const text = this.textarea.value.trim();
    if (!text || this.isStreaming) return;

    // Add user message
    const msg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    this.messages.push(msg);
    this.appendMessageEl(msg);
    this.persistSession();

    // Clear input
    this.textarea.value = '';
    this.textarea.style.height = 'auto';

    // Send to agent
    this.agent?.sendMessage(text);
  }

  private handleAgentEvent(event: AgentEvent): void {
    log.debug('Agent event', { type: event.type });
    switch (event.type) {
      case 'message_start':
        this.handleMessageStart(event.messageId);
        break;
      case 'content_delta':
        this.handleContentDelta(event.messageId, event.text);
        break;
      case 'content_done':
        this.handleContentDone(event.messageId);
        break;
      case 'tool_use_start':
        this.handleToolUseStart(event.messageId, event.toolName, event.toolInput);
        break;
      case 'tool_result':
        this.handleToolResult(event.messageId, event.toolName, event.result, event.isError);
        break;
      case 'turn_end':
        this.handleTurnEnd(event.messageId);
        break;
      case 'error':
        this.handleError(event.error);
        break;
      case 'screenshot':
        break;
      case 'terminal_output':
        this.terminalOutputCallback?.(event.text);
        break;
    }
  }

  private handleMessageStart(messageId: string): void {
    this.setStreamingState(true);
    this.currentStreamId = messageId;

    const msg: ChatMessage = {
      id: messageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [],
    };
    this.messages.push(msg);
    this.appendMessageEl(msg);
  }

  private handleContentDelta(messageId: string, text: string): void {
    const msg = this.findMessage(messageId);
    if (!msg) return;
    msg.content += text;
    this.updateMessageEl(messageId);
  }

  private handleContentDone(messageId: string): void {
    const msg = this.findMessage(messageId);
    if (!msg) return;
    msg.isStreaming = false;
    this.updateMessageEl(messageId);
  }

  private handleToolUseStart(messageId: string, toolName: string, toolInput: unknown): void {
    const msg = this.findMessage(messageId);
    if (!msg) return;
    if (!msg.toolCalls) msg.toolCalls = [];
    msg.toolCalls.push({
      id: uid(),
      name: toolName,
      input: toolInput,
    });
    this.updateMessageEl(messageId);
  }

  private handleToolResult(messageId: string, toolName: string, result: string, isError?: boolean): void {
    const msg = this.findMessage(messageId);
    if (!msg || !msg.toolCalls) return;
    // Find the most recent tool call matching this name that has no result yet
    const tc = [...msg.toolCalls].reverse().find((t) => t.name === toolName && t.result === undefined);
    if (tc) {
      tc.result = result;
      tc.isError = isError;
    }
    this.updateMessageEl(messageId);
  }

  private handleTurnEnd(_messageId: string): void {
    this.setStreamingState(false);
    this.currentStreamId = null;
    this.persistSession();
  }

  private handleError(error: string): void {
    this.setStreamingState(false);
    this.currentStreamId = null;

    // If we have an active assistant message, append the error
    const lastMsg = this.messages[this.messages.length - 1];
    if (lastMsg?.role === 'assistant' && lastMsg.isStreaming) {
      lastMsg.isStreaming = false;
      lastMsg.content += `\n\n**Error:** ${error}`;
      this.updateMessageEl(lastMsg.id);
    } else {
      // Show as a system-like error message
      const msg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        content: `**Error:** ${error}`,
        timestamp: Date.now(),
      };
      this.messages.push(msg);
      this.appendMessageEl(msg);
    }
    this.persistSession();
  }

  private setStreamingState(streaming: boolean): void {
    this.isStreaming = streaming;
    this.sendBtn.style.display = streaming ? 'none' : 'flex';
    this.stopBtn.style.display = streaming ? 'flex' : 'none';
    this.textarea.disabled = streaming;
    if (!streaming) {
      // Restore focus after generation completes
      this.textarea.focus();
    }
  }

  private findMessage(id: string): ChatMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  // -- DOM rendering --

  private renderMessages(): void {
    this.messagesEl.innerHTML = '';
    for (const msg of this.messages) {
      this.appendMessageEl(msg);
    }
  }

  private appendMessageEl(msg: ChatMessage): void {
    const el = this.createMessageEl(msg);
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  private updateMessageEl(messageId: string): void {
    const msg = this.findMessage(messageId);
    if (!msg) return;
    const existing = this.messagesEl.querySelector(`[data-msg-id="${messageId}"]`);
    if (existing) {
      const newEl = this.createMessageEl(msg);
      existing.replaceWith(newEl);
    }
    this.scrollToBottom();
  }

  private createMessageEl(msg: ChatMessage): HTMLElement {
    const el = document.createElement('div');
    el.className = `msg msg--${msg.role}`;
    el.setAttribute('data-msg-id', msg.id);

    // Role label
    const roleEl = document.createElement('div');
    roleEl.className = 'msg__role';
    roleEl.textContent = msg.role === 'user' ? 'You' : 'sliccy';
    el.appendChild(roleEl);

    // Content
    const contentEl = document.createElement('div');
    contentEl.className = 'msg__content';
    contentEl.innerHTML = renderMessageContent(msg.content);
    if (msg.isStreaming) {
      const cursor = document.createElement('span');
      cursor.className = 'streaming-cursor';
      contentEl.appendChild(cursor);
    }
    el.appendChild(contentEl);

    // Tool calls
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        el.appendChild(this.createToolCallEl(tc));
      }
    }

    return el;
  }

  private createToolCallEl(tc: ToolCall): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tool-call';

    const header = document.createElement('div');
    header.className = 'tool-call__header';
    header.textContent = `⚙ ${tc.name}`;
    el.appendChild(header);

    if (tc.input !== undefined) {
      const inputEl = document.createElement('div');
      inputEl.className = 'tool-call__input';
      inputEl.innerHTML = renderToolInput(tc.input);
      el.appendChild(inputEl);
    }

    if (tc.result !== undefined) {
      const resultEl = document.createElement('div');
      resultEl.className = `tool-call__result${tc.isError ? ' tool-call__result--error' : ''}`;
      resultEl.textContent = tc.result;
      el.appendChild(resultEl);
    }

    return el;
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  private persistSession(): void {
    // Fire-and-forget save
    this.sessionStore.saveMessages(this.sessionId, this.messages).catch(() => {
      // Silently ignore persistence errors
    });
  }

  /** Dispose the panel. */
  dispose(): void {
    this.unsubscribe?.();
    this.container.innerHTML = '';
  }
}
