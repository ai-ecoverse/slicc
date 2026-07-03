/**
 * OffscreenClient — side panel's interface to the offscreen agent engine.
 *
 * Replaces direct Orchestrator usage in extension mode. Sends commands via
 * chrome.runtime messages and receives events back. Provides:
 * - AgentHandle for the chat panel
 * - Orchestrator-compatible facade for scoops/memory/scoop-switcher panels
 * - State sync on reconnect with retry logic
 */

import type {
  AgentEventMsg,
  ErrorMsg,
  ExtensionMessage,
  ForwardedLickEvent,
  IncomingMessageMsg,
  MessageUpdatedMsg,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
  ScoopCreatedMsg,
  ScoopListMsg,
  ScoopMessagesReplacedMsg,
  ScoopStatusMsg,
  ScoopTranscriptMsg,
  SessionStatsMsg,
  StateSnapshotMsg,
  TrayFollowerStatusSnapshot,
  TrayLeaderStatusSnapshot,
  TrayRuntimeStatusMsg,
} from '../../../chrome-extension/src/messages.js';
import type { MessageAttachment } from '../core/attachments.js';
import { createLogger } from '../core/logger.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import { createPanelChromeRuntimeTransport } from '../kernel/transport-chrome-runtime.js';
import type { KernelClientFacade, KernelTransport } from '../kernel/types.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import { setFollowerTrayRuntimeStatus } from '../scoops/tray-follower-status.js';
import { setLeaderTrayRuntimeStatus } from '../scoops/tray-leader.js';
import type { RegisteredScoop, ScoopTabState, ThinkingLevel } from '../scoops/types.js';
import type { TerminalEventMsg } from '../shell/terminal-protocol.js';
import type { AgentHandle, ChatMessage, AgentEvent as UIAgentEvent } from './types.js';

const log = createLogger('offscreen-client');

// Compile-time guard: the real `LickEvent`'s carrier fields must stay
// assignable to the wire mirror `ForwardedLickEvent` (messages.ts can't import
// LickEvent directly). `ForwardedLickEvent` is intentionally a loose carrier
// (`[key: string]: unknown`) that an `interface` source can't satisfy
// wholesale, so we assert the named carrier fields with NO cast — if
// `type` / `timestamp` / `body` drift, this fails the build instead of
// silently breaking the `as unknown as LickEvent` casts at the boundary.
const _assertLickWireCarrier: (
  e: LickEvent
) => Pick<ForwardedLickEvent, 'type' | 'timestamp' | 'body'> = (e) => e;
void _assertLickWireCarrier;

/** Stats bundle the worker computes on demand: cost + per-scoop context fill. */
export interface SessionStats {
  /** Total session cost (USD) across all scoops, dropped ones included. */
  totalCost: number;
  /** Per-scoop context-window fill, 0..1 (last assistant turn's usage). */
  fills: Array<{ jid: string; fill: number }>;
  /** Per-model cost breakdown, sorted by cost descending. */
  models: Array<{ model: string; cost: number; turns: number; tokens: number }>;
  /** Per-scoop cost breakdown. */
  scoops: Array<{ name: string; model: string; cost: number; type: 'cone' | 'scoop' }>;
}

export interface OffscreenClientCallbacks {
  onStatusChange: (scoopJid: string, status: ScoopTabState['status']) => void;
  onScoopCreated: (scoop: RegisteredScoop) => void;
  onScoopListUpdate: (scoops: ScoopListMsg['scoops']) => void;
  onIncomingMessage: (scoopJid: string, message: IncomingMessageMsg['message']) => void;
  /**
   * In-place state update for an already-delivered message (currently a
   * settled actionable lick): the panel flips the rendered card located by
   * `lickId` instead of appending a row. Parity path for standalone +
   * extension — both floats route through this client.
   */
  onMessageUpdate?: (
    scoopJid: string,
    update: { messageId: string; lickId?: string; lickState?: ChatMessage['lickState'] }
  ) => void;
  /**
   * Whole-history replacement (used when the offscreen acts as a tray
   * follower and receives a snapshot from the leader). The payload has
   * already been persisted to IndexedDB by the offscreen, so callers
   * just need to repaint the chat for the matching scoop.
   */
  onScoopMessagesReplaced?: (
    scoopJid: string,
    messages: ScoopMessagesReplacedMsg['messages']
  ) => void;
  /** Called when the offscreen engine is ready and state has been received. */
  onReady?: () => void;
  /**
   * Fired when a scoop's compaction transformer enters or leaves a
   * phase. The panel uses this to render a ghost-bubble affordance
   * while the agent is silent on summarize / memory-extract calls;
   * `'idle'` clears the affordance.
   */
  onCompactionStateChange?: (
    scoopJid: string,
    state: 'summarizing' | 'extracting-memory' | 'idle'
  ) => void;
  /**
   * Fired when any scoop (selected or not) produces meaningful agent
   * activity — text deltas, tool starts, tool UI, or turn ends. Lets
   * the host move the navbar `attention` (googly eyes) to whichever
   * scoop is actively streaming, regardless of selection. Does NOT
   * affect which scoop's thread renders — the selection gate that
   * controls thread routing in {@link handleAgentEvent} is unchanged.
   */
  onScoopActivity?: (scoopJid: string) => void;
}

export class OffscreenClient implements KernelClientFacade {
  private eventListeners = new Set<(event: UIAgentEvent) => void>();
  private callbacks: OffscreenClientCallbacks;
  private scoops: RegisteredScoop[] = [];
  private scoopStatuses = new Map<string, ScoopTabState['status']>();
  private currentMessageId = new Map<string, string>();
  private ready = false;
  private stateRetryTimer: ReturnType<typeof setInterval> | null = null;
  private localFs: LocalVfsClient | null = null;
  /**
   * Pending `clear-chat` requests awaiting the bridge's ack. Keyed by
   * `requestId`; resolved when a `clear-chat-ack` envelope arrives.
   */
  private pendingClearAcks = new Map<string, () => void>();
  /**
   * Pending `request-scoop-transcript` requests awaiting the bridge's
   * reply. Keyed by `requestId`; resolved with the transcript string
   * (or `''` on timeout) when a `scoop-transcript` envelope arrives.
   */
  private pendingTranscriptRequests = new Map<string, (transcript: string) => void>();
  private pendingChatMessagesRequests = new Map<
    string,
    (messages: ScoopMessagesReplacedMsg['messages']) => void
  >();
  private pendingStatsRequests = new Map<string, (stats: SessionStats) => void>();
  /**
   * KernelTransport — defaults to the chrome.runtime adapter.
   * A `MessageChannel`-backed transport can be passed via the
   * constructor so the standalone panel can drive the same client
   * over the kernel worker. The transport delivers raw
   * `ExtensionMessage` envelopes either way so the existing source
   * filter and special-case routing (`sprinkle-op`) stay intact.
   */
  private transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>;

  /** Currently selected scoop JID (set by the UI via {@link setSelectedScoopJid}). */
  private _selectedScoopJid: string | null = null;

  get selectedScoopJid(): string | null {
    return this._selectedScoopJid;
  }

  private readonly scoopSelectedListeners = new Set<(jid: string) => void>();

  /**
   * Subscribe to scoop-selection changes. The handler fires whenever
   * the selected scoop JID changes to a non-null value. Returns an
   * unsubscribe function. Used by the extension-leader path so the
   * panel can push the active scoop to offscreen for tray sync.
   */
  onScoopSelected(handler: (jid: string) => void): () => void {
    this.scoopSelectedListeners.add(handler);
    return () => {
      this.scoopSelectedListeners.delete(handler);
    };
  }

  /**
   * Set the currently selected scoop JID and notify listeners. No-op
   * if the value is unchanged. Listeners only fire for non-null
   * selections (a `null` clear is internal bookkeeping).
   */
  setSelectedScoopJid(jid: string | null): void {
    if (this._selectedScoopJid === jid) return;
    this._selectedScoopJid = jid;
    if (jid === null) return;
    for (const fn of this.scoopSelectedListeners) {
      try {
        fn(jid);
      } catch (err) {
        log.error('onScoopSelected handler threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private locked = false;

  /**
   * Optional transport injection. If omitted (today's extension
   * panel), the chrome.runtime adapter is constructed. Standalone
   * passes a `MessageChannel`-backed transport bound to the kernel
   * worker.
   */
  constructor(
    callbacks: OffscreenClientCallbacks,
    transport?: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>
  ) {
    this.callbacks = callbacks;
    this.transport = transport ?? createPanelChromeRuntimeTransport<PanelToOffscreenMessage>();
    this.setupMessageListener();
  }

  /**
   * Set a local VFS handle for the memory panel / file browser. Typed
   * as `LocalVfsClient` (read-only surface) so accidental panel-side
   * writes fail at compile time. With `slicc_opfs_vfs=opfs`, callers
   * pass a worker-RPC-backed `RemoteVfsClient`; with the flag off, a
   * page-side `VirtualFS` satisfies the same structural type.
   */
  setLocalFS(fs: LocalVfsClient): void {
    this.localFs = fs;
  }

  /**
   * Expose the underlying kernel transport so the page can wire a
   * `RemoteVfsClient` onto the same wire when the `slicc_opfs_vfs`
   * flag routes panel reads through the worker's `VfsRpcHost`. The
   * transport is shared — RemoteVfsClient adds its own `onMessage`
   * subscriber and only acts on `vfs-*-result` envelopes, so existing
   * routing (`agent-event`, `scoop-list`, sprinkle ops, terminal
   * events) keeps flowing untouched.
   */
  getTransport(): KernelTransport<ExtensionMessage, PanelToOffscreenMessage> {
    return this.transport;
  }

  // -------------------------------------------------------------------------
  // AgentHandle (for chat panel)
  // -------------------------------------------------------------------------

  createAgentHandle(): AgentHandle {
    return {
      sendMessage: (text: string, messageId?: string, attachments?: MessageAttachment[]) => {
        if (!this.selectedScoopJid) {
          this.emitToUI({ type: 'error', error: 'No scoop selected' });
          return;
        }
        this.send({
          type: 'user-message',
          scoopJid: this.selectedScoopJid,
          text,
          attachments,
          messageId: messageId ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
      },

      onEvent: (callback: (event: UIAgentEvent) => void) => {
        this.eventListeners.add(callback);
        return () => this.eventListeners.delete(callback);
      },

      stop: () => {
        if (this.selectedScoopJid) {
          this.send({ type: 'abort', scoopJid: this.selectedScoopJid });
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Orchestrator-compatible facade
  // All methods that ScoopsPanel, ScoopSwitcher, and MemoryPanel call.
  // -------------------------------------------------------------------------

  getScoops(): RegisteredScoop[] {
    return this.scoops;
  }

  getScoop(jid: string): RegisteredScoop | undefined {
    return this.scoops.find((s) => s.jid === jid);
  }

  isProcessing(jid: string): boolean {
    return this.scoopStatuses.get(jid) === 'processing';
  }

  /** Bootstrap the cone. Only called once per session when no cone exists on
   *  disk. Non-cone scoops are created inside the offscreen orchestrator by
   *  the agent's `scoop_scoop` tool — never through this path. Adds
   *  optimistically so the UI updates immediately, then sends to offscreen.
   *  The real scoop (with a different JID) replaces the optimistic one when
   *  `scoop-created` arrives. */
  async registerScoop(scoop: RegisteredScoop): Promise<void> {
    if (!scoop.isCone) {
      throw new Error(
        'OffscreenClient.registerScoop is cone-only; use scoop_scoop for non-cone scoops'
      );
    }
    if (!this.scoops.find((s) => s.name === scoop.name)) {
      this.scoops.push(scoop);
      this.scoopStatuses.set(scoop.jid, 'initializing');
    }
    this.send({ type: 'cone-create', name: scoop.name });
  }

  /** Called by ScoopsPanel delete button. */
  async unregisterScoop(jid: string): Promise<void> {
    this.send({ type: 'scoop-drop', scoopJid: jid });
    // Optimistically remove
    this.scoops = this.scoops.filter((s) => s.jid !== jid);
    this.scoopStatuses.delete(jid);
  }

  /** No-op in offscreen mode — tab creation happens in offscreen. */
  createScoopTab(_jid: string): void {
    // Offscreen manages scoop tabs internally
  }

  /** Read global memory from the shared VFS (same IndexedDB). */
  async getGlobalMemory(): Promise<string> {
    if (!this.localFs) return '';
    try {
      const content = await this.localFs.readFile('/shared/CLAUDE.md', { encoding: 'utf-8' });
      return typeof content === 'string' ? content : new TextDecoder().decode(content);
    } catch {
      return '';
    }
  }

  /** Return a lightweight context facade for the memory panel.
   *  The memory panel only calls context.getFS() to read CLAUDE.md files. */
  getScoopContext(_jid: string): { getFS: () => LocalVfsClient | null } | undefined {
    if (!this.localFs) return undefined;
    // Return a facade that gives the memory panel access to the shared VFS.
    // The memory panel reads scoop memory at /scoops/{folder}/CLAUDE.md or /workspace/CLAUDE.md.
    return { getFS: () => this.localFs };
  }

  /** Return the shared VFS handle (read-only surface). */
  getSharedFS(): LocalVfsClient | null {
    return this.localFs;
  }

  stopScoop(jid: string): void {
    this.send({ type: 'abort', scoopJid: jid });
  }

  async clearQueuedMessages(_jid: string): Promise<void> {
    // Handled by the abort message
  }

  async deleteQueuedMessage(jid: string, messageId: string): Promise<void> {
    this.send({ type: 'delete-queued-message', scoopJid: jid, messageId });
  }

  updateModel(): void {
    // Side panel already wrote to localStorage. Tell offscreen to re-read.
    this.send({ type: 'refresh-model' });
  }

  /**
   * Mark this client as locked. While locked, all outbound traffic
   * via send() is dropped and an error is surfaced to the UI.
   * Used by the detached-popout flow to prevent a soon-to-close
   * panel from sending duplicate user actions.
   */
  setLocked(locked: boolean): void {
    this.locked = locked;
  }

  /**
   * Update a scoop's reasoning / thinking level on the offscreen
   * orchestrator. Mirrors the standalone-mode
   * `Orchestrator.setScoopThinkingLevel` call:
   *
   * - The offscreen side mutates the live `Agent.state.thinkingLevel`
   *   so the next agent turn picks up the new value.
   * - It also persists `scoop.config.thinkingLevel` into the
   *   orchestrator's IndexedDB record.
   * - The persisted value is surfaced back to the panel through the
   *   `scoop-list` / `state-snapshot` / `scoop-created` messages
   *   (see `ScoopSnapshotConfig`), so the brain icon rehydrates with
   *   the correct level on reconnect / scoop switch.
   */
  setScoopThinkingLevel(jid: string, level: ThinkingLevel | undefined): void {
    this.send({ type: 'set-thinking-level', scoopJid: jid, level });
  }

  /**
   * Cone-only chat clear. Sends a `clear-chat` envelope to the bridge
   * and resolves only after the bridge's `clear-chat-ack` lands — so
   * callers can `await` this before `location.reload()` without
   * racing the offscreen document (which survives the panel reload in
   * extension mode). A 5-second timeout backs out cleanly in the rare
   * case the bridge is wedged; reload still proceeds.
   */
  async clearAllMessages(): Promise<void> {
    const requestId = `clear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ack = new Promise<void>((resolve) => {
      this.pendingClearAcks.set(requestId, resolve);
    });
    this.send({ type: 'clear-chat', requestId });
    await Promise.race([ack, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
    this.pendingClearAcks.delete(requestId);
  }

  clearFilesystem(): void {
    this.send({ type: 'clear-filesystem' });
  }

  /**
   * Ask the worker for the canonical chat history of a scoop. The
   * worker translates from the live `AgentMessage[]` and replies with
   * a `scoop-messages-replaced` event the panel handler can swap in.
   * Fire-and-forget — the worker may also no-op if the scoop is gone
   * or has no history yet.
   */
  requestScoopMessages(scoopJid: string): void {
    this.send({ type: 'request-scoop-messages', scoopJid } as PanelToOffscreenMessage);
  }

  /**
   * Side-effect-free transcript accessor. Distinct from
   * {@link requestScoopMessages}, which mutates the chat panel via
   * `scoop-messages-replaced`. The worker replies with a
   * `scoop-transcript` envelope carrying the same `requestId` so this
   * Promise can resolve cleanly without touching panel state. Used by
   * the scoop-switcher's scope-label tooltip. Resolves to an empty
   * string on timeout or unknown scoop.
   */
  async getScoopTranscript(scoopJid: string): Promise<string> {
    const requestId = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reply = new Promise<string>((resolve) => {
      this.pendingTranscriptRequests.set(requestId, resolve);
    });
    this.send({
      type: 'request-scoop-transcript',
      requestId,
      scoopJid,
    } as PanelToOffscreenMessage);
    const result = await Promise.race([
      reply,
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 5000)),
    ]);
    this.pendingTranscriptRequests.delete(requestId);
    return result;
  }

  /**
   * Side-effect-free chat-messages fetch for a specific scoop. Returns
   * the full ChatMessage[] without mutating the local panel state.
   * Used by the tray leader to serve follower scoop-select requests.
   */
  async getMessagesForScoop(scoopJid: string): Promise<ScoopMessagesReplacedMsg['messages']> {
    const requestId = `cm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reply = new Promise<ScoopMessagesReplacedMsg['messages']>((resolve) => {
      this.pendingChatMessagesRequests.set(requestId, resolve);
    });
    this.send({
      type: 'request-scoop-chat-messages',
      requestId,
      scoopJid,
    } as PanelToOffscreenMessage);
    const result = await Promise.race([
      reply,
      new Promise<ScoopMessagesReplacedMsg['messages']>((resolve) =>
        setTimeout(() => resolve([]), 5000)
      ),
    ]);
    this.pendingChatMessagesRequests.delete(requestId);
    return result;
  }

  /**
   * Session-stats pull: total session cost + per-scoop context-window
   * fill. Resolves `null` on timeout (the UI keeps its last values).
   */
  async getSessionStats(): Promise<SessionStats | null> {
    const requestId = `st-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reply = new Promise<SessionStats>((resolve) => {
      this.pendingStatsRequests.set(requestId, resolve);
    });
    this.send({ type: 'request-session-stats', requestId } as PanelToOffscreenMessage);
    const result = await Promise.race([
      reply,
      new Promise<SessionStats | null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    this.pendingStatsRequests.delete(requestId);
    return result;
  }

  /** Request full state from offscreen. Retries until state arrives. */
  requestState(): void {
    this.send({ type: 'request-state' });

    // Retry every 500ms until we get state or 10s passes
    let attempts = 0;
    this.stateRetryTimer = setInterval(() => {
      attempts++;
      if (this.ready || attempts > 20) {
        if (this.stateRetryTimer) {
          clearInterval(this.stateRetryTimer);
          this.stateRetryTimer = null;
        }
        return;
      }
      log.debug('Retrying request-state', { attempt: attempts });
      this.send({ type: 'request-state' });
    }, 500);
  }

  /** Whether the offscreen engine has reported ready. */
  isReady(): boolean {
    return this.ready;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private sprinkleOpHandler: ((payload: unknown) => void) | null = null;
  private forwardLickHandler: ((event: LickEvent) => void) | null = null;

  /** Send a sprinkle lick event to the offscreen orchestrator. */
  sendSprinkleLick(
    sprinkleName: string,
    body: unknown,
    targetScoop?: string,
    originLabel?: string
  ): void {
    this.send({
      type: 'sprinkle-lick',
      sprinkleName,
      body,
      targetScoop,
      originLabel,
    } as PanelToOffscreenMessage);
  }

  /**
   * Forward a `tool_ui` dip lick (or the reserved `__mounted` ack) into
   * the worker realm where `toolUIRegistry.handleAction` lives. Without
   * this route the dip would resolve against an empty page-side registry
   * and the tool (e.g. `mount`) would hang on its own timeout. The
   * envelope mirrors the extension's `tool-ui-action` shape so the same
   * `handleToolUIAction` consumer serves both runtimes.
   */
  sendToolUiAction(requestId: string, action: string, data?: unknown): void {
    this.send({
      type: 'tool-ui-action',
      requestId,
      action,
      data,
    } as PanelToOffscreenMessage);
  }

  /**
   * Relay a webhook event from the page-side `LeaderTrayManager` into the
   * worker-side `LickManager`. The leader receives `webhook.event` control
   * messages from the Cloudflare tray; this method forwards them across the
   * bridge so the lick manager (which lives in the kernel worker post-refactor)
   * can route to the registered scoop. Fire-and-forget — no ack expected.
   */
  sendWebhookEvent(webhookId: string, headers: Record<string, string>, body: unknown): void {
    this.send({
      type: 'lick-webhook-event',
      webhookId,
      headers,
      body,
    } as PanelToOffscreenMessage);
  }

  /** Standalone follower: tell the worker to forward (or stop forwarding) licks. */
  sendSetFollowerForwarding(enabled: boolean): void {
    this.send({ type: 'set-follower-forwarding', enabled } as PanelToOffscreenMessage);
  }

  /** Standalone leader: inject a follower-forwarded lick into the worker's LickManager. */
  sendForwardedLick(event: LickEvent): void {
    this.send({ type: 'inject-forwarded-lick', event } as PanelToOffscreenMessage);
  }

  /** Register the page-side handler the worker's forward-lick messages dispatch into. */
  setForwardLickHandler(handler: ((event: LickEvent) => void) | null): void {
    this.forwardLickHandler = handler;
  }

  /**
   * Relay a cherry host event from the page-side `LeaderSyncManager` into the
   * worker-side `LickManager`. The leader receives `cherry.host_event` over a
   * follower's data channel (its embedded cherry host page called
   * `emitHostEvent`); this method forwards it across the bridge so the lick
   * manager (kernel worker) can emit a `'cherry'` lick to the cone.
   * Fire-and-forget — no ack expected.
   */
  sendCherryHostEvent(cherryRuntimeId: string | undefined, name: string, detail?: unknown): void {
    this.send({
      type: 'lick-cherry-host-event',
      cherryRuntimeId,
      name,
      detail,
    } as PanelToOffscreenMessage);
  }

  /** Register a handler for sprinkle-op messages from the offscreen proxy. */
  setSprinkleOpHandler(handler: (payload: unknown) => void): void {
    this.sprinkleOpHandler = handler;
  }

  /**
   * Send a raw `PanelToOffscreenMessage` over the wire. Used by
   * `installPageStorageSync` to forward `local-storage-{set,remove,clear}`
   * events to the worker. Marked `@internal` because higher-level
   * facade methods cover normal traffic; this is for cases where the
   * page needs to push a typed envelope outside the orchestrator-shim API.
   */
  sendRaw(message: PanelToOffscreenMessage): void {
    this.send(message);
  }

  private setupMessageListener(): void {
    this.transport.onMessage((msg) => {
      if (msg.source !== 'offscreen') return;
      const payload = msg.payload as { type?: string };
      if (payload?.type === 'sprinkle-op' && this.sprinkleOpHandler) {
        this.sprinkleOpHandler(payload);
      } else {
        this.handleOffscreenMessage(msg.payload as OffscreenToPanelMessage | StateSnapshotMsg);
      }
    });
  }

  private handleOffscreenMessage(msg: OffscreenToPanelMessage | StateSnapshotMsg): void {
    switch (msg.type) {
      case 'offscreen-ready':
        if (this.ready) {
          // Offscreen restarted while panel was open (e.g. MV3 SW killed and
          // recreated the offscreen doc). Reset so the state-snapshot handler
          // treats the next snapshot as a first-ready and fires onReady again.
          log.warn('Offscreen restarted — re-requesting state');
          this.ready = false;
        } else {
          log.info('Offscreen engine ready');
        }
        this.send({ type: 'request-state' });
        break;

      case 'agent-event':
        this.handleAgentEvent(msg as AgentEventMsg);
        break;

      case 'scoop-status':
        this.handleScoopStatus(msg as ScoopStatusMsg);
        break;

      case 'compaction-state':
        this.callbacks.onCompactionStateChange?.(msg.scoopJid, msg.state);
        break;

      case 'clear-chat-ack': {
        const resolve = this.pendingClearAcks.get(msg.requestId);
        if (resolve) {
          this.pendingClearAcks.delete(msg.requestId);
          resolve();
        }
        break;
      }

      case 'scoop-created':
        this.handleScoopCreated(msg as ScoopCreatedMsg);
        break;

      case 'scoop-list':
        this.handleScoopList(msg as ScoopListMsg);
        break;

      case 'state-snapshot':
        this.handleStateSnapshot(msg as StateSnapshotMsg);
        break;

      case 'error':
        this.handleError(msg as ErrorMsg);
        break;

      case 'incoming-message':
        this.handleIncomingMessage(msg as IncomingMessageMsg);
        break;

      case 'message-updated':
        this.handleMessageUpdated(msg as MessageUpdatedMsg);
        break;

      case 'scoop-messages-replaced': {
        const m = msg as ScoopMessagesReplacedMsg;
        this.resyncStreamPointer(m.scoopJid, m.messages);
        this.callbacks.onScoopMessagesReplaced?.(m.scoopJid, m.messages);
        break;
      }

      case 'scoop-transcript': {
        const m = msg as ScoopTranscriptMsg;
        const resolve = this.pendingTranscriptRequests.get(m.requestId);
        if (resolve) {
          this.pendingTranscriptRequests.delete(m.requestId);
          resolve(m.transcript);
        }
        break;
      }

      case 'scoop-chat-messages': {
        const m = msg as { requestId: string; messages: ScoopMessagesReplacedMsg['messages'] };
        const resolve = this.pendingChatMessagesRequests.get(m.requestId);
        if (resolve) {
          this.pendingChatMessagesRequests.delete(m.requestId);
          resolve(m.messages);
        }
        break;
      }

      case 'session-stats': {
        const m = msg as SessionStatsMsg;
        const resolve = this.pendingStatsRequests.get(m.requestId);
        if (resolve) {
          this.pendingStatsRequests.delete(m.requestId);
          resolve({
            totalCost: m.totalCost,
            fills: m.fills,
            models: m.models ?? [],
            scoops: m.scoops ?? [],
          });
        }
        break;
      }

      case 'tray-runtime-status': {
        const m = msg as TrayRuntimeStatusMsg;
        applyTrayRuntimeStatusSnapshot(m.leader, m.follower);
        break;
      }

      case 'forward-lick':
        this.forwardLickHandler?.(msg.event as unknown as LickEvent);
        break;

      // Terminal session events route to subscribers registered via
      // `onTerminalEvent`. Not chat-related, so they don't go through
      // `emitToUI` / `agent-event` plumbing.
      case 'terminal-status':
      case 'terminal-output':
      case 'terminal-media-preview':
      case 'terminal-exit':
      case 'terminal-cleared': {
        for (const handler of this.terminalEventListeners) {
          try {
            handler(msg);
          } catch (err) {
            log.error('terminal event listener error', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Terminal event subscribers
  // -------------------------------------------------------------------------

  private terminalEventListeners = new Set<(event: TerminalEventMsg) => void>();

  /**
   * Subscribe to inbound terminal session events. Returns an
   * unsubscribe function. Used by `TerminalSessionClient` and any
   * future panel-side terminal-view to receive output / media-
   * preview / status / exit envelopes routed by session id.
   */
  onTerminalEvent(handler: (event: TerminalEventMsg) => void): () => void {
    this.terminalEventListeners.add(handler);
    return () => this.terminalEventListeners.delete(handler);
  }

  /**
   * Re-sync the panel's streaming pointer with a canonical replay.
   *
   * A mid-turn rehydrate (thawing a frozen session, switching scoops, or
   * an HMR/reload remount) replaces the thread via `scoop-messages-replaced`.
   * The synthetic message id we had been streaming into is no longer in the
   * rebuilt thread, so the next live `text_delta` would target a vanished
   * bubble and `WcChatController` drops it silently — leaving a perpetual
   * "working" spinner that never renders the reply (issue #959).
   *
   * Mirror the bridge's own rebuild logic: adopt the replay's streaming
   * assistant message id so subsequent (incremental) deltas keep extending
   * that exact bubble, otherwise forget the pointer so the next delta opens
   * a fresh `message_start`. The streaming assistant is usually the tail, but
   * a prompt or lick queued mid-turn is buffered AFTER it, so scan backward
   * for the last streaming assistant rather than assuming it is the final
   * entry.
   */
  private resyncStreamPointer(
    scoopJid: string,
    messages: ScoopMessagesReplacedMsg['messages']
  ): void {
    let streamingId: string | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && m.isStreaming) {
        streamingId = m.id;
        break;
      }
    }
    if (streamingId !== undefined) {
      this.currentMessageId.set(scoopJid, streamingId);
    } else {
      this.currentMessageId.delete(scoopJid);
    }
  }

  private handleAgentEvent(msg: AgentEventMsg): void {
    // Per-scoop activity ping fires BEFORE the selection gate so the
    // host can move the navbar eyes onto a non-selected scoop that is
    // actively streaming. The gate below still controls which scoop's
    // thread renders.
    switch (msg.eventType) {
      case 'text_delta':
      case 'tool_start':
      case 'tool_ui':
      case 'turn_end':
        this.callbacks.onScoopActivity?.(msg.scoopJid);
        break;
    }

    if (msg.scoopJid !== this.selectedScoopJid) return;

    switch (msg.eventType) {
      case 'text_delta': {
        let msgId = this.currentMessageId.get(msg.scoopJid);
        if (!msgId) {
          msgId = `scoop-${msg.scoopJid}-${uid()}`;
          this.currentMessageId.set(msg.scoopJid, msgId);
          this.emitToUI({ type: 'message_start', messageId: msgId });
        }
        this.emitToUI({ type: 'content_delta', messageId: msgId, text: msg.text ?? '' });
        break;
      }

      case 'tool_start': {
        let msgId = this.currentMessageId.get(msg.scoopJid);
        if (!msgId) {
          msgId = `scoop-${msg.scoopJid}-${uid()}`;
          this.currentMessageId.set(msg.scoopJid, msgId);
          this.emitToUI({ type: 'message_start', messageId: msgId });
        }
        this.emitToUI({
          type: 'tool_use_start',
          messageId: msgId,
          toolName: msg.toolName ?? '',
          toolInput: msg.toolInput,
        });
        break;
      }

      case 'tool_end': {
        const msgId = this.currentMessageId.get(msg.scoopJid);
        if (msgId) {
          this.emitToUI({
            type: 'tool_result',
            messageId: msgId,
            toolName: msg.toolName ?? '',
            result: msg.toolResult ?? '',
            isError: msg.isError,
          });
        }
        break;
      }

      case 'tool_ui': {
        let msgId = this.currentMessageId.get(msg.scoopJid);
        if (!msgId) {
          msgId = `scoop-${msg.scoopJid}-${uid()}`;
          this.currentMessageId.set(msg.scoopJid, msgId);
          this.emitToUI({ type: 'message_start', messageId: msgId });
        }
        this.emitToUI({
          type: 'tool_ui',
          messageId: msgId,
          toolName: msg.toolName ?? '',
          requestId: msg.requestId ?? '',
          html: msg.html ?? '',
        });
        break;
      }

      case 'tool_ui_done': {
        const msgId = this.currentMessageId.get(msg.scoopJid);
        if (msgId) {
          this.emitToUI({
            type: 'tool_ui_done',
            messageId: msgId,
            requestId: msg.requestId ?? '',
          });
        }
        break;
      }

      case 'response_done': {
        const msgId = this.currentMessageId.get(msg.scoopJid);
        if (msgId) {
          this.emitToUI({ type: 'content_done', messageId: msgId });
          this.currentMessageId.delete(msg.scoopJid);
        }
        break;
      }

      case 'turn_end': {
        const msgId = this.currentMessageId.get(msg.scoopJid) ?? `done-${msg.scoopJid}-${uid()}`;
        this.currentMessageId.delete(msg.scoopJid);
        this.emitToUI({ type: 'turn_end', messageId: msgId });
        break;
      }
    }
  }

  private handleScoopStatus(msg: ScoopStatusMsg): void {
    this.scoopStatuses.set(msg.scoopJid, msg.status);
    this.callbacks.onStatusChange(msg.scoopJid, msg.status);
  }

  private handleScoopCreated(msg: ScoopCreatedMsg): void {
    const scoop = this.msgScoopToRegistered(msg.scoop);
    // Remove optimistic entry (same name, different JID) and add the real one
    this.scoops = this.scoops.filter((s) => s.name !== scoop.name || s.jid === scoop.jid);
    if (!this.scoops.find((s) => s.jid === scoop.jid)) {
      this.scoops.push(scoop);
    }
    this.scoopStatuses.set(scoop.jid, msg.scoop.status);
    this.callbacks.onScoopCreated(scoop);
  }

  private handleScoopList(msg: ScoopListMsg): void {
    this.scoops = msg.scoops.map((s) => this.msgScoopToRegistered(s));
    for (const s of msg.scoops) {
      this.scoopStatuses.set(s.jid, s.status);
    }
    this.callbacks.onScoopListUpdate(msg.scoops);
  }

  private handleStateSnapshot(msg: StateSnapshotMsg): void {
    log.info('Received state snapshot', { scoopCount: msg.scoops.length });

    this.scoops = msg.scoops.map((s) => this.msgScoopToRegistered(s));
    for (const s of msg.scoops) {
      this.scoopStatuses.set(s.jid, s.status);
    }

    if (msg.trayRuntimeStatus) {
      applyTrayRuntimeStatusSnapshot(msg.trayRuntimeStatus.leader, msg.trayRuntimeStatus.follower);
    }

    const isFirstReady = !this.ready;
    if (isFirstReady) {
      this.ready = true;
      if (this.stateRetryTimer) {
        clearInterval(this.stateRetryTimer);
        this.stateRetryTimer = null;
      }
    }

    this.callbacks.onScoopListUpdate(msg.scoops);

    if (isFirstReady) {
      this.callbacks.onReady?.();
    }
  }

  private handleError(msg: ErrorMsg): void {
    if (msg.scoopJid === this.selectedScoopJid) {
      this.emitToUI({ type: 'error', error: msg.error });
    }
  }

  private handleIncomingMessage(msg: IncomingMessageMsg): void {
    this.callbacks.onIncomingMessage(msg.scoopJid, msg.message);
  }

  private handleMessageUpdated(msg: MessageUpdatedMsg): void {
    this.callbacks.onMessageUpdate?.(msg.scoopJid, {
      messageId: msg.messageId,
      lickId: msg.lickId,
      lickState: msg.lickState,
    });
  }

  private msgScoopToRegistered(s: ScoopListMsg['scoops'][number]): RegisteredScoop {
    return {
      jid: s.jid,
      name: s.name,
      folder: s.folder,
      isCone: s.isCone,
      type: s.isCone ? 'cone' : 'scoop',
      requiresTrigger: !s.isCone,
      assistantLabel: s.assistantLabel,
      addedAt: new Date().toISOString(),
      // Carry the persisted-per-scoop config snapshot through to the
      // panel-side `RegisteredScoop`. The offscreen bridge populates
      // `s.config` with `modelId` + `thinkingLevel` (see
      // `OffscreenBridge.toScoopSnapshot`); the panel reads these in
      // `syncThinkingButtonForExtensionScoop` to drive the brain icon's
      // visibility and persisted level on scoop switches and reconnect.
      ...(s.config ? { config: { ...s.config } } : {}),
    };
  }

  private emitToUI(event: UIAgentEvent): void {
    for (const cb of this.eventListeners) {
      try {
        cb(event);
      } catch (err) {
        log.error('Listener error', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private send(payload: PanelToOffscreenMessage): void {
    if (this.locked) {
      this.emitToUI({
        type: 'error',
        error: 'This window is detached. Close it and use the detached tab.',
      });
      return;
    }
    this.transport.send(payload);
  }
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Mirror an offscreen tray status snapshot into the panel-side singletons
 * so `Layout.appendTrayMenu` and any other panel code reading
 * `getLeaderTrayRuntimeStatus` / `getFollowerTrayRuntimeStatus` sees the
 * same view as offscreen. The wire snapshot carries the full
 * `LeaderTraySession`, so consumers like the lick-WebSocket
 * `create_webhook` handler that read `session.webhookUrl` get real
 * values instead of falling back silently.
 */
function applyTrayRuntimeStatusSnapshot(
  leader: TrayLeaderStatusSnapshot,
  follower: TrayFollowerStatusSnapshot
): void {
  setLeaderTrayRuntimeStatus({
    state: leader.state,
    error: leader.error,
    reconnectAttempts: leader.reconnectAttempts,
    session: leader.session ? { ...leader.session } : null,
  });
  setFollowerTrayRuntimeStatus({
    state: follower.state,
    joinUrl: follower.joinUrl,
    trayId: follower.trayId,
    error: follower.error,
    lastError: follower.lastError,
    reconnectAttempts: follower.reconnectAttempts,
    attachAttempts: follower.attachAttempts,
    lastAttachCode: follower.lastAttachCode,
    connectingSince: follower.connectingSince,
    lastPingTime: follower.lastPingTime,
  });
}
