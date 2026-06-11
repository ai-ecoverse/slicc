/**
 * Live chat controller for the WC shell: binds an `AgentHandle` event stream
 * and the scoop message history onto a `<slicc-chat-thread>`. Mirrors the
 * legacy `ChatPanel` streaming state machine (message_start → content_delta →
 * content_done / tool rows → turn_end) but renders through the
 * `wc-message-view.ts` mapper instead of hand-built DOM.
 */

import type { AgentEvent, AgentHandle, ChatMessage } from '../types.js';
import { daySeparatorEl, messageEls } from './wc-message-view.js';

export interface WcChatControllerOptions {
  /** The `<slicc-chat-thread>` element messages render into. */
  thread: HTMLElement;
  /** Agent surface for sending prompts and receiving events. */
  agent: AgentHandle;
  /** Notified when the agent starts/stops processing a turn. */
  onProcessingChange?: (processing: boolean) => void;
  /**
   * Invoked when a message reaches a stable (non-streaming) render — the
   * dip-hydration hook. Streaming re-renders don't fire it; a message that
   * streams fires once, on its final render.
   */
  onMessageRendered?: (message: ChatMessage, els: readonly HTMLElement[]) => void;
  /** Invoked before a message's rendered elements are replaced or removed. */
  onMessageDisposed?: (messageId: string) => void;
}

function uid(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class WcChatController {
  readonly #thread: HTMLElement;
  #agent: AgentHandle;
  readonly #onProcessingChange?: (processing: boolean) => void;
  readonly #onMessageRendered?: (message: ChatMessage, els: readonly HTMLElement[]) => void;
  readonly #onMessageDisposed?: (messageId: string) => void;
  #unsubscribe: () => void;
  #onLocalUserMessage?: (text: string, messageId: string, attachments?: undefined) => void;

  #messages: ChatMessage[] = [];
  /** Rendered thread elements per message id (a message can span several). */
  readonly #els = new Map<string, HTMLElement[]>();
  #currentStreamId: string | null = null;
  #pendingDelta = '';
  #flushScheduled = false;
  #processing = false;

  constructor(options: WcChatControllerOptions) {
    this.#thread = options.thread;
    this.#agent = options.agent;
    this.#onProcessingChange = options.onProcessingChange;
    this.#onMessageRendered = options.onMessageRendered;
    this.#onMessageDisposed = options.onMessageDisposed;
    this.#unsubscribe = options.agent.onEvent((event) => this.#handleAgentEvent(event));
  }

  dispose(): void {
    this.#unsubscribe();
  }

  get processing(): boolean {
    return this.#processing;
  }

  /** Snapshot of the rendered conversation (tray leader snapshots etc.). */
  getMessages(): ChatMessage[] {
    return this.#messages.map((m) => ({ ...m }));
  }

  /**
   * Swap the agent surface (tray role switches: follower mode replaces the
   * local orchestrator with the leader's `FollowerSyncManager`).
   */
  setAgent(agent: AgentHandle): void {
    this.#unsubscribe();
    this.#agent = agent;
    this.#unsubscribe = agent.onEvent((event) => this.#handleAgentEvent(event));
  }

  /** Leader-tray broadcast hook, invoked after every local user send. */
  setOnLocalUserMessage(
    hook: ((text: string, messageId: string, attachments?: undefined) => void) | undefined
  ): void {
    this.#onLocalUserMessage = hook;
  }

  /** Append a user bubble without sending (follower echoes, leader relays). */
  addUserMessage(text: string, _attachments?: unknown): void {
    this.#appendMessage({
      id: uid(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    });
  }

  /** Replace the whole thread with a scoop's canonical history. */
  loadMessages(messages: readonly ChatMessage[]): void {
    for (const id of this.#els.keys()) this.#onMessageDisposed?.(id);
    this.#messages = messages.map((m) => ({ ...m }));
    this.#currentStreamId = null;
    this.#pendingDelta = '';
    this.#flushScheduled = false;
    this.#els.clear();

    const children: HTMLElement[] = [];
    let lastDay = '';
    for (const message of this.#messages) {
      const day = new Date(message.timestamp).toDateString();
      if (day !== lastDay) {
        children.push(daySeparatorEl(message.timestamp));
        lastDay = day;
      }
      const els = messageEls(message);
      this.#els.set(message.id, els);
      children.push(...els);
    }

    const thread = this.#thread as HTMLElement & {
      replaceContent?: (...nodes: Node[]) => void;
    };
    // `<slicc-chat-thread>` wraps its content in an inner column; its
    // `replaceContent` swaps that column's children without destroying the
    // wrapper (plain `replaceChildren` would). Fall back for bare hosts.
    if (typeof thread.replaceContent === 'function') thread.replaceContent(...children);
    else thread.replaceChildren(...children);

    for (const message of this.#messages) {
      if (!message.isStreaming) {
        this.#onMessageRendered?.(message, this.#els.get(message.id) ?? []);
      }
    }
    this.#scrollToBottom();
  }

  /** Append a user prompt locally and forward it to the agent. */
  sendUserMessage(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const message: ChatMessage = {
      id: uid(),
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
      queued: this.#processing ? true : undefined,
    };
    this.#appendMessage(message);
    this.#agent.sendMessage(trimmed, message.id);
    try {
      this.#onLocalUserMessage?.(trimmed, message.id);
    } catch (err) {
      // The broadcast hook is the followers' visibility path; never let a
      // broken broadcaster undo the local send.
      console.error('onLocalUserMessage hook threw', err);
    }
  }

  /** Render an inbound lick (webhook/cron/…) into the thread. */
  addLickMessage(id: string, content: string, channel: string, timestamp: number): void {
    this.#appendMessage({
      id,
      role: 'user',
      content,
      timestamp,
      source: 'lick',
      channel,
    });
  }

  /** External processing-state override (e.g. scoop status broadcasts). */
  setProcessing(processing: boolean): void {
    if (this.#processing === processing) return;
    this.#processing = processing;
    this.#onProcessingChange?.(processing);
  }

  // -- agent events ---------------------------------------------------------

  #handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'message_start':
        this.#handleMessageStart(event.messageId);
        break;
      case 'content_delta':
        this.#handleContentDelta(event.messageId, event.text);
        break;
      case 'content_done':
        this.#handleContentDone(event.messageId);
        break;
      case 'tool_use_start':
        this.#handleToolUseStart(event.messageId, event.toolName, event.toolInput);
        break;
      case 'tool_result':
        this.#handleToolResult(event.messageId, event.toolName, event.result, event.isError);
        break;
      case 'turn_end':
        this.#handleTurnEnd(event.messageId);
        break;
      case 'error':
        this.#handleError(event.error);
        break;
      default:
        break;
    }
  }

  #handleMessageStart(messageId: string): void {
    this.setProcessing(true);
    this.#currentStreamId = messageId;
    this.#appendMessage({
      id: messageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [],
    });
  }

  #handleContentDelta(messageId: string, text: string): void {
    if (!this.#findMessage(messageId)) return;
    this.#pendingDelta += text;
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    requestAnimationFrame(() => this.#flushDelta(messageId));
  }

  #flushDelta(messageId: string): void {
    this.#flushScheduled = false;
    if (!this.#pendingDelta) return;
    const message = this.#findMessage(messageId);
    if (!message) return;
    message.content += this.#pendingDelta;
    this.#pendingDelta = '';
    this.#rerenderMessage(message);
  }

  #handleContentDone(messageId: string): void {
    const message = this.#findMessage(messageId);
    if (!message) return;
    if (this.#pendingDelta && this.#currentStreamId === messageId) {
      message.content += this.#pendingDelta;
    }
    this.#pendingDelta = '';
    this.#flushScheduled = false;
    message.isStreaming = false;
    this.#rerenderMessage(message);
  }

  #handleToolUseStart(messageId: string, toolName: string, toolInput: unknown): void {
    const message = this.#findMessage(messageId);
    if (!message) return;
    message.toolCalls = message.toolCalls ?? [];
    message.toolCalls.push({ id: uid(), name: toolName, input: toolInput });
    this.#rerenderMessage(message);
  }

  #handleToolResult(messageId: string, toolName: string, result: string, isError?: boolean): void {
    const message = this.#findMessage(messageId);
    const call = [...(message?.toolCalls ?? [])]
      .reverse()
      .find((t) => t.name === toolName && t.result === undefined);
    if (!message || !call) return;
    call.result = result;
    call.isError = isError;
    this.#rerenderMessage(message);
  }

  #handleTurnEnd(messageId: string): void {
    const message = this.#findMessage(messageId);
    if (message?.isStreaming) {
      message.isStreaming = false;
      this.#rerenderMessage(message);
    }
    this.#currentStreamId = null;
    this.setProcessing(false);
  }

  #handleError(error: string): void {
    this.setProcessing(false);
    this.#appendMessage({
      id: uid(),
      role: 'assistant',
      content: `**Error:** ${error}`,
      timestamp: Date.now(),
    });
  }

  // -- rendering ------------------------------------------------------------

  #findMessage(id: string): ChatMessage | undefined {
    return this.#messages.find((m) => m.id === id);
  }

  #appendMessage(message: ChatMessage): void {
    this.#messages.push(message);
    const els = messageEls(message);
    this.#els.set(message.id, els);
    this.#thread.append(...els);
    if (!message.isStreaming) this.#onMessageRendered?.(message, els);
    this.#scrollToBottom();
  }

  #rerenderMessage(message: ChatMessage): void {
    this.#onMessageDisposed?.(message.id);
    const old = this.#els.get(message.id) ?? [];
    const next = messageEls(message);
    // Anchor on the old elements' real parent: `<slicc-chat-thread>`
    // delegates `append()` into its inner column, so appended elements are
    // not direct children of the host element.
    const anchor = old[0] ?? null;
    const parent = anchor?.parentNode;
    if (parent) {
      for (const el of next) parent.insertBefore(el, anchor);
      for (const el of old) el.remove();
    } else {
      this.#thread.append(...next);
    }
    this.#els.set(message.id, next);
    if (!message.isStreaming) this.#onMessageRendered?.(message, next);
    this.#scrollToBottom();
  }

  #scrollToBottom(): void {
    this.#thread.scrollTop = this.#thread.scrollHeight;
  }
}
