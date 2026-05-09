/**
 * OffscreenClient — side panel's interface to the offscreen agent engine.
 *
 * Replaces direct Orchestrator usage in extension mode. Sends commands via
 * chrome.runtime messages and receives events back. Provides:
 * - AgentHandle for the chat panel
 * - Orchestrator-compatible facade for scoops/memory/scoop-switcher panels
 * - State sync on reconnect with retry logic
 */

import type { AgentHandle, AgentEvent as UIAgentEvent } from './types.js';
import type { MessageAttachment } from '../core/attachments.js';
import type { RegisteredScoop, ScoopTabState, ThinkingLevel } from '../scoops/types.js';
import type { VirtualFS } from '../fs/index.js';
import type {
  ExtensionMessage,
  PanelToOffscreenMessage,
  OffscreenToPanelMessage,
  StateSnapshotMsg,
  AgentEventMsg,
  ScoopStatusMsg,
  ScoopCreatedMsg,
  ErrorMsg,
  IncomingMessageMsg,
  ScoopListMsg,
  ScoopMessagesReplacedMsg,
  TrayFollowerStatusSnapshot,
  TrayLeaderStatusSnapshot,
  TrayRuntimeStatusMsg,
} from '../../../chrome-extension/src/messages.js';
import { createLogger } from '../core/logger.js';
import { setLeaderTrayRuntimeStatus } from '../scoops/tray-leader.js';
import { setFollowerTrayRuntimeStatus } from '../scoops/tray-follower-status.js';
import type { KernelClientFacade, KernelTransport } from '../kernel/types.js';
import { createPanelChromeRuntimeTransport } from '../kernel/transport-chrome-runtime.js';

const log = createLogger('offscreen-client');

export interface OffscreenClientCallbacks {
  onStatusChange: (scoopJid: string, status: ScoopTabState['status']) => void;
  onScoopCreated: (scoop: RegisteredScoop) => void;
  onScoopListUpdate: (scoops: ScoopListMsg['scoops']) => void;
  onIncomingMessage: (scoopJid: string, message: IncomingMessageMsg['message']) => void;
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
}

export class OffscreenClient implements KernelClientFacade {
  private eventListeners = new Set<(event: UIAgentEvent) => void>();
  private callbacks: OffscreenClientCallbacks;
  private scoops: RegisteredScoop[] = [];
  private scoopStatuses = new Map<string, ScoopTabState['status']>();
  private currentMessageId = new Map<string, string>();
  private ready = false;
  private stateRetryTimer: ReturnType<typeof setInterval> | null = null;
  private localFs: VirtualFS | null = null;
  /**
   * KernelTransport — defaults to the chrome.runtime adapter. Phase 2
   * step 6b allows passing a `MessageChannel`-backed transport via the
   * constructor so the standalone panel can drive the same client over
   * the kernel worker. The transport delivers raw `ExtensionMessage`
   * envelopes either way so the existing source filter and special-case
   * routing (`debug-tabs`, `sprinkle-op`) stay intact.
   */
  private transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>;

  /** Currently selected scoop JID (set by the UI). */
  selectedScoopJid: string | null = null;

  /**
   * Phase 2: optional transport injection. If omitted (today's
   * extension panel), the chrome.runtime adapter is constructed.
   * Standalone passes a `MessageChannel`-backed transport bound to
   * the kernel worker.
   */
  constructor(
    callbacks: OffscreenClientCallbacks,
    transport?: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>
  ) {
    this.callbacks = callbacks;
    this.transport = transport ?? createPanelChromeRuntimeTransport<PanelToOffscreenMessage>();
    this.setupMessageListener();
  }

  /** Set a local VFS instance (same IndexedDB as offscreen) for memory panel / file browser. */
  setLocalFS(fs: VirtualFS): void {
    this.localFs = fs;
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
  getScoopContext(_jid: string): { getFS: () => VirtualFS | null } | undefined {
    if (!this.localFs) return undefined;
    // Return a facade that gives the memory panel access to the shared VFS.
    // The memory panel reads scoop memory at /scoops/{folder}/CLAUDE.md or /workspace/CLAUDE.md.
    return { getFS: () => this.localFs };
  }

  /** Return the shared VFS. */
  getSharedFS(): VirtualFS | null {
    return this.localFs;
  }

  stopScoop(jid: string): void {
    this.send({ type: 'abort', scoopJid: jid });
  }

  async clearQueuedMessages(_jid: string): Promise<void> {
    // Handled by the abort message
  }

  async deleteQueuedMessage(_jid: string, _messageId: string): Promise<void> {
    // Not supported through offscreen proxy
  }

  updateModel(): void {
    // Side panel already wrote to localStorage. Tell offscreen to re-read.
    this.send({ type: 'refresh-model' });
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

  async clearAllMessages(): Promise<void> {
    this.send({ type: 'clear-chat' });
  }

  clearFilesystem(): void {
    this.send({ type: 'clear-filesystem' });
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

  /** Send a sprinkle lick event to the offscreen orchestrator. */
  sendSprinkleLick(sprinkleName: string, body: unknown, targetScoop?: string): void {
    this.send({
      type: 'sprinkle-lick',
      sprinkleName,
      body,
      targetScoop,
    } as PanelToOffscreenMessage);
  }

  /** Register a handler for sprinkle-op messages from the offscreen proxy. */
  setSprinkleOpHandler(handler: (payload: unknown) => void): void {
    this.sprinkleOpHandler = handler;
  }

  private setupMessageListener(): void {
    this.transport.onMessage((msg) => {
      if (msg.source !== 'offscreen') return;
      const payload = msg.payload as { type?: string; show?: unknown };
      // Route debug-tabs toggle to the panel's Layout
      if (payload?.type === 'debug-tabs') {
        const toggle = (window as unknown as Record<string, unknown>).__slicc_debug_tabs as
          | ((show: boolean) => void)
          | undefined;
        toggle?.(!!payload.show);
      } else if (payload?.type === 'sprinkle-op' && this.sprinkleOpHandler) {
        this.sprinkleOpHandler(payload);
      } else {
        this.handleOffscreenMessage(msg.payload as OffscreenToPanelMessage | StateSnapshotMsg);
      }
    });
  }

  private handleOffscreenMessage(msg: OffscreenToPanelMessage | StateSnapshotMsg): void {
    switch (msg.type) {
      case 'offscreen-ready':
        log.info('Offscreen engine ready');
        if (!this.ready) {
          // Request state now that offscreen is confirmed ready
          this.send({ type: 'request-state' });
        }
        break;

      case 'agent-event':
        this.handleAgentEvent(msg as AgentEventMsg);
        break;

      case 'scoop-status':
        this.handleScoopStatus(msg as ScoopStatusMsg);
        break;

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

      case 'scoop-messages-replaced': {
        const m = msg as ScoopMessagesReplacedMsg;
        this.callbacks.onScoopMessagesReplaced?.(m.scoopJid, m.messages);
        break;
      }

      case 'tray-runtime-status': {
        const m = msg as TrayRuntimeStatusMsg;
        applyTrayRuntimeStatusSnapshot(m.leader, m.follower);
        break;
      }
    }
  }

  private handleAgentEvent(msg: AgentEventMsg): void {
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
