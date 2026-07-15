/**
 * Live chat controller for the WC shell: binds an `AgentHandle` event stream
 * and the scoop message history onto a `<slicc-chat-thread>`. Mirrors the
 * legacy `ChatPanel` streaming state machine (message_start → content_delta →
 * content_done / tool rows → turn_end) but renders through the
 * `wc-message-view.ts` mapper instead of hand-built DOM.
 */

import {
  applyDictationMarkers,
  consumeDictationFirst,
  stripDictationMarkers,
} from '../../speech/dictation-priming.js';
import { TOOL_UI_MOUNTED_ACTION } from '../../tools/tool-ui.js';
import { consumeStaleAssetReplayPending } from '../boot/setup-preload-error-reload.js';
import { type DipInstance, mountDip } from '../dip.js';
import { trackChatSend, trackError } from '../telemetry.js';
import type { AgentEvent, AgentHandle, ChatMessage, ToolCall } from '../types.js';
import { createCopyRow } from './wc-copy-row.js';
import {
  collateLickMessages,
  daySeparatorEl,
  isAuthExpiredError,
  isInvalidModelError,
  isNoApiKeyError,
  messageEls,
  reflowToolClusters,
  unwrapToolClusters,
} from './wc-message-view.js';

/**
 * View shape the controller hands the host for stack rendering. The full
 * `ChatMessage` is kept internally; this is the projection the
 * `slicc-queued-stack` component consumes via `setMessages`. Mirrors the
 * library's `QueuedMessage` shape without importing the component, so the
 * controller stays framework-free.
 */
/**
 * Busy-turn phase mirrored onto `<slicc-send-button>`'s `phase` attribute:
 * `tool` while a tool call runs, `thinking` while waiting on / streaming from
 * the LLM. Matches the component's supported attribute values.
 */
export type BusyPhase = 'thinking' | 'tool';

export interface QueuedMessageView {
  id: string;
  text: string;
  /** Optional attachment count — shown as a small `+N` hint on the front card. */
  attachments?: number;
}

export interface WcChatControllerOptions {
  /** The `<slicc-chat-thread>` element messages render into. */
  thread: HTMLElement;
  /** Agent surface for sending prompts and receiving events. */
  agent: AgentHandle;
  /** Notified when the agent starts/stops processing a turn. */
  onProcessingChange?: (processing: boolean) => void;
  /**
   * Notified when the busy turn's phase changes — `tool` while one or more
   * tool calls are executing, `thinking` while waiting on / streaming from
   * the LLM. Derived from `tool_use_start` / `tool_result` events and reset
   * to `thinking` on each turn's rising edge. The host wires this onto the
   * send button's `phase` attribute (only meaningful while `busy`).
   */
  onBusyPhaseChange?: (phase: BusyPhase) => void;
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
  /**
   * Telemetry context resolver fired on each user-initiated send. Returns the
   * scoop name + resolved model id for the `formsubmit` beacon; returning
   * null / throwing skips the beacon (telemetry must never block a send).
   */
  resolveTelemetryContext?: () => { scoopName: string; model: string } | null;
  /**
   * Invoked when the queued-submissions list changes (enqueue, local
   * dismiss, flush-on-consume). The host wires this to its
   * `<slicc-queued-stack>` ref's `setMessages`. The controller never
   * touches the component directly.
   */
  onQueuedChange?: (items: readonly QueuedMessageView[]) => void;
  /**
   * Invoked once per dropped queued message id when the live-only stack
   * is discarded by a scoop switch / session reload (`loadMessages` with
   * a non-empty `#queued`). The host wires this to the SAME backend
   * cancel path the local `×` dismiss uses (the offscreen client's
   * `deleteQueuedMessage` RPC) so the orchestrator never delivers a
   * queued prompt the user has implicitly dropped by navigating away.
   * The controller stays free of any direct client/RPC dependency,
   * consistent with the existing `onQueuedChange` seam.
   */
  onQueuedCancel?: (messageId: string) => void;
  /**
   * Invoked when a dip mounted for an agent-driven `tool_ui` event fires
   * a lick — the host wires this to {@link OffscreenClient.sendToolUiAction}
   * so the worker realm's `toolUIRegistry.handleAction` resolves the
   * pending request. The controller also dispatches the reserved
   * {@link TOOL_UI_MOUNTED_ACTION} sentinel once the dip mounts, so the
   * worker-side mount backend can fail fast when no panel is listening.
   */
  onToolUiAction?: (requestId: string, action: string, data?: unknown) => void;
  /**
   * True for tray followers (including cherry): the follower has no
   * `onToolUiAction` wiring and no mounted permissions surface, so an
   * agent-driven `tool_ui` card (mount/USB/serial/HID approval) broadcast
   * from the leader can never be acted on here — clicking its buttons
   * would silently no-op. When set, `#handleToolUI` renders a static,
   * non-interactive "waiting for approval on the leader" card instead of
   * mounting the live dip.
   */
  readOnlyToolUi?: boolean;
}

function uid(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Pull the human-readable title out of a `buildApprovalCardHtml` card
 * (`picker-approval.ts`) — e.g. "Mount local directory" — so the follower
 * placeholder can name what's pending without importing the picker-kind
 * text table. Falls back to a generic label if the header can't be found
 * (defensive: any tool_ui card, not just picker-approval, could arrive).
 */
function extractToolUiTitle(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const header = doc.querySelector('.sprinkle-action-card__header');
    if (header) {
      // Strip the trailing "approval" badge and the target-path meta line
      // (`.sprinkle-action-card__meta`, nested under the header's
      // title-group) — the follower placeholder shows only the title,
      // never the mount target path.
      header.querySelector('.sprinkle-badge')?.remove();
      header.querySelector('.sprinkle-action-card__meta')?.remove();
      const title = header.textContent?.trim();
      if (title) return title;
    }
  } catch {
    /* malformed html — fall through to the generic label */
  }
  return 'Approval requested';
}

/** Escape text for safe interpolation into an HTML string. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Static, non-interactive placeholder shown to a tray follower in place of
 * a cone-driven `tool_ui` approval card (mount/USB/serial/HID). Followers
 * have no `onToolUiAction` wiring and no mounted permissions surface —
 * clicking Deny/Approve here would silently no-op — so this renders plain
 * status text instead of live buttons.
 */
function buildReadOnlyToolUiHtml(html: string): string {
  const title = escapeHtml(extractToolUiTitle(html));
  return `
    <div class="sprinkle-action-card">
      <div class="sprinkle-action-card__header">${title} <span class="sprinkle-badge sprinkle-badge--informative">pending</span></div>
      <div class="sprinkle-action-card__body">Waiting for approval on the leader&hellip;</div>
    </div>
  `;
}

/** Project a queued `ChatMessage` onto the host-render shape. */
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
  readonly #onMessageRendered?: (message: ChatMessage, els: readonly HTMLElement[]) => void;
  readonly #onMessageDisposed?: (messageId: string) => void;
  readonly #onTurnComplete?: (message: ChatMessage | null) => void;
  readonly #resolveTelemetryContext?: () => { scoopName: string; model: string } | null;
  readonly #onQueuedChange?: (items: readonly QueuedMessageView[]) => void;
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
  /** Bubbled `slicc-error-retry` listener wired to the thread — see `#handleErrorRetry`. */
  readonly #onErrorRetry: (event: Event) => void;

  #messages: ChatMessage[] = [];
  /**
   * User submissions sent while `#processing` is true — held OUT of the
   * thread (no inline bubble) and OUT of `#messages` until the next turn's
   * first `message_start` flushes them in enqueue order. The host renders
   * the stack via `onQueuedChange`; the agent already received each one
   * synchronously in `sendUserMessage` (delivery cancel is a separate task).
   */
  #queued: ChatMessage[] = [];
  /** Rendered thread elements per message id (a message can span several). */
  readonly #els = new Map<string, HTMLElement[]>();
  #currentStreamId: string | null = null;
  /** The assistant message the ACTIVE turn streamed (reset on each rise). */
  #turnAssistantId: string | null = null;
  #pendingDelta = '';
  #flushScheduled = false;
  #processing = false;
  /**
   * The busy turn's current phase, mirrored onto the send button. Reset to
   * `thinking` on each turn's rising edge and flipped to `tool` whenever at
   * least one tool call is in flight (see `#activeToolCount`).
   */
  #busyPhase: BusyPhase = 'thinking';
  /**
   * In-flight tool calls for the active turn — incremented per rendered
   * `tool_use_start`, decremented per matched `tool_result`. Drives the
   * `tool` ↔ `thinking` phase transition; reset on each turn's rising edge.
   */
  #activeToolCount = 0;
  /** Lazily-built copy affordance, re-appended after the last reply. */
  #copyRow: HTMLElement | null = null;
  /** Anchor msgIds of tool-call clusters that were expanded immediately
   *  before the most recent unwrap. Populated by `#unwrapToolClusters`
   *  and consumed (then cleared) by `#reflowToolClusters`, so the
   *  rebuilt cluster preserves the user's expanded state when a new
   *  tool call streams into the chain. */
  readonly #openClusterAnchors = new Set<string>();
  /**
   * Active agent-driven `tool_ui` dips keyed by requestId. Each entry
   * owns its own detached container appended to the thread inner column
   * (NOT inside a message bubble) so streaming-message rerenders never
   * wipe the live approval card. Disposed on `tool_ui_done`, controller
   * dispose, or a wholesale {@link loadMessages} reset.
   */
  readonly #toolUiDips = new Map<string, { instance: DipInstance; container: HTMLElement }>();

  constructor(options: WcChatControllerOptions) {
    this.#thread = options.thread;
    this.#agent = options.agent;
    this.#onProcessingChange = options.onProcessingChange;
    this.#onBusyPhaseChange = options.onBusyPhaseChange;
    this.#onMessageRendered = options.onMessageRendered;
    this.#onMessageDisposed = options.onMessageDisposed;
    this.#onTurnComplete = options.onTurnComplete;
    this.#resolveTelemetryContext = options.resolveTelemetryContext;
    this.#onQueuedChange = options.onQueuedChange;
    this.#onQueuedCancel = options.onQueuedCancel;
    this.#onToolUiAction = options.onToolUiAction;
    this.#readOnlyToolUi = options.readOnlyToolUi ?? false;
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
    for (const id of [...this.#toolUiDips.keys()]) this.#disposeToolUiDip(id);
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

  /**
   * Leader-tray broadcast hook, invoked on every local processing-state
   * transition. The leader mirrors its turn lifecycle to followers as a
   * `status` message (`processing` on the rising edge, `ready` on the
   * falling edge). Followers map that onto their own composer
   * turn-complete/ready transition — the live float emits no `turn_end`
   * agent event, so without it a follower's send spinner never clears (F1)
   * and a queued card never promotes on the next turn's rising edge (F2).
   */
  setOnLocalProcessingChange(hook: ((processing: boolean) => void) | undefined): void {
    this.#onLocalProcessingChange = hook;
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

  /** Snapshot of the currently-queued submissions (host-render projection). */
  getQueuedMessages(): QueuedMessageView[] {
    return this.#queued.map(toQueuedView);
  }

  /**
   * Local dismiss path for the stack's `×` button — drops the item from
   * `#queued` and refreshes the host. Delivery has already happened (the
   * agent's send fires synchronously on enqueue); cancelling the orchestrator
   * dequeue is tracked separately. No-op for unknown ids.
   */
  removeQueuedMessage(id: string): void {
    const next = this.#queued.filter((m) => m.id !== id);
    if (next.length === this.#queued.length) return;
    this.#queued = next;
    this.#fireQueuedChange();
  }

  /**
   * Flush the queued submissions into the thread as ordinary user bubbles —
   * in enqueue order, with no `queued` flag set so they render plain. The
   * agent already received each one in `sendUserMessage`; this is the
   * presentation-only consume boundary. Fires `onQueuedChange([])` once.
   */
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
    // A scoop switch / session reload also drops any in-flight tool_ui
    // dips — the new thread has no place for the old approval card and
    // the worker-side request is canceled when its scoop unloads.
    for (const id of [...this.#toolUiDips.keys()]) this.#disposeToolUiDip(id);
    // The queued stack is live-only — a scoop switch / session reload starts
    // with an empty pile rather than carrying the previous scoop's queue.
    // Each dropped id routes through the SAME backend cancel path the local
    // `×` dismiss uses so the orchestrator never delivers a prompt the user
    // implicitly dropped by switching away. The hook is fired BEFORE we clear
    // the local queue so a throwing host can't strand entries half-dropped.
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
      this.#fireQueuedChange();
    }
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

    this.#reflowToolClusters();
    for (const message of this.#messages) {
      if (!message.isStreaming) {
        this.#onMessageRendered?.(message, this.#els.get(message.id) ?? []);
      }
    }
    this.#syncCopyRow();
    this.#scrollToBottom();
    // loadMessages is the convergence point where the restored thread arrives
    // post-(re)connect on the leader; auto-resubmit a cone turn dropped by a
    // stale-asset recovery reload once the thread is in place (consume-once).
    this.#maybeReplayDroppedTurn();
  }

  /**
   * After a stale-asset recovery reload (#1330), the cone turn that was in
   * flight was dropped: the user's message is persisted (shows as sent) but
   * the agent never answered it. If the worker turn-time trigger marked a
   * replay pending, re-send that dropped turn ONCE so the agent answers it —
   * reusing the existing retry path, no new agent API. Leader/standalone only
   * (a follower has no kernel worker, so its reload drops no cone turn).
   *
   * Scoped to the CONE thread. `loadMessages` fires for whichever thread loads
   * first post-boot, which can be a `scoop:<name>` / `freezer:<file>` deep-link
   * — NOT the cone. Gating on the thread's `context` attribute (set
   * synchronously by `applyThreadContext` BEFORE messages are requested) keeps
   * the one-shot flag alive until the cone thread loads, so a non-cone load
   * never (a) consumes the flag — which would MISS the cone's real dropped
   * turn — nor (b) wrong-sends: a scoop mid-delegation ends in a
   * `role:'user'` prompt that is NOT tagged `source:'delegation'`, so replaying
   * there would inject the cone's prompt into the scoop's agent.
   */
  #maybeReplayDroppedTurn(): void {
    // Only the cone thread carries a user-resubmittable dropped turn.
    if (this.#thread.getAttribute('context') !== 'cone') return;
    // A transient empty cone load must not waste the one-shot flag — wait for
    // the real cone snapshot.
    if (this.#messages.length === 0) return;
    // Consume-once: reads AND clears the flag, so repeat loadMessages calls
    // (scoop switches) never re-replay. No-op unless a cone turn was dropped.
    if (!consumeStaleAssetReplayPending()) return;
    // A turn is already running — the dropped turn either resumed or a new one
    // started; resubmitting would double-submit.
    if (this.#processing) return;
    const last = this.#messages[this.#messages.length - 1];
    // Only replay when the thread ENDS in an unanswered user-typed turn (a
    // dropped turn). If the last message is an assistant reply, the turn
    // completed — do not resend. Licks / delegations / queued rows are not
    // user-resubmittable originators.
    if (
      last.role !== 'user' ||
      last.source === 'lick' ||
      last.source === 'delegation' ||
      last.queued
    ) {
      return;
    }
    // No messageId → #handleErrorRetry replays the last user turn via
    // #agent.sendMessage (it has its own #processing double-submit guard).
    this.#handleErrorRetry(new Event('slicc-error-retry'));
  }

  /**
   * Append a user prompt locally and forward it to the agent. When
   * `options.dictation` is set, the dictation markers (🎙️ + the one-time
   * priming note) are appended to the text before storing and sending —
   * the marked text is what the agent (and replay/compaction) sees; the
   * render seam strips the markers so the visible bubble stays clean.
   */
  sendUserMessage(
    text: string,
    attachments?: ChatMessage['attachments'],
    options?: { dictation?: boolean }
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
    if (this.#processing) {
      // Busy-submit: park the bubble in the stack instead of the thread. The
      // agent still receives it now (orchestrator owns turn batching); the
      // bubble flushes into the thread when the consuming turn starts.
      this.#queued.push(message);
      this.#fireQueuedChange();
    } else {
      this.#appendMessage(message);
    }
    this.#agent.sendMessage(content, message.id, message.attachments);
    // Fire ONLY on the single user-initiated send site. The retry path
    // (`#handleErrorRetry`) replays an existing user turn through
    // `#agent.sendMessage` directly and intentionally does NOT re-beacon,
    // so a click on "Try again" can't inflate the chat-send count.
    this.#emitChatSendBeacon();
    try {
      // Attachments ride along so tray followers see the full prompt, not a
      // text-only echo. The follower echo is a DISPLAY string — iOS renders
      // `message.content` verbatim, so dictation markers must be stripped
      // here (web followers strip at render, but iOS does not). The agent
      // send and the locally-stored ChatMessage keep the marked form so
      // replay / compaction keep the priming context.
      const echo = options?.dictation ? stripDictationMarkers(content) : content;
      this.#onLocalUserMessage?.(echo, message.id, message.attachments);
    } catch (err) {
      // The broadcast hook is the followers' visibility path; never let a
      // broken broadcaster undo the local send.
      console.error('onLocalUserMessage hook threw', err);
    }
  }

  /**
   * Append the dictation markers to a freshly-submitted dictated message —
   * the one-time priming note rides only on the FIRST dictated turn of the
   * session (via `consumeDictationFirst`); every later turn gets just 🎙️.
   */
  #applyDictation(text: string): string {
    return applyDictationMarkers(text, consumeDictationFirst());
  }

  /**
   * Resolve the active scoop name + model and emit the `formsubmit` telemetry
   * beacon. Failure to resolve is silently swallowed — telemetry is fire and
   * forget and must never disrupt the send path.
   */
  #emitChatSendBeacon(): void {
    if (!this.#resolveTelemetryContext) return;
    try {
      const ctx = this.#resolveTelemetryContext();
      if (!ctx) return;
      trackChatSend(ctx.scoopName, ctx.model);
    } catch {
      // Telemetry must never block the send.
    }
  }

  /** Render an inbound lick (webhook/cron/…) into the thread. */
  addLickMessage(
    id: string,
    content: string,
    channel: string,
    timestamp: number,
    lickId?: string
  ): void {
    // Collate into the trailing card when the previous message is a lick of
    // the same channel — the pill counts up instead of stacking cards. NEVER
    // collate actionable licks: if the incoming lick carries a `lickId`, or the
    // trailing card already does, each must stand alone so exactly one card
    // flips via `updateLickState`.
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
      // Actionable licks (sudo-request) carry an id so a later resolve can
      // flip this card's state in place (see `updateLickState`).
      lickId,
      lickState: lickId ? 'pending' : undefined,
      // Mirror `sendUserMessage`: a lick that arrives mid-turn is not the
      // originator of the current turn, so retry scans must skip it.
      queued: this.#processing ? true : undefined,
    });
  }

  /**
   * Flip an actionable lick card's result state in place (no new row),
   * located by its `lickId`. Fired when the cone settles a sudo-request;
   * a no-op when the card isn't in the current thread (e.g. a different
   * scoop is selected).
   */
  updateLickState(lickId: string, lickState: ChatMessage['lickState']): void {
    const message = this.#messages.find((m) => m.lickId === lickId);
    if (!message) return;
    message.lickState = lickState;
    this.#rerenderMessage(message);
  }

  /** External processing-state override (e.g. scoop status broadcasts). */
  setProcessing(processing: boolean): void {
    if (this.#processing === processing) return;
    this.#processing = processing;
    // A RISING edge starts a fresh turn — forget the previous turn's reply
    // so a turn that streams nothing can never surface a stale one.
    if (processing) this.#turnAssistantId = null;
    // A turn always opens in the `thinking` phase (LLM wait/stream); any
    // tool calls flip it to `tool` as they start (see `#handleToolUseStart`).
    // Reset the in-flight count too so a turn that ended mid-tool can't leak
    // a stale `tool` phase into the next one.
    if (processing) {
      this.#activeToolCount = 0;
      this.#setBusyPhase('thinking');
    }
    // The RISING edge is also the queue-consume boundary: items parked
    // while busy belong to THIS turn, so flush them into the thread (in
    // enqueue order, as ordinary user bubbles) BEFORE the streaming
    // assistant lands. Hanging the flush off the rising edge (rather than
    // off `message_start`) is the one turn-boundary signal BOTH floats
    // share — live floats drive processing via scoop STATUS broadcasts
    // that fire BEFORE the agent's `message_start` arrives, so a flush
    // gated on `message_start` would miss the live ordering entirely. A
    // mid-turn second `message_start` (multi-message turns) finds
    // `#processing` already true → `setProcessing` early-returns above →
    // no double flush, so items queued mid-turn keep waiting for the NEXT
    // turn's rising edge.
    if (processing) this.#flushQueued();
    if (!processing) this.#syncCopyRow();
    this.#onProcessingChange?.(processing);
    // Mirror the local turn lifecycle to tray followers (leader only — the
    // hook is set by `wireLeaderHooks`). The live float never emits a
    // `turn_end` agent event, so this `status` broadcast is the follower's
    // sole processing→idle signal; a throwing broadcaster must never disturb
    // the local composer state.
    try {
      this.#onLocalProcessingChange?.(processing);
    } catch (err) {
      console.error('onLocalProcessingChange hook threw', err);
    }
    // End-of-turn = the processing flag FALLING. This is deliberately not
    // hung off the `turn_end` agent event: the live floats' chat wire only
    // carries `response_done` (offscreen-bridge.ts defers `turn_end`
    // synthesis), so processing falls via scoop STATUS broadcasts there —
    // the transition is the one signal every float shares.
    if (!processing) this.#fireTurnComplete();
  }

  /**
   * Update the busy-turn phase and notify the host (deduped — only fires on
   * an actual change). The host mirrors this onto the send button's `phase`
   * attribute, which is only meaningful while the button is `busy`.
   */
  #setBusyPhase(phase: BusyPhase): void {
    if (this.#busyPhase === phase) return;
    this.#busyPhase = phase;
    this.#onBusyPhaseChange?.(phase);
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
      case 'tool_ui':
        this.#handleToolUI(event.messageId, event.requestId, event.html);
        break;
      case 'tool_ui_done':
        this.#handleToolUIDone(event.requestId);
        break;
      case 'turn_end':
        this.#handleTurnEnd(event.messageId);
        break;
      case 'error':
        this.#handleError(event.error);
        break;
      // Carried by `AgentEvent` for other surfaces (offscreen screenshot
      // pipe, terminal echo) — the chat thread doesn't render them but
      // listing them explicitly keeps the exhaustiveness guard below
      // honest: deleting any case (including these no-ops) becomes a
      // compile error rather than a silent UI regression.
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
    // The queued-stack flush rides the processing rising edge inside
    // `setProcessing` — both this code path AND the live-float scoop-status
    // broadcast path go through that one chokepoint, so a flush gated here
    // would miss the live ordering (status fires BEFORE `message_start`).
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
    // A tool is now in flight — flip the busy phase to `tool` so the send
    // button stops the LLM-wait fill treatment and spins instead.
    this.#activeToolCount += 1;
    this.#setBusyPhase('tool');
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
    // One fewer tool in flight; once they all settle the turn is back to
    // waiting on / streaming from the LLM, so return to the `thinking` phase.
    this.#activeToolCount = Math.max(0, this.#activeToolCount - 1);
    if (this.#activeToolCount === 0) this.#setBusyPhase('thinking');
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
    this.#emitErrorCardBeacon(error);
  }

  /**
   * Best-effort RUM beacon for user-visible error cards that have NO dedicated
   * handler (the default "Try again" variant). The handled families — no-api-key,
   * invalid-model, auth-expired — own remediation UX and are user-fixable known
   * states, so beaconing them would only add triage noise; we skip them. A
   * distinct `'error-card'` source lets the nightly triage distinguish these
   * from the agent-loop `'llm'`/`'tool'` beacons. Mirrors `#emitChatSendBeacon`'s
   * fire-and-forget style — telemetry must never disrupt the error-render path.
   */
  #emitErrorCardBeacon(error: string): void {
    try {
      if (isNoApiKeyError(error) || isInvalidModelError(error) || isAuthExpiredError(error)) {
        return;
      }
      trackError('error-card', error);
    } catch {
      // Telemetry must never block the error render.
    }
  }

  /**
   * Mount the agent's interactive `tool_ui` approval/picker card as a dip
   * appended to the thread inner column. Each card lives in its own
   * container OUTSIDE the streaming message bubble — `#rerenderMessage`
   * swaps out per-message element arrays on every content_delta, so a
   * dip attached inside the bubble would be wiped mid-stream. The dip's
   * `onLick` forwards to `onToolUiAction(requestId, …)` so the worker
   * realm's `toolUIRegistry.handleAction` runs; a reserved
   * {@link TOOL_UI_MOUNTED_ACTION} ack fires immediately after mount so
   * the worker-side mount backend can fail fast if no panel was listening.
   *
   * On a tray follower ({@link WcChatControllerOptions.readOnlyToolUi}) the
   * card is broadcast from the leader purely for visibility — this instance
   * has no `onToolUiAction` and no mounted permissions surface, so the real
   * buttons would silently no-op. Render a static "waiting on the leader"
   * placeholder instead, and skip the mount ack (the leader's OWN card is
   * what the worker-side mount backend is waiting on).
   */
  #handleToolUI(_messageId: string, requestId: string, html: string): void {
    // Defensive: a re-entrant tool_ui for the same id replaces the
    // prior card (avoids stacking duplicates after an agent retry).
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
      /* trusted */ false
    );
    this.#toolUiDips.set(requestId, { instance, container });
    // Tell the worker realm we rendered the card. Without this ack the
    // mount backend would wait its full 5-minute timeout when no panel
    // is listening (the regression d222f1385 deleted the renderer that
    // used to receive the event at all).
    this.#onToolUiAction?.(requestId, TOOL_UI_MOUNTED_ACTION, undefined);
  }

  #handleToolUIDone(requestId: string): void {
    this.#disposeToolUiDip(requestId);
  }

  #disposeToolUiDip(requestId: string): void {
    const entry = this.#toolUiDips.get(requestId);
    if (!entry) return;
    this.#toolUiDips.delete(requestId);
    try {
      entry.instance.dispose();
    } catch {
      /* best-effort — iframe may already be gone */
    }
    entry.container.remove();
  }

  /**
   * Re-run the input that produced THIS error card through the existing
   * agent send path (`#agent.sendMessage`) — no new agent API, no duplicate
   * user bubble. The card forwards its `message-id` (the failed error
   * message's id) on the event; we walk backward from that message to find
   * the originating input. A retry while a turn is in flight is dropped to
   * avoid double-submissions. Falls back to the legacy "scan the whole
   * thread" when the event carries no messageId (older callers / non-card
   * dispatchers).
   *
   * Two replay sources, in priority order:
   * 1. **Immediately-preceding lick.** Welcome / webhook / cron licks DO
   *    trigger cone turns (e.g. the onboarding welcome lick is the very
   *    first input the cone sees). If the cone errored on the lick — common
   *    for an invalid-model fail on the first turn after sign-in — there is
   *    no user message to fall back to. Replaying the lick body so the cone
   *    has context is the whole point of the change-model affordance.
   * 2. **Last user-typed message** otherwise. Lick rows further up the
   *    thread are skipped; only the lick directly above the error counts as
   *    the originating turn. Delegation rows are skipped in both modes —
   *    they are scoop-internal, never a user-driven retry target.
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
    // (1) Immediately-preceding lick — the welcome-lick onboarding case.
    // A queued lick arrived mid-turn (after the originator) so it is NOT
    // the originator and must be skipped here.
    const prev = startIndex > 0 ? this.#messages[startIndex - 1] : undefined;
    if (prev && prev.source === 'lick' && !prev.queued) {
      this.#agent.sendMessage(prev.content, uid(), prev.attachments);
      return;
    }
    // (2) Last user-typed message in the thread (skip licks / delegations
    // and anything queued mid-turn — that was submitted AFTER the failing
    // turn started, so it's not the originator).
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
    // Per-message ops must operate on a clean inline layout — tool rows
    // currently nested inside a cross-message cluster have to be
    // returned home first so the new message and the unwrapped rows
    // share the same parent (the thread inner). The next reflow pass
    // rebuilds the cluster from the post-append DOM.
    this.#unwrapToolClusters();
    this.#messages.push(message);
    const els = this.#safeMessageEls(message);
    this.#els.set(message.id, els);
    this.#thread.append(...els);
    this.#reflowToolClusters();
    if (!message.isStreaming) this.#onMessageRendered?.(message, els);
    // The user's own submission always lands in view; agent-driven appends
    // defer to the thread's polite follow (new-messages chip when scrolled).
    if (message.role === 'user') this.#scrollToBottom();
    else this.#followThread();
  }

  #rerenderMessage(message: ChatMessage): void {
    // Tool rows for sibling messages in the same chain may be sitting
    // inside a cross-message cluster appended to a different message's
    // slot. Unwrap first so each message owns its tool rows again
    // before we swap THIS message's elements — otherwise the new
    // inline rows would coexist with stale clustered copies.
    this.#unwrapToolClusters();
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
    this.#reflowToolClusters();
    if (!message.isStreaming) this.#onMessageRendered?.(message, next);
    this.#followThread();
  }

  /** The thread's reading column (where children actually live). The
   *  `<slicc-chat-thread>` component appends into its inner column;
   *  bare hosts (tests) put children on the host element itself. */
  #threadInner(): HTMLElement {
    return (this.#thread as { inner?: HTMLElement }).inner ?? this.#thread;
  }

  /** Return every relocated tool row to its message's inline position
   *  before any per-message op or full reflow. The shared anchor set
   *  captures user-expanded state so the rebuilt cluster reopens. */
  #unwrapToolClusters(): void {
    unwrapToolClusters(this.#threadInner(), this.#openClusterAnchors);
  }

  /** Wrap consecutive ≥3-row runs across the thread inner into shared
   *  `<slicc-tool-cluster>`s. The lookup resolves clustered rows back
   *  to their owning `ToolCall` so labels are scheduled with input
   *  data. Safe to call after every load / append / rerender — empty
   *  threads and shorter runs are no-ops. */
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
