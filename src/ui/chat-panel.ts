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

/** Cycling face emojis for user messages */
const USER_FACES = ['😀', '😊', '🙂', '😄', '😎', '🤔', '😁', '🤗'];
let userFaceIndex = 0;

/** Get the next user face emoji (cycles through the list) */
function getNextUserFace(): string {
  const face = USER_FACES[userFaceIndex];
  userFaceIndex = (userFaceIndex + 1) % USER_FACES.length;
  return face;
}

/** Tool icons by name */
const TOOL_ICONS: Record<string, string> = {
  bash: '⚙️',
  browser: '🌐',
  read_file: '📖',
  write_file: '✏️',
  edit_file: '✏️',
  javascript: '📜',
  delegate_to_scoop: '🥄',
  send_message: '💬',
  schedule_task: '⏰',
  list_scoops: '📋',
  list_tasks: '📋',
  register_scoop: '🍨',
  update_global_memory: '🧠',
};

/** Get icon for a tool */
function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? '🔧';
}

export class ChatPanel {
  private container: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputArea!: HTMLElement;
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
  private readOnly = false;
  private terminalOutputCallback: ((text: string) => void) | null = null;
  private currentScoopName: string | null = null; // null = cone, string = scoop name

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

  /** Switch to a different scoop's chat context. */
  async switchToContext(contextId: string, readOnly: boolean, scoopName?: string): Promise<void> {
    // Save current session first
    await this.persistSessionAsync();

    // Reset streaming state — prevents stale isStreaming from a different scoop
    // from locking the input in the new context
    this.setStreamingState(false);
    this.currentStreamId = null;

    // Switch
    this.sessionId = contextId;
    this.currentScoopName = scoopName ?? null; // null means cone
    this.setReadOnly(readOnly);

    // Load the new session
    const session = await this.sessionStore.load(this.sessionId);
    if (session && session.messages.length > 0) {
      this.messages = session.messages.map((m) => ({
        ...m,
        isStreaming: false,
      }));
    } else {
      this.messages = [];
    }
    this.renderMessages();
  }

  /** Set read-only mode (hide input for non-cone scoops). */
  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    if (this.inputArea) {
      this.inputArea.style.display = readOnly ? 'none' : '';
    }
  }

  /** Persist session (async, awaitable). */
  private async persistSessionAsync(): Promise<void> {
    try {
      await this.sessionStore.saveMessages(this.sessionId, this.messages);
    } catch {
      // Silently ignore persistence errors
    }
  }

  /** Lock/unlock input based on external processing state (e.g., cone auto-activated by scoop notification). */
  setProcessing(busy: boolean): void {
    if (busy) {
      this.setStreamingState(true);
    } else {
      this.setStreamingState(false);
    }
  }

  /** Add a system message (for scoop summaries in cone chat). */
  addSystemMessage(content: string): void {
    const msg: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
    };
    this.messages.push(msg);
    this.appendMessageEl(msg);
    this.persistSession();
  }

  /** Get current messages. */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /** Load a set of messages (from external buffer) and render them. */
  loadMessages(messages: ChatMessage[]): void {
    this.messages = messages.map(m => ({ ...m, isStreaming: false }));
    this.renderMessages();
    this.persistSession();
  }

  /** Clear all messages from the display (doesn't affect session store). */
  clear(): void {
    this.messages = [];
    this.renderMessages();
  }

  /** Add a user message to the display (for history loading). */
  addUserMessage(content: string): void {
    const msg: ChatMessage = {
      id: uid(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    this.messages.push(msg);
    this.appendMessageEl(msg);
  }

  private render(): void {
    this.container.innerHTML = '';
    this.container.classList.add('chat');

    // Messages area
    this.messagesEl = document.createElement('div');
    this.messagesEl.className = 'chat__messages';
    this.container.appendChild(this.messagesEl);

    // Input area
    this.inputArea = document.createElement('div');
    const inputArea = this.inputArea;
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

    // Disable input immediately — don't wait for message_start event
    this.setStreamingState(true);

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
      // Strip inline image data from stored result to avoid bloating conversation history.
      // The image is rendered by createToolCallEl from a transient property, not persisted.
      const imgMatch = result.match(/<img:(data:image\/[^>]+)>/);
      tc.result = result.replace(/<img:data:image\/[^>]+>/g, '').trim();
      if (imgMatch) {
        (tc as any)._screenshotDataUrl = imgMatch[1]; // transient, not persisted
      }
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
    // Use a fragment-like wrapper for messages with tool calls
    // so tool calls appear outside the message bubble
    const wrapper = document.createElement('div');
    wrapper.className = 'msg-group';
    wrapper.setAttribute('data-msg-id', msg.id);

    const el = document.createElement('div');
    el.className = `msg msg--${msg.role}`;

    // Determine icon and label based on role, source, and current context
    let icon: string;
    let label: string;
    const isInScoopThread = this.currentScoopName !== null;

    if (msg.role === 'user') {
      // Check if this is a lick (webhook/cron event)
      if (msg.source === 'lick' || msg.channel === 'webhook' || msg.channel === 'cron') {
        icon = '👅';
        label = msg.channel ? `lick:${msg.channel}` : 'lick';
      } else if (msg.source === 'delegation' || msg.channel === 'delegation') {
        // Delegation instructions from sliccy
        icon = '🥄';
        label = 'sliccy';
      } else {
        icon = getNextUserFace();
        label = 'You';
      }
    } else if (msg.source === 'lick' || msg.channel === 'webhook' || msg.channel === 'cron') {
      icon = '👅';
      label = msg.channel ? `lick:${msg.channel}` : 'lick';
    } else if (isInScoopThread) {
      // In a scoop thread, all assistant messages show the scoop icon/name
      icon = '💩';
      label = `@${this.currentScoopName}`;
    } else if (msg.source && msg.source !== 'cone') {
      // Scoop message in cone view
      icon = '💩';
      label = msg.source;
    } else {
      // Main agent (sliccy / cone)
      icon = '🍦';
      label = 'sliccy';
    }

    // Role label with icon
    const roleEl = document.createElement('div');
    roleEl.className = 'msg__role';
    roleEl.innerHTML = `<span class="msg__icon">${icon}</span> ${escapeHtml(label)}`;
    el.appendChild(roleEl);

    // For lick messages in cone view, wrap content in collapsible
    const isLickInCone = (msg.source === 'lick' || msg.channel === 'webhook' || msg.channel === 'cron') && this.sessionId === 'session-cone';
    // For scoop messages in cone view, wrap in collapsible
    const isScoopInCone = msg.source && msg.source !== 'cone' && msg.source !== 'lick' && msg.role === 'assistant' && this.sessionId === 'session-cone';

    if (isLickInCone || isScoopInCone) {
      // Collapsed by default
      const details = document.createElement('details');
      details.className = 'msg__collapsible';

      const summary = document.createElement('summary');
      summary.className = 'msg__summary';
      const preview = msg.content.slice(0, 60).replace(/\n/g, ' ');
      summary.textContent = preview + (msg.content.length > 60 ? '...' : '');
      details.appendChild(summary);

      const contentEl = document.createElement('div');
      contentEl.className = 'msg__content';
      contentEl.innerHTML = renderMessageContent(msg.content);
      details.appendChild(contentEl);

      el.appendChild(details);
    } else {
      // Normal expanded content
      const contentEl = document.createElement('div');
      contentEl.className = 'msg__content';
      contentEl.innerHTML = renderMessageContent(msg.content);
      if (msg.isStreaming) {
        const cursor = document.createElement('span');
        cursor.className = 'streaming-cursor';
        contentEl.appendChild(cursor);
      }
      el.appendChild(contentEl);
    }

    // Only show the message bubble if there's actual content
    const hasContent = msg.content.trim().length > 0;
    if (hasContent) {
      wrapper.appendChild(el);
    }

    // Tool calls rendered outside the message bubble for compact display
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        wrapper.appendChild(this.createToolCallEl(tc));
      }
    }

    return wrapper;
  }

  private createToolCallEl(tc: ToolCall): HTMLElement {
    const icon = getToolIcon(tc.name);

    // Use <details> for collapsible behavior - collapsed by default, expand on hover/click
    const el = document.createElement('details');
    el.className = 'tool-call';

    // Summary shows icon and tool name
    const summary = document.createElement('summary');
    summary.className = 'tool-call__header';
    summary.innerHTML = `<span class="tool-call__icon">${icon}</span> <span class="tool-call__name">${escapeHtml(tc.name)}</span>`;

    // Add brief input preview to summary
    if (tc.input !== undefined) {
      const preview = document.createElement('span');
      preview.className = 'tool-call__preview';
      const inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
      preview.textContent = inputStr.slice(0, 40) + (inputStr.length > 40 ? '...' : '');
      summary.appendChild(preview);
    }

    // Status indicator
    if (tc.result === undefined) {
      const spinner = document.createElement('span');
      spinner.className = 'tool-call__spinner';
      spinner.textContent = '⏳';
      summary.appendChild(spinner);
    } else if (tc.isError) {
      const errorIcon = document.createElement('span');
      errorIcon.className = 'tool-call__error-icon';
      errorIcon.textContent = '❌';
      summary.appendChild(errorIcon);
    } else {
      const checkIcon = document.createElement('span');
      checkIcon.className = 'tool-call__check-icon';
      checkIcon.textContent = '✅';
      summary.appendChild(checkIcon);
    }

    el.appendChild(summary);

    // Details content (shown on expand)
    const details = document.createElement('div');
    details.className = 'tool-call__details';

    if (tc.input !== undefined) {
      const inputEl = document.createElement('div');
      inputEl.className = 'tool-call__input';
      const inputLabel = document.createElement('div');
      inputLabel.className = 'tool-call__label';
      inputLabel.textContent = 'Input:';
      inputEl.appendChild(inputLabel);
      const inputCode = document.createElement('pre');
      inputCode.innerHTML = renderToolInput(tc.input);
      inputEl.appendChild(inputCode);
      details.appendChild(inputEl);
    }

    if (tc.result !== undefined) {
      const resultEl = document.createElement('div');
      resultEl.className = `tool-call__result${tc.isError ? ' tool-call__result--error' : ''}`;
      const resultLabel = document.createElement('div');
      resultLabel.className = 'tool-call__label';
      resultLabel.textContent = tc.isError ? 'Error:' : 'Result:';
      resultEl.appendChild(resultLabel);
      const resultPre = document.createElement('pre');
      resultPre.textContent = tc.result;
      resultEl.appendChild(resultPre);
      details.appendChild(resultEl);
    }

    // Render screenshot thumbnail from transient data (not persisted in messages)
    const screenshotUrl = (tc as any)._screenshotDataUrl as string | undefined;
    if (screenshotUrl) {
      const imgEl = document.createElement('img');
      imgEl.src = screenshotUrl;
      imgEl.className = 'tool-call__screenshot';
      imgEl.title = 'Click to view full size';
      imgEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const w = window.open('about:blank');
        if (w) {
          const fullImg = w.document.createElement('img');
          fullImg.src = screenshotUrl;
          w.document.title = 'Screenshot';
          w.document.body.style.margin = '0';
          w.document.body.style.background = '#1a1a2e';
          w.document.body.appendChild(fullImg);
        }
      });
      details.appendChild(imgEl);
    }

    el.appendChild(details);

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
