import { createLogger } from '../base/logger.js';
import type { MessageAttachment } from '../core/attachments.js';
import type { CompactionState } from '../core/context-compaction.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type {
  AgentEventMsg,
  AgentSpawnResultMsg,
  CompactionStateMsg,
  ErrorMsg,
  ExtensionMessage,
  ForwardedLickEvent,
  IncomingMessageMsg,
  LickBackpressureMsg,
  MessageUpdatedMsg,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
  ScoopChatMessagesMsg,
  ScoopCreatedMsg,
  ScoopListMsg,
  ScoopMessagesReplacedMsg,
  ScoopSnapshotConfig,
  ScoopStatusMsg,
  ScoopTranscriptMsg,
  SessionBudgetWindow,
  SessionStatsMsg,
  SetScoopModelAckMsg,
  SetThinkingLevelAckMsg,
  SprinkleLickOrigin,
  StateSnapshotMsg,
  SudoApprovalMsg,
  TrayFollowerStatusSnapshot,
  TrayLeaderStatusSnapshot,
  TrayRuntimeStatusMsg,
} from '../kernel/messages.js';
import { createPanelChromeRuntimeTransport } from '../kernel/transport-chrome-runtime.js';
import type { KernelClientFacade, KernelTransport } from '../kernel/types.js';
import type { AgentSpawnOptions, AgentSpawnResult } from '../scoops/agent-bridge.js';
import { CompactionRowTracker } from '../scoops/compaction-rows.js';
import type { LickEvent, WebhookDeliveryDisposition } from '../scoops/lick-manager.js';
import { setFollowerTrayRuntimeStatus } from '../scoops/tray-follower-status.js';
import { setLeaderTrayRuntimeStatus } from '../scoops/tray-leader.js';
import type {
  RegisteredScoop,
  ScoopTabState,
  ThinkingLevel,
  WorkUnitModel,
} from '../scoops/types.js';
import type { TerminalEventMsg } from '../shell/terminal-protocol.js';
import { isRootUnit, rootsOf } from '../work-unit/policy.js';
import {
  modelFor,
  normalizeScoopRecord,
  setUnitThinking,
  thinkingFor,
} from '../work-unit/record.js';

const WEBHOOK_DELIVERY_ACK_TIMEOUT_MS = 2000;

import type { AgentHandle, ChatMessage, AgentEvent as UIAgentEvent } from './types.js';

const log = createLogger('offscreen-client');

const _assertLickWireCarrier: (
  e: LickEvent
) => Pick<ForwardedLickEvent, 'type' | 'timestamp' | 'body'> = (e) => e;
void _assertLickWireCarrier;

export interface SessionStats {
  totalCost: number;

  burnRate: number;

  fills: Array<{ jid: string; fill: number }>;

  models: Array<{ model: string; cost: number; turns: number; tokens: number }>;

  scoops: Array<{
    name: string;
    model: string;
    cost: number;
    type: 'cone' | 'scoop';
    source: 'live' | 'dropped' | 'frozen';
  }>;

  budget?: SessionBudgetWindow;
}

export interface CompactionNoticeDetail {
  trigger: 'threshold' | 'overflow' | 'idle';
  transcriptPath?: string;

  roundId?: string;
}

export interface OffscreenClientCallbacks {
  onStatusChange: (scoopJid: string, status: ScoopTabState['status']) => void;
  onScoopCreated: (scoop: RegisteredScoop) => void;
  onScoopListUpdate: (scoops: ScoopListMsg['scoops']) => void;
  onIncomingMessage: (scoopJid: string, message: IncomingMessageMsg['message']) => void;

  onLickBackpressure?: (
    scoopJid: string,
    info: Pick<LickBackpressureMsg, 'count' | 'waitingMs'>
  ) => void;

  onMessageUpdate?: (
    scoopJid: string,
    update: { messageId: string; lickId?: string; lickState?: ChatMessage['lickState'] }
  ) => void;

  onScoopMessagesReplaced?: (
    scoopJid: string,
    messages: ScoopMessagesReplacedMsg['messages'],

    queuedIds?: string[]
  ) => void;

  onReady?: () => void;

  onCompactionStateChange?: (
    scoopJid: string,
    state: 'summarizing' | 'extracting-memory' | 'fallback' | 'cancelled' | 'idle',
    detail: CompactionNoticeDetail
  ) => void;

  onScoopActivity?: (scoopJid: string) => void;

  onScoopPhaseChange?: (scoopJid: string, phase: ScoopBusyPhase) => void;
}

export type ScoopBusyPhase = 'thinking' | 'tool';

export class OffscreenClient implements KernelClientFacade {
  private eventListeners = new Set<(event: UIAgentEvent) => void>();
  private callbacks: OffscreenClientCallbacks;
  private scoops: RegisteredScoop[] = [];
  private scoopStatuses = new Map<string, ScoopTabState['status']>();
  private currentMessageId = new Map<string, string>();

  private readonly compactionRows = new CompactionRowTracker(
    (scoopJid) => `compaction-${scoopJid}-${uid()}`
  );

  private toolDepth = new Map<string, number>();
  private ready = false;
  private stateRetryTimer: ReturnType<typeof setInterval> | null = null;
  private localFs: LocalVfsClient | null = null;

  private pendingClearAcks = new Map<string, () => void>();

  private pendingWebhookDeliveries = new Map<
    string,
    (disposition: WebhookDeliveryDisposition) => void
  >();
  private pendingAgentSpawnRequests = new Map<
    string,
    { resolve: (result: AgentSpawnResult) => void; reject: (error: Error) => void }
  >();

  private pendingThinkingAcks = new Map<string, (applied: boolean) => void>();
  private pendingModelAcks = new Map<string, (applied: boolean) => void>();

  private pendingTranscriptRequests = new Map<string, (transcript: string) => void>();
  private pendingChatMessagesRequests = new Map<
    string,
    (messages: ScoopMessagesReplacedMsg['messages']) => void
  >();
  private pendingStatsRequests = new Map<string, (stats: SessionStats) => void>();
  private pendingSudoRequests = new Map<
    string,
    (decision: import('../sudo/types.js').SudoDecision) => void
  >();

  private transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>;

  private _selectedScoopJid: string | null = null;

  get selectedScoopJid(): string | null {
    return this._selectedScoopJid;
  }

  private readonly scoopSelectedListeners = new Set<(jid: string) => void>();

  onScoopSelected(handler: (jid: string) => void): () => void {
    this.scoopSelectedListeners.add(handler);
    return () => {
      this.scoopSelectedListeners.delete(handler);
    };
  }

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

  constructor(
    callbacks: OffscreenClientCallbacks,
    transport?: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>
  ) {
    this.callbacks = callbacks;
    this.transport = transport ?? createPanelChromeRuntimeTransport<PanelToOffscreenMessage>();
    this.setupMessageListener();
  }

  setLocalFS(fs: LocalVfsClient): void {
    this.localFs = fs;
  }

  getTransport(): KernelTransport<ExtensionMessage, PanelToOffscreenMessage> {
    return this.transport;
  }

  emitAgentError(error: string): void {
    this.emitToUI({ type: 'error', error });
  }

  createAgentHandle(): AgentHandle {
    return {
      sendMessage: (
        text: string,
        messageId?: string,
        attachments?: MessageAttachment[],
        options?: { steer?: boolean; guestGate?: import('../sudo/types.js').TurnGuestGate }
      ) => {
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
          ...(options?.steer ? { steer: true as const } : {}),
          ...(options?.guestGate ? { guestGate: options.guestGate } : {}),
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

  getScoops(): RegisteredScoop[] {
    return this.scoops;
  }

  getScoop(jid: string): RegisteredScoop | undefined {
    return this.scoops.find((s) => s.jid === jid);
  }

  isProcessing(jid: string): boolean {
    return this.scoopStatuses.get(jid) === 'processing';
  }

  async registerScoop(
    scoop: RegisteredScoop,
    options: { description?: string; prompt?: string } = {}
  ): Promise<void> {
    if (!isRootUnit(scoop)) {
      throw new Error(
        'OffscreenClient.registerScoop is cone-only; use scoop_scoop for non-cone scoops'
      );
    }
    if (!this.scoops.find((s) => s.name === scoop.name)) {
      this.scoops.push(scoop);
      this.scoopStatuses.set(scoop.jid, 'initializing');
    }
    this.send({
      type: 'cone-create',
      name: scoop.name,
      ...(options.description ? { description: options.description } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),

      ...(scoop.model ? { model: scoop.model } : {}),
    });
  }

  async unregisterScoop(jid: string): Promise<void> {
    const target = this.scoops.find((s) => s.jid === jid);
    if (target && isRootUnit(target) && rootsOf(this.scoops).length <= 1) {
      throw new Error('Cannot remove the last cone');
    }
    this.send({ type: 'scoop-drop', scoopJid: jid });

    this.scoops = this.scoops.filter((s) => s.jid !== jid);
    this.scoopStatuses.delete(jid);
  }

  createScoopTab(_jid: string): void {}

  async getGlobalMemory(): Promise<string> {
    if (!this.localFs) return '';
    try {
      const content = await this.localFs.readFile('/shared/CLAUDE.md', { encoding: 'utf-8' });
      return typeof content === 'string' ? content : new TextDecoder().decode(content);
    } catch {
      return '';
    }
  }

  getScoopContext(_jid: string): { getFS: () => LocalVfsClient | null } | undefined {
    if (!this.localFs) return undefined;

    return { getFS: () => this.localFs };
  }

  getSharedFS(): LocalVfsClient | null {
    return this.localFs;
  }

  stopScoop(jid: string): void {
    this.send({ type: 'abort', scoopJid: jid });
  }

  async clearQueuedMessages(_jid: string): Promise<void> {}

  async deleteQueuedMessage(jid: string, messageId: string): Promise<void> {
    this.send({ type: 'delete-queued-message', scoopJid: jid, messageId });
  }

  updateModel(): void {
    this.send({ type: 'refresh-model' });
  }

  setScoopModel(jid: string, model: WorkUnitModel | undefined): Promise<boolean> {
    const requestId = `model-${uid()}`;
    const ack = new Promise<boolean>((resolve) => {
      this.pendingModelAcks.set(requestId, resolve);
    });
    this.send({ type: 'set-scoop-model', requestId, scoopJid: jid, model });
    return Promise.race([
      ack,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]).finally(() => this.pendingModelAcks.delete(requestId));
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
  }

  setScoopThinkingLevel(
    jid: string,
    level: ThinkingLevel | undefined,
    effortOverride?: string
  ): Promise<boolean> {
    const requestId = `thinking-${uid()}`;
    const ack = new Promise<boolean>((resolve) => {
      this.pendingThinkingAcks.set(requestId, resolve);
    });
    this.send({ type: 'set-thinking-level', requestId, scoopJid: jid, level, effortOverride });
    return Promise.race([
      ack,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]).finally(() => this.pendingThinkingAcks.delete(requestId));
  }

  async clearAllMessages(
    scoopJid?: string,
    options: { discardLiveSnapshot?: boolean } = {}
  ): Promise<void> {
    const requestId = `clear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ack = new Promise<void>((resolve) => {
      this.pendingClearAcks.set(requestId, resolve);
    });
    this.send({
      type: 'clear-chat',
      requestId,
      ...(scoopJid ? { scoopJid } : {}),
      ...(options.discardLiveSnapshot ? { discardLiveSnapshot: true } : {}),
    });
    await Promise.race([ack, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
    this.pendingClearAcks.delete(requestId);
  }

  spawnAgent(options: AgentSpawnOptions): Promise<AgentSpawnResult> {
    const requestId = `agent-${uid()}`;
    const result = new Promise<AgentSpawnResult>((resolve, reject) => {
      this.pendingAgentSpawnRequests.set(requestId, { resolve, reject });
    });

    const { signal, ...wireOptions } = options;
    this.send({ type: 'agent-spawn-request', requestId, options: wireOptions });
    if (signal) {
      if (signal.aborted) this.send({ type: 'agent-spawn-abort', requestId });
      else
        signal.addEventListener(
          'abort',
          () => this.send({ type: 'agent-spawn-abort', requestId }),
          {
            once: true,
          }
        );
    }
    return result;
  }

  clearFilesystem(): void {
    this.send({ type: 'clear-filesystem' });
  }

  requestScoopMessages(scoopJid: string): void {
    this.send({ type: 'request-scoop-messages', scoopJid } as PanelToOffscreenMessage);
  }

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
    let timedOut = false;
    const result = await Promise.race([
      reply,
      new Promise<ScoopMessagesReplacedMsg['messages']>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve([]);
        }, 5000)
      ),
    ]);
    this.pendingChatMessagesRequests.delete(requestId);
    if (timedOut) log.warn('getMessagesForScoop timed out', { scoopJid });
    return result;
  }

  async requestSudoApproval(
    request: import('../sudo/types.js').SudoRequest,
    timeoutMs = 10 * 60 * 1000
  ): Promise<import('../sudo/types.js').SudoDecision> {
    const requestId = `sudo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reply = new Promise<import('../sudo/types.js').SudoDecision>((resolve) => {
      this.pendingSudoRequests.set(requestId, resolve);
    });
    this.send({ type: 'request-sudo-approval', requestId, request } as PanelToOffscreenMessage);
    const result = await Promise.race([
      reply,
      new Promise<import('../sudo/types.js').SudoDecision>((resolve) =>
        setTimeout(() => resolve({ decision: 'deny' }), timeoutMs)
      ),
    ]);
    this.pendingSudoRequests.delete(requestId);
    return result;
  }

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

  requestState(): void {
    this.send({ type: 'request-state' });

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

  isReady(): boolean {
    return this.ready;
  }

  private sprinkleOpHandler: ((payload: unknown) => void) | null = null;
  private forwardLickHandler: ((event: LickEvent) => void) | null = null;

  sendSprinkleLick(
    sprinkleName: string,
    body: unknown,
    targetScoop?: string,
    origin?: SprinkleLickOrigin
  ): void {
    this.send({
      type: 'sprinkle-lick',
      sprinkleName,
      body,
      targetScoop,
      origin,
    } as PanelToOffscreenMessage);
  }

  sendToolUiAction(requestId: string, action: string, data?: unknown): void {
    this.send({
      type: 'tool-ui-action',
      requestId,
      action,
      data,
    } as PanelToOffscreenMessage);
  }

  async sendWebhookEvent(
    webhookId: string,
    headers: Record<string, string>,
    body: unknown
  ): Promise<WebhookDeliveryDisposition | null> {
    const requestId = `wh-${uid()}`;
    const ack = new Promise<WebhookDeliveryDisposition>((resolve) => {
      this.pendingWebhookDeliveries.set(requestId, resolve);
    });
    this.send({
      type: 'lick-webhook-event',
      webhookId,
      headers,
      body,
      requestId,
    } as PanelToOffscreenMessage);
    try {
      return await Promise.race([
        ack,
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), WEBHOOK_DELIVERY_ACK_TIMEOUT_MS)
        ),
      ]);
    } finally {
      this.pendingWebhookDeliveries.delete(requestId);
    }
  }

  sendSetFollowerForwarding(enabled: boolean): void {
    this.send({ type: 'set-follower-forwarding', enabled } as PanelToOffscreenMessage);
  }

  sendForwardedLick(event: LickEvent): void {
    this.send({ type: 'inject-forwarded-lick', event } as PanelToOffscreenMessage);
  }

  setForwardLickHandler(handler: ((event: LickEvent) => void) | null): void {
    this.forwardLickHandler = handler;
  }

  sendCherryHostEvent(cherryRuntimeId: string | undefined, name: string, detail?: unknown): void {
    this.send({
      type: 'lick-cherry-host-event',
      cherryRuntimeId,
      name,
      detail,
    } as PanelToOffscreenMessage);
  }

  sendPreviewLick(event: LickEvent): void {
    this.send({
      type: 'lick-preview',
      event: event as unknown as ForwardedLickEvent,
    } as PanelToOffscreenMessage);
  }

  setSprinkleOpHandler(handler: (payload: unknown) => void): void {
    this.sprinkleOpHandler = handler;
  }

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
        this.handleCompactionState(msg as CompactionStateMsg);
        break;

      case 'clear-chat-ack': {
        const resolve = this.pendingClearAcks.get(msg.requestId);
        if (resolve) {
          this.pendingClearAcks.delete(msg.requestId);
          resolve();
        }
        break;
      }

      case 'lick-webhook-delivery': {
        const resolve = this.pendingWebhookDeliveries.get(msg.requestId);
        if (resolve) {
          this.pendingWebhookDeliveries.delete(msg.requestId);
          resolve(msg.disposition);
        }
        break;
      }

      case 'agent-spawn-result': {
        this.handleAgentSpawnResult(msg);
        break;
      }

      case 'set-scoop-model-ack':
        this.handleScoopModelAck(msg);
        break;

      case 'set-thinking-level-ack':
        this.handleThinkingLevelAck(msg);
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

      case 'lick-backpressure':
        this.callbacks.onLickBackpressure?.(msg.scoopJid, {
          count: msg.count,
          waitingMs: msg.waitingMs,
        });
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
        this.callbacks.onScoopMessagesReplaced?.(m.scoopJid, m.messages, m.queuedIds);
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
        const m = msg as ScoopChatMessagesMsg;
        const resolve = this.pendingChatMessagesRequests.get(m.requestId);
        if (resolve) {
          this.pendingChatMessagesRequests.delete(m.requestId);
          resolve(m.messages);
        }
        break;
      }

      case 'sudo-approval': {
        const m = msg as SudoApprovalMsg;
        const resolve = this.pendingSudoRequests.get(m.requestId);
        if (resolve) {
          this.pendingSudoRequests.delete(m.requestId);
          resolve(m.decision);
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
            burnRate: m.burnRate,
            fills: m.fills,
            models: m.models ?? [],
            scoops: m.scoops ?? [],

            ...(m.budget ? { budget: m.budget } : {}),
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

  private handleAgentSpawnResult(msg: AgentSpawnResultMsg): void {
    const pending = this.pendingAgentSpawnRequests.get(msg.requestId);
    if (!pending) return;
    this.pendingAgentSpawnRequests.delete(msg.requestId);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error));
  }

  private terminalEventListeners = new Set<(event: TerminalEventMsg) => void>();

  onTerminalEvent(handler: (event: TerminalEventMsg) => void): () => void {
    this.terminalEventListeners.add(handler);
    return () => this.terminalEventListeners.delete(handler);
  }

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

  private trackToolPhase(scoopJid: string, delta: number | null): void {
    const before = this.toolDepth.get(scoopJid) ?? 0;
    const after = delta === null ? 0 : Math.max(0, before + delta);
    if (after === 0) this.toolDepth.delete(scoopJid);
    else this.toolDepth.set(scoopJid, after);

    if (before > 0 === after > 0) return;
    this.callbacks.onScoopPhaseChange?.(scoopJid, after > 0 ? 'tool' : 'thinking');
  }

  private handleToolUiAgentEvent(msg: AgentEventMsg): void {
    if (msg.displayScoopJid) {
      const routedId = `tool-ui-${msg.requestId ?? ''}`;
      if (msg.eventType === 'tool_ui') {
        this.emitToUI({
          type: 'tool_ui',
          messageId: routedId,
          toolName: msg.toolName ?? '',
          requestId: msg.requestId ?? '',
          html: msg.html ?? '',
        });
      } else if (msg.eventType === 'tool_ui_done') {
        this.emitToUI({
          type: 'tool_ui_done',
          messageId: routedId,
          requestId: msg.requestId ?? '',
        });
      }
      return;
    }
    if (msg.eventType === 'tool_ui') {
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
      return;
    }
    const msgId = this.currentMessageId.get(msg.scoopJid);
    if (!msgId) return;
    if (msg.eventType === 'tool_ui_done') {
      this.emitToUI({ type: 'tool_ui_done', messageId: msgId, requestId: msg.requestId ?? '' });
    } else if (msg.progress) {
      this.emitToUI({
        type: 'tool_progress',
        messageId: msgId,
        toolName: msg.toolName ?? '',
        progress: msg.progress,
        toolCallId: msg.toolCallId,
      });
    }
  }

  private handleAgentEvent(msg: AgentEventMsg): void {
    switch (msg.eventType) {
      case 'text_delta':
      case 'tool_start':
      case 'tool_ui':
      case 'turn_end':
        this.callbacks.onScoopActivity?.(msg.scoopJid);
        break;
    }

    switch (msg.eventType) {
      case 'tool_start':
        this.trackToolPhase(msg.scoopJid, 1);
        break;
      case 'tool_end':
        this.trackToolPhase(msg.scoopJid, -1);
        break;
      case 'turn_end':
        this.trackToolPhase(msg.scoopJid, null);
        break;
    }

    const displayJid = msg.displayScoopJid ?? msg.scoopJid;
    if (displayJid !== this.selectedScoopJid) return;

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
          toolCallId: msg.toolCallId,
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
            toolCallId: msg.toolCallId,
          });
        }
        break;
      }

      case 'tool_ui':
      case 'tool_ui_done':
      case 'tool_progress':
        this.handleToolUiAgentEvent(msg);
        break;

      case 'response_done': {
        const msgId = this.currentMessageId.get(msg.scoopJid);
        if (msgId) {
          this.emitToUI({
            type: 'content_done',
            messageId: msgId,
            model: msg.model,
            usage: msg.usage,
          });
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

  private renderCompactionNotice(
    scoopJid: string,
    state: CompactionState,
    detail: CompactionNoticeDetail,
    rowId?: string
  ): void {
    const action = this.compactionRows.apply(scoopJid, state, detail, rowId);
    if (!action) return;
    if (scoopJid !== this.selectedScoopJid) return;
    this.emitToUI({
      type: 'compaction_notice',
      messageId: action.messageId,

      marker:
        action.kind === 'retract' ? { trigger: detail.trigger, state: 'discarded' } : action.marker,
    });
  }

  private handleCompactionState(msg: CompactionStateMsg): void {
    const detail: CompactionNoticeDetail = {
      trigger: msg.trigger ?? 'threshold',
      ...(msg.transcriptPath ? { transcriptPath: msg.transcriptPath } : {}),
      ...(msg.roundId ? { roundId: msg.roundId } : {}),
    };
    this.callbacks.onCompactionStateChange?.(msg.scoopJid, msg.state, detail);

    this.renderCompactionNotice(msg.scoopJid, msg.state, detail, msg.rowId);
  }

  private handleScoopStatus(msg: ScoopStatusMsg): void {
    const previous = this.scoopStatuses.get(msg.scoopJid);
    this.scoopStatuses.set(msg.scoopJid, msg.status);

    if (previous !== msg.status) this.trackToolPhase(msg.scoopJid, null);
    this.callbacks.onStatusChange(msg.scoopJid, msg.status);
  }

  private handleScoopCreated(msg: ScoopCreatedMsg): void {
    const scoop = this.msgScoopToRegistered(msg.scoop);

    this.scoops = this.scoops.filter((s) => s.name !== scoop.name || s.jid === scoop.jid);
    if (!this.scoops.find((s) => s.jid === scoop.jid)) {
      this.scoops.push(scoop);
    }
    this.scoopStatuses.set(scoop.jid, msg.scoop.status);
    this.callbacks.onScoopCreated(scoop);
  }

  private wireScoops(): ScoopListMsg['scoops'] {
    return this.scoops.map((unit) => {
      const model = modelFor(unit);
      const thinking = thinkingFor(unit);
      const config: ScoopSnapshotConfig = {
        ...unit.config,
        ...(model ? { modelId: model.id, modelProviderId: model.provider } : {}),
        ...(thinking.level ? { thinkingLevel: thinking.level } : {}),
        ...(thinking.effortOverride ? { effortOverride: thinking.effortOverride } : {}),
      };
      return {
        jid: unit.jid,
        name: unit.name,
        folder: unit.folder,
        parentId: unit.parentJid,
        assistantLabel: unit.assistantLabel,
        status: this.scoopStatuses.get(unit.jid) ?? 'ready',
        ...(Object.keys(config).length > 0 ? { config } : {}),
      };
    });
  }

  private handleScoopModelAck(msg: SetScoopModelAckMsg): void {
    if (msg.applied) {
      const scoop = this.getScoop(msg.scoopJid);
      if (scoop) {
        scoop.model = msg.model ? { ...msg.model } : undefined;

        this.callbacks.onScoopListUpdate(this.wireScoops());
      }
    }
    this.pendingModelAcks.get(msg.requestId)?.(msg.applied);
  }

  private handleThinkingLevelAck(msg: SetThinkingLevelAckMsg): void {
    if (msg.applied) {
      const scoop = this.getScoop(msg.scoopJid);

      if (scoop) {
        setUnitThinking(
          scoop,
          msg.level === undefined
            ? undefined
            : { level: msg.level as ThinkingLevel, effortOverride: msg.effortOverride }
        );
      }
    }
    this.pendingThinkingAcks.get(msg.requestId)?.(msg.applied);
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
    return normalizeScoopRecord({
      jid: s.jid,
      name: s.name,
      folder: s.folder,

      parentJid: s.parentId,
      requiresTrigger: s.parentId !== null,
      assistantLabel: s.assistantLabel,
      addedAt: new Date().toISOString(),

      ...(s.config ? { config: { ...s.config } } : {}),
    });
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
