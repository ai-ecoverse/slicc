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
import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';
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
} from '../extension/messages.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('offscreen-client');

export interface OffscreenClientCallbacks {
  onStatusChange: (scoopJid: string, status: ScoopTabState['status']) => void;
  onScoopCreated: (scoop: RegisteredScoop) => void;
  onScoopListUpdate: (scoops: ScoopListMsg['scoops']) => void;
  onIncomingMessage: (scoopJid: string, message: IncomingMessageMsg['message']) => void;
  /** Called when the offscreen engine is ready and state has been received. */
  onReady?: () => void;
}

export class OffscreenClient {
  private eventListeners = new Set<(event: UIAgentEvent) => void>();
  private callbacks: OffscreenClientCallbacks;
  private scoops: RegisteredScoop[] = [];
  private scoopStatuses = new Map<string, ScoopTabState['status']>();
  private currentMessageId = new Map<string, string>();
  private ready = false;
  private stateRetryTimer: ReturnType<typeof setInterval> | null = null;
  private localFs: VirtualFS | null = null;

  /** Currently selected scoop JID (set by the UI). */
  selectedScoopJid: string | null = null;

  constructor(callbacks: OffscreenClientCallbacks) {
    this.callbacks = callbacks;
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
      sendMessage: (text: string, messageId?: string) => {
        if (!this.selectedScoopJid) {
          this.emitToUI({ type: 'error', error: 'No scoop selected' });
          return;
        }
        this.send({
          type: 'user-message',
          scoopJid: this.selectedScoopJid,
          text,
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
    return this.scoops.find(s => s.jid === jid);
  }

  isProcessing(jid: string): boolean {
    return this.scoopStatuses.get(jid) === 'processing';
  }

  /** Called by ScoopsPanel.createScoop(). Adds optimistically so the UI
   *  updates immediately, then sends to offscreen. The real scoop (with a
   *  different JID) replaces the optimistic one when scoop-created arrives. */
  async registerScoop(scoop: RegisteredScoop): Promise<void> {
    if (!this.scoops.find(s => s.name === scoop.name)) {
      this.scoops.push(scoop);
      this.scoopStatuses.set(scoop.jid, 'initializing');
    }
    this.send({ type: 'scoop-create', name: scoop.name, isCone: scoop.isCone });
  }

  /** Called by ScoopsPanel delete button. */
  async unregisterScoop(jid: string): Promise<void> {
    this.send({ type: 'scoop-drop', scoopJid: jid });
    // Optimistically remove
    this.scoops = this.scoops.filter(s => s.jid !== jid);
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

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener(
      (message: unknown, _sender: ChromeMessageSender, _sendResponse: (response?: unknown) => void) => {
        if (!isExtMsg(message)) return false;
        const msg = message as ExtensionMessage;

        if (msg.source === 'offscreen') {
          this.handleOffscreenMessage(msg.payload as OffscreenToPanelMessage | StateSnapshotMsg);
        }

        return false;
      },
    );
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
    this.scoops = this.scoops.filter(s => s.name !== scoop.name || s.jid === scoop.jid);
    if (!this.scoops.find(s => s.jid === scoop.jid)) {
      this.scoops.push(scoop);
    }
    this.scoopStatuses.set(scoop.jid, msg.scoop.status);
    this.callbacks.onScoopCreated(scoop);
  }

  private handleScoopList(msg: ScoopListMsg): void {
    this.scoops = msg.scoops.map(s => this.msgScoopToRegistered(s));
    for (const s of msg.scoops) {
      this.scoopStatuses.set(s.jid, s.status);
    }
    this.callbacks.onScoopListUpdate(msg.scoops);
  }

  private handleStateSnapshot(msg: StateSnapshotMsg): void {
    log.info('Received state snapshot', { scoopCount: msg.scoops.length });

    this.scoops = msg.scoops.map(s => this.msgScoopToRegistered(s));
    for (const s of msg.scoops) {
      this.scoopStatuses.set(s.jid, s.status);
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
    chrome.runtime.sendMessage({
      source: 'panel' as const,
      payload,
    }).catch((err) => {
      log.error('Failed to send to offscreen', { error: err instanceof Error ? err.message : String(err) });
    });
  }
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function isExtMsg(msg: unknown): boolean {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'source' in msg &&
    'payload' in msg
  );
}
