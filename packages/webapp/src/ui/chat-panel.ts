/**
 * Chat Panel — message list + input area with streaming support.
 *
 * Displays user messages, assistant messages, and tool results.
 * Connects to an AgentHandle for sending messages and receiving events.
 */

import { Brain, File as FileIcon, FileText, Image as ImageIcon, Paperclip, X } from 'lucide';
import { THINKING_LEVEL_CYCLE, isThinkingLevel, type ThinkingLevel } from '../scoops/types.js';
import type { AgentHandle, AgentEvent, ChatMessage, ToolCall } from './types.js';
import { renderAssistantMessageContent, renderMessageContent } from './message-renderer.js';
import { SessionStore } from './session-store.js';
import { createLogger } from '../core/logger.js';
import type { MessageAttachment, MessageAttachmentKind } from '../core/attachments.js';
import { formatAttachmentSize, formatAttachmentSummary } from '../core/attachments.js';
import { getMimeType } from '../core/mime-types.js';
import { processImageContent, isSupportedImageFormat } from '../core/image-processor.js';
import { VoiceInput, getVoiceAutoSend, getVoiceLang } from './voice-input.js';
import {
  hydrateDips,
  disposeDips,
  mountDraftDip,
  splitContentSegments,
  type DipInstance,
  type DraftDipInstance,
} from './dip.js';
import { createToolUIRenderer, disposeToolUIRenderer } from './tool-ui-renderer.js';
import {
  getToolDescriptor,
  createToolIcon,
  createToolBody,
  toolStatus,
  groupToolCalls,
  clusterPreview,
  clusterPreviewFromTitles,
  createClusterIcon,
  TOOL_CLUSTER_MIN,
} from './tool-call-view.js';
import { getLickDescriptor, createLickIcon, parseLickContent } from './lick-view.js';
import { isLickChannel, type LickChannel } from './lick-channels.js';
import {
  getAllAvailableModels,
  getSelectedModelId,
  getSelectedProvider,
  setSelectedModelId,
  getProviderConfig,
} from './provider-settings.js';
import { quickLabel } from './quick-llm.js';
import { trackChatSend, trackImageView } from './telemetry.js';
import { attachLongPressGesture } from './long-press.js';

const log = createLogger('chat-panel');

type IconNode = [tag: string, attrs: Record<string, string | number>][];

/**
 * Writes a dropped/picked file somewhere the agent can reach (typically
 * `/tmp` on the virtual filesystem) and returns the resulting absolute
 * VFS path. Used by ChatPanel to off-load attachments that are too large
 * to inline as base64/text into the prompt.
 */
export type AttachmentWriter = (file: File) => Promise<string>;

/**
 * Above this size, images are saved to the VFS instead of inlined.
 * Kept conservative because inlined images are base64-encoded (≈33%
 * expansion) and forwarded through chrome.runtime / tray sync message
 * buses, both of which have transport-size ceilings.
 */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** Above this size, text files are saved to the VFS instead of inlined. */
const MAX_INLINE_TEXT_BYTES = 512 * 1024;

/** Generate a simple unique ID. */
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Reject degenerate cluster labels: too short, just digits/punctuation, or
 *  a single word. The LLM occasionally treats tool inputs as code to run
 *  and replies with the *result* (e.g., "3" for `console.log(1+2)`); this
 *  guards against displaying that as the cluster's label. */
function isUsefulClusterLabel(text: string): boolean {
  if (text.length < 6) return false;
  if (!/[a-zA-Z]/.test(text)) return false;
  // Reject single-word labels; cluster summaries should be a phrase.
  if (!/\s/.test(text.trim())) return false;
  return true;
}

/** Read a tool-call element's current status from its `tool-call--<status>`
 *  modifier. `createToolCallEl` always sets exactly one of these and
 *  refreshes them on every `updateMessageEl`, so they're the live status
 *  source the chain-level cluster mirrors in its summary dots. */
function readToolCallStatus(el: Element): 'running' | 'success' | 'error' {
  if (el.classList.contains('tool-call--success')) return 'success';
  if (el.classList.contains('tool-call--error')) return 'error';
  return 'running';
}

function createLucideIcon(node: IconNode, size = 18): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const [tag, attrs] of node) {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) {
      child.setAttribute(key, String(value));
    }
    svg.appendChild(child);
  }
  return svg;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Accumulate chunks into an array and join once instead of building
  // the binary string with `+=`. Repeated string concatenation over a
  // multi-MB image causes quadratic-ish allocations and noticeable UI
  // hitches when attaching larger images.
  const chunkSize = 0x8000;
  const chunks: string[] = new Array(Math.ceil(bytes.length / chunkSize));
  let chunkIndex = 0;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    chunks[chunkIndex++] = String.fromCharCode(...chunk);
  }
  return btoa(chunks.join(''));
}

async function readFileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return bytesToBase64(bytes);
}

async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new TextDecoder().decode(await file.arrayBuffer());
}

function isTextLikeFile(file: File, mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (mimeType === 'application/json' || mimeType === 'application/xml') return true;
  if (mimeType === 'image/svg+xml') return true;
  return /\.(?:md|markdown|txt|csv|tsv|json|jsonl|yaml|yml|xml|html|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|c|cc|cpp|h|hpp|sh|bash|zsh|sql)$/i.test(
    file.name
  );
}

function renderChatMessageContent(msg: ChatMessage): string {
  return msg.role === 'assistant'
    ? renderAssistantMessageContent(msg.content, msg.isStreaming === true)
    : renderMessageContent(msg.content);
}

/**
 * Render a single prose segment of a streaming assistant message. Called
 * once per prose segment per flush by `renderStreamingSegmented`. The
 * `isStreaming` flag is always false here because the caller has
 * already split shtml fences out into their own segments — there's no
 * shtml block in the prose to swap for a placeholder, and rendering
 * with the streaming flag would only suppress legitimate code blocks.
 */
function renderProseSegment(text: string, role: ChatMessage['role']): string {
  return role === 'assistant'
    ? renderAssistantMessageContent(text, false)
    : renderMessageContent(text);
}

/**
 * Render a chat as Markdown for the clipboard. Each message becomes a
 * `## User`/`## Assistant` block, attachments and tool calls are
 * appended underneath their owning message. Used by the copy-chat
 * long-press gesture.
 */
export function formatChatForClipboard(messages: ChatMessage[]): string {
  let formatted = '';
  for (const msg of messages) {
    const heading = msg.role === 'user' ? 'User' : 'Assistant';
    formatted += `## ${heading}\n${msg.content}\n\n`;
    if (msg.attachments?.length) {
      formatted += `Attachments:\n${msg.attachments
        .map((attachment) => `- ${formatAttachmentSummary(attachment)}`)
        .join('\n')}\n\n`;
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        formatted += `### Tool: ${tc.name}\nInput: ${JSON.stringify(tc.input, null, 2)}\nResult: ${tc.result ?? ''}\n\n`;
      }
    }
  }
  return formatted;
}

export class ChatPanel {
  private container: HTMLElement;
  private messagesEl!: HTMLElement;
  private messagesInner!: HTMLElement;
  private inputArea!: HTMLElement;
  private textarea!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private micBtn!: HTMLButtonElement;
  private attachBtn!: HTMLButtonElement;
  private fileInput!: HTMLInputElement;
  private attachmentsEl!: HTMLElement;
  private pendingAttachments: MessageAttachment[] = [];
  private attachmentReadInProgress = false;
  private attachmentWriter: AttachmentWriter | null = null;
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
  private dips = new Map<string, DipInstance[]>();
  /**
   * Streaming-draft iframes by message id, indexed in shtml-block order.
   * Slot is `null` when a placeholder exists but no draft has been mounted
   * (e.g. extension mode, or the block content is still empty). Drafts
   * persist across `updateStreamingContent` re-renders by being re-parented
   * onto the freshly-rendered `.msg__dip-pending` element — re-parenting
   * within the same document does not reload the iframe, which is the
   * whole point of this mechanism. Disposed before final `hydrateDips`.
   */
  private drafts = new Map<string, Array<DraftDipInstance | null>>();
  public onDipLick?: (action: string, data: unknown) => void;
  /**
   * Fired whenever the displayed message list changes (new message,
   * streaming update, switch to a new context). The estimated token
   * count is a coarse chars/4 heuristic over message content + tool
   * call JSON — same family of estimate the compaction pass uses,
   * accurate enough to drive UI affordances like the "context getting
   * full" glow on the New Session button.
   */
  public onMessagesChanged?: (estimatedTokens: number) => void;
  private modelSelectorEl!: HTMLElement;
  public onModelChange?: (modelId: string) => void;
  private thinkingBtn!: HTMLButtonElement;
  /**
   * Currently displayed thinking level. Source of truth for the brain icon
   * UI; mirrored to the active scoop's `agent.state.thinkingLevel` and
   * `scoop.config.thinkingLevel` via {@link onThinkingLevelChange}.
   */
  private thinkingLevel: ThinkingLevel = 'off';
  /**
   * Whether the active model supports reasoning at all. The brain icon is
   * hidden when false. Toggled by {@link setModelSupportsReasoning} when
   * the layout learns the active scoop's model has changed.
   */
  private modelSupportsReasoning = false;
  /** Whether the active model supports the `xhigh` cycle stop. */
  private modelSupportsXhigh = false;
  public onThinkingLevelChange?: (level: ThinkingLevel) => void;
  // Per-sessionId write queue for `persistLickToSession`. Chains concurrent
  // load→mutate→save cycles behind the previous in-flight call so bursty
  // licks (e.g. fswatch) for a non-selected scoop can't clobber each other.
  private lickPersistQueues = new Map<string, Promise<void>>();
  /** Anchor msgIds of tool-call clusters that were expanded immediately
   *  before the most recent unwrap. Populated by `unwrapToolClusters` and
   *  consumed (then cleared) by `reflowToolClusters`, so the rebuilt
   *  cluster preserves the user's expanded state when a new tool call
   *  streams into the chain. The first contained tool-call's owning
   *  msgId is used as the anchor: it's the chain's first call and stays
   *  stable as the cluster grows. */
  private openClusterAnchors = new Set<string>();
  /** Cache of LLM-generated cluster labels keyed by sorted tool-call ids. */
  private clusterLabelCache = new Map<string, string>();
  /** Sticky label keyed by the cluster's *anchor* (first tool-call id).
   *  The anchor stays the same as the cluster grows, so once an LLM label
   *  has been shown we can re-display it on every subsequent rebuild —
   *  instead of flickering back to the comma-joined fallback while the
   *  new signature's label is being fetched. */
  private clusterLabelByAnchor = new Map<string, string>();
  /** Debounce timers keyed by anchor. A fresh tool call arriving inside
   *  the debounce window resets the timer, so a fast burst fires one
   *  LLM call for the whole cluster instead of one per call. */
  private clusterLabelTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Latest pending snapshot per anchor: the signature we'll request a
   *  label for, plus every preview element that should receive the
   *  result (including orphaned ones from intermediate reflows — those
   *  are filtered with `isConnected` at settle time). `inFlight` flips
   *  true once `fireClusterLabelRequest` has actually called the LLM
   *  for this signature, so identical-signature reschedules (the same
   *  cluster reflowing during streaming) can enroll their new
   *  previewEl without starting a duplicate request. */
  private clusterLabelPending = new Map<
    string,
    {
      signature: string;
      toolCalls: readonly ToolCall[];
      elements: Set<HTMLElement>;
      inFlight: boolean;
    }
  >();
  /** Debounce window before a cluster-label request actually fires.
   *  Short enough that a finished cluster gets its label promptly, long
   *  enough to coalesce a fast burst of tool calls into one request. */
  private static readonly CLUSTER_LABEL_DEBOUNCE_MS = 600;
  /** Default placeholder before any LLM-suggested replacement. */
  private static readonly DEFAULT_PLACEHOLDER = 'What shall we build?';
  /** AbortController for the most recent placeholder-suggestion request. */
  private placeholderAbort: AbortController | null = null;
  /** Previous `setStreamingState` value. The placeholder refresh fires
   *  only on the streaming→idle edge — not on every "still idle" call
   *  (e.g. context switches that pass `false` while already idle). */
  private wasStreaming = false;

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

  /**
   * Provide a writer used to off-load oversized or unsupported binary
   * attachments to the virtual filesystem (typically `/tmp`). When set,
   * files that exceed the inline limits — or non-text/non-image binaries
   * — are written to disk and surface in the prompt as a path the agent
   * can read instead of being skipped.
   */
  setAttachmentWriter(writer: AttachmentWriter | null): void {
    this.attachmentWriter = writer;
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
    this.resetEphemeralLlmState();
    this.renderMessages();
    await this.sessionStore.delete(this.sessionId);
  }

  /** Delete a specific session by ID (e.g., when a scoop is dropped). */
  async deleteSessionById(sessionId: string): Promise<void> {
    await this.sessionStore.delete(sessionId);
  }

  /** Switch to a different scoop's chat context. */
  /**
   * Render a frozen-session archive as a read-only chat view. Bypasses
   * `SessionStore` (the archive lives on the VFS, not in IndexedDB) and
   * does NOT persist on the way out — the contextId is namespaced so a
   * subsequent `persistSessionAsync()` would no-op rather than poison
   * the live cone session.
   */
  async displayFrozenSession(opts: {
    /** Unique id for this view; prefixed with `frozen:` so it can't collide with a real session. */
    contextId: string;
    /** Pre-parsed messages from the archive. */
    messages: ChatMessage[];
    /** Title to show in the thread header. */
    title: string;
  }): Promise<void> {
    await this.persistSessionAsync();
    this.setStreamingState(false);
    this.currentStreamId = null;
    this.cancelPendingDelta();
    this.resetEphemeralLlmState();
    if (this.textarea) this.textarea.placeholder = ChatPanel.DEFAULT_PLACEHOLDER;
    this.sessionId = opts.contextId;
    // The current-scoop label is a free-form string in this code path —
    // re-use it as a "frozen indicator" so the thread header reads naturally.
    this.currentScoopName = `❄ ${opts.title}`;
    this.setReadOnly(true);
    this.messages = opts.messages.map((m) => ({ ...m, isStreaming: false }));
    this.renderMessages();
  }

  async switchToContext(contextId: string, readOnly: boolean, scoopName?: string): Promise<void> {
    // Save current session first
    await this.persistSessionAsync();

    // Reset streaming state — prevents stale isStreaming from a different scoop
    // from locking the input in the new context
    this.setStreamingState(false);
    this.currentStreamId = null;
    this.cancelPendingDelta();

    // Drop ephemeral LLM-suggestion state from the prior scoop. The
    // cluster cache is keyed by tool-call ids (which are scoped to the
    // outgoing scoop) and the placeholder we generated reflects the
    // outgoing transcript; both would be misleading in the new context.
    this.resetEphemeralLlmState();
    // Reset the placeholder back to the static default until the next
    // streaming→idle transition computes a fresh one for this scoop.
    if (this.textarea) this.textarea.placeholder = ChatPanel.DEFAULT_PLACEHOLDER;

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

  /** Drop all ephemeral state tied to a scoop's lifetime: cluster
   *  labels (keyed by tool-call ids that vanish with the scoop) and
   *  any in-flight placeholder suggestion. Called on every session
   *  reset (`switchToContext`, `clearSession`, `dispose`) so the
   *  ChatPanel never carries unbounded label entries across switches
   *  or applies a label resolved from a previous scoop's signatures. */
  private resetEphemeralLlmState(): void {
    this.clusterLabelCache.clear();
    this.clusterLabelByAnchor.clear();
    for (const t of this.clusterLabelTimers.values()) clearTimeout(t);
    this.clusterLabelTimers.clear();
    this.clusterLabelPending.clear();
    this.placeholderAbort?.abort();
    this.placeholderAbort = null;
    this.wasStreaming = false;
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

  /** Persist a lick message into an arbitrary session (by id).
   *
   * Used by `routeLickToScoop` when the lick arrives for a scoop that isn't
   * currently selected: we still want the next reload's first-select to
   * render the lick as a lick widget, not as a plain user bubble loaded from
   * orchestrator DB. Safe to call concurrently with the panel's own saves —
   * writes are scoped to the non-selected session id so there's no overlap.
   *
   * Per-sessionId writes are serialized via `lickPersistQueues` so bursty
   * channels (fswatch, rapid webhook fanout) can't interleave their
   * load→mutate→save cycles and clobber each other.
   */
  async persistLickToSession(
    sessionId: string,
    lick: {
      id: string;
      content: string;
      channel: LickChannel;
      timestamp: number;
    }
  ): Promise<void> {
    const prior = this.lickPersistQueues.get(sessionId) ?? Promise.resolve();
    const next = prior
      .catch(() => {
        /* swallow upstream errors so this write still runs */
      })
      .then(() => this.writeLickToSession(sessionId, lick));
    this.lickPersistQueues.set(sessionId, next);
    // Evict the entry once it settles if no newer write has queued behind it,
    // to keep the map bounded across long-lived panels.
    void next.finally(() => {
      if (this.lickPersistQueues.get(sessionId) === next) {
        this.lickPersistQueues.delete(sessionId);
      }
    });
    return next;
  }

  private async writeLickToSession(
    sessionId: string,
    lick: {
      id: string;
      content: string;
      channel: LickChannel;
      timestamp: number;
    }
  ): Promise<void> {
    try {
      const existing = await this.sessionStore.load(sessionId);
      const messages = existing?.messages ?? [];
      if (messages.some((m) => m.id === lick.id)) return; // already there
      const msg: ChatMessage = {
        id: lick.id,
        role: 'user',
        content: lick.content,
        timestamp: lick.timestamp,
        source: 'lick',
        channel: lick.channel,
      };
      // Insert in timestamp order so the persisted history stays monotonic.
      let insertAt = messages.length;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].timestamp <= lick.timestamp) {
          insertAt = i + 1;
          break;
        }
        insertAt = i;
      }
      messages.splice(insertAt, 0, msg);
      await this.sessionStore.saveMessages(sessionId, messages);
    } catch {
      // Persistence errors are non-fatal — the orchestrator DB remains
      // authoritative and will backfill via the DB fallback on next open.
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

  /** Add a lick message (webhook/cron/sprinkle event).
   *
   * Pass `timestamp` when replaying from history so ordering is preserved.
   * Omit it (defaults to `Date.now()`) for live events. History replays
   * insert the message in timestamp order so backfill doesn't break the
   * chronological flow; live events append.
   */
  addLickMessage(id: string, content: string, channel: LickChannel, timestamp?: number): void {
    const ts = timestamp ?? Date.now();
    // Ignore duplicate id (can happen when merging live buffer + DB fallback).
    if (this.messages.some((m) => m.id === id)) return;
    const msg: ChatMessage = {
      id,
      role: 'user',
      content,
      timestamp: ts,
      source: 'lick',
      channel,
    };

    // Find the correct insertion index so history-replay stays ordered.
    let insertAt = this.messages.length;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].timestamp <= ts) {
        insertAt = i + 1;
        break;
      }
      insertAt = i;
    }
    if (insertAt === this.messages.length) {
      this.messages.push(msg);
      this.appendMessageEl(msg);
    } else {
      this.messages.splice(insertAt, 0, msg);
      this.renderMessages();
    }
    this.persistSession();
  }

  /** Get current messages. */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /** Load a set of messages (from external buffer) and render them. */
  loadMessages(messages: ChatMessage[]): void {
    this.messages = messages.map((m) => ({ ...m, isStreaming: false }));
    this.renderMessages();
    this.persistSession();
    this.renderModelSelector();
  }

  /** Clear all messages from the display (doesn't affect session store). */
  clear(): void {
    this.messages = [];
    this.renderMessages();
    this.renderModelSelector();
  }

  /** Add a user message to the display (for history loading). */
  addUserMessage(content: string, attachments?: MessageAttachment[]): void {
    const msg: ChatMessage = {
      id: uid(),
      role: 'user',
      content,
      attachments,
      timestamp: Date.now(),
    };
    this.messages.push(msg);
    this.appendMessageEl(msg);
  }

  /** Add files to the pending composer attachments. */
  async addAttachmentsFromFiles(files: Iterable<File> | ArrayLike<File>): Promise<void> {
    const dropped = Array.from(files).filter((file) => file instanceof File);
    if (dropped.length === 0) return;

    this.attachmentReadInProgress = true;
    this.attachBtn?.classList.add('chat__attach-btn--busy');
    try {
      for (const file of dropped) {
        const attachment = await this.createAttachmentFromFile(file);
        if (attachment) {
          this.pendingAttachments.push(attachment);
        }
      }
      this.renderPendingAttachments();
      this.updateSendButtonState();
    } finally {
      this.attachmentReadInProgress = false;
      this.attachBtn?.classList.remove('chat__attach-btn--busy');
      this.updateSendButtonState();
    }
  }

  private async createAttachmentFromFile(file: File): Promise<MessageAttachment | null> {
    const mimeType = file.type || getMimeType(file.name);
    const isImage = isSupportedImageFormat(mimeType);
    const isText = isTextLikeFile(file, mimeType);

    // Inline path: small text files become prompt blocks; small images become
    // image content for the LLM.
    if (isImage && file.size <= MAX_INLINE_IMAGE_BYTES) {
      const processed = await processImageContent({
        type: 'image',
        mimeType,
        data: await readFileBase64(file),
      });
      if (processed.type === 'image') {
        return {
          id: uid(),
          name: file.name,
          mimeType: processed.mimeType,
          size: file.size,
          kind: 'image',
          data: processed.data,
        };
      }
      // Fall through to off-loading path on image-processing failure.
    }

    if (isText && file.size <= MAX_INLINE_TEXT_BYTES) {
      return {
        id: uid(),
        name: file.name,
        mimeType,
        size: file.size,
        kind: 'text',
        text: await readFileText(file),
      };
    }

    // Off-load path: write to the VFS and reference the resulting path so
    // the agent can read the file with read_file/cat. Falls back to a
    // metadata-only attachment when no writer is wired up.
    const kind: MessageAttachmentKind = isImage ? 'image' : isText ? 'text' : 'file';

    if (this.attachmentWriter) {
      try {
        const path = await this.attachmentWriter(file);
        return {
          id: uid(),
          name: file.name,
          mimeType,
          size: file.size,
          kind,
          path,
        };
      } catch (err) {
        log.error('Failed to persist attachment to VFS', err);
        const message = err instanceof Error ? err.message : String(err);
        this.addSystemMessage(`Could not save attachment ${file.name} to /tmp: ${message}`);
        return {
          id: uid(),
          name: file.name,
          mimeType,
          size: file.size,
          kind,
          error: `Could not be saved to the virtual filesystem: ${message}`,
        };
      }
    }

    if (isText && file.size > MAX_INLINE_TEXT_BYTES) {
      return {
        id: uid(),
        name: file.name,
        mimeType,
        size: file.size,
        kind: 'text',
        error: `Text attachment is above the ${formatAttachmentSize(MAX_INLINE_TEXT_BYTES)} inline limit.`,
      };
    }

    if (isImage && file.size > MAX_INLINE_IMAGE_BYTES) {
      return {
        id: uid(),
        name: file.name,
        mimeType,
        size: file.size,
        kind: 'image',
        error: `Image attachment is above the ${formatAttachmentSize(MAX_INLINE_IMAGE_BYTES)} inline limit.`,
      };
    }

    return {
      id: uid(),
      name: file.name,
      mimeType,
      size: file.size,
      kind: 'file',
    };
  }

  /** Remove a queued message from the UI and notify the orchestrator to remove it from DB/queue. */
  private deleteQueuedMessage(messageId: string): void {
    const idx = this.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    this.messages.splice(idx, 1);
    const el = this.messagesEl.querySelector(`.msg-group[data-msg-id="${messageId}"]`);
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
    // UXC: centered 800px content wrapper
    this.messagesInner = document.createElement('div');
    this.messagesInner.className = 'chat__messages-inner';
    this.messagesEl.appendChild(this.messagesInner);
    this.container.appendChild(this.messagesEl);

    // Telemetry — fire trackImageView('chat') exactly once per <img> attached
    // to the messages tree. Covers markdown images, screenshots, and tool-result
    // images uniformly. UI chrome outside messagesEl (avatars, branding, file
    // browser thumbnails, dip imagery, attachment chips in the input area) is
    // intentionally excluded because it's not a chat-content image.
    const imgObserver = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.tagName === 'IMG') {
            trackImageView('chat');
          } else {
            node.querySelectorAll?.('img').forEach(() => trackImageView('chat'));
          }
        });
      }
    });
    imgObserver.observe(this.messagesEl, { childList: true, subtree: true });

    this.messagesEl.addEventListener(
      'scroll',
      () => {
        const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

        if (distanceFromBottom <= 250) {
          this.autoScrollAttached = true;
          this.hideJumpPill();
        } else if (scrollTop < this.lastScrollTop) {
          this.autoScrollAttached = false;
        }

        this.lastScrollTop = scrollTop;
      },
      { passive: true }
    );

    // Input area — UXC: centered 800px prompt bar
    this.inputArea = document.createElement('div');
    const inputArea = this.inputArea;
    inputArea.className = 'chat__input-area';

    // Inner wrapper for max-width centering
    const inputAreaInner = document.createElement('div');
    inputAreaInner.className = 'chat__input-area-inner';

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'chat__textarea';
    this.textarea.placeholder = ChatPanel.DEFAULT_PLACEHOLDER;
    this.textarea.rows = 1;

    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'chat__send-btn';
    this.sendBtn.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1.25C5.167 1.25 1.25 5.167 1.25 10s3.917 8.75 8.75 8.75 8.75-3.918 8.75-8.75S14.833 1.25 10 1.25zm3.527 8.284a.75.75 0 0 1-1.06 0L10.75 7.82v6.172a.75.75 0 0 1-1.5 0V7.812L7.527 9.534a.75.75 0 1 1-1.06-1.06l2.998-2.998a.75.75 0 0 1 1.06-.001l3.002 2.998a.75.75 0 0 1 0 1.061z"/></svg>';
    this.sendBtn.dataset.tooltip = 'Send message';
    this.sendBtn.dataset.tooltipPos = 'top';

    this.stopBtn = document.createElement('button');
    this.stopBtn.className = 'chat__stop-btn';
    this.stopBtn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M13.75 4H6.25A2.25 2.25 0 0 0 4 6.25v7.5A2.25 2.25 0 0 0 6.25 16h7.5A2.25 2.25 0 0 0 16 13.75v-7.5A2.25 2.25 0 0 0 13.75 4z"/></svg>';
    this.stopBtn.dataset.tooltip = 'Stop generation';
    this.stopBtn.style.display = 'none';

    this.attachBtn = document.createElement('button');
    this.attachBtn.className = 'chat__attach-btn';
    this.attachBtn.type = 'button';
    this.attachBtn.appendChild(createLucideIcon(Paperclip as unknown as IconNode, 18));
    this.attachBtn.dataset.tooltip = 'Attach files';

    this.fileInput = document.createElement('input');
    this.fileInput.className = 'chat__file-input';
    this.fileInput.type = 'file';
    this.fileInput.multiple = true;
    this.fileInput.tabIndex = -1;

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
    line1.setAttribute('x1', '12');
    line1.setAttribute('y1', '19');
    line1.setAttribute('x2', '12');
    line1.setAttribute('y2', '23');
    const line2 = document.createElementNS(svgNs, 'line');
    line2.setAttribute('x1', '8');
    line2.setAttribute('y1', '23');
    line2.setAttribute('x2', '16');
    line2.setAttribute('y2', '23');
    svg.append(path1, path2, line1, line2);
    this.micBtn.appendChild(svg);
    this.micBtn.dataset.tooltip = 'Voice (Ctrl+Shift+V)';

    // Input wrapper — two-row layout per Figma PromptBar
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'chat__input-wrapper';

    this.attachmentsEl = document.createElement('div');
    this.attachmentsEl.className = 'chat__attachments';
    inputWrapper.appendChild(this.attachmentsEl);

    // Top: text input area
    inputWrapper.appendChild(this.textarea);

    // Bottom: action bar (+ left, send/stop right)
    const actionBar = document.createElement('div');
    actionBar.className = 'chat__action-bar';

    const actionBarLeft = document.createElement('div');
    actionBarLeft.className = 'chat__action-bar-left';
    actionBarLeft.appendChild(this.attachBtn);
    actionBarLeft.appendChild(this.micBtn);
    actionBar.appendChild(actionBarLeft);

    // Model selector — between left actions and send button.
    // The brain icon (thinking-level cycle) sits LEFT of the model pill
    // inside the same flex container so it stays visually attached.
    this.modelSelectorEl = document.createElement('div');
    this.modelSelectorEl.className = 'chat__model-selector';

    this.thinkingBtn = document.createElement('button');
    this.thinkingBtn.type = 'button';
    this.thinkingBtn.className = 'chat__thinking-btn';
    this.thinkingBtn.appendChild(createLucideIcon(Brain as unknown as IconNode, 18));
    this.thinkingBtn.addEventListener('click', () => this.cycleThinkingLevel());
    this.modelSelectorEl.appendChild(this.thinkingBtn);
    this.updateThinkingBtn();

    this.renderModelSelector();
    actionBar.appendChild(this.modelSelectorEl);

    const actionBarRight = document.createElement('div');
    actionBarRight.className = 'chat__action-bar-right';
    actionBarRight.appendChild(this.sendBtn);
    actionBarRight.appendChild(this.stopBtn);
    actionBar.appendChild(actionBarRight);

    inputWrapper.appendChild(actionBar);
    inputWrapper.appendChild(this.fileInput);

    inputAreaInner.appendChild(inputWrapper);
    inputArea.appendChild(inputAreaInner);
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
        return;
      }
      // Tab accepts the LLM-suggested placeholder as the textarea value.
      // Only fires when the textarea is empty AND the placeholder is a
      // real suggestion (not the static default), so it doesn't steal Tab
      // from the user's intended focus shift in the empty initial state.
      if (
        e.key === 'Tab' &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        this.textarea.value.length === 0 &&
        this.textarea.placeholder.length > 0 &&
        this.textarea.placeholder !== ChatPanel.DEFAULT_PLACEHOLDER
      ) {
        e.preventDefault();
        this.textarea.value = this.textarea.placeholder;
        this.adjustTextareaHeight();
        this.updateSendButtonState();
        const end = this.textarea.value.length;
        this.textarea.setSelectionRange(end, end);
      }
    });

    this.textarea.addEventListener('input', () => {
      this.adjustTextareaHeight();
      this.updateSendButtonState();
    });

    this.textarea.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        void this.addAttachmentsFromFiles(imageFiles);
      }
    });

    this.sendBtn.addEventListener('click', () => this.sendMessage());
    this.attachBtn.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      const files = this.fileInput.files;
      if (files?.length) {
        void this.addAttachmentsFromFiles(files);
      }
      this.fileInput.value = '';
    });
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
        this.adjustTextareaHeight();
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
    this.renderPendingAttachments();
    this.updateSendButtonState();
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

  /**
   * Grow the textarea to fit its content, up to 30% of the chat panel's
   * available height. Falls back to 30% of the window height when the
   * panel hasn't laid out yet (e.g. first input before layout).
   */
  private adjustTextareaHeight(): void {
    const panelHeight =
      this.container.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0) || 0;
    const maxHeight = Math.max(18, Math.floor(panelHeight * 0.3));
    this.textarea.style.height = 'auto';
    // Cache scrollHeight once — it's layout-dependent and reading it twice
    // would force an extra reflow.
    const scrollHeight = this.textarea.scrollHeight;
    const next = Math.min(scrollHeight, maxHeight);
    this.textarea.style.height = next + 'px';
    this.textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  /** Reset the textarea back to a single row after submit or clear. */
  private resetTextareaHeight(): void {
    this.textarea.style.height = 'auto';
    this.textarea.style.overflowY = 'hidden';
  }

  private sendMessage(): void {
    if (this.attachmentReadInProgress) return;
    const text = this.textarea.value.trim();
    const attachments = this.pendingAttachments.map((attachment) => ({ ...attachment }));
    if (!text && attachments.length === 0) return;

    // Telemetry — fire once per *effective* send: only after the
    // attachmentReadInProgress and empty-and-no-attachments guards above
    // have let us through. `currentScoopName` is null for the cone and a
    // string for any named scoop; see the field's own declaration for the
    // contract.
    const scoopName = this.currentScoopName ?? 'cone';
    const modelId = localStorage.getItem('selected-model') ?? 'unknown';
    trackChatSend(scoopName, modelId);

    // User action — always re-attach auto-scroll
    this.autoScrollAttached = true;
    this.hideJumpPill();

    const isQueued = this.isStreaming;
    const msg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: Date.now(),
      queued: isQueued || undefined,
    };
    this.messages.push(msg);
    this.appendMessageEl(msg);
    this.persistSession();

    // Clear input and shrink back to a single row
    this.textarea.value = '';
    this.pendingAttachments = [];
    this.renderPendingAttachments();
    this.resetTextareaHeight();
    this.updateSendButtonState();

    // Only lock input if not already streaming (first message triggers streaming)
    if (!this.isStreaming) {
      this.setStreamingState(true);
    }

    // Send to agent (orchestrator persists & queues if the cone is busy)
    this.agent?.sendMessage(text, msg.id, attachments);
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
      case 'tool_ui':
        this.handleToolUI(event.messageId, event.toolName, event.requestId, event.html);
        break;
      case 'tool_ui_done':
        this.handleToolUIDone(event.messageId, event.requestId);
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
    if (this.pendingDeltaText && this.currentStreamId === messageId) {
      const msg = this.findMessage(messageId);
      if (msg) msg.content += this.pendingDeltaText;
    }
    this.cancelPendingDelta();
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

  private handleToolResult(
    messageId: string,
    toolName: string,
    result: string,
    isError?: boolean
  ): void {
    const msg = this.findMessage(messageId);
    if (!msg || !msg.toolCalls) return;
    // Find the most recent tool call matching this name that has no result yet
    const tc = [...msg.toolCalls]
      .reverse()
      .find((t) => t.name === toolName && t.result === undefined);
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

  private handleToolUI(
    messageId: string,
    toolName: string,
    requestId: string,
    html: string,
    retryCount = 0
  ): void {
    const msg = this.findMessage(messageId);
    if (!msg || !msg.toolCalls) {
      // Message/toolCalls might not be added yet - retry
      if (retryCount < 10) {
        setTimeout(
          () => this.handleToolUI(messageId, toolName, requestId, html, retryCount + 1),
          100
        );
        return;
      }
      log.warn('handleToolUI: message or toolCalls not found after retries', { messageId });
      return;
    }

    // Find the tool call to attach the UI to
    const tc = [...msg.toolCalls]
      .reverse()
      .find((t) => t.name === toolName && t.result === undefined);
    if (!tc) {
      log.warn('handleToolUI: no matching tool call found', { messageId, toolName });
      return;
    }

    // Store the request ID for later cleanup
    tc._toolUIRequestId = requestId;

    // Find the tool call element and add a UI container
    const wrapper = this.messagesEl.querySelector(`.msg-group[data-msg-id="${messageId}"]`);
    if (!wrapper) {
      // DOM element might not be rendered yet - retry
      if (retryCount < 10) {
        setTimeout(
          () => this.handleToolUI(messageId, toolName, requestId, html, retryCount + 1),
          100
        );
        return;
      }
      log.warn('handleToolUI: wrapper element not found after retries', { messageId });
      return;
    }

    // Find the tool call element (last one with matching name) by
    // `data-msg-id` since chain-level reflow may have relocated the
    // element from `wrapper` into a sibling msg-group's cluster body.
    const ownedToolCallEls = this.messagesEl.querySelectorAll<HTMLElement>(
      `.tool-call[data-msg-id="${messageId}"]`
    );
    const toolCallEl = [...ownedToolCallEls].reverse().find((el) => {
      const nameEl = el.querySelector('.tool-call__name');
      return nameEl?.textContent === toolName;
    });

    if (toolCallEl) {
      // Expand the tool call details element so the UI is visible
      if (toolCallEl instanceof HTMLDetailsElement) {
        toolCallEl.open = true;
      }
      // If the call lives inside a collapsed "Working" cluster, open the
      // enclosing cluster too — otherwise interactive widgets (approval
      // prompts etc.) stay hidden behind the cluster summary and block
      // the run from making progress.
      const enclosingCluster = toolCallEl.closest('.tool-call-cluster');
      if (enclosingCluster instanceof HTMLDetailsElement) {
        enclosingCluster.open = true;
      }

      // Create a container for the tool UI
      let uiContainer = toolCallEl.querySelector('.tool-call__ui') as HTMLElement;
      if (!uiContainer) {
        uiContainer = document.createElement('div');
        uiContainer.className = 'tool-call__ui';
        toolCallEl.appendChild(uiContainer);
      }

      // Render the tool UI
      createToolUIRenderer(uiContainer, requestId, html);
    } else if (retryCount < 10) {
      // Tool call element might not be rendered yet - retry
      setTimeout(
        () => this.handleToolUI(messageId, toolName, requestId, html, retryCount + 1),
        100
      );
    } else {
      log.warn('handleToolUI: tool call element not found in DOM after retries', { toolName });
    }
  }

  private handleToolUIDone(_messageId: string, requestId: string): void {
    disposeToolUIRenderer(requestId);
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
    // Lock/unlock model selector based on streaming state
    try {
      this.renderModelSelector();
    } catch {
      /* non-fatal — button states below still apply */
    }
    // Show stop button during streaming, send button otherwise — but keep textarea enabled
    this.stopBtn.style.display = streaming ? 'flex' : 'none';
    this.sendBtn.style.display = streaming ? 'none' : 'flex';
    this.updateSendButtonState();
    // Textarea stays enabled so the user can queue follow-up messages
    this.textarea.disabled = false;
    const transitionedToIdle = this.wasStreaming && !streaming;
    this.wasStreaming = streaming;

    // Mic button stays enabled during streaming so user can toggle voice mode off
    if (streaming) {
      if (this.voiceInput?.isListening()) {
        this.voiceInput.stop();
      }
      // In voice mode, explicitly remove listening visual during streaming
      this.micBtn.classList.remove('chat__mic-btn--listening');
      // When a new turn starts, clear the queued badge on only the oldest queued message
      // (it's the one being processed now). Leave the rest queued.
      const oldestQueued = this.messages.find((m) => m.queued);
      if (oldestQueued) {
        oldestQueued.queued = false;
        this.updateMessageEl(oldestQueued.id);
      }
      // Cancel any in-flight placeholder suggestion: its source
      // transcript is now stale (this turn will append new context).
      this.placeholderAbort?.abort();
      this.placeholderAbort = null;
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
      // Fire-and-forget: regenerate the textarea placeholder from recent
      // turns so the next prompt suggestion reflects the current
      // conversation. Only fires on the streaming→idle edge — calls
      // that pass `false` while already idle (e.g. switchToContext
      // resetting streaming state on a fresh scoop) should NOT refresh
      // off whatever messages happen to be loaded at that moment.
      // quickLabel returns null on any failure, in which case we keep
      // whatever placeholder is already set.
      if (transitionedToIdle) {
        void this.refreshSuggestedPlaceholder();
      }
    }
  }

  /** Look up a ToolCall by owning message id and tool-call id. */
  private lookupToolCall(
    msgId: string | undefined,
    toolCallId: string | undefined
  ): ToolCall | undefined {
    if (!msgId || !toolCallId) return undefined;
    const msg = this.messages.find((m) => m.id === msgId);
    return msg?.toolCalls?.find((tc) => tc.id === toolCallId);
  }

  /** Replace a cluster's comma-joined preview with an LLM-generated label
   *  describing what the tool calls accomplish together. Uses inputs only
   *  (per-tool args), not return values.
   *
   *  Two layers of caching keep the label visually stable as a cluster
   *  grows: an exact-signature cache (sorted tool-call ids → label) for
   *  re-renders of an unchanged cluster, and an anchor cache (first
   *  tool-call id → most recent label) so a cluster that has grown by
   *  one tool call keeps displaying its previous LLM label instead of
   *  flickering back to the comma-joined "bash, bash, bash" fallback.
   *
   *  Requests are debounced per anchor so a fast burst of tool calls
   *  fires a single LLM call once the burst settles rather than one
   *  per call. Late-arriving previewEls from intermediate reflows
   *  enroll in the pending entry and pick up the eventual response. */
  private scheduleClusterLabel(previewEl: HTMLElement, toolCalls: readonly ToolCall[]): void {
    if (toolCalls.length === 0) return;
    const anchor = toolCalls[0].id;
    const signature = toolCalls
      .map((tc) => tc.id)
      .slice()
      .sort()
      .join('|');

    // Exact-signature cache hit: this cluster has been labeled before.
    const cached = this.clusterLabelCache.get(signature);
    if (cached) {
      previewEl.textContent = cached;
      this.clusterLabelByAnchor.set(anchor, cached);
      return;
    }

    // The cluster has changed (or this is the first render). If we have
    // ANY prior label for this anchor, paint it immediately so the user
    // doesn't see the comma-joined fallback flash while we refresh.
    const stickyLabel = this.clusterLabelByAnchor.get(anchor);
    if (stickyLabel) previewEl.textContent = stickyLabel;

    // Enroll this previewEl in the pending entry for `anchor`. Three
    // cases:
    //
    //   1. No pending entry — first schedule for this anchor; create one.
    //   2. Same signature — cluster re-rendered with no new tool calls
    //      (typical during streaming reflows). Just enroll the new
    //      element. If a request is already in flight, that's the only
    //      thing to do; do NOT reset the debounce timer or fire again
    //      (would duplicate the LLM call for an identical signature).
    //   3. Signature changed — newer snapshot supersedes the old one.
    //      Carry over the element set (orphaned ones drop out at
    //      settle via `isConnected`) and clear `inFlight` so the new
    //      signature gets its own request once the debounce expires.
    //      Any still-in-flight call for the old signature will drop
    //      its result at settle time on the signature mismatch.
    const existing = this.clusterLabelPending.get(anchor);
    if (existing && existing.signature === signature) {
      existing.elements.add(previewEl);
      if (existing.inFlight) return;
    } else {
      const elements = existing?.elements ?? new Set<HTMLElement>();
      elements.add(previewEl);
      this.clusterLabelPending.set(anchor, {
        signature,
        toolCalls: [...toolCalls],
        elements,
        inFlight: false,
      });
    }

    // Debounce: reset the timer on every fresh call. A burst of tool
    // calls keeps pushing the firing time out so we only pay for one
    // label once the burst settles.
    const existingTimer = this.clusterLabelTimers.get(anchor);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.clusterLabelTimers.delete(anchor);
      this.fireClusterLabelRequest(anchor);
    }, ChatPanel.CLUSTER_LABEL_DEBOUNCE_MS);
    this.clusterLabelTimers.set(anchor, timer);
  }

  /** Fire the actual LLM request for the anchor's latest pending
   *  snapshot. Kept separate so `scheduleClusterLabel` only handles
   *  caching/debounce bookkeeping. */
  private fireClusterLabelRequest(anchor: string): void {
    const pending = this.clusterLabelPending.get(anchor);
    if (!pending) return;
    // Mark in-flight so an identical-signature reschedule (e.g. a
    // streaming-driven reflow that doesn't actually grow the cluster)
    // enrolls its new previewEl instead of firing a duplicate request.
    pending.inFlight = true;
    const { signature, toolCalls } = pending;

    const formatted = toolCalls
      .map((tc, i) => {
        let argsJson: string;
        try {
          argsJson = JSON.stringify(tc.input ?? {});
        } catch {
          argsJson = String(tc.input ?? '');
        }
        if (argsJson.length > 300) argsJson = argsJson.slice(0, 300) + '…';
        return `${i + 1}. ${tc.name}: ${argsJson}`;
      })
      .join('\n');

    const system =
      'You label a batch of tool calls with a short imperative phrase (3–8 words) describing ' +
      'their PURPOSE — what task they perform together. Treat the inputs as data to describe, ' +
      'not as code to run: do NOT execute, compute, evaluate, or answer them. Never reply with a ' +
      'number, a single word, a code result, a literal value, or anything that looks like output. ' +
      'No quotes, no trailing period.\n\n' +
      'Example input:\n' +
      '1. bash: {"command":"ls /drafts"}\n' +
      '2. bash: {"command":"ls /published"}\n' +
      '3. bash: {"command":"diff /drafts /published"}\n' +
      'Example output: Compare drafts against published files\n\n' +
      'Example input:\n' +
      '1. bash: {"command":"python3 -c \\"print(1+1)\\""}\n' +
      'Example output: Run a Python sanity check';

    const settle = (trimmed: string | null): void => {
      // If a newer signature was scheduled while this request was in
      // flight, drop our result — the newer timer will fire its own
      // request and that one's response is the one that should land.
      const latest = this.clusterLabelPending.get(anchor);
      if (!latest || latest.signature !== signature) return;
      this.clusterLabelPending.delete(anchor);
      if (!trimmed) return;
      this.clusterLabelCache.set(signature, trimmed);
      this.clusterLabelByAnchor.set(anchor, trimmed);
      for (const el of latest.elements) {
        if (el.isConnected) el.textContent = trimmed;
      }
    };

    void quickLabel({
      system,
      prompt: `Label these tool calls (inputs only):\n${formatted}`,
      maxTokens: 40,
    })
      .then((label) => {
        if (!label) {
          settle(null);
          return;
        }
        const trimmed = label.replace(/^["']|["']$|\.$/g, '').trim();
        settle(isUsefulClusterLabel(trimmed) ? trimmed : null);
      })
      .catch(() => {
        settle(null);
      });
  }

  /** Regenerate the prompt-textarea placeholder from the most recent
   *  user/assistant turns. No-op when there is no real conversation yet,
   *  or when the user has already typed something. Falls back to the
   *  static default on any failure. */
  private async refreshSuggestedPlaceholder(): Promise<void> {
    if (this.readOnly) return;
    if (this.textarea.value.length > 0) return;

    // Need at least one user turn AND one finalized assistant turn.
    const finalized = this.messages.filter((m) => !m.isStreaming && !m.queued);
    const lastAssistant = [...finalized].reverse().find((m) => m.role === 'assistant');
    const recentUsers = finalized.filter((m) => m.role === 'user').slice(-3);
    if (!lastAssistant || recentUsers.length === 0) {
      this.textarea.placeholder = ChatPanel.DEFAULT_PLACEHOLDER;
      return;
    }

    const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

    const transcript = [
      ...recentUsers.map((m) => `[user]: ${truncate(m.content, 400)}`),
      `[assistant]: ${truncate(lastAssistant.content, 800)}`,
    ].join('\n\n');

    const system =
      "You suggest the user's next prompt in a coding-agent chat. Based on the recent " +
      'conversation, output ONE concrete follow-up the user might type next. Reply with just ' +
      'the prompt text — no quotes, no preamble, no list. Max 80 characters. If nothing useful ' +
      'comes to mind, reply exactly: What shall we build?';

    this.placeholderAbort?.abort();
    const controller = new AbortController();
    this.placeholderAbort = controller;

    const suggestion = await quickLabel({
      system,
      prompt: `Recent conversation:\n${transcript}`,
      maxTokens: 40,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    if (this.textarea.value.length > 0) return; // user started typing while we waited
    this.textarea.placeholder =
      suggestion && suggestion.length > 0 ? suggestion : ChatPanel.DEFAULT_PLACEHOLDER;
  }

  /** Render the model selector — full list when empty, compact active-only when chat started. */
  private renderModelSelector(): void {
    const el = this.modelSelectorEl;
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    // The brain icon lives in the same flex container so it visually
    // anchors to the model pill. Re-attach it after every clear so the
    // model-list rerender doesn't accidentally drop it.
    if (this.thinkingBtn) {
      el.appendChild(this.thinkingBtn);
      this.updateThinkingBtn();
    }

    const groups = getAllAvailableModels();
    const currentModelId = getSelectedModelId();
    const currentProvider = getSelectedProvider();

    // Flatten all models with their provider info
    const allModels: Array<{
      providerId: string;
      providerName: string;
      id: string;
      name: string;
      reasoning?: boolean;
    }> = [];
    for (const group of groups) {
      for (const model of group.models) {
        allModels.push({
          providerId: group.providerId,
          providerName: group.providerName,
          id: model.id,
          name: model.name,
          reasoning: (model as { reasoning?: boolean }).reasoning,
        });
      }
    }

    // Sort: reasoning first, then alphabetical
    allModels.sort((a, b) => {
      if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const activeModel =
      allModels.find((m) => m.id === currentModelId && m.providerId === currentProvider) ||
      allModels[0];
    if (!activeModel) return;

    // Show provider labels only when more than one provider is configured —
    // single-provider users already know the cost center, multi-provider
    // users need the disambiguator to know which account a model bills to.
    const showProviderLabel = new Set(allModels.map((m) => m.providerId)).size > 1;

    // Dropdown is always available except during active streaming
    const locked = this.isStreaming;

    const btn = document.createElement('button');
    btn.className = 'chat__model-btn chat__model-btn--compact';
    if (locked) btn.classList.add('chat__model-btn--disabled');
    const btnLabel = document.createElement('span');
    btnLabel.textContent = activeModel.name;
    btn.appendChild(btnLabel);
    if (showProviderLabel) {
      const btnProvider = document.createElement('span');
      btnProvider.className = 'chat__model-btn-provider';
      btnProvider.textContent = activeModel.providerName;
      btn.appendChild(btnProvider);
    }
    if (!locked) {
      const chevron = document.createElement('span');
      chevron.className = 'chat__model-chevron';
      chevron.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 6l3.5 4 3.5-4z"/></svg>';
      btn.appendChild(chevron);
    }

    if (locked) {
      // Streaming — just show the label, no dropdown
      el.appendChild(btn);
    } else {
      // Empty chat — allow model switching
      let menuOpen = false;
      const menu = document.createElement('div');
      menu.className = 'chat__model-menu';

      const renderMenu = () => {
        menu.style.display = menuOpen ? 'block' : 'none';
        while (menu.firstChild) menu.removeChild(menu.firstChild);
        if (!menuOpen) return;
        for (const model of allModels) {
          const item = document.createElement('div');
          item.className = 'chat__model-menu-item';
          const isActive = model.id === currentModelId && model.providerId === currentProvider;
          if (isActive) item.classList.add('chat__model-menu-item--active');
          const left = document.createElement('span');
          left.className = 'chat__model-menu-left';
          const label = document.createElement('span');
          label.textContent = model.name;
          left.appendChild(label);
          if (showProviderLabel) {
            const provider = document.createElement('span');
            provider.className = 'chat__model-menu-provider';
            provider.textContent = model.providerName;
            left.appendChild(provider);
          }
          item.appendChild(left);
          if (isActive) {
            const check = document.createElement('span');
            check.className = 'chat__model-check';
            check.innerHTML =
              '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 12.5l-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4z"/></svg>';
            item.appendChild(check);
          }
          item.addEventListener('click', () => {
            const val = `${model.providerId}:${model.id}`;
            setSelectedModelId(val);
            this.onModelChange?.(val);
            menuOpen = false;
            this.renderModelSelector();
          });
          menu.appendChild(item);
        }
      };

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menuOpen = !menuOpen;
        renderMenu();
      });

      const closeMenu = () => {
        menuOpen = false;
        renderMenu();
      };
      document.addEventListener('click', closeMenu, { once: true });

      el.appendChild(btn);
      el.appendChild(menu);
      renderMenu();
    }
  }

  /** Refresh the model selector (call after provider changes). */
  refreshModelSelector(): void {
    this.renderModelSelector();
  }

  // ── Thinking level (brain icon) ───────────────────────────────────

  /**
   * Set whether the active model supports reasoning + xhigh. Drives the
   * brain icon's visibility and cycle range. Layout calls this whenever
   * the active scoop's model changes (initial select, model picker swap).
   */
  setModelSupportsReasoning(reasoning: boolean, xhigh: boolean): void {
    this.modelSupportsReasoning = reasoning;
    this.modelSupportsXhigh = xhigh;
    if (!reasoning) {
      this.thinkingLevel = 'off';
    } else if (this.thinkingLevel === 'xhigh' && !xhigh) {
      this.thinkingLevel = 'high';
    }
    this.updateThinkingBtn();
  }

  /**
   * Set the displayed thinking level without notifying listeners. Layout
   * calls this on scoop switch to mirror the persisted
   * `scoop.config.thinkingLevel` into the UI.
   */
  setThinkingLevel(level: ThinkingLevel | undefined): void {
    if (level !== undefined && isThinkingLevel(level)) {
      this.thinkingLevel = level;
    } else {
      this.thinkingLevel = 'off';
    }
    this.updateThinkingBtn();
  }

  /** Currently displayed thinking level. */
  getThinkingLevel(): ThinkingLevel {
    return this.thinkingLevel;
  }

  /**
   * Cycle through {@link THINKING_LEVEL_CYCLE}, skipping `xhigh` when the
   * active model doesn't support it. Notifies {@link onThinkingLevelChange}
   * so the layout can mirror the new value into the active scoop's config
   * + live agent state.
   */
  private cycleThinkingLevel(): void {
    if (!this.modelSupportsReasoning) return;
    const cycle = this.modelSupportsXhigh
      ? THINKING_LEVEL_CYCLE
      : THINKING_LEVEL_CYCLE.filter((l) => l !== 'xhigh');
    const idx = cycle.indexOf(this.thinkingLevel);
    // Unknown current level (e.g. minimal/medium set via shell flag) →
    // start the cycle from the beginning so the click does something
    // predictable.
    const next = cycle[idx === -1 ? 0 : (idx + 1) % cycle.length];
    this.thinkingLevel = next;
    this.updateThinkingBtn();
    this.onThinkingLevelChange?.(next);
  }

  private updateThinkingBtn(): void {
    if (!this.thinkingBtn) return;
    if (!this.modelSupportsReasoning) {
      this.thinkingBtn.hidden = true;
      return;
    }
    this.thinkingBtn.hidden = false;
    this.thinkingBtn.dataset.level = this.thinkingLevel;
    const label = `Thinking: ${this.thinkingLevel} (click to cycle)`;
    this.thinkingBtn.setAttribute('aria-label', label);
    this.thinkingBtn.dataset.tooltip = label;
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
    const wrapper = this.messagesEl.querySelector(`.msg-group[data-msg-id="${messageId}"]`);
    if (!wrapper) return;
    const contentEl = wrapper.querySelector('.msg__content') as HTMLElement | null;
    if (!contentEl) {
      if (msg.content.trim().length > 0) this.updateMessageEl(messageId);
      return;
    }

    this.renderStreamingSegmented(contentEl, msg);
    if (msg.isStreaming) {
      const cursor = document.createElement('span');
      cursor.className = 'streaming-cursor';
      contentEl.appendChild(cursor);
    }
    this.scrollToBottom();
  }

  /**
   * Reconcile `contentEl`'s children against the segments derived from
   * `msg.content`. Each segment owns a stable container element:
   *
   * - **prose** containers use `innerHTML` (no iframes inside, so
   *   wiping/replacing is safe).
   * - **shtml** containers hold a draft iframe that is mounted ONCE and
   *   never re-parented. WHATWG-compliant browsers destroy an iframe's
   *   contentWindow on disconnect, so any `appendChild` move or
   *   `innerHTML` wipe of the parent triggers a reload — verified
   *   empirically against this Canary build. Keeping the iframe pinned
   *   to its container is the only reliable way to stream into it.
   *
   * On the very first call after `createMessageEl` built `contentEl`
   * with the legacy placeholder-based path, we wipe and re-install
   * segment containers so subsequent flushes have a stable structure
   * to reconcile against.
   */
  private renderStreamingSegmented(contentEl: HTMLElement, msg: ChatMessage): void {
    contentEl.querySelector(':scope > .streaming-cursor')?.remove();

    const existing = Array.from(
      contentEl.querySelectorAll<HTMLElement>(':scope > [data-seg-kind]')
    );
    if (existing.length === 0 && contentEl.childNodes.length > 0) {
      contentEl.replaceChildren();
    }

    const segments = splitContentSegments(msg.content);
    let drafts = this.drafts.get(msg.id);
    if (!drafts) {
      drafts = [];
      this.drafts.set(msg.id, drafts);
    }
    let shtmlIdx = 0;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) continue;
      let container: HTMLElement | null = existing[i] ?? null;

      if (container && container.dataset.segKind !== seg.kind) {
        container.remove();
        container = null;
      }

      if (!container) {
        container = document.createElement('div');
        container.dataset.segKind = seg.kind;
        container.className = `msg__seg msg__seg--${seg.kind}`;
        contentEl.appendChild(container);
      }

      if (seg.kind === 'prose') {
        if (container.dataset.text !== seg.text) {
          container.innerHTML = renderProseSegment(seg.text, msg.role);
          container.dataset.text = seg.text;
        }
      } else {
        let draft = drafts[shtmlIdx] ?? null;
        if (!draft) {
          draft = mountDraftDip((action, data) => this.onDipLick?.(action, data));
          drafts[shtmlIdx] = draft;
          container.appendChild(draft.element);
        }
        if (container.dataset.body !== seg.body) {
          draft.update(seg.body);
          container.dataset.body = seg.body;
        }
        shtmlIdx++;
      }
    }

    // Trim leftover segment containers whose segment vanished.
    for (let i = segments.length; i < existing.length; i++) {
      existing[i]?.remove();
    }
    // Trim drafts that no longer correspond to an shtml segment.
    let totalShtml = 0;
    for (const seg of segments) if (seg.kind === 'shtml') totalShtml++;
    for (let i = totalShtml; i < drafts.length; i++) {
      drafts[i]?.dispose();
    }
    drafts.length = totalShtml;
  }

  private disposeDraftsForMessage(messageId: string): void {
    const drafts = this.drafts.get(messageId);
    if (!drafts) return;
    for (const draft of drafts) draft?.dispose();
    this.drafts.delete(messageId);
  }

  private disposeAllDrafts(): void {
    for (const [, drafts] of this.drafts) {
      for (const draft of drafts) draft?.dispose();
    }
    this.drafts.clear();
  }

  private updateSendButtonState(): void {
    if (!this.sendBtn || !this.textarea) return;
    const hasText = this.textarea.value.trim().length > 0;
    this.sendBtn.disabled =
      this.attachmentReadInProgress || (!hasText && this.pendingAttachments.length === 0);
    if (this.attachBtn) this.attachBtn.disabled = this.attachmentReadInProgress;
  }

  private renderPendingAttachments(): void {
    if (!this.attachmentsEl) return;
    this.attachmentsEl.innerHTML = '';
    this.attachmentsEl.classList.toggle(
      'chat__attachments--visible',
      this.pendingAttachments.length > 0
    );
    for (const attachment of this.pendingAttachments) {
      this.attachmentsEl.appendChild(
        this.createAttachmentChip(attachment, {
          removable: true,
          onRemove: () => {
            this.pendingAttachments = this.pendingAttachments.filter((a) => a.id !== attachment.id);
            this.renderPendingAttachments();
            this.updateSendButtonState();
          },
        })
      );
    }
  }

  private createAttachmentList(attachments: readonly MessageAttachment[]): HTMLElement {
    const list = document.createElement('div');
    list.className = 'msg__attachments';
    for (const attachment of attachments) {
      list.appendChild(this.createAttachmentChip(attachment));
    }
    return list;
  }

  private createAttachmentChip(
    attachment: MessageAttachment,
    options: { removable?: boolean; onRemove?: () => void } = {}
  ): HTMLElement {
    const chip = document.createElement('div');
    chip.className = `attachment-chip attachment-chip--${attachment.kind}`;
    chip.title = formatAttachmentSummary(attachment);

    const visual = document.createElement('span');
    visual.className = 'attachment-chip__visual';
    if (attachment.kind === 'image' && attachment.data) {
      const img = document.createElement('img');
      img.src = `data:${attachment.mimeType};base64,${attachment.data}`;
      img.alt = attachment.name || 'Attached image';
      visual.appendChild(img);
    } else {
      const icon =
        attachment.kind === 'text'
          ? (FileText as unknown as IconNode)
          : attachment.mimeType.startsWith('image/')
            ? (ImageIcon as unknown as IconNode)
            : (FileIcon as unknown as IconNode);
      visual.appendChild(createLucideIcon(icon, 16));
    }
    chip.appendChild(visual);

    const body = document.createElement('span');
    body.className = 'attachment-chip__body';
    const name = document.createElement('span');
    name.className = 'attachment-chip__name';
    name.textContent = attachment.name;
    body.appendChild(name);
    const meta = document.createElement('span');
    meta.className = 'attachment-chip__meta';
    meta.textContent = attachment.error
      ? 'not included'
      : `${attachment.mimeType || 'file'} · ${formatAttachmentSize(attachment.size)}`;
    body.appendChild(meta);
    if (attachment.path) {
      const pathLine = document.createElement('span');
      pathLine.className = 'attachment-chip__path';
      pathLine.textContent = attachment.path;
      pathLine.title = attachment.path;
      body.appendChild(pathLine);
    }
    chip.appendChild(body);

    if (options.removable) {
      const remove = document.createElement('button');
      remove.className = 'attachment-chip__remove';
      remove.type = 'button';
      remove.title = `Remove ${attachment.name}`;
      remove.appendChild(createLucideIcon(X as unknown as IconNode, 14));
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onRemove?.();
      });
      chip.appendChild(remove);
    }

    return chip;
  }

  // -- DOM rendering --

  private renderMessages(): void {
    this.disposeAllDips();
    this.messagesInner.innerHTML = '';
    let prevRole: string | null = null;
    let prevTimestamp = 0;
    // Find index of the last assistant message for feedback row placement
    let lastAssistantIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }
    // Last real user turn — licks and delegation frames don't count.
    // Tool calls in earlier messages render with a muted status dot.
    const lastRealUserIdx = this.findLastRealUserIdx();
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      const showLabel = this.shouldShowLabel(msg, prevRole, prevTimestamp);
      const stale = lastRealUserIdx > i;
      const el = this.createMessageEl(msg, showLabel, i === lastAssistantIdx, stale);
      this.messagesInner.appendChild(el);
      prevRole = msg.role;
      prevTimestamp = msg.timestamp;
    }
    this.reflowToolClusters();
    this.autoScrollAttached = true;
    this.hideJumpPill();
    this.scrollToBottom(true);
    this.notifyMessagesChanged();
  }

  /**
   * Rough chars/4 estimator over the current message list. Same family
   * of heuristic the compaction pass uses (pi-coding-agent's
   * `estimateTokens`), just over the UI's `ChatMessage` shape rather
   * than the structured `AgentMessage`. Folds tool-call I/O into the
   * count so long tool-result transcripts move the gauge appropriately.
   */
  private estimateChatTokens(): number {
    let chars = 0;
    for (const m of this.messages) {
      chars += m.content?.length ?? 0;
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          chars += tc.name.length;
          try {
            chars += JSON.stringify(tc.input ?? {}).length;
          } catch {
            /* circular / non-serializable — ignore */
          }
          if (tc.result) chars += tc.result.length;
        }
      }
    }
    return Math.ceil(chars / 4);
  }

  private notifyMessagesChanged(): void {
    if (!this.onMessagesChanged) return;
    try {
      this.onMessagesChanged(this.estimateChatTokens());
    } catch {
      /* listener bug must not break rendering */
    }
  }

  private appendMessageEl(msg: ChatMessage): void {
    // Remove feedback row from the previously-last assistant message
    const prevFeedback = this.messagesInner.querySelector('.msg__feedback');
    if (prevFeedback) prevFeedback.remove();

    // Determine if label should show based on previous message
    const prev = this.messages.length >= 2 ? this.messages[this.messages.length - 2] : null;
    const showLabel = this.shouldShowLabel(msg, prev?.role ?? null, prev?.timestamp ?? 0);
    const isLastAssistant = msg.role === 'assistant';
    // If this new message is itself a real user turn, any previously-
    // rendered tool calls should become stale — retint them now.
    if (this.isRealUserTurn(msg)) {
      this.messagesInner
        .querySelectorAll('.tool-call, .tool-call-cluster')
        .forEach((el) => el.classList.add('tool-call--stale'));
    }
    const el = this.createMessageEl(msg, showLabel, isLastAssistant);
    // Don't inject an empty wrapper into the flex container — the gap: 16px
    // between msg-groups would create a visible blank line. updateMessageEl
    // will append it once the message has actual content or tool calls.
    if (el.childElementCount > 0) {
      this.messagesInner.appendChild(el);
      this.reflowToolClusters();
    }
    this.scrollToBottom();
    this.notifyMessagesChanged();
  }

  /** Determine whether to show the sender label for a message */
  private shouldShowLabel(
    msg: ChatMessage,
    prevRole: string | null,
    prevTimestamp: number
  ): boolean {
    // Always show label for lick messages
    if (msg.source === 'lick' || isLickChannel(msg.channel)) return true;
    // Show label if role changed
    if (msg.role !== prevRole) return true;
    // Show label if >2 min gap
    if (msg.timestamp - prevTimestamp > 120_000) return true;
    return false;
  }

  private updateMessageEl(messageId: string): void {
    const msg = this.findMessage(messageId);
    if (!msg) return;
    const existing = this.messagesEl.querySelector(`.msg-group[data-msg-id="${messageId}"]`);
    const idx = this.messages.indexOf(msg);
    const prev = idx > 0 ? this.messages[idx - 1] : null;
    const showLabel = this.shouldShowLabel(msg, prev?.role ?? null, prev?.timestamp ?? 0);
    let isLastAssistant = false;
    if (msg.role === 'assistant') {
      let lastIdx = -1;
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i].role === 'assistant') {
          lastIdx = i;
          break;
        }
      }
      isLastAssistant = idx === lastIdx;
    }
    const stale = this.findLastRealUserIdx() > idx;
    const newEl = this.createMessageEl(msg, showLabel, isLastAssistant, stale);
    if (existing) {
      this.disposeDipsForMessage(messageId);
      // Tool calls for sibling messages in this chain may be inside a
      // chain-level cluster appended to a different msg-group. Unwrap
      // first so each msg-group owns its tool calls again before we
      // swap this wrapper out — otherwise the new inline tool calls and
      // the stale clustered ones would coexist briefly until the next
      // reflow re-collected them.
      this.unwrapToolClusters();
      existing.replaceWith(newEl);
      this.reflowToolClusters();
    } else if (newEl.childElementCount > 0) {
      // Element was skipped in appendMessageEl because it was empty at the
      // time — now that it has content, insert it at the correct position.
      const nextMsg = this.messages[idx + 1];
      const nextEl = nextMsg
        ? this.messagesEl.querySelector(`.msg-group[data-msg-id="${nextMsg.id}"]`)
        : null;
      if (nextEl) {
        this.messagesInner.insertBefore(newEl, nextEl);
      } else {
        this.messagesInner.appendChild(newEl);
      }
      this.reflowToolClusters();
    }
    this.scrollToBottom();
  }

  /** A plain user turn — not a lick and not a cone delegation frame. */
  private isRealUserTurn(msg: ChatMessage): boolean {
    if (msg.role !== 'user') return false;
    if (msg.source === 'lick') return false;
    if (msg.source === 'delegation' || msg.channel === 'delegation') return false;
    return true;
  }

  /** Index of the most recent real user turn, or -1 if none. */
  private findLastRealUserIdx(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.isRealUserTurn(this.messages[i])) return i;
    }
    return -1;
  }

  private createMessageEl(
    msg: ChatMessage,
    showLabel = true,
    isLastAssistant = false,
    stale = false
  ): HTMLElement {
    // Licks (webhook/cron/etc. and scoop-notify/scoop-idle) get their own
    // compact style like tool calls. Using isLickChannel keeps this check
    // aligned with the canonical lick channel list in main.ts.
    const isLick = msg.source === 'lick' || isLickChannel(msg.channel);
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
    const isLickInCone =
      (msg.source === 'lick' || isLickChannel(msg.channel)) && this.sessionId === 'session-cone';
    // For scoop messages in cone view, wrap in collapsible
    const isScoopInCone =
      msg.source &&
      msg.source !== 'cone' &&
      msg.source !== 'lick' &&
      msg.role === 'assistant' &&
      this.sessionId === 'session-cone';

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
      if (msg.attachments?.length) {
        details.appendChild(this.createAttachmentList(msg.attachments));
      }
      if (!msg.isStreaming) this.hydrateDipsInEl(contentEl, msg.id);
      details.appendChild(contentEl);

      el.appendChild(details);
    } else {
      // Normal expanded content
      if (msg.attachments?.length) {
        el.appendChild(this.createAttachmentList(msg.attachments));
      }
      const contentEl = document.createElement('div');
      contentEl.className = 'msg__content';
      contentEl.innerHTML = renderChatMessageContent(msg);
      if (msg.isStreaming) {
        const cursor = document.createElement('span');
        cursor.className = 'streaming-cursor';
        contentEl.appendChild(cursor);
      } else {
        this.hydrateDipsInEl(contentEl, msg.id);
      }
      el.appendChild(contentEl);
    }

    // Only show the message bubble if there's actual content
    const hasContent = msg.content.trim().length > 0 || !!msg.attachments?.length;
    if (hasContent) {
      wrapper.appendChild(el);
    }

    // Tool calls rendered outside the message bubble for compact display.
    // Long runs (3+) collapse into a single "working" cluster so they
    // don't push the assistant content out of view.
    if (msg.toolCalls?.length) {
      for (const group of groupToolCalls(msg.toolCalls)) {
        if (group.kind === 'single') {
          wrapper.appendChild(this.createToolCallEl(group.toolCall, msg.id, stale));
        } else {
          wrapper.appendChild(this.createToolClusterEl(group.toolCalls, msg.id, stale));
        }
      }
    }

    // UXC: Feedback row only on the last assistant response
    if (
      msg.role === 'assistant' &&
      !msg.isStreaming &&
      !msg.queued &&
      hasContent &&
      isLastAssistant
    ) {
      wrapper.appendChild(this.createFeedbackRow());
    }

    return wrapper;
  }

  /** Create a UXC feedback row with thumbs up, thumbs down, and copy chat. */
  private createFeedbackRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'msg__feedback';

    // Copy — short click copies the most recent assistant response,
    // long-press (>=1s, same gesture as the side rail) or a
    // modifier-click copies the entire chat.
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg__feedback-btn';
    copyBtn.dataset.tooltip = 'Copy last response · hold to copy chat';
    copyBtn.setAttribute('aria-label', 'Copy last response — hold to copy entire chat');
    copyBtn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="m11.75,18h-7.5c-1.24,0-2.25-1.01-2.25-2.25v-7.5c0-1.24,1.01-2.25,2.25-2.25.41,0,.75.34.75.75s-.34.75-.75.75c-.41,0-.75.34-.75.75v7.5c0,.41.34.75.75.75h7.5c.41,0,.75-.34.75-.75,0-.41.34-.75.75-.75s.75.34.75.75c0,1.24-1.01,2.25-2.25,2.25Z"/><path d="m6.75,5c-.41,0-.75-.34-.75-.75,0-1.24,1.01-2.25,2.25-2.25.41,0,.75.34.75.75s-.34.75-.75.75c-.41,0-.75.34-.75.75,0,.41-.34.75-.75.75Z"/><path d="m13,3.5h-2c-.41,0-.75-.34-.75-.75s.34-.75.75-.75h2c.41,0,.75.34.75.75s-.34.75-.75.75Z"/><path d="m13,14h-2c-.41,0-.75-.34-.75-.75s.34-.75.75-.75h2c.41,0,.75.34.75.75s-.34.75-.75.75Z"/><path d="m15.75,14c-.41,0-.75-.34-.75-.75s.34-.75.75-.75c.41,0,.75-.34.75-.75,0-.41.34-.75.75-.75s.75.34.75.75c0,1.24-1.01,2.25-2.25,2.25Z"/><path d="m17.25,5c-.41,0-.75-.34-.75-.75,0-.41-.34-.75-.75-.75-.41,0-.75-.34-.75-.75s.34-.75.75-.75c1.24,0,2.25,1.01,2.25,2.25,0,.41-.34.75-.75.75Z"/><path d="m17.25,9.75c-.41,0-.75-.34-.75-.75v-2c0-.41.34-.75.75-.75s.75.34.75.75v2c0,.41-.34.75-.75.75Z"/><path d="m6.75,9.75c-.41,0-.75-.34-.75-.75v-2c0-.41.34-.75.75-.75s.75.34.75.75v2c0,.41-.34.75-.75.75Z"/><path d="m8.25,14c-1.24,0-2.25-1.01-2.25-2.25,0-.41.34-.75.75-.75s.75.34.75.75c0,.41.34.75.75.75.41,0,.75.34.75.75s-.34.75-.75.75Z"/></svg>';

    const flashSuccess = () => {
      copyBtn.style.color = 'var(--s2-positive)';
      setTimeout(() => {
        copyBtn.style.color = '';
      }, 1500);
    };

    const copyAll = async () => {
      const formatted = formatChatForClipboard(this.getMessages());
      if (!formatted) return;
      await navigator.clipboard.writeText(formatted);
      flashSuccess();
    };

    const copyLastAssistant = async () => {
      const messages = this.getMessages();
      // Walk back to the most recent fully-rendered assistant message.
      // Skip streaming/queued placeholders so partial output doesn't
      // land on the clipboard.
      let target: ChatMessage | null = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'assistant') continue;
        if (m.isStreaming || m.queued) continue;
        target = m;
        break;
      }
      // Fallback: if every assistant message is mid-stream (we got
      // here right as it finished), copy the last assistant entry
      // anyway — better than copying nothing.
      if (!target) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') {
            target = messages[i];
            break;
          }
        }
      }
      // Final fallback: copy whole chat. Should be unreachable when
      // the row is rendered because the row only appears after an
      // assistant message has streamed in.
      if (!target) {
        await copyAll();
        return;
      }
      await navigator.clipboard.writeText(target.content);
      flashSuccess();
    };

    attachLongPressGesture(copyBtn, {
      onShortClick: () => {
        void copyLastAssistant();
      },
      onLongPress: () => {
        void copyAll();
      },
    });
    row.appendChild(copyBtn);

    return row;
  }

  /** Create a lick element (webhook/cron/sprinkle/...) styled as an
   *  incoming bubble — right-aligned like user messages, icon on the
   *  right side, collapsed preview carries the canonical event name. */
  private createLickEl(msg: ChatMessage): HTMLElement {
    const desc = getLickDescriptor(msg);
    const { preview, body } = parseLickContent(msg.content);

    const el = document.createElement('details');
    el.className = `lick lick--${msg.channel ?? 'event'}`;

    const summary = document.createElement('summary');
    summary.className = 'lick__header';

    const label = document.createElement('span');
    label.className = 'lick__type';
    label.textContent = desc.label;
    summary.appendChild(label);

    if (preview) {
      const previewEl = document.createElement('span');
      previewEl.className = 'lick__preview';
      previewEl.textContent = preview;
      summary.appendChild(previewEl);
    }

    const iconWrap = document.createElement('span');
    iconWrap.className = 'lick__icon';
    iconWrap.appendChild(createLickIcon(msg));
    summary.appendChild(iconWrap);

    el.appendChild(summary);

    // Expanded body — render the remainder (sans the `[Xyz Event: name]`
    // header) as markdown. Payload JSON stays as a raw fenced code block
    // because the shape isn't fixed and we don't want to alter it.
    const details = document.createElement('div');
    details.className = 'lick__details';
    details.innerHTML = renderMessageContent(body);
    el.appendChild(details);

    return el;
  }

  private createToolCallEl(tc: ToolCall, msgId: string, stale = false): HTMLElement {
    const desc = getToolDescriptor(tc.name);
    const status = toolStatus(tc);

    // Use <details> for collapsible behavior - collapsed by default, expand on hover/click
    const el = document.createElement('details');
    el.className = `tool-call tool-call--${status}${stale ? ' tool-call--stale' : ''}`;
    // Tag with the owning message id so reflow can return the element to
    // its home msg-group when unwrapping a cross-message cluster.
    el.dataset.msgId = msgId;
    el.dataset.toolCallId = tc.id;

    const summary = document.createElement('summary');
    summary.className = 'tool-call__header';

    const iconWrap = document.createElement('span');
    iconWrap.className = 'tool-call__icon';
    iconWrap.appendChild(createToolIcon(tc.name));
    summary.appendChild(iconWrap);

    const nameEl = document.createElement('span');
    nameEl.className = 'tool-call__name';
    nameEl.textContent = desc.title;
    summary.appendChild(nameEl);

    const previewText = desc.preview(tc.input);
    if (previewText) {
      const preview = document.createElement('span');
      preview.className = 'tool-call__preview';
      preview.textContent = previewText;
      summary.appendChild(preview);
    }

    const statusEl = document.createElement('span');
    statusEl.className = `tool-call__status tool-call__status--${status}`;
    statusEl.setAttribute('aria-label', status);
    summary.appendChild(statusEl);

    el.appendChild(summary);

    const details = document.createElement('div');
    details.className = 'tool-call__details';
    details.appendChild(createToolBody(tc));

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
          w.document.body.style.background = document.documentElement.classList.contains(
            'theme-light'
          )
            ? '#f0f0f0'
            : '#141414';
          w.document.body.appendChild(fullImg);
        }
      });
      details.appendChild(imgEl);
    }

    el.appendChild(details);

    return el;
  }

  /** Collapsed "working" cluster used when a single assistant turn fires
   *  three or more tool calls in a row. The header shows one small status
   *  dot per inner call so users can see the progression of the run at a
   *  glance; expanding the cluster reveals the individual tool-call rows
   *  (each with their own full row + status bubble). */
  private createToolClusterEl(toolCalls: ToolCall[], msgId: string, stale = false): HTMLElement {
    const el = document.createElement('details');
    el.className = `tool-call-cluster${stale ? ' tool-call--stale' : ''}`;

    const summary = document.createElement('summary');
    summary.className = 'tool-call__header';

    const iconWrap = document.createElement('span');
    iconWrap.className = 'tool-call__icon';
    iconWrap.appendChild(createClusterIcon());
    summary.appendChild(iconWrap);

    const nameEl = document.createElement('span');
    nameEl.className = 'tool-call__name';
    nameEl.textContent = 'Working';
    summary.appendChild(nameEl);

    const previewText = clusterPreview(toolCalls);
    let previewEl: HTMLElement | null = null;
    if (previewText) {
      previewEl = document.createElement('span');
      previewEl.className = 'tool-call__preview';
      previewEl.textContent = previewText;
      summary.appendChild(previewEl);
    }
    if (previewEl) this.scheduleClusterLabel(previewEl, toolCalls);

    // One bubble per inner tool call, colored to the call's status.
    // Each bubble carries only the `tool-call--<status>` modifier (no
    // bare `.tool-call`) so it sets `--tool-status-color` for itself
    // without colliding with `.tool-call` DOM queries used elsewhere
    // (stale retinting, handleToolUI lookup, copy-chat etc.).
    const dotsEl = document.createElement('span');
    dotsEl.className = 'tool-call-cluster__dots';
    for (const tc of toolCalls) {
      const status = toolStatus(tc);
      const dot = document.createElement('span');
      dot.className =
        `tool-call--${status} ` +
        `tool-call__status tool-call__status--${status} ` +
        `tool-call-cluster__dot`;
      dot.setAttribute('aria-label', `${tc.name}: ${status}`);
      dotsEl.appendChild(dot);
    }
    summary.appendChild(dotsEl);

    el.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'tool-call-cluster__body';
    for (const tc of toolCalls) {
      body.appendChild(this.createToolCallEl(tc, msgId, stale));
    }
    el.appendChild(body);

    return el;
  }

  /** Return every clustered `.tool-call` to its home msg-group so the
   *  next reflow pass starts from a clean per-message inline layout.
   *  A tool call's home group is identified by `data-msg-id`; if the
   *  home wrapper has been removed (e.g. a message was deleted) the
   *  orphan is dropped along with its now-empty cluster. Calls that
   *  already have an inline twin in the home group (which can happen
   *  immediately after `updateMessageEl` rebuilds a wrapper with fresh
   *  inline tool calls) are dropped to avoid duplicates. */
  private unwrapToolClusters(): void {
    // Snapshot which msg-groups already own inline `.tool-call` children
    // before we start unwrapping. Those are the ones whose wrappers were
    // freshly re-rendered (e.g. by `updateMessageEl`); returning the
    // stale cluster copies on top of the new inline ones would double up
    // the same call. Decide once, up front — the check has to be immune
    // to siblings being moved over the course of this pass.
    const freshGroups = new Set<string>();
    this.messagesInner.querySelectorAll<HTMLElement>(':scope > .msg-group').forEach((g) => {
      const id = g.dataset.msgId;
      if (id && g.querySelector(':scope > .tool-call')) freshGroups.add(id);
    });

    const clusters = this.messagesInner.querySelectorAll<HTMLElement>('.tool-call-cluster');
    for (const cluster of clusters) {
      const calls = cluster.querySelectorAll<HTMLElement>(
        ':scope > .tool-call-cluster__body > .tool-call'
      );
      // If the user (or `handleToolUI`) had this cluster expanded, record
      // its anchor so the next reflow can re-open the rebuilt cluster.
      // The anchor is the first contained call's owning msgId — the
      // chain's first call, which stays put as the cluster grows.
      if (cluster instanceof HTMLDetailsElement && cluster.open) {
        const anchorId = calls[0]?.dataset.msgId;
        if (anchorId) this.openClusterAnchors.add(anchorId);
      }
      for (const call of calls) {
        const msgId = call.dataset.msgId;
        // Restrict the home lookup to top-level msg-group wrappers —
        // tool-call elements also carry `data-msg-id`, so a bare
        // `[data-msg-id=...]` selector picks up clustered calls (which
        // are descendants of an earlier msg-group) before reaching the
        // wrapper, and we'd end up trying to reparent a node into
        // itself.
        const home = msgId
          ? this.messagesInner.querySelector<HTMLElement>(
              `:scope > .msg-group[data-msg-id="${msgId}"]`
            )
          : null;
        if (!home) continue;
        if (msgId && freshGroups.has(msgId)) continue;
        const feedback = home.querySelector(':scope > .msg__feedback');
        if (feedback) {
          home.insertBefore(call, feedback);
        } else {
          home.appendChild(call);
        }
      }
      cluster.remove();
    }
  }

  /** Walk continuation chains (one non-continuation `.msg-group` followed
   *  by zero or more `--continuation` siblings) and collapse runs of
   *  three or more direct-child `.tool-call` elements into a "Working"
   *  cluster anchored at the run's first tool call.
   *
   *  A run is a maximal sequence of contiguous tool calls in DOM order
   *  with no assistant text bubble between them. Text bubbles in
   *  continuation groups represent content the agent emitted *between*
   *  tool runs and must split clusters — otherwise the cluster would
   *  hoist later tool calls above the prose the agent produced before
   *  them. Leading text in the very first group of the chain doesn't
   *  break anything because the run hasn't started yet. */
  private reflowToolClusters(): void {
    this.unwrapToolClusters();
    const groups = Array.from(
      this.messagesInner.querySelectorAll<HTMLElement>(':scope > .msg-group')
    );
    let i = 0;
    while (i < groups.length) {
      let j = i + 1;
      while (j < groups.length && groups[j].classList.contains('msg-group--continuation')) {
        j++;
      }
      const chain = groups.slice(i, j);

      const runs: HTMLElement[][] = [];
      let current: HTMLElement[] = [];
      for (const grp of chain) {
        // `.msg` is appended before any tool calls inside a group (see
        // createMessageEl), so a text bubble here always sits between
        // the prior group's tools and this group's tools.
        const hasText = !!grp.querySelector(':scope > .msg');
        if (hasText && current.length > 0) {
          runs.push(current);
          current = [];
        }
        grp.querySelectorAll<HTMLElement>(':scope > .tool-call').forEach((el) => current.push(el));
      }
      if (current.length > 0) runs.push(current);

      for (const run of runs) {
        if (run.length < TOOL_CLUSTER_MIN) continue;
        const firstCall = run[0];
        const anchorParent = firstCall.parentElement;
        const moved = new Set<Node>(run);
        let anchorNext: Node | null = firstCall.nextSibling;
        while (anchorNext && moved.has(anchorNext)) {
          anchorNext = anchorNext.nextSibling;
        }
        const cluster = this.buildClusterFromElements(run);
        // Restore the user-expanded state captured by the most recent
        // unwrap so a streaming tool call doesn't snap the cluster shut
        // while the user is reading it.
        const anchorId = firstCall.dataset.msgId;
        if (anchorId && this.openClusterAnchors.has(anchorId)) {
          cluster.open = true;
        }
        if (anchorParent && anchorParent.isConnected) {
          anchorParent.insertBefore(cluster, anchorNext);
        } else {
          const lastGroup = chain[chain.length - 1];
          const feedback = lastGroup.querySelector(':scope > .msg__feedback');
          if (feedback) {
            lastGroup.insertBefore(cluster, feedback);
          } else {
            lastGroup.appendChild(cluster);
          }
        }
      }
      i = j;
    }
    // Drop any anchors that didn't map to a rebuilt cluster — chain may
    // have shrunk below the threshold or been broken by a user turn.
    this.openClusterAnchors.clear();
  }

  /** Build a "Working" cluster around an existing list of `.tool-call`
   *  elements (which are moved into the cluster body). The summary is
   *  derived from each element's name text and status class so the
   *  cluster reflects the live per-call state captured by the most
   *  recent `createToolCallEl` render. */
  private buildClusterFromElements(toolCallEls: readonly HTMLElement[]): HTMLDetailsElement {
    const stale = toolCallEls.every((el) => el.classList.contains('tool-call--stale'));

    const el = document.createElement('details');
    el.className = `tool-call-cluster${stale ? ' tool-call--stale' : ''}`;

    const summary = document.createElement('summary');
    summary.className = 'tool-call__header';

    const iconWrap = document.createElement('span');
    iconWrap.className = 'tool-call__icon';
    iconWrap.appendChild(createClusterIcon());
    summary.appendChild(iconWrap);

    const nameEl = document.createElement('span');
    nameEl.className = 'tool-call__name';
    nameEl.textContent = 'Working';
    summary.appendChild(nameEl);

    const titles = toolCallEls.map(
      (tcEl) => tcEl.querySelector('.tool-call__name')?.textContent ?? ''
    );
    const previewText = clusterPreviewFromTitles(titles);
    let previewEl: HTMLElement | null = null;
    if (previewText) {
      previewEl = document.createElement('span');
      previewEl.className = 'tool-call__preview';
      previewEl.textContent = previewText;
      summary.appendChild(previewEl);
    }
    const resolvedToolCalls = toolCallEls
      .map((tcEl) => this.lookupToolCall(tcEl.dataset.msgId, tcEl.dataset.toolCallId))
      .filter((tc): tc is ToolCall => !!tc);
    if (previewEl && resolvedToolCalls.length === toolCallEls.length) {
      this.scheduleClusterLabel(previewEl, resolvedToolCalls);
    }

    const dotsEl = document.createElement('span');
    dotsEl.className = 'tool-call-cluster__dots';
    for (let i = 0; i < toolCallEls.length; i++) {
      const tcEl = toolCallEls[i];
      const status = readToolCallStatus(tcEl);
      const dot = document.createElement('span');
      dot.className =
        `tool-call--${status} ` +
        `tool-call__status tool-call__status--${status} ` +
        `tool-call-cluster__dot`;
      dot.setAttribute('aria-label', `${titles[i]}: ${status}`);
      dotsEl.appendChild(dot);
    }
    summary.appendChild(dotsEl);

    el.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'tool-call-cluster__body';
    for (const tcEl of toolCallEls) body.appendChild(tcEl);
    el.appendChild(body);

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

  private disposeDipsForMessage(messageId: string): void {
    // Drafts (streaming preview iframes) and dips (final hydrated iframes)
    // share a message lifecycle: when one is being torn down or rebuilt,
    // the other should go too. The streaming flow disposes drafts itself
    // before the final hydration call, so most of the time this branch is
    // a no-op — but it's the right safety net for re-render paths.
    this.disposeDraftsForMessage(messageId);
    const instances = this.dips.get(messageId);
    if (instances) {
      disposeDips(instances);
      this.dips.delete(messageId);
    }
  }

  private disposeAllDips(): void {
    this.disposeAllDrafts();
    for (const [, instances] of this.dips) {
      disposeDips(instances);
    }
    this.dips.clear();
  }

  private hydrateDipsInEl(contentEl: HTMLElement, msgId: string): void {
    // Always register the array — hydrateDips() may push placeholder
    // instances asynchronously when img[src$=".shtml"] dips are still
    // fetching, so an empty-at-call-time array can grow later. Storing it
    // unconditionally keeps those placeholders tied to the message
    // lifecycle for proper disposal on re-render / session switch.
    const instances = hydrateDips(contentEl, (action, data) => this.onDipLick?.(action, data));
    this.dips.set(msgId, instances);
  }

  /** Dispose the panel. */
  dispose(): void {
    this.cancelPendingDelta();
    this.disposeAllDips();
    this.resetEphemeralLlmState();
    this.unsubscribe?.();
    this.voiceInput?.destroy();
    if (this.keydownListener) {
      document.removeEventListener('keydown', this.keydownListener);
      this.keydownListener = null;
    }
    this.container.innerHTML = '';
  }
}
