/**
 * Chat Panel — message list + input area with streaming support.
 *
 * Displays user messages, assistant messages, and tool results.
 * Connects to an AgentHandle for sending messages and receiving events.
 */

import type { AgentHandle, AgentEvent, ChatMessage, ToolCall } from './types.js';
import {
  renderAssistantMessageContent,
  renderMessageContent,
  renderToolInput,
  escapeHtml,
} from './message-renderer.js';
import { SessionStore } from './session-store.js';
import { createLogger } from '../core/logger.js';
import { VoiceInput, getVoiceAutoSend, getVoiceLang } from './voice-input.js';

const log = createLogger('chat-panel');

/** Generate a simple unique ID. */
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Tool icons — compact text abbreviations instead of emojis */
const TOOL_ICONS: Record<string, string> = {
  bash: '$',
  browser: 'B',
  read_file: 'R',
  write_file: 'W',
  edit_file: 'E',
  javascript: 'JS',
  delegate_to_scoop: 'D',
  send_message: 'M',
  schedule_task: 'T',
  list_scoops: 'LS',
  list_tasks: 'LT',
  register_scoop: 'RS',
  update_global_memory: 'GM',
};

/** Get icon for a tool */
function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? '?';
}

function renderChatMessageContent(msg: ChatMessage): string {
  return msg.role === 'assistant'
    ? renderAssistantMessageContent(msg.content)
    : renderMessageContent(msg.content);
}

export class ChatPanel {
  private container: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputArea!: HTMLElement;
  private textarea!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private micBtn!: HTMLButtonElement;
  private voiceInput: VoiceInput | null = null;
  private voiceMode = false;
  private keydownListener: ((e: KeyboardEvent) => void) | null = null;
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
  private autoScrollAttached = true;
  private lastScrollTop = 0;
  private jumpPill!: HTMLElement;
  private onDeleteQueuedMessage: ((messageId: string) => void) | null = null;
  private pendingDeltaText = '';
  private streamingRafId: number | null = null;

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

  /** Set a callback for deleting queued messages (removes from orchestrator DB + queue). */
  setDeleteQueuedMessageCallback(cb: (messageId: string) => void): void {
    this.onDeleteQueuedMessage = cb;
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

  /** Delete a specific session by ID (e.g., when a scoop is dropped). */
  async deleteSessionById(sessionId: string): Promise<void> {
    await this.sessionStore.delete(sessionId);
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

  /** Add a lick message (webhook/cron event). */
  addLickMessage(id: string, content: string, channel: 'webhook' | 'cron'): void {
    const msg: ChatMessage = {
      id,
      role: 'user',
      content,
      timestamp: Date.now(),
      source: 'lick',
      channel,
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

  /** Remove a queued message from the UI and notify the orchestrator to remove it from DB/queue. */
  private deleteQueuedMessage(messageId: string): void {
    const idx = this.messages.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    this.messages.splice(idx, 1);
    const el = this.messagesEl.querySelector(`[data-msg-id="${messageId}"]`);
    if (el) el.remove();
    this.persistSession();
    this.onDeleteQueuedMessage?.(messageId);
  }

  private render(): void {
    this.container.innerHTML = '';
    this.container.classList.add('chat');

    // Messages area
    this.messagesEl = document.createElement('div');
    this.messagesEl.className = 'chat__messages';
    this.container.appendChild(this.messagesEl);

    this.messagesEl.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

      if (distanceFromBottom <= 250) {
        this.autoScrollAttached = true;
        this.hideJumpPill();
      } else if (scrollTop < this.lastScrollTop) {
        this.autoScrollAttached = false;
      }

      this.lastScrollTop = scrollTop;
    }, { passive: true });

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
    this.sendBtn.dataset.tooltip = 'Send message';

    this.stopBtn = document.createElement('button');
    this.stopBtn.className = 'chat__stop-btn';
    this.stopBtn.innerHTML = '&#9632;'; // ■
    this.stopBtn.dataset.tooltip = 'Stop generation';
    this.stopBtn.style.display = 'none';

    this.micBtn = document.createElement('button');
    this.micBtn.className = 'chat__mic-btn';
    // Static SVG mic icon — safe, no user content
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path1 = document.createElementNS(svgNs, 'path');
    path1.setAttribute('d', 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z');
    const path2 = document.createElementNS(svgNs, 'path');
    path2.setAttribute('d', 'M19 10v2a7 7 0 0 1-14 0v-2');
    const line1 = document.createElementNS(svgNs, 'line');
    line1.setAttribute('x1', '12'); line1.setAttribute('y1', '19');
    line1.setAttribute('x2', '12'); line1.setAttribute('y2', '23');
    const line2 = document.createElementNS(svgNs, 'line');
    line2.setAttribute('x1', '8'); line2.setAttribute('y1', '23');
    line2.setAttribute('x2', '16'); line2.setAttribute('y2', '23');
    svg.append(path1, path2, line1, line2);
    this.micBtn.appendChild(svg);
    this.micBtn.dataset.tooltip = 'Voice (Ctrl+Shift+V)';

    // Input wrapper — textarea + inline actions
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'chat__input-wrapper';
    inputWrapper.appendChild(this.textarea);

    const inputActions = document.createElement('div');
    inputActions.className = 'chat__input-actions';
    inputActions.appendChild(this.micBtn);
    inputActions.appendChild(this.sendBtn);
    inputActions.appendChild(this.stopBtn);
    inputWrapper.appendChild(inputActions);

    inputArea.appendChild(inputWrapper);
    this.container.appendChild(inputArea);

    // "New activity" pill — shown when auto-scroll is detached
    this.jumpPill = document.createElement('button');
    this.jumpPill.className = 'chat__jump-pill';
    this.jumpPill.textContent = '\u2193 New activity';
    this.jumpPill.addEventListener('click', () => {
      this.autoScrollAttached = true;
      this.hideJumpPill();
      this.scrollToBottom(true);
    });
    this.container.appendChild(this.jumpPill);

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
      // Clear all remaining queued badges since these messages won't be processed
      for (const msg of this.messages) {
        if (msg.queued) {
          msg.queued = false;
          this.updateMessageEl(msg.id);
        }
      }
      this.setStreamingState(false);
    });

    // Voice input
    this.voiceInput = new VoiceInput({
      onTranscript: (text, _isFinal) => {
        this.textarea.value = text;
        this.textarea.style.height = 'auto';
        this.textarea.style.height = Math.min(this.textarea.scrollHeight, 120) + 'px';
      },
      onStateChange: (state) => {
        if (state === 'error') {
          this.voiceMode = false;
          this.micBtn.classList.remove('chat__mic-btn--active', 'chat__mic-btn--listening');
        } else if (this.voiceMode) {
          // In voice mode, keep --listening on unless we're actively streaming
          // (streaming state manages the visual via setStreamingState).
          // Don't let transient idle states during stop→start flicker the button.
          if (state === 'listening') {
            this.micBtn.classList.add('chat__mic-btn--listening');
          }
          // Don't remove --listening on 'idle' in voice mode — setStreamingState handles it
        } else {
          this.micBtn.classList.toggle('chat__mic-btn--listening', state === 'listening');
        }
      },
      onError: (error) => {
        log.debug('Voice input error', { error });
        // In voice mode, suppress "no speech detected" — silence between turns is normal
        if (this.voiceMode && error.includes('No speech detected')) return;
        this.addSystemMessage(error);
      },
      autoSend: true, // always auto-send in voice mode
      onAutoSend: (text) => {
        this.textarea.value = text;
        this.sendMessage();
      },
      onAutoDisable: () => {
        this.voiceMode = false;
        this.micBtn.classList.remove('chat__mic-btn--active', 'chat__mic-btn--listening');
        this.addSystemMessage('Voice mode disabled after 2 minutes of inactivity.');
      },
      lang: getVoiceLang(),
    });

    this.micBtn.addEventListener('click', () => {
      this.toggleVoiceMode();
    });

    // Keyboard shortcut: Ctrl+Shift+V / Cmd+Shift+V
    this.keydownListener = (e) => {
      if (e.shiftKey && (e.ctrlKey || e.metaKey) && e.key === 'V') {
        e.preventDefault();
        this.toggleVoiceMode();
      }
    };
    document.addEventListener('keydown', this.keydownListener);
  }

  private toggleVoiceMode(): void {
    this.voiceMode = !this.voiceMode;
    this.micBtn.classList.toggle('chat__mic-btn--active', this.voiceMode);
    if (this.voiceMode) {
      this.voiceInput?.start();
    } else {
      this.voiceInput?.stop();
    }
  }

  private sendMessage(): void {
    const text = this.textarea.value.trim();
    if (!text) return;

    // User action — always re-attach auto-scroll
    this.autoScrollAttached = true;
    this.hideJumpPill();

    const isQueued = this.isStreaming;
    const msg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      queued: isQueued || undefined,
    };
    this.messages.push(msg);
    this.appendMessageEl(msg);
    this.persistSession();

    // Clear input
    this.textarea.value = '';
    this.textarea.style.height = 'auto';

    // Only lock input if not already streaming (first message triggers streaming)
    if (!this.isStreaming) {
      this.setStreamingState(true);
    }

    // Send to agent (orchestrator persists & queues if the cone is busy)
    this.agent?.sendMessage(text, msg.id);
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
    this.pendingDeltaText += text;
    if (this.streamingRafId === null) {
      this.streamingRafId = requestAnimationFrame(() => this.flushPendingDelta());
    }
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
        tc._screenshotDataUrl = imgMatch[1];
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
    // Show stop button during streaming, send button otherwise — but keep textarea enabled
    this.stopBtn.style.display = streaming ? 'flex' : 'none';
    this.sendBtn.style.display = streaming ? 'none' : 'flex';
    // Textarea stays enabled so the user can queue follow-up messages
    this.textarea.disabled = false;
    // Mic button stays enabled during streaming so user can toggle voice mode off
    if (streaming) {
      if (this.voiceInput?.isListening()) {
        this.voiceInput.stop();
      }
      // In voice mode, explicitly remove listening visual during streaming
      this.micBtn.classList.remove('chat__mic-btn--listening');
      // When a new turn starts, clear the queued badge on only the oldest queued message
      // (it's the one being processed now). Leave the rest queued.
      const oldestQueued = this.messages.find(m => m.queued);
      if (oldestQueued) {
        oldestQueued.queued = false;
        this.updateMessageEl(oldestQueued.id);
      }
    }
    if (!streaming) {
      if (this.voiceMode) {
        // Voice mode: auto-restart listening when the agent finishes.
        // Pre-set the listening class to avoid a visual flicker during
        // the async getUserMedia → recognition start gap.
        this.micBtn.classList.add('chat__mic-btn--listening');
        this.voiceInput?.start();
      } else {
        this.textarea.focus();
      }
    }
  }

  private findMessage(id: string): ChatMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  private flushPendingDelta(): void {
    this.streamingRafId = null;
    if (!this.pendingDeltaText || !this.currentStreamId) return;
    const msg = this.findMessage(this.currentStreamId);
    if (!msg) {
      this.pendingDeltaText = '';
      return;
    }
    msg.content += this.pendingDeltaText;
    this.pendingDeltaText = '';
    this.updateStreamingContent(this.currentStreamId);
  }

  private cancelPendingDelta(): void {
    if (this.streamingRafId !== null) {
      cancelAnimationFrame(this.streamingRafId);
      this.streamingRafId = null;
    }
    this.pendingDeltaText = '';
  }

  private updateStreamingContent(messageId: string): void {
    const msg = this.findMessage(messageId);
    if (!msg) return;
    const wrapper = this.messagesEl.querySelector(`[data-msg-id="${messageId}"]`);
    if (!wrapper) return;
    const contentEl = wrapper.querySelector('.msg__content');
    if (contentEl) {
      contentEl.innerHTML = renderChatMessageContent(msg);
      if (msg.isStreaming) {
        const cursor = document.createElement('span');
        cursor.className = 'streaming-cursor';
        contentEl.appendChild(cursor);
      }
    } else if (msg.content.trim().length > 0) {
      this.updateMessageEl(messageId);
      return;
    }
    this.scrollToBottom();
  }

  // -- DOM rendering --

  private renderMessages(): void {
    this.messagesEl.innerHTML = '';
    let prevRole: string | null = null;
    let prevTimestamp = 0;
    for (const msg of this.messages) {
      const showLabel = this.shouldShowLabel(msg, prevRole, prevTimestamp);
      const el = this.createMessageEl(msg, showLabel);
      this.messagesEl.appendChild(el);
      prevRole = msg.role;
      prevTimestamp = msg.timestamp;
    }
    this.autoScrollAttached = true;
    this.hideJumpPill();
    this.scrollToBottom(true);
  }

  private appendMessageEl(msg: ChatMessage): void {
    // Determine if label should show based on previous message
    const prev = this.messages.length >= 2 ? this.messages[this.messages.length - 2] : null;
    const showLabel = this.shouldShowLabel(msg, prev?.role ?? null, prev?.timestamp ?? 0);
    const el = this.createMessageEl(msg, showLabel);
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  /** Determine whether to show the sender label for a message */
  private shouldShowLabel(msg: ChatMessage, prevRole: string | null, prevTimestamp: number): boolean {
    // Always show label for lick messages
    if (msg.source === 'lick' || msg.channel === 'webhook' || msg.channel === 'cron') return true;
    // Show label if role changed
    if (msg.role !== prevRole) return true;
    // Show label if >2 min gap
    if (msg.timestamp - prevTimestamp > 120_000) return true;
    return false;
  }

  private updateMessageEl(messageId: string): void {
    const msg = this.findMessage(messageId);
    if (!msg) return;
    const existing = this.messagesEl.querySelector(`[data-msg-id="${messageId}"]`);
    if (existing) {
      // Determine showLabel based on previous message in the list
      const idx = this.messages.indexOf(msg);
      const prev = idx > 0 ? this.messages[idx - 1] : null;
      const showLabel = this.shouldShowLabel(msg, prev?.role ?? null, prev?.timestamp ?? 0);
      const newEl = this.createMessageEl(msg, showLabel);
      existing.replaceWith(newEl);
    }
    this.scrollToBottom();
  }

  private createMessageEl(msg: ChatMessage, showLabel = true): HTMLElement {
    // Licks (webhook/cron) get their own compact style like tool calls
    const isLick = msg.source === 'lick' || msg.channel === 'webhook' || msg.channel === 'cron';
    if (isLick) {
      const wrapper = document.createElement('div');
      wrapper.className = 'msg-group';
      wrapper.setAttribute('data-msg-id', msg.id);
      wrapper.appendChild(this.createLickEl(msg));
      return wrapper;
    }

    // Use a fragment-like wrapper for messages with tool calls
    // so tool calls appear outside the message bubble
    const wrapper = document.createElement('div');
    wrapper.className = `msg-group${showLabel ? '' : ' msg-group--continuation'}`;
    wrapper.setAttribute('data-msg-id', msg.id);

    const el = document.createElement('div');
    el.className = `msg msg--${msg.role}${msg.queued ? ' msg--queued' : ''}`;

    if (showLabel) {
      // Determine icon letter and label based on role, source, and current context
      let iconLetter: string;
      let label: string;
      const isInScoopThread = this.currentScoopName !== null;

      if (msg.role === 'user') {
        if (msg.source === 'delegation' || msg.channel === 'delegation') {
          iconLetter = 'S';
          label = 'sliccy';
        } else {
          iconLetter = 'U';
          label = 'You';
        }
      } else if (isInScoopThread) {
        iconLetter = (this.currentScoopName || 'S').charAt(0).toUpperCase();
        label = `@${this.currentScoopName}`;
      } else if (msg.source && msg.source !== 'cone') {
        iconLetter = msg.source.charAt(0).toUpperCase();
        label = msg.source;
      } else {
        iconLetter = 'S';
        label = 'sliccy';
      }

      // Role label with initial avatar
      const roleEl = document.createElement('div');
      roleEl.className = 'msg__role';
      const iconSpan = document.createElement('span');
      iconSpan.className = 'msg__icon';
      iconSpan.textContent = iconLetter;
      roleEl.appendChild(iconSpan);
      roleEl.appendChild(document.createTextNode(` ${label}`));
      // Queued badge + delete button
      if (msg.queued) {
        const badge = document.createElement('span');
        badge.className = 'msg__queued-badge';
        badge.textContent = 'queued';
        roleEl.appendChild(badge);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'msg__queued-delete';
        deleteBtn.textContent = '\u00d7'; // ×
        deleteBtn.title = 'Remove queued message';
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteQueuedMessage(msg.id);
        });
        roleEl.appendChild(deleteBtn);
      }
      el.appendChild(roleEl);
    }

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
      contentEl.innerHTML = renderChatMessageContent(msg);
      details.appendChild(contentEl);

      el.appendChild(details);
    } else {
      // Normal expanded content
      const contentEl = document.createElement('div');
      contentEl.className = 'msg__content';
      contentEl.innerHTML = renderChatMessageContent(msg);
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

  /** Create a lick element (webhook/cron event) styled like tool calls */
  private createLickEl(msg: ChatMessage): HTMLElement {
    const el = document.createElement('details');
    el.className = 'lick';

    const channelType = msg.channel === 'webhook' ? 'Webhook' : msg.channel === 'cron' ? 'Cron' : 'Event';

    // Summary shows tongue emoji and type
    const summary = document.createElement('summary');
    summary.className = 'lick__header';
    summary.innerHTML = `<span class="lick__icon">E</span> <span class="lick__type">${channelType}</span>`;

    // Add brief preview
    const preview = document.createElement('span');
    preview.className = 'lick__preview';
    // Extract a meaningful preview from the content
    const contentPreview = msg.content.replace(/\[Webhook Event:.*?\]\n```json\n?/s, '').slice(0, 50);
    preview.textContent = contentPreview.replace(/\n/g, ' ') + (contentPreview.length >= 50 ? '...' : '');
    summary.appendChild(preview);

    el.appendChild(summary);

    // Details content
    const details = document.createElement('div');
    details.className = 'lick__details';
    details.innerHTML = renderMessageContent(msg.content);
    el.appendChild(details);

    return el;
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

    // Status indicator — text-based
    const statusEl = document.createElement('span');
    if (tc.result === undefined) {
      statusEl.className = 'tool-call__status tool-call__status--running';
    } else if (tc.isError) {
      statusEl.className = 'tool-call__status tool-call__status--error';
      statusEl.textContent = 'failed';
    } else {
      statusEl.className = 'tool-call__status tool-call__status--success';
      statusEl.textContent = '\u2713'; // ✓
    }
    summary.appendChild(statusEl);

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
    const screenshotUrl = tc._screenshotDataUrl;
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
          w.document.body.style.background = document.documentElement.classList.contains('theme-light') ? '#f0f0f0' : '#141414';
          w.document.body.appendChild(fullImg);
        }
      });
      details.appendChild(imgEl);
    }

    el.appendChild(details);

    return el;
  }

  private scrollToBottom(force = false): void {
    if (!force && !this.autoScrollAttached) {
      this.showJumpPill();
      return;
    }
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this.lastScrollTop = this.messagesEl.scrollTop;
    });
  }

  private showJumpPill(): void {
    this.jumpPill.classList.add('chat__jump-pill--visible');
  }

  private hideJumpPill(): void {
    this.jumpPill.classList.remove('chat__jump-pill--visible');
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
    this.voiceInput?.destroy();
    if (this.keydownListener) {
      document.removeEventListener('keydown', this.keydownListener);
      this.keydownListener = null;
    }
    this.container.innerHTML = '';
  }
}
