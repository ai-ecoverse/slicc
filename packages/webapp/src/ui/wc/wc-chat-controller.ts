/**
 * Live chat controller for the WC shell: binds an `AgentHandle` event stream
 * and the scoop message history onto a `<slicc-chat-thread>`. Mirrors the
 * legacy `ChatPanel` streaming state machine (message_start → content_delta →
 * content_done / tool rows → turn_end) but renders through the
 * `wc-message-view.ts` mapper instead of hand-built DOM.
 */

import type { AgentEvent, AgentHandle, ChatMessage } from '../types.js';
import { createCopyRow } from './wc-copy-row.js';
import { collateLickMessages, daySeparatorEl, messageEls } from './wc-message-view.js';

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
  /**
   * Invoked when a turn completes (the processing flag falls — via the
   * `turn_end` agent event OR a scoop status broadcast; live floats only
   * have the latter), with the turn's last settled assistant message (null
   * when none exists). The spoken-reply loop hangs off this.
   */
  onTurnComplete?: (message: ChatMessage | null) => void;
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
  readonly #onTurnComplete?: (message: ChatMessage | null) => void;
  #unsubscribe: () => void;
  #onLocalUserMessage?: (
    text: string,
    messageId: string,
    attachments?: ChatMessage['attachments']
  ) => void;
  /** Bubbled `slicc-error-retry` listener wired to the thread — see `#handleErrorRetry`. */
  readonly #onErrorRetry: (event: Event) => void;

  #messages: ChatMessage[] = [];
  /** Rendered thread elements per message id (a message can span several). */
  readonly #els = new Map<string, HTMLElement[]>();
  #currentStreamId: string | null = null;
  /** The assistant message the ACTIVE turn streamed (reset on each rise). */
  #turnAssistantId: string | null = null;
  #pendingDelta = '';
  #flushScheduled = false;
  #processing = false;
  /** Lazily-built copy affordance, re-appended after the last reply. */
  #copyRow: HTMLElement | null = null;

  constructor(options: WcChatControllerOptions) {
    this.#thread = options.thread;
    this.#agent = options.agent;
    this.#onProcessingChange = options.onProcessingChange;
    this.#onMessageRendered = options.onMessageRendered;
    this.#onMessageDisposed = options.onMessageDisposed;
    this.#onTurnComplete = options.onTurnComplete;
    this.#unsubscribe = options.agent.onEvent((event) => this.#handleAgentEvent(event));
    // Bubbled retry event from any rendered `slicc-error-card` (composed, so it
    // pierces shadow roots). One listener at the thread covers every error card.
    // The event's `detail.messageId` identifies WHICH error card was clicked so
    // retry binds to that specific failed turn (see `#handleErrorRetry`).
    this.#onErrorRetry = (event) => this.#handleErrorRetry(event);
    this.#thread.addEventListener('slicc-error-retry', this.#onErrorRetry);
  }

  dispose(): void {
    this.#unsubscribe();
    this.#thread.removeEventListener('slicc-error-retry', this.#onErrorRetry);
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
    hook:
      | ((text: string, messageId: string, attachments?: ChatMessage['attachments']) => void)
      | undefined
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

  /**
   * Append a synthetic assistant message that never touched the agent —
   * deterministic onboarding lines and dip references (`![…](…shtml)`,
   * hydrated by the regular onMessageRendered dip pipeline).
   */
  addAssistantMessage(text: string): void {
    this.#appendMessage({
      id: uid(),
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
    });
  }

  /** Replace the whole thread with a scoop's canonical history. */
  loadMessages(messages: readonly ChatMessage[]): void {
    for (const id of this.#els.keys()) this.#onMessageDisposed?.(id);
    // Runs of same-channel licks render as ONE collated card ("×2" pill).
    this.#messages = collateLickMessages(messages);
    // A canonical replay can land mid-turn (rehydrate after a scoop switch /
    // frozen-session thaw / remount). When a message is still streaming, keep
    // the stream machine pointed at that bubble so the resumed deltas extend
    // it and `content_done` flushes the final chunk (issue #959). The
    // streaming message is usually the tail, but a prompt/lick queued mid-turn
    // is buffered AFTER it, so scan backward rather than assuming the tail.
    const streamingTail = [...this.#messages].reverse().find((m) => m.isStreaming);
    this.#currentStreamId = streamingTail?.id ?? null;
    if (streamingTail) this.#turnAssistantId = streamingTail.id;
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
      const els = this.#safeMessageEls(message);
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
    this.#syncCopyRow();
    this.#scrollToBottom();
  }

  /** Append a user prompt locally and forward it to the agent. */
  sendUserMessage(text: string, attachments?: ChatMessage['attachments']): void {
    const trimmed = text.trim();
    if (!trimmed && !attachments?.length) return;
    const message: ChatMessage = {
      id: uid(),
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
      attachments: attachments?.length ? attachments : undefined,
      queued: this.#processing ? true : undefined,
    };
    this.#appendMessage(message);
    this.#agent.sendMessage(trimmed, message.id, message.attachments);
    try {
      // Attachments ride along so tray followers see the full prompt, not a
      // text-only echo.
      this.#onLocalUserMessage?.(trimmed, message.id, message.attachments);
    } catch (err) {
      // The broadcast hook is the followers' visibility path; never let a
      // broken broadcaster undo the local send.
      console.error('onLocalUserMessage hook threw', err);
    }
  }

  /** Render an inbound lick (webhook/cron/…) into the thread. */
  addLickMessage(id: string, content: string, channel: string, timestamp: number): void {
    // Collate into the trailing card when the previous message is a lick of
    // the same channel — the pill counts up instead of stacking cards.
    const last = this.#messages[this.#messages.length - 1];
    if (last && last.source === 'lick' && last.channel === channel) {
      last.lickParts = [...(last.lickParts ?? [last.content]), content];
      last.lickCount = last.lickParts.length;
      last.content += `\n\n${content}`;
      this.#rerenderMessage(last);
      return;
    }
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
    // A RISING edge starts a fresh turn — forget the previous turn's reply
    // so a turn that streams nothing can never surface a stale one.
    if (processing) this.#turnAssistantId = null;
    if (!processing) this.#syncCopyRow();
    this.#onProcessingChange?.(processing);
    // End-of-turn = the processing flag FALLING. This is deliberately not
    // hung off the `turn_end` agent event: the live floats' chat wire only
    // carries `response_done` (offscreen-bridge.ts defers `turn_end`
    // synthesis), so processing falls via scoop STATUS broadcasts there —
    // the transition is the one signal every float shares.
    if (!processing) this.#fireTurnComplete();
  }

  /**
   * Surface THIS turn's assistant reply to the host (null when the turn
   * produced none — e.g. the error path — so the host can settle its own
   * one-shot state without ever speaking a historical message).
   */
  #fireTurnComplete(): void {
    const id = this.#turnAssistantId;
    this.#turnAssistantId = null;
    if (!this.#onTurnComplete) return;
    const message = id ? this.#findMessage(id) : null;
    this.#onTurnComplete(message ? { ...message } : null);
  }

  /**
   * Copy affordance (legacy feedback-row parity): shown after the last
   * COMPLETED assistant message — short click copies the latest response,
   * long press copies the whole chat. Appending an existing element moves
   * it, so re-syncing after each load/turn keeps it pinned to the tail.
   */
  #syncCopyRow(): void {
    const last = this.#messages[this.#messages.length - 1];
    const show = last?.role === 'assistant' && !last.isStreaming;
    if (!show) {
      this.#copyRow?.remove();
      return;
    }
    this.#copyRow ??= createCopyRow({ getMessages: () => this.getMessages() });
    // Straight into the reading column: the component's overridden `append`
    // treats new nodes as live content (scrolls + invalidates the URL scroll
    // restore) — the copy row is chrome, not content.
    const inner = (this.#thread as { inner?: HTMLElement }).inner;
    (inner ?? this.#thread).append(this.#copyRow);
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
    // Record AFTER the rise (which resets it): a multi-message turn keeps
    // overwriting, so the turn-complete hook gets the turn's LAST message.
    this.#turnAssistantId = messageId;
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
    // The processing FALL inside setProcessing fires onTurnComplete — one
    // chokepoint shared with the status-broadcast path (live floats never
    // receive a `turn_end` event at all).
    this.setProcessing(false);
  }

  #handleError(error: string): void {
    this.setProcessing(false);
    // The error path renders as `<slicc-error-card>` (a presentational card
    // with a "Try again" button that emits the bubbled `slicc-error-retry`
    // event picked up by `#handleErrorRetry`). Mark the message with `error`
    // so `messageEls` routes it to the card instead of the plain bubble.
    this.#appendMessage({
      id: uid(),
      role: 'assistant',
      content: error,
      timestamp: Date.now(),
      error: true,
    });
  }

  /**
   * Re-run the user turn that produced THIS error card through the existing
   * agent send path (`#agent.sendMessage`) — no new agent API, no duplicate
   * user bubble. The card forwards its `message-id` (the failed error
   * message's id) on the event; we walk backward from that message to find the
   * user turn that produced it, so a click on an older error card or a retry
   * after a newer prompt was queued still re-runs the RIGHT turn. A retry
   * while a turn is in flight is dropped to avoid double-submissions. Lick /
   * delegation user-rows are skipped: they are not user turns. Falls back to
   * the legacy "last user message in the whole thread" scan if the event
   * carries no messageId (older callers / non-card dispatchers).
   */
  #handleErrorRetry(event: Event): void {
    if (this.#processing) return;
    const messageId =
      (event as CustomEvent<{ messageId?: string | null }>).detail?.messageId ?? null;
    let startIndex = this.#messages.length;
    if (messageId) {
      const errorIndex = this.#messages.findIndex((m) => m.id === messageId);
      if (errorIndex >= 0) startIndex = errorIndex;
      // If the id is unknown (stale card, history reload), fall back to the
      // legacy whole-thread scan rather than silently dropping the retry.
    }
    let target: ChatMessage | undefined;
    for (let i = startIndex - 1; i >= 0; i--) {
      const m = this.#messages[i];
      if (m.role === 'user' && m.source !== 'lick' && m.source !== 'delegation') {
        target = m;
        break;
      }
    }
    if (!target) return;
    this.#agent.sendMessage(target.content, uid(), target.attachments);
  }

  // -- rendering ------------------------------------------------------------

  #findMessage(id: string): ChatMessage | undefined {
    return this.#messages.find((m) => m.id === id);
  }

  /**
   * Render one message, degrading to a plain bubble on ANY renderer throw —
   * a single malformed message must never abort a load loop (which would
   * leave the whole thread unrendered).
   */
  #safeMessageEls(message: ChatMessage): HTMLElement[] {
    try {
      return messageEls(message);
    } catch (err) {
      console.error('[wc-chat] message render failed — degrading to plain bubble', err);
      const fallback = document.createElement(
        message.role === 'assistant' ? 'slicc-agent-message' : 'slicc-user-message'
      );
      fallback.setAttribute('text', String(message.content ?? ''));
      return [fallback];
    }
  }

  #appendMessage(message: ChatMessage): void {
    this.#messages.push(message);
    const els = this.#safeMessageEls(message);
    this.#els.set(message.id, els);
    this.#thread.append(...els);
    if (!message.isStreaming) this.#onMessageRendered?.(message, els);
    // The user's own submission always lands in view; agent-driven appends
    // defer to the thread's polite follow (new-messages chip when scrolled).
    if (message.role === 'user') this.#scrollToBottom();
    else this.#followThread();
  }

  #rerenderMessage(message: ChatMessage): void {
    this.#onMessageDisposed?.(message.id);
    const old = this.#els.get(message.id) ?? [];
    const next = this.#safeMessageEls(message);
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
    this.#followThread();
  }

  #scrollToBottom(): void {
    this.#thread.scrollTop = this.#thread.scrollHeight;
  }

  /**
   * Streaming/agent updates follow politely: `<slicc-chat-thread>` only
   * auto-scrolls when the user is near the bottom, otherwise it raises its
   * new-messages chip. Bare hosts (tests) fall back to a hard scroll.
   */
  #followThread(): void {
    const thread = this.#thread as HTMLElement & { requestFollow?: () => void };
    if (typeof thread.requestFollow === 'function') thread.requestFollow();
    else this.#scrollToBottom();
  }
}
