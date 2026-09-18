import type { ChatCompactionMarker, ToolProgressEvent } from '@slicc/shared-ts';
import { escapeHtml } from '@slicc/webcomponents/internal/html';
import { isUserFixableError } from '../../core/error-families.js';
import { errorDetailsToRawString, formatErrorDetails } from '../../core/error-text.js';
import { trackChatSend, trackError, trackLickBackpressure } from '../../kernel/telemetry.js';
import {
  applyDictationMarkers,
  consumeDictationFirst,
  stripDictationMarkers,
} from '../../speech/dictation-priming.js';
import { TOOL_UI_MOUNTED_ACTION } from '../../tools/tool-ui.js';
import { consumeStaleAssetReplayPending } from '../boot/setup-preload-error-reload.js';
import { type DipInstance, mountDip } from '../dip.js';
import type { AgentEvent, AgentHandle, ChatMessage, ToolCall } from '../types.js';
import { createCopyRow } from './wc-copy-row.js';
import {
  aggregateClusterProgress,
  applyClusterProgress,
  applyToolProgress,
  type ClusterCallState,
  collateLickMessages,
  daySeparatorEl,
  messageEls,
  reflowToolClusters,
  unwrapToolClusters,
} from './wc-message-view.js';

export type BusyPhase = 'thinking' | 'tool';

export interface QueuedMessageView {
  id: string;
  text: string;

  attachments?: number;
}

export interface LickBackpressureNoticeView {
  text: string;
}

export interface WcChatControllerOptions {
  thread: HTMLElement;

  agent: AgentHandle;

  onProcessingChange?: (processing: boolean) => void;

  onBusyPhaseChange?: (phase: BusyPhase) => void;

  onToolProgressChange?: (fraction: number | null) => void;

  onMessageRendered?: (message: ChatMessage, els: readonly HTMLElement[]) => void;

  onMessageDisposed?: (messageId: string) => void;

  onTurnComplete?: (message: ChatMessage | null) => void;

  resolveTelemetryContext?: () => { scoopName: string; model: string } | null;

  onQueuedChange?: (items: readonly QueuedMessageView[]) => void;

  onLickBackpressureChange?: (notice: LickBackpressureNoticeView | null) => void;

  onQueuedCancel?: (messageId: string) => void;

  onToolUiAction?: (requestId: string, action: string, data?: unknown) => void;

  readOnlyToolUi?: boolean;
}

function uid(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractToolUiTitle(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const header = doc.querySelector('.sprinkle-action-card__header');
    if (header) {
      header.querySelector('.sprinkle-badge')?.remove();
      header.querySelector('.sprinkle-action-card__meta')?.remove();
      const title = header.textContent?.trim();
      if (title) return title;
    }
  } catch {}
  return 'Approval requested';
}

function buildReadOnlyToolUiHtml(html: string): string {
  const title = escapeHtml(extractToolUiTitle(html));
  return `
    <div class="sprinkle-action-card">
      <div class="sprinkle-action-card__header">${title} <span class="sprinkle-badge sprinkle-badge--informative">pending</span></div>
      <div class="sprinkle-action-card__body">Waiting for approval on the leader&hellip;</div>
    </div>
  `;
}

function toQueuedView(message: ChatMessage): QueuedMessageView {
  const view: QueuedMessageView = { id: message.id, text: message.content };
  if (message.attachments?.length) view.attachments = message.attachments.length;
  return view;
}

export class WcChatController {
  readonly #thread: HTMLElement;
  #agent: AgentHandle;
  readonly #onProcessingChange?: (processing: boolean) => void;
  readonly #onBusyPhaseChange?: (phase: BusyPhase) => void;
  readonly #onToolProgressChange?: (fraction: number | null) => void;
  #lastToolProgress: number | null = null;
  readonly #onMessageRendered?: (message: ChatMessage, els: readonly HTMLElement[]) => void;
  readonly #onMessageDisposed?: (messageId: string) => void;
  readonly #onTurnComplete?: (message: ChatMessage | null) => void;
  readonly #resolveTelemetryContext?: () => { scoopName: string; model: string } | null;
  readonly #onQueuedChange?: (items: readonly QueuedMessageView[]) => void;
  readonly #onLickBackpressureChange?: (notice: LickBackpressureNoticeView | null) => void;
  readonly #onQueuedCancel?: (messageId: string) => void;
  readonly #onToolUiAction?: (requestId: string, action: string, data?: unknown) => void;
  readonly #readOnlyToolUi: boolean;
  #unsubscribe: () => void;
  #onLocalUserMessage?: (
    text: string,
    messageId: string,
    attachments?: ChatMessage['attachments']
  ) => void;
  #onLocalProcessingChange?: (processing: boolean) => void;

  readonly #onErrorRetry: (event: Event) => void;

  #messages: ChatMessage[] = [];

  #queued: ChatMessage[] = [];

  #lickBackpressureNotice: LickBackpressureNoticeView | null = null;

  readonly #els = new Map<string, HTMLElement[]>();
  #currentStreamId: string | null = null;

  #turnAssistantId: string | null = null;

  #pendingDelta = '';
  #pendingDeltaId: string | null = null;
  #flushFrame: number | null = null;
  #processing = false;

  #busyPhase: BusyPhase = 'thinking';

  #activeToolCount = 0;

  #copyRow: HTMLElement | null = null;

  readonly #openClusterAnchors = new Set<string>();

  readonly #toolUiDips = new Map<string, { instance: DipInstance; container: HTMLElement }>();

  readonly #toolProgress = new Map<string, ToolProgressEvent>();

  readonly #sessionToolCalls = new Set<string>();

  #readOnly = false;

  #pendingQueueRestore: ChatMessage[] | null = null;

  constructor(options: WcChatControllerOptions) {
    this.#thread = options.thread;
    this.#agent = options.agent;
    this.#onProcessingChange = options.onProcessingChange;
    this.#onBusyPhaseChange = options.onBusyPhaseChange;
    this.#onToolProgressChange = options.onToolProgressChange;
    this.#onMessageRendered = options.onMessageRendered;
    this.#onMessageDisposed = options.onMessageDisposed;
    this.#onTurnComplete = options.onTurnComplete;
    this.#resolveTelemetryContext = options.resolveTelemetryContext;
    this.#onQueuedChange = options.onQueuedChange;
    this.#onLickBackpressureChange = options.onLickBackpressureChange;
    this.#onQueuedCancel = options.onQueuedCancel;
    this.#onToolUiAction = options.onToolUiAction;
    this.#readOnlyToolUi = options.readOnlyToolUi ?? false;
    this.#unsubscribe = options.agent.onEvent((event) => this.#handleAgentEvent(event));

    this.#onErrorRetry = (event) => this.#handleErrorRetry(event);
    this.#thread.addEventListener('slicc-error-retry', this.#onErrorRetry);
  }

  dispose(): void {
    this.#unsubscribe();
    this.#thread.removeEventListener('slicc-error-retry', this.#onErrorRetry);
    for (const id of [...this.#toolUiDips.keys()]) this.#disposeToolUiDip(id);
    this.#toolProgress.clear();
    this.#sessionToolCalls.clear();
    this.#publishToolProgress();
  }

  setReadOnly(readOnly: boolean): void {
    if (this.#readOnly === readOnly) return;
    this.#readOnly = readOnly;
    if (readOnly) {
      for (const id of [...this.#toolUiDips.keys()]) this.#disposeToolUiDip(id);
    }
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  get processing(): boolean {
    return this.#processing;
  }

  getMessages(): ChatMessage[] {
    return this.#messages.map((m) => ({ ...m }));
  }

  setAgent(agent: AgentHandle): void {
    this.#unsubscribe();
    this.#agent = agent;
    this.#unsubscribe = agent.onEvent((event) => this.#handleAgentEvent(event));
  }

  setOnLocalUserMessage(
    hook:
      | ((text: string, messageId: string, attachments?: ChatMessage['attachments']) => void)
      | undefined
  ): void {
    this.#onLocalUserMessage = hook;
  }

  setOnLocalProcessingChange(hook: ((processing: boolean) => void) | undefined): void {
    this.#onLocalProcessingChange = hook;
  }

  addUserMessage(text: string, _attachments?: unknown, source?: string): void {
    this.#appendMessage({
      id: uid(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      ...(source ? { source } : {}),
    });
  }

  getQueuedMessages(): QueuedMessageView[] {
    return this.#queued.map(toQueuedView);
  }

  removeQueuedMessage(id: string): void {
    const next = this.#queued.filter((m) => m.id !== id);
    if (next.length === this.#queued.length) return;
    this.#queued = next;
    this.#fireQueuedChange();
  }

  stashQueued(): ChatMessage[] {
    const pending = this.#pendingQueueRestore ?? [];
    this.#pendingQueueRestore = null;
    const items = this.#queued;
    if (items.length === 0) return pending;
    this.#queued = [];
    this.#fireQueuedChange();
    return [...pending, ...items];
  }

  restoreQueued(items: readonly ChatMessage[]): void {
    this.#pendingQueueRestore = items.length > 0 ? [...items] : null;
  }

  private heldBackendPendingIds(backendQueuedIds?: readonly string[]): Set<string> {
    if (!this.#pendingQueueRestore || !backendQueuedIds?.length) return new Set();
    const pending = new Set(backendQueuedIds);
    return new Set(this.#pendingQueueRestore.filter((m) => pending.has(m.id)).map((m) => m.id));
  }

  #applyPendingQueueRestore(
    messages: readonly ChatMessage[],
    backendQueuedIds?: readonly string[]
  ): void {
    if (!this.#pendingQueueRestore) return;
    const stillPending = this.heldBackendPendingIds(backendQueuedIds);
    const replayed = new Set(messages.map((m) => m.id));
    const held = this.#pendingQueueRestore.filter(
      (m) => !replayed.has(m.id) || stillPending.has(m.id)
    );
    this.#pendingQueueRestore = null;
    if (held.length === 0) return;
    if (!backendQueuedIds) {
      this.#queued = held;
      this.#fireQueuedChange();
      return;
    }
    const rank = new Map(backendQueuedIds.map((id, index) => [id, index]));
    const known = held
      .filter((m) => rank.has(m.id))
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    const unlisted = held.filter((m) => !rank.has(m.id));

    this.#queued = this.#processing ? known : [...known, ...unlisted];
    this.#fireQueuedChange();
    if (this.#processing) for (const message of unlisted) this.#appendMessage(message);
  }

  #flushQueued(): void {
    if (this.#queued.length === 0) return;
    const items = this.#queued;
    this.#queued = [];
    for (const message of items) this.#appendMessage(message);
    this.#fireQueuedChange();
  }

  #fireQueuedChange(): void {
    this.#onQueuedChange?.(this.#queued.map(toQueuedView));
  }

  #fireLickBackpressureChange(): void {
    this.#onLickBackpressureChange?.(this.#lickBackpressureNotice);
  }

  setLickBackpressure(count: number, waitingMs: number, scoopName: string): void {
    if (count <= 0) {
      if (!this.#lickBackpressureNotice) return;
      this.#lickBackpressureNotice = null;
      this.#fireLickBackpressureChange();
      return;
    }
    this.#lickBackpressureNotice = {
      text: `${count} events waiting for the current turn`,
    };
    this.#fireLickBackpressureChange();
    try {
      trackLickBackpressure(scoopName, waitingMs);
    } catch {}
  }

  addAssistantMessage(text: string): void {
    this.#appendMessage({
      id: uid(),
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
    });
  }

  loadMessages(messages: readonly ChatMessage[], backendQueuedIds?: readonly string[]): void {
    for (const id of this.#els.keys()) this.#onMessageDisposed?.(id);

    for (const id of [...this.#toolUiDips.keys()]) this.#disposeToolUiDip(id);
    this.#toolProgress.clear();
    this.#sessionToolCalls.clear();
    this.#publishToolProgress();

    const hadQueued = this.#queued.length > 0;
    if (this.#queued.length > 0) {
      if (this.#onQueuedCancel) {
        for (const message of this.#queued) {
          try {
            this.#onQueuedCancel(message.id);
          } catch (err) {
            console.error('onQueuedCancel hook threw', err);
          }
        }
      }
      this.#queued = [];
    }
    if (hadQueued) this.#fireQueuedChange();

    const heldPending = this.heldBackendPendingIds(backendQueuedIds);
    const rendered =
      heldPending.size > 0 ? messages.filter((m) => !heldPending.has(m.id)) : messages;

    this.#messages = collateLickMessages(rendered);

    const streamingTail = [...this.#messages].reverse().find((m) => m.isStreaming);
    this.#currentStreamId = streamingTail?.id ?? null;
    if (streamingTail) this.#turnAssistantId = streamingTail.id;
    this.#dropPendingDelta();
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

    if (typeof thread.replaceContent === 'function') thread.replaceContent(...children);
    else thread.replaceChildren(...children);

    this.#reflowToolClusters();
    for (const message of this.#messages) {
      this.#onMessageRendered?.(message, this.#els.get(message.id) ?? []);
    }
    this.#syncCopyRow();
    this.#scrollToBottom();

    this.#maybeReplayDroppedTurn();

    this.#applyPendingQueueRestore(messages, backendQueuedIds);
  }

  #maybeReplayDroppedTurn(): void {
    if (this.#thread.getAttribute('context') !== 'cone') return;

    if (this.#messages.length === 0) return;

    if (!consumeStaleAssetReplayPending()) return;

    if (this.#processing) return;
    const last = this.#messages[this.#messages.length - 1];

    if (
      last.role !== 'user' ||
      last.source === 'lick' ||
      last.source === 'delegation' ||
      last.queued
    ) {
      return;
    }

    this.#handleErrorRetry(new Event('slicc-error-retry'));
  }

  sendUserMessage(
    text: string,
    attachments?: ChatMessage['attachments'],
    options?: { dictation?: boolean; steer?: boolean }
  ): void {
    const trimmed = text.trim();
    if (!trimmed && !attachments?.length) return;
    const content = options?.dictation ? this.#applyDictation(trimmed) : trimmed;
    const message: ChatMessage = {
      id: uid(),
      role: 'user',
      content,
      timestamp: Date.now(),
      attachments: attachments?.length ? attachments : undefined,
    };
    if (this.#processing && !options?.steer) {
      this.#queued.push(message);
      this.#fireQueuedChange();
    } else {
      this.#appendMessage(message);
    }

    if (options?.steer) {
      this.#agent.sendMessage(content, message.id, message.attachments, { steer: true });
    } else {
      this.#agent.sendMessage(content, message.id, message.attachments);
    }

    this.#emitChatSendBeacon();
    try {
      const echo = options?.dictation ? stripDictationMarkers(content) : content;
      this.#onLocalUserMessage?.(echo, message.id, message.attachments);
    } catch (err) {
      console.error('onLocalUserMessage hook threw', err);
    }
  }

  #applyDictation(text: string): string {
    return applyDictationMarkers(text, consumeDictationFirst());
  }

  #emitChatSendBeacon(): void {
    if (!this.#resolveTelemetryContext) return;
    try {
      const ctx = this.#resolveTelemetryContext();
      if (!ctx) return;
      trackChatSend(ctx.scoopName, ctx.model);
    } catch {}
  }

  addLickMessage(
    id: string,
    content: string,
    channel: string,
    timestamp: number,
    lickId?: string
  ): void {
    const last = this.#messages[this.#messages.length - 1];
    const actionable = !!lickId || !!last?.lickId;
    if (!actionable && last && last.source === 'lick' && last.channel === channel) {
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

      lickId,
      lickState: lickId ? 'pending' : undefined,

      queued: this.#processing ? true : undefined,
    });
  }

  updateLickState(lickId: string, lickState: ChatMessage['lickState']): void {
    const message = this.#messages.find((m) => m.lickId === lickId);
    if (!message) return;
    message.lickState = lickState;
    this.#rerenderMessage(message);
  }

  setProcessing(processing: boolean): void {
    if (this.#processing === processing) return;
    this.#processing = processing;

    if (processing) this.#turnAssistantId = null;

    if (processing) {
      this.#activeToolCount = 0;
      this.#setBusyPhase('thinking');
    }

    if (processing) this.#flushQueued();
    if (!processing) {
      if (this.#lickBackpressureNotice) {
        this.#lickBackpressureNotice = null;
        this.#fireLickBackpressureChange();
      }
      this.#syncCopyRow();
    }
    this.#onProcessingChange?.(processing);

    try {
      this.#onLocalProcessingChange?.(processing);
    } catch (err) {
      console.error('onLocalProcessingChange hook threw', err);
    }

    if (!processing) this.#fireTurnComplete();
  }

  #setBusyPhase(phase: BusyPhase): void {
    if (this.#busyPhase === phase) return;
    this.#busyPhase = phase;
    this.#onBusyPhaseChange?.(phase);
  }

  #fireTurnComplete(): void {
    const id = this.#turnAssistantId;
    this.#turnAssistantId = null;
    if (!this.#onTurnComplete) return;
    const message = id ? this.#findMessage(id) : null;
    this.#onTurnComplete(message ? { ...message } : null);
  }

  #syncCopyRow(): void {
    const last = this.#messages[this.#messages.length - 1];
    const show = last?.role === 'assistant' && !last.isStreaming;
    if (!show) {
      this.#copyRow?.remove();
      return;
    }
    this.#copyRow ??= createCopyRow({ getMessages: () => this.getMessages() });

    const inner = (this.#thread as { inner?: HTMLElement }).inner;
    (inner ?? this.#thread).append(this.#copyRow);
  }

  #handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'message_start':
        this.#handleMessageStart(event.messageId);
        break;
      case 'content_delta':
        this.#handleContentDelta(event.messageId, event.text);
        break;
      case 'content_done':
        this.#handleContentDone(event.messageId, event.model, event.usage);
        break;
      case 'tool_use_start':
        this.#handleToolUseStart(
          event.messageId,
          event.toolName,
          event.toolInput,
          event.toolCallId
        );
        break;
      case 'tool_result':
        this.#handleToolResult(
          event.messageId,
          event.toolName,
          event.result,
          event.isError,
          event.toolCallId
        );
        break;
      case 'tool_ui':
        this.#handleToolUI(event.messageId, event.requestId, event.html);
        break;
      case 'tool_ui_done':
        this.#handleToolUIDone(event.requestId);
        break;
      case 'tool_progress':
        this.#handleToolProgress(event.messageId, event.toolName, event.progress, event.toolCallId);
        break;
      case 'turn_end':
        this.#handleTurnEnd(event.messageId);
        break;
      case 'compaction_notice':
        this.#handleCompactionNotice(event.messageId, event.marker);
        break;
      case 'error':
        this.#handleError(event.error, event.endTurn !== false);
        break;

      case 'screenshot':
      case 'terminal_output':
        break;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
        break;
      }
    }
  }

  #handleMessageStart(messageId: string): void {
    this.setProcessing(true);
    this.#currentStreamId = messageId;

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

    if (this.#pendingDeltaId !== messageId) this.#flushDelta();
    this.#pendingDeltaId = messageId;
    this.#pendingDelta += text;
    this.#flushFrame ??= requestAnimationFrame(() => this.#flushDelta());
  }

  #flushDelta(): void {
    const messageId = this.#pendingDeltaId;
    const text = this.#pendingDelta;
    this.#dropPendingDelta();
    const message = text && messageId ? this.#findMessage(messageId) : undefined;
    if (!message) return;
    message.content += text;
    this.#rerenderMessage(message);
  }

  #dropPendingDelta(): void {
    if (this.#flushFrame !== null) cancelAnimationFrame(this.#flushFrame);
    this.#flushFrame = null;
    this.#pendingDelta = '';
    this.#pendingDeltaId = null;
  }

  #handleContentDone(
    messageId: string,
    model?: ChatMessage['model'],
    usage?: ChatMessage['usage']
  ): void {
    const message = this.#findMessage(messageId);
    if (!message) return;
    if (model) message.model = model;
    if (usage) message.usage = usage;
    if (this.#pendingDeltaId === messageId) {
      message.content += this.#pendingDelta;
      this.#dropPendingDelta();
    }
    message.isStreaming = false;
    this.#rerenderMessage(message);
  }

  static #rowKey(messageId: string, toolCallId: string): string {
    return `${messageId}:${toolCallId}`;
  }

  #handleToolUseStart(
    messageId: string,
    toolName: string,
    toolInput: unknown,
    toolCallId?: string
  ): void {
    const message = this.#findMessage(messageId);
    if (!message) return;
    message.toolCalls = message.toolCalls ?? [];

    const id = toolCallId ? WcChatController.#rowKey(messageId, toolCallId) : uid();
    this.#sessionToolCalls.add(id);
    message.toolCalls.push({ id, name: toolName, input: toolInput });

    this.#activeToolCount += 1;
    this.#setBusyPhase('tool');
    this.#rerenderMessage(message);
  }

  #findToolCall(message: ChatMessage | undefined, toolName: string, toolCallId?: string) {
    const calls = message?.toolCalls ?? [];
    if (toolCallId) {
      const scoped = message ? WcChatController.#rowKey(message.id, toolCallId) : undefined;
      return calls.find((t) => t.id === scoped) ?? calls.find((t) => t.id === toolCallId);
    }
    return [...calls].reverse().find((t) => t.name === toolName && t.result === undefined);
  }

  #handleToolResult(
    messageId: string,
    toolName: string,
    result: string,
    isError?: boolean,
    toolCallId?: string
  ): void {
    const message = this.#findMessage(messageId);
    const call = this.#findToolCall(message, toolName, toolCallId);
    if (!message || !call) return;
    call.result = result;
    call.isError = isError;
    if (call.id) {
      this.#toolProgress.delete(call.id);
      this.#publishToolProgress();
    }

    this.#activeToolCount = Math.max(0, this.#activeToolCount - 1);
    if (this.#activeToolCount === 0) this.#setBusyPhase('thinking');
    this.#rerenderMessage(message);
  }

  #handleCompactionNotice(messageId: string, marker: ChatCompactionMarker): void {
    const existing = this.#findMessage(messageId);
    if (marker.state === 'discarded') {
      if (existing) this.#removeMessage(existing);
      return;
    }
    if (existing) {
      existing.compaction = marker;
      this.#rerenderMessage(existing);
      return;
    }

    this.#appendMessage({
      id: messageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      compaction: marker,
    });
  }

  #removeMessage(message: ChatMessage): void {
    this.#unwrapToolClusters();
    this.#onMessageDisposed?.(message.id);
    for (const el of this.#els.get(message.id) ?? []) el.remove();
    this.#els.delete(message.id);
    this.#messages = this.#messages.filter((m) => m !== message);
    this.#reflowToolClusters();
    this.#refreshClusterProgress();
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

  #handleError(error: unknown, endTurn = true): void {
    if (endTurn) {
      this.setProcessing(false);
    }

    this.#appendMessage({
      id: uid(),
      role: 'assistant',
      content: typeof error === 'string' ? error : (formatErrorDetails(error) ?? ''),
      timestamp: Date.now(),
      error: true,
    });
    this.#emitErrorCardBeacon(error);
  }

  #emitErrorCardBeacon(error: unknown): void {
    try {
      const raw = typeof error === 'string' ? error : errorDetailsToRawString(error);
      if (typeof raw === 'string' && isUserFixableError(raw)) return;
      trackError('error-card', error);
    } catch {}
  }

  #handleToolUI(_messageId: string, requestId: string, html: string): void {
    if (this.#readOnly) return;

    this.#disposeToolUiDip(requestId);
    const container = document.createElement('div');
    container.className = 'msg__dip';
    container.setAttribute('data-tool-ui-request', requestId);
    const inner = (this.#thread as { inner?: HTMLElement }).inner ?? this.#thread;
    inner.append(container);
    if (this.#readOnlyToolUi) {
      const instance = mountDip(container, buildReadOnlyToolUiHtml(html), () => {}, false);
      this.#toolUiDips.set(requestId, { instance, container });
      return;
    }
    const instance = mountDip(
      container,
      html,
      (action, data) => {
        this.#onToolUiAction?.(requestId, action, data);
      },
      false
    );
    this.#toolUiDips.set(requestId, { instance, container });

    this.#onToolUiAction?.(requestId, TOOL_UI_MOUNTED_ACTION, undefined);
  }

  #handleToolUIDone(requestId: string): void {
    this.#disposeToolUiDip(requestId);
  }

  #handleToolProgress(
    messageId: string,
    toolName: string,
    progress: ToolProgressEvent,
    toolCallId?: string
  ): void {
    const message = this.#findMessage(messageId);
    const call = this.#findToolCall(message, toolName, toolCallId);
    if (!call?.id) return;
    if (progress.phase === 'end') this.#toolProgress.delete(call.id);
    else this.#toolProgress.set(call.id, progress);
    this.#applyToolProgress(call.id);
    this.#publishToolProgress();
  }

  #applyToolProgress(toolCallId: string): void {
    const row = this.#thread.querySelector<HTMLElement>(
      `slicc-action-row[data-tool-id="${CSS.escape(toolCallId)}"]`
    );
    if (row) applyToolProgress(row, this.#toolProgress.get(toolCallId) ?? null);

    this.#refreshClusterProgress();
  }

  #refreshClusterProgress(): void {
    const clusters = this.#thread.querySelectorAll<HTMLElement>('slicc-tool-cluster');
    for (const cluster of clusters) {
      const calls: ClusterCallState[] = [
        ...cluster.querySelectorAll<HTMLElement>('slicc-action-row[data-tool-id]'),
      ]

        .filter((row) => row.dataset.toolId && this.#sessionToolCalls.has(row.dataset.toolId))
        .map((row) => {
          const id = row.dataset.toolId as string;
          const badge = row.getAttribute('result');
          return {
            done: badge !== null && badge !== '…',
            fraction: this.#toolProgress.get(id)?.fraction,
          };
        });
      applyClusterProgress(cluster, aggregateClusterProgress(calls));
    }
  }

  #publishToolProgress(): void {
    let next: number | null = null;
    const units = [...this.#toolProgress.values()];
    if (units.length > 0 && units.every((u) => typeof u.fraction === 'number')) {
      next = units.reduce((sum, u) => sum + (u.fraction as number), 0) / units.length;
    }
    if (next === this.#lastToolProgress) return;
    this.#lastToolProgress = next;
    this.#onToolProgressChange?.(next);
  }

  #disposeToolUiDip(requestId: string): void {
    const entry = this.#toolUiDips.get(requestId);
    if (!entry) return;
    this.#toolUiDips.delete(requestId);
    try {
      entry.instance.dispose();
    } catch {}
    entry.container.remove();
  }

  #handleErrorRetry(event: Event): void {
    if (this.#processing) return;
    const messageId =
      (event as CustomEvent<{ messageId?: string | null }>).detail?.messageId ?? null;
    let startIndex = this.#messages.length;
    if (messageId) {
      const errorIndex = this.#messages.findIndex((m) => m.id === messageId);
      if (errorIndex >= 0) startIndex = errorIndex;
    }

    const prev = startIndex > 0 ? this.#messages[startIndex - 1] : undefined;
    if (prev && prev.source === 'lick' && !prev.queued) {
      this.#agent.sendMessage(prev.content, uid(), prev.attachments);
      return;
    }

    let target: ChatMessage | undefined;
    for (let i = startIndex - 1; i >= 0; i--) {
      const m = this.#messages[i];
      if (m.role === 'user' && m.source !== 'lick' && m.source !== 'delegation' && !m.queued) {
        target = m;
        break;
      }
    }
    if (!target) return;
    this.#agent.sendMessage(target.content, uid(), target.attachments);
  }

  #findMessage(id: string): ChatMessage | undefined {
    return this.#messages.find((m) => m.id === id);
  }

  #safeMessageEls(message: ChatMessage): HTMLElement[] {
    try {
      return messageEls(message, { readOnly: this.#readOnly });
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
    this.#unwrapToolClusters();
    this.#messages.push(message);
    const els = this.#safeMessageEls(message);
    this.#els.set(message.id, els);
    this.#thread.append(...els);
    this.#reflowToolClusters();
    this.#onMessageRendered?.(message, els);

    if (message.role === 'user') this.#scrollToBottom();
    else this.#followThread();
  }

  #rerenderMessage(message: ChatMessage): void {
    this.#unwrapToolClusters();
    const old = this.#els.get(message.id) ?? [];
    const next = this.#safeMessageEls(message);

    const anchor = old[0] ?? null;
    const parent = anchor?.parentNode;
    if (parent) for (const el of next) parent.insertBefore(el, anchor);
    else this.#thread.append(...next);
    this.#els.set(message.id, next);

    this.#onMessageRendered?.(message, next);
    for (const el of old) el.remove();

    for (const call of message.toolCalls ?? []) {
      if (call.id && this.#toolProgress.has(call.id)) this.#applyToolProgress(call.id);
    }
    this.#reflowToolClusters();

    this.#refreshClusterProgress();
    this.#followThread();
  }

  #threadInner(): HTMLElement {
    return (this.#thread as { inner?: HTMLElement }).inner ?? this.#thread;
  }

  #unwrapToolClusters(): void {
    unwrapToolClusters(this.#threadInner(), this.#openClusterAnchors);
  }

  #reflowToolClusters(): void {
    reflowToolClusters(this.#threadInner(), {
      openClusterAnchors: this.#openClusterAnchors,
      toolCallLookup: (msgId, callId) => this.#lookupToolCall(msgId, callId),
    });
  }

  #lookupToolCall(messageId: string, callId: string): ToolCall | undefined {
    const message = this.#messages.find((m) => m.id === messageId);
    return message?.toolCalls?.find((c) => c.id === callId);
  }

  #scrollToBottom(): void {
    this.#thread.scrollTop = this.#thread.scrollHeight;
  }

  #followThread(): void {
    const thread = this.#thread as HTMLElement & { requestFollow?: () => void };
    if (typeof thread.requestFollow === 'function') thread.requestFollow();
    else this.#scrollToBottom();
  }
}
