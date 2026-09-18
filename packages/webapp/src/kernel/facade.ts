import { matchLickTargetAlias } from '../base/lick-target-match.js';
import { createLogger } from '../base/logger.js';
import type { BrowserAPI } from '../cdp/index.js';
import type { AgentEvent } from '../core/agent-types.js';
import type { MessageAttachment } from '../core/attachments.js';
import { readoptFeatureFlagsFromCache } from '../core/feature-flags-cache.js';
import { getBudgetWindowSnapshot, refreshBudgetWindow } from '../providers/budget-usage-source.js';
import { AGENT_BRIDGE_GLOBAL_KEY, type AgentBridge } from '../scoops/agent-bridge.js';
import { SessionStore } from '../scoops/chat-session-store.js';
import type { ChatMessage } from '../scoops/chat-types.js';
import { type CompactionRowAction, CompactionRowTracker } from '../scoops/compaction-rows.js';
import { HIDDEN_TOOL_NAMES } from '../scoops/hidden-tools.js';
import { formatLickEventForCone } from '../scoops/lick-formatting.js';
import type { Orchestrator, OrchestratorCallbacks } from '../scoops/orchestrator.js';
import {
  capTranscriptToolInput,
  capTranscriptToolResultForBuffer,
  capTranscriptToolResultForEvent,
} from '../scoops/transcript-limits.js';
import type { FollowerSyncManager } from '../scoops/tray-follower-sync.js';
import type { ChannelMessage, RegisteredScoop, ScoopTabState } from '../scoops/types.js';
import { getSprinkleRoute } from '../shell/sprinkle-routes.js';
import { TOOL_UI_MOUNTED_ACTION, toolUIRegistry } from '../tools/tool-ui.js';
import type { ConversationMarker } from '../work-unit/conversation/types.js';
import { buildWorkUnitRecord } from '../work-unit/manager.js';
import { isRootUnit, rootOwnerOf, rootsOf } from '../work-unit/policy.js';
import {
  chatSessionIdFor,
  coneFolderFor,
  modelFor,
  PRIMARY_CONE_FOLDER,
  sourceLabelFor,
} from '../work-unit/record.js';
import { AgentEventStream } from './facade/agent-event-stream.js';
import { ScoopPresentation } from './facade/scoop-presentation.js';
import { buildTrayRuntimeSnapshot } from './facade/tray-runtime.js';
import type {
  AgentSpawnResultMsg,
  ErrorMsg,
  ExtensionMessage,
  ForwardedLickEvent,
  IncomingMessageMsg,
  LickBackpressureMsg,
  MessageUpdatedMsg,
  OffscreenToPanelMessage,
  PanelCdpResponseMsg,
  PanelToOffscreenMessage,
  ScoopCreatedMsg,
  ScoopListMsg,
  ScoopModelSelection,
  ScoopStatusMsg,
  SessionBudgetWindow,
  SetScoopModelMsg,
  SetThinkingLevelMsg,
  SprinkleLickOrigin,
  StateSnapshotMsg,
  ToolUIActionMsg,
  TrayRuntimeStatusMsg,
  WebhookEventMsg,
} from './messages.js';
import { createOffscreenChromeRuntimeTransport } from './transport-chrome-runtime.js';
import type { KernelFacade, KernelTransport } from './types.js';

const log = createLogger('kernel-bridge');

const FIRST_BUDGET_PROBE_MS = 2_500;

const MAX_PENDING_MARKERS = 4;

interface FacadeLickManager {
  setForwarder(forwarder: ((event: ForwardedLickEvent) => void) | null): void;
  emitEvent(event: ForwardedLickEvent): void;
  handleForwardedEvent(event: ForwardedLickEvent): void;
}

interface KernelFacadeGlobals {
  __slicc_agent?: AgentBridge;
  __slicc_lickManager?: FacadeLickManager;
}

function getKernelFacadeGlobals(): typeof globalThis & KernelFacadeGlobals {
  return globalThis as typeof globalThis & KernelFacadeGlobals;
}

function parseNavigateHandoffDip(body: unknown): { lickId: string; accepted: boolean } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as { action?: unknown; data?: unknown };
  if (b.action !== 'accept' && b.action !== 'dismiss') return null;
  const data = b.data as { lickId?: unknown } | null | undefined;
  const lickId = data && typeof data.lickId === 'string' ? data.lickId : null;
  if (!lickId) return null;
  return { lickId, accepted: b.action === 'accept' };
}

interface BufferedChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: MessageAttachment[];
  timestamp: number;
  source?: string;
  channel?: string;

  lickId?: string;

  lickState?: 'pending' | 'confirmed' | 'dismissed';
  toolCalls?: Array<{
    id: string;
    name: string;
    input: unknown;
    result?: string;
    isError?: boolean;
  }>;
  isStreaming?: boolean;
  model?: string;
  usage?: ChatMessage['usage'];

  compaction?: ChatMessage['compaction'];

  error?: boolean;
}

export class Bridge implements KernelFacade {
  private orchestrator: Orchestrator | null = null;

  private readonly agentSpawnAborts = new Map<string, AbortController>();
  private browserAPI: BrowserAPI | null = null;

  private messageBuffers = new Map<string, BufferedChatMessage[]>();

  private readonly conesBeingCreated = new Map<string, Promise<void>>();

  private currentMessageId = new Map<string, string>();

  private readonly compactionRows = new CompactionRowTracker(
    (scoopJid) => `compaction-${scoopJid}-${uid()}`
  );

  private readonly pendingMarkers = new Map<string, ConversationMarker[]>();

  private readonly scoopPresentation = new ScoopPresentation();

  private readonly agentEventStream = new AgentEventStream();

  private sessionStore: SessionStore | null = null;

  private followerSync: FollowerSyncManager | null = null;

  private followerActive = false;

  private _transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage> | null;

  private transportUnsubscribe: (() => void) | null = null;

  constructor(transport?: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>) {
    this._transport = transport ?? null;
  }

  private get transport(): KernelTransport<ExtensionMessage, OffscreenToPanelMessage> {
    if (!this._transport) {
      this._transport = createOffscreenChromeRuntimeTransport<OffscreenToPanelMessage>();
    }
    return this._transport;
  }

  async bind(orchestrator: Orchestrator, browserAPI?: BrowserAPI): Promise<void> {
    this.orchestrator = orchestrator;
    this.browserAPI = browserAPI ?? null;
    this.transportUnsubscribe?.();
    this.transportUnsubscribe = this.setupMessageListener();
    const store = new SessionStore();
    await store.init();
    this.sessionStore = store;
  }

  static createCallbacks(bridge: Bridge): Omit<OrchestratorCallbacks, 'getBrowserAPI'> {
    return {
      onResponse: (scoopJid, text, isPartial) => {
        const msg = bridge.getOrCreateAssistantMsg(scoopJid);
        if (isPartial) {
          msg.content += text;
        } else {
          msg.content = text;
          msg.isStreaming = false;
        }

        bridge.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'text_delta',
          text,
        });
      },

      onResponseDone: (scoopJid) => {
        const metadata = bridge.getLatestAssistantMetadata(scoopJid);
        const msgId = bridge.currentMessageId.get(scoopJid);
        if (msgId) {
          const buf = bridge.getBuffer(scoopJid);
          const msg = buf.find((m) => m.id === msgId);
          if (msg) {
            msg.isStreaming = false;
            if (metadata) Object.assign(msg, metadata);
          }
          bridge.currentMessageId.delete(scoopJid);
        }

        void bridge.flushPendingMarkers(scoopJid);

        bridge.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'response_done',
          ...(metadata ?? {}),
        });
      },

      onSendMessage: (targetJid, text) => {
        const buf = bridge.getBuffer(targetJid);
        const msgId = `msg-${uid()}`;
        buf.push({ id: msgId, role: 'assistant', content: text, timestamp: Date.now() });

        bridge.emit({
          type: 'agent-event',
          scoopJid: targetJid,
          eventType: 'text_delta',
          text,
        });
        bridge.emit({
          type: 'agent-event',
          scoopJid: targetJid,
          eventType: 'response_done',
        });
      },

      onStatusChange: (scoopJid, status) => {
        bridge.scoopPresentation.setStatus(scoopJid, status);

        if (status === 'ready') {
          bridge.currentMessageId.delete(scoopJid);
        }
        if (status === 'ready' || status === 'error') {
          void bridge.flushPendingMarkers(scoopJid);
        }

        bridge.emit({
          type: 'scoop-status',
          scoopJid,
          status,
        } satisfies ScoopStatusMsg);

        bridge.emitScoopList();
      },

      onCompactionStateChange: (scoopJid, state, detail) => {
        const action = bridge.compactionRows.apply(scoopJid, state, detail);
        bridge.emit({
          type: 'compaction-state',
          scoopJid,
          state,
          trigger: detail.trigger,
          ...(detail.transcriptPath ? { transcriptPath: detail.transcriptPath } : {}),
          ...(detail.failure ? { failure: detail.failure } : {}),
          ...(detail.roundId ? { roundId: detail.roundId } : {}),
          ...(action ? { rowId: action.messageId } : {}),
        });

        void bridge.recordCompactionRow(scoopJid, action);
      },

      onError: (scoopJid, error, options) => {
        void bridge.recordErrorCard(scoopJid, error);
        bridge.emit({
          type: 'error',
          scoopJid,
          error,
          ...(options?.endTurn === false ? { endTurn: false } : {}),
        } satisfies ErrorMsg);
      },

      onLickBackpressure: (scoopJid, info) => {
        bridge.emit({
          type: 'lick-backpressure',
          scoopJid,
          ...info,
        } satisfies LickBackpressureMsg);
      },

      onToolStart: (scoopJid, toolName, toolInput, toolCallId) => {
        if (HIDDEN_TOOL_NAMES.has(toolName)) return;
        bridge.bufferToolStart(scoopJid, toolName, toolInput, toolCallId);
      },

      onToolEnd: (scoopJid, toolName, result, isError, toolCallId) => {
        if (HIDDEN_TOOL_NAMES.has(toolName)) return;
        bridge.bufferToolEnd(scoopJid, toolName, result, isError, toolCallId);
      },

      onToolUI: (scoopJid, toolName, requestId, html, displayScoopJid) => {
        bridge.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'tool_ui',
          toolName,
          requestId,
          html,
          ...(displayScoopJid ? { displayScoopJid } : {}),
        });
      },

      onToolUIDone: (scoopJid, requestId, displayScoopJid) => {
        bridge.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'tool_ui_done',
          requestId,
          ...(displayScoopJid ? { displayScoopJid } : {}),
        });
      },

      onToolProgress: (scoopJid, toolName, progress, toolCallId) => {
        bridge.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'tool_progress',
          toolName,
          progress,
          toolCallId,
        });
      },

      onIncomingMessage: (scoopJid, message) => bridge.bufferIncomingMessage(scoopJid, message),

      onMessageUpdate: (scoopJid, update) => bridge.applyMessageUpdate(scoopJid, update),

      onScoopUnregistered: (scoop) => bridge.evictScoopState(scoop),
    };
  }

  private bufferToolStart(
    scoopJid: string,
    toolName: string,
    toolInput: unknown,
    toolCallId?: string
  ): void {
    const cappedInput = capTranscriptToolInput(toolInput);

    const msg = this.getOrCreateAssistantMsg(scoopJid);
    if (!msg.toolCalls) msg.toolCalls = [];

    msg.toolCalls.push({ id: toolCallId ?? uid(), name: toolName, input: cappedInput });

    this.emit({
      type: 'agent-event',
      scoopJid,
      eventType: 'tool_start',
      toolName,
      toolInput: cappedInput,
      toolCallId,
    });
  }

  private bufferToolEnd(
    scoopJid: string,
    toolName: string,
    result: string,
    isError: boolean,
    toolCallId?: string
  ): void {
    const msgId = this.currentMessageId.get(scoopJid);
    if (msgId) {
      const buf = this.getBuffer(scoopJid);
      const msg = buf.find((m) => m.id === msgId);
      if (msg?.toolCalls) {
        const tc = toolCallId
          ? msg.toolCalls.find((t) => t.id === toolCallId)
          : [...msg.toolCalls].reverse().find((t) => t.name === toolName && t.result === undefined);
        if (tc) {
          tc.result = capTranscriptToolResultForBuffer(result);
          tc.isError = isError;
        }
      }
    }

    this.emit({
      type: 'agent-event',
      scoopJid,
      eventType: 'tool_end',
      toolName,
      toolResult: capTranscriptToolResultForEvent(result),
      isError,
      toolCallId,
    });
  }

  private bufferIncomingMessage(scoopJid: string, message: ChannelMessage): void {
    const chatMsg: BufferedChatMessage = {
      id: message.id,
      role: 'user',
      content:
        message.channel === 'delegation'
          ? `**[Instructions from sliccy]**\n\n${message.content}`
          : message.content,
      attachments: message.attachments,
      timestamp: new Date(message.timestamp).getTime(),
      source: message.channel === 'delegation' ? 'delegation' : undefined,
      channel: message.channel,
      lickId: message.lickId,
      lickState: message.lickState,
    };
    this.getBuffer(scoopJid).push(chatMsg);
    this.notifyPanelIncomingMessage(scoopJid, message);
  }

  private evictScoopState(scoop: RegisteredScoop): void {
    this.messageBuffers.delete(scoop.jid);
    this.currentMessageId.delete(scoop.jid);
    this.agentEventStream.clear(scoop.jid);
    this.scoopPresentation.clearStatus(scoop.jid);

    if (scoop.parentJid !== null && this.sessionStore) {
      this.sessionStore.delete(chatSessionIdFor(scoop)).catch((err) => {
        console.warn(
          '[kernel-bridge] Failed to delete session for unregistered scoop:',
          scoop.folder,
          err
        );
      });
    }
    this.emitScoopList();
  }

  notifyPanelIncomingMessage(scoopJid: string, message: ChannelMessage): void {
    this.emit({
      type: 'incoming-message',
      scoopJid,
      message: {
        id: message.id,
        content: message.content,
        attachments: message.attachments,
        channel: message.channel,
        senderName: message.senderName,
        fromAssistant: message.fromAssistant,
        timestamp: message.timestamp,
        lickId: message.lickId,
        lickState: message.lickState,
      },
    } satisfies IncomingMessageMsg);
  }

  private applyMessageUpdate(
    scoopJid: string,
    update: { messageId: string; lickId?: string; lickState?: BufferedChatMessage['lickState'] }
  ): void {
    const buf = this.messageBuffers.get(scoopJid);
    const entry = buf?.find(
      (m) => (update.lickId && m.lickId === update.lickId) || m.id === update.messageId
    );
    if (entry) entry.lickState = update.lickState;
    this.emit({
      type: 'message-updated',
      scoopJid,
      messageId: update.messageId,
      lickId: update.lickId,
      lickState: update.lickState,
    } satisfies MessageUpdatedMsg);
  }

  private toScoopSnapshot(scoop: RegisteredScoop): ScoopListMsg['scoops'][number] {
    return this.scoopPresentation.projectScoop(scoop);
  }

  buildStateSnapshot(): StateSnapshotMsg {
    return this.scoopPresentation.buildStateSnapshot(
      this.orchestrator?.getScoops() ?? [],
      buildTrayRuntimeSnapshot()
    );
  }

  emitTrayRuntimeStatus(): void {
    const status = buildTrayRuntimeSnapshot();
    const msg: TrayRuntimeStatusMsg = { type: 'tray-runtime-status', ...status };
    this.emit(msg);
  }

  setFollowerSync(sync: FollowerSyncManager | null): void {
    this.followerSync = sync;
  }

  setFollowerActive(active: boolean): void {
    this.followerActive = active;
  }

  setActiveScoopJid(jid: string | null): void {
    this.scoopPresentation.setActiveScoopJid(jid);
  }

  getActiveScoopJid(): string | null {
    return this.scoopPresentation.getActiveScoopJid();
  }

  onAgentEvent(handler: (scoopJid: string, event: AgentEvent) => void): () => void {
    return this.agentEventStream.subscribe(handler);
  }

  getMessagesForJid(jid: string): ChatMessage[] {
    return this.getBuffer(jid) as unknown as ChatMessage[];
  }

  async routeSprinkleLick(
    sprinkleName: string,
    body: unknown,
    targetScoop?: string,
    origin?: SprinkleLickOrigin
  ): Promise<void> {
    if (!this.orchestrator) return;

    const handoff = parseNavigateHandoffDip(body);
    if (handoff) {
      void this.orchestrator.resolveNavigateHandoffByHuman(handoff.lickId, handoff.accepted);
    }
    const scoops = this.orchestrator.getScoops();

    const configuredRoute = getSprinkleRoute(sprinkleName);
    const targetCandidates: Array<{
      source: 'explicit target' | 'configured route';
      value: string;
    }> = [];
    if (targetScoop) targetCandidates.push({ source: 'explicit target', value: targetScoop });
    if (configuredRoute && configuredRoute !== targetScoop) {
      targetCandidates.push({ source: 'configured route', value: configuredRoute });
    }
    const unresolvedTargets: typeof targetCandidates = [];
    let target: RegisteredScoop | undefined;
    for (const candidate of targetCandidates) {
      target = matchLickTargetAlias(scoops, candidate.value);
      if (target) break;
      unresolvedTargets.push(candidate);
    }
    if (!target) {
      target = this.originRootOf(scoops, origin?.unitJid) ?? rootsOf(scoops)[0];
    }
    if (unresolvedTargets.length > 0) {
      log.warn('Sprinkle lick target could not be resolved; using fallback', {
        sprinkleName,
        unresolvedTargets,
        fallbackJid: target?.jid,
      });
    }
    if (!target) return;
    const msgId = `sprinkle-${sprinkleName}-${Date.now()}`;
    const formatted = formatLickEventForCone({
      type: 'sprinkle',
      sprinkleName,
      timestamp: new Date().toISOString(),
      body,
      originLabel: origin?.label,
    } as Parameters<typeof formatLickEventForCone>[0]);
    const baseContent =
      formatted?.content ??
      `[Sprinkle Event: ${sprinkleName}]\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``;
    const unresolvedTargetSummary = unresolvedTargets
      .map(({ source, value }) => `${source} ${JSON.stringify(value)}`)
      .join(' and ');
    const deliveryNote = unresolvedTargetSummary
      ? `\n\n> Delivery note: ${unresolvedTargetSummary} could not be resolved; delivered to fallback ${JSON.stringify(target.folder)}.`
      : '';
    const content = baseContent + deliveryNote;
    const channelMsg: ChannelMessage = {
      id: msgId,
      chatJid: target.jid,
      senderId: 'sprinkle',
      senderName: `sprinkle:${sprinkleName}`,
      content,
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'sprinkle',
    };
    this.getBuffer(target.jid).push({
      id: msgId,
      role: 'user',
      content,
      timestamp: Date.now(),
      source: 'lick',
      channel: 'sprinkle',
    });
    await this.orchestrator.handleMessage(channelMsg);
  }

  private originRootOf(
    scoops: readonly RegisteredScoop[],
    jid: string | undefined
  ): RegisteredScoop | undefined {
    if (!jid) return undefined;
    return rootOwnerOf(
      scoops,
      scoops.find((scoop) => scoop.jid === jid)
    );
  }

  applyFollowerSnapshot(messages: ChatMessage[]): void {
    if (!this.orchestrator) return;
    const cone = rootsOf(this.orchestrator.getScoops())[0];
    if (!cone) return;

    const buf = toBufferedChatMessages(messages).map((row, i) => ({
      ...row,
      isStreaming: messages[i]?.isStreaming,
    }));
    this.messageBuffers.set(cone.jid, buf);
    this.currentMessageId.delete(cone.jid);
    this.agentEventStream.clear(cone.jid);
    this.emit({
      type: 'scoop-messages-replaced',
      scoopJid: cone.jid,
      messages: buf,
    });
  }

  getConeJid(): string | null {
    return this.orchestrator ? (rootsOf(this.orchestrator.getScoops())[0]?.jid ?? null) : null;
  }

  emitFollowerAgentEvent(event: import('../core/agent-types.js').AgentEvent): void {
    const scoopJid = this.getConeJid();
    if (!scoopJid) return;
    switch (event.type) {
      case 'content_delta':
        this.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'text_delta',
          text: event.text,
        });
        break;
      case 'content_done':
        this.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'response_done',
          model: event.model,
          usage: event.usage,
        });
        break;
      case 'tool_use_start':
        this.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'tool_start',
          toolName: event.toolName,
          toolInput: event.toolInput,
        });
        break;
      case 'tool_result':
        this.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'tool_end',
          toolName: event.toolName,
          toolResult: event.result,
          isError: event.isError,
        });
        break;
      case 'turn_end':
        this.emit({ type: 'agent-event', scoopJid, eventType: 'turn_end' });
        break;
      case 'error':
        this.emit({ type: 'error', scoopJid, error: event.error });
        break;
    }
  }

  emitFollowerIncomingMessage(messageId: string, text: string): void {
    const scoopJid = this.getConeJid();
    if (!scoopJid) return;
    this.emit({
      type: 'incoming-message',
      scoopJid,
      message: {
        id: messageId,
        content: text,
        channel: 'web',
        senderName: 'User',
        fromAssistant: false,
        timestamp: new Date().toISOString(),
      },
    });
  }

  emitFollowerStatus(scoopStatus: string): void {
    const scoopJid = this.getConeJid();
    if (!scoopJid) return;
    const status: ScoopTabState['status'] = scoopStatus === 'processing' ? 'processing' : 'ready';
    this.scoopPresentation.setStatus(scoopJid, status);
    this.emit({ type: 'scoop-status', scoopJid, status });
  }

  private async buildBufferFromCanonicalRecord(
    scoop: RegisteredScoop
  ): Promise<BufferedChatMessage[] | null> {
    const store = this.orchestrator?.getConversationStore?.();
    if (!store) return null;
    const { conversationKeyFor } = await import('../work-unit/conversation/key.js');
    const record = await store.load(conversationKeyFor(scoop));
    if (!record) return null;
    const { toChatMessages } = await import('../work-unit/conversation/derive.js');
    const chatMessages = await toChatMessages(record, { source: sourceLabelFor(scoop) });
    if (chatMessages.length === 0) return null;
    return this.overlayPersistedLickDecisionsOn(scoop, toBufferedChatMessages(chatMessages));
  }

  private async overlayPersistedLickDecisionsOn(
    scoop: RegisteredScoop,
    buf: BufferedChatMessage[]
  ): Promise<BufferedChatMessage[]> {
    if (!buf.some((m) => m.channel === 'sudo-request' || m.lickId || m.lickState)) return buf;
    const stored: PersistedLickDecision[] = [];
    try {
      const channel = await this.orchestrator?.getMessagesForScoop?.(scoop.jid);
      if (channel) {
        for (const m of channel) {
          stored.push({
            id: m.id,
            content: m.content,
            channel: m.channel,
            lickId: m.lickId,
            lickState: m.lickState,
          });
        }
      }
    } catch {}
    return overlayPersistedLickDecisions(buf, stored);
  }

  async hydrateBuffersFromRecords(): Promise<void> {
    if (!this.orchestrator) return;
    for (const scoop of this.orchestrator.getScoops()) {
      const existing = this.messageBuffers.get(scoop.jid);
      if (existing && existing.length > 0) continue;
      const buf = await this.buildBufferFromCanonicalRecord(scoop);
      if (!buf) continue;
      this.messageBuffers.set(scoop.jid, buf);
      this.currentMessageId.delete(scoop.jid);
      this.agentEventStream.clear(scoop.jid);
    }
  }

  private queuedIdsFor(scoopJid: string): string[] | undefined {
    if (this.followerSync || !this.orchestrator) return undefined;
    return this.orchestrator.getQueuedMessageIds(scoopJid);
  }

  private async handleRequestScoopMessages(scoopJid: string): Promise<void> {
    await this.conesBeingCreated.get(scoopJid);
    if (!this.orchestrator) return;
    const scoop = this.orchestrator.getScoops().find((s) => s.jid === scoopJid);
    if (!scoop) return;

    const buffered = this.messageBuffers.get(scoopJid);
    if (buffered && buffered.length > 0) {
      this.emit({
        type: 'scoop-messages-replaced',
        scoopJid,
        messages: buffered,
        queuedIds: this.queuedIdsFor(scoopJid),
      });
      return;
    }

    const derived = await this.buildBufferFromCanonicalRecord(scoop);
    if (derived) {
      this.messageBuffers.set(scoopJid, derived);
      this.currentMessageId.delete(scoopJid);
      this.agentEventStream.clear(scoopJid);
      this.emit({
        type: 'scoop-messages-replaced',
        scoopJid,
        messages: derived,
        queuedIds: this.queuedIdsFor(scoopJid),
      });
      return;
    }

    this.emit({
      type: 'scoop-messages-replaced',
      scoopJid,
      messages: [],
      queuedIds: this.queuedIdsFor(scoopJid),
    });
  }

  private async handleConeCreate(
    name: string,
    description?: string,
    prompt?: string,
    model?: ScoopModelSelection
  ): Promise<void> {
    if (!this.orchestrator) return;
    const existing = this.orchestrator.getScoops();
    const folder = coneFolderFor(name, existing);
    const primary = folder === PRIMARY_CONE_FOLDER;

    const defaultRoot = rootsOf(existing)[0];
    const inheritedModel = model ?? (defaultRoot ? modelFor(defaultRoot) : undefined);

    const purpose = description?.trim();
    const scoop: RegisteredScoop = {
      ...buildWorkUnitRecord({ parentId: null, name, folder }),
      assistantLabel: primary ? 'sliccy' : name,

      ...(purpose ? { config: { systemPromptAppend: `This cone is for: ${purpose}` } } : {}),

      ...(inheritedModel ? { model: inheritedModel } : {}),
    };

    let openReplayGate: () => void = () => {};
    this.conesBeingCreated.set(
      scoop.jid,
      new Promise<void>((resolve) => {
        openReplayGate = resolve;
      })
    );
    const releaseReplayGate = (): void => {
      this.conesBeingCreated.delete(scoop.jid);
      openReplayGate();
    };
    try {
      await this.orchestrator.registerScoop(scoop);
      this.emit({
        type: 'scoop-created',
        scoop: this.toScoopSnapshot(scoop),
      } satisfies ScoopCreatedMsg);

      const first = prompt?.trim();
      if (!first) return;
      const delivered = this.handleUserMessage({
        type: 'user-message',
        scoopJid: scoop.jid,
        text: first,
        messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });

      releaseReplayGate();
      await delivered;
    } finally {
      releaseReplayGate();
    }
  }

  private async handleRequestSudoApproval(
    requestId: string,
    request: import('../sudo/types.js').SudoRequest
  ): Promise<void> {
    let decision: import('../sudo/types.js').SudoDecision = { decision: 'deny' };

    const directive = request.approver;
    if (directive && directive.kind !== 'user') {
      const orchestrator = this.orchestrator;
      if (!orchestrator) {
        console.warn('[kernel-bridge] directed approval before orchestrator init — denying');
      } else {
        try {
          decision = await orchestrator.enqueueDirectedApproval(directive, request);
        } catch (err) {
          console.warn('[kernel-bridge] directed approval threw — denying', err);
        }
      }
      this.emit({ type: 'sudo-approval', requestId, decision });
      return;
    }
    const manager = this.orchestrator?.getSudoManager() ?? null;
    if (!manager) {
      console.warn('[kernel-bridge] request-sudo-approval before SudoManager init — denying');
    } else {
      try {
        decision = await manager.approve(request);
      } catch (err) {
        console.warn('[kernel-bridge] sudo approval threw — denying', err);
      }
    }
    this.emit({ type: 'sudo-approval', requestId, decision });
  }

  private async handleRequestSessionStats(requestId: string): Promise<void> {
    let totalCost = 0;
    let burnRate = 0;
    let fills: Array<{ jid: string; fill: number }> = [];
    let models: Array<{ model: string; cost: number; turns: number; tokens: number }> = [];
    let scoops: Array<{
      name: string;
      model: string;
      cost: number;
      type: 'cone' | 'scoop';
      source: 'live' | 'dropped' | 'frozen';
    }> = [];
    try {
      const sessionCosts = this.orchestrator?.getSessionCosts() ?? [];
      const allSessionCosts = this.orchestrator?.getSessionCosts({ includeDropped: true }) ?? [];
      totalCost = allSessionCosts.reduce((sum, scoop) => sum + scoop.usage.cost.total, 0);
      burnRate = this.orchestrator?.getBurnRate() ?? 0;
      fills = this.orchestrator?.getContextFills() ?? [];
      models = (this.orchestrator?.getModelCosts() ?? []).map((m) => ({
        model: m.model,
        cost: m.cost,
        turns: m.turns,
        tokens: m.input + m.output + m.cacheRead + m.cacheWrite,
      }));
      scoops = sessionCosts.map((s) => ({
        name: s.name,
        model: s.model,
        cost: s.usage.cost.total,
        type: s.type,
        source: s.source,
      }));
    } catch {}
    const budget = await this.resolveBudgetWindow();
    this.emit({
      type: 'session-stats',
      requestId,
      totalCost,
      burnRate,
      fills,
      models,
      scoops,
      ...(budget ? { budget } : {}),
    });
  }

  private budgetProbePending = true;

  private async resolveBudgetWindow(): Promise<SessionBudgetWindow | undefined> {
    if (this.budgetProbePending) {
      this.budgetProbePending = false;
      const first = await Promise.race([
        refreshBudgetWindow().catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), FIRST_BUDGET_PROBE_MS)),
      ]);
      return first ?? undefined;
    }
    void refreshBudgetWindow().catch(() => null);
    return getBudgetWindowSnapshot() ?? undefined;
  }

  private async handleRequestScoopTranscript(requestId: string, scoopJid: string): Promise<void> {
    const empty = (): void => {
      this.emit({ type: 'scoop-transcript', requestId, scoopJid, transcript: '' });
    };
    if (!this.orchestrator) {
      empty();
      return;
    }
    const scoop = this.orchestrator.getScoops().find((s) => s.jid === scoopJid);
    if (!scoop) {
      empty();
      return;
    }

    const buffered = this.messageBuffers.get(scoopJid);
    if (buffered && buffered.length > 0) {
      this.emit({
        type: 'scoop-transcript',
        requestId,
        scoopJid,
        transcript: formatTranscript(buffered),
      });
      return;
    }

    const context = this.orchestrator.getScoopContext(scoopJid);
    if (context) {
      const { agentMessagesToChatMessages } = await import('../scoops/agent-message-to-chat.js');
      const agentMessages = context.getAgentMessages();
      if (agentMessages.length > 0) {
        const chatMessages = agentMessagesToChatMessages(agentMessages, {
          source: sourceLabelFor(scoop),
        });
        this.emit({
          type: 'scoop-transcript',
          requestId,
          scoopJid,
          transcript: formatTranscript(chatMessages),
        });
        return;
      }
    }

    empty();
  }

  private async handleRequestScoopChatMessages(requestId: string, scoopJid: string): Promise<void> {
    const empty = (): void => {
      this.emit({ type: 'scoop-chat-messages', requestId, scoopJid, messages: [] });
    };
    if (!this.orchestrator) {
      empty();
      return;
    }
    const scoop = this.orchestrator.getScoops().find((s) => s.jid === scoopJid);
    if (!scoop) {
      empty();
      return;
    }

    const buffered = this.messageBuffers.get(scoopJid);
    if (buffered && buffered.length > 0) {
      this.emit({ type: 'scoop-chat-messages', requestId, scoopJid, messages: buffered });
      return;
    }

    const derived = await this.buildBufferFromCanonicalRecord(scoop);
    if (derived) {
      this.emit({ type: 'scoop-chat-messages', requestId, scoopJid, messages: derived });
      return;
    }

    empty();
  }

  private async recordCompactionRow(
    scoopJid: string,
    action: CompactionRowAction | null
  ): Promise<void> {
    if (!action || action.kind === 'open') return;
    const scoop = this.orchestrator?.getScoops().find((s) => s.jid === scoopJid);
    if (!scoop) return;
    const buf = this.getBuffer(scoopJid);
    if (action.kind === 'retract') {
      const at = buf.findIndex((m) => m.id === action.messageId);
      if (at >= 0) buf.splice(at, 1);
    } else {
      const existing = buf.find((m) => m.id === action.messageId);
      if (existing) existing.compaction = action.marker;
      else {
        buf.push({
          id: action.messageId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          compaction: action.marker,
        });
      }
    }
    const store = this.orchestrator?.getConversationStore?.();
    if (!store) return;
    const { conversationKeyFor } = await import('../work-unit/conversation/key.js');
    const key = conversationKeyFor(scoop);
    if (action.kind === 'retract') {
      this.dropPendingMarker(scoopJid, action.messageId);
      await store.deleteMarker(key, action.messageId);
      return;
    }
    const marker: ConversationMarker = {
      id: action.messageId,
      kind: 'compaction',

      timestamp: Date.now(),
      compaction: action.marker,
    };
    if (!(await store.putMarker(key, marker))) this.holdPendingMarker(scoopJid, marker);
  }

  private holdPendingMarker(scoopJid: string, marker: ConversationMarker): void {
    const held = this.pendingMarkers.get(scoopJid) ?? [];
    this.pendingMarkers.set(
      scoopJid,
      [...held.filter((m) => m.id !== marker.id), marker].slice(-MAX_PENDING_MARKERS)
    );
  }

  private dropPendingMarker(scoopJid: string, markerId: string): void {
    const held = this.pendingMarkers.get(scoopJid);
    if (!held) return;
    const kept = held.filter((m) => m.id !== markerId);
    if (kept.length === 0) this.pendingMarkers.delete(scoopJid);
    else this.pendingMarkers.set(scoopJid, kept);
  }

  private async flushPendingMarkers(scoopJid: string): Promise<void> {
    const held = this.pendingMarkers.get(scoopJid);
    if (!held || held.length === 0) return;
    const store = this.orchestrator?.getConversationStore?.();
    const scoop = this.orchestrator?.getScoops().find((s) => s.jid === scoopJid);
    if (!store || !scoop) return;
    const { conversationIdentityFor, conversationKeyFor } = await import(
      '../work-unit/conversation/key.js'
    );
    const key = conversationKeyFor(scoop);
    for (const marker of held) {
      let written = false;
      try {
        written = await store.putMarker(
          key,
          marker,
          marker.kind === 'error' ? { createWith: conversationIdentityFor(scoop) } : undefined
        );
      } catch (err) {
        log.warn('Conversation marker retry threw', {
          scoopJid,
          folder: scoop.folder,
          markerId: marker.id,
          kind: marker.kind,
          errorName: err instanceof Error ? err.name : 'unknown',
        });
      }
      if (written) {
        this.dropPendingMarker(scoopJid, marker.id);
      } else {
        log.warn('Conversation marker retry deferred', {
          scoopJid,
          folder: scoop.folder,
          markerId: marker.id,
          kind: marker.kind,
        });
      }
    }
  }

  private async recordErrorCard(scoopJid: string, error: string): Promise<void> {
    const id = uid();
    const timestamp = Date.now();
    this.getBuffer(scoopJid).push({
      id,
      role: 'assistant',
      content: error,
      timestamp,
      error: true,
    });
    const marker: ConversationMarker = { id, kind: 'error', timestamp, text: error };

    this.holdPendingMarker(scoopJid, marker);
    const store = this.orchestrator?.getConversationStore?.();
    const scoop = this.orchestrator?.getScoops().find((s) => s.jid === scoopJid);
    if (!store || !scoop) {
      log.warn('Error marker is waiting for a canonical target', {
        scoopJid,
        markerId: marker.id,
        hasStore: Boolean(store),
        hasScoop: Boolean(scoop),
      });
      return;
    }
    const { conversationIdentityFor } = await import('../work-unit/conversation/key.js');
    const identity = conversationIdentityFor(scoop);
    let written = false;
    try {
      written = await store.putMarker(identity.key, marker, { createWith: identity });
    } catch (err) {
      log.warn('Error marker write threw; queued for retry', {
        scoopJid,
        folder: scoop.folder,
        markerId: marker.id,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
    }
    if (written) {
      this.dropPendingMarker(scoopJid, marker.id);
    } else {
      log.warn('Error marker write deferred', {
        scoopJid,
        folder: scoop.folder,
        markerId: marker.id,
      });
    }
  }

  getBuffer(jid: string): BufferedChatMessage[] {
    let buf = this.messageBuffers.get(jid);
    if (!buf) {
      buf = [];
      this.messageBuffers.set(jid, buf);
    }
    return buf;
  }

  getOrCreateAssistantMsg(jid: string): BufferedChatMessage {
    const buf = this.getBuffer(jid);
    let msgId = this.currentMessageId.get(jid);
    if (msgId) {
      const existing = buf.find((m) => m.id === msgId);
      if (existing) return existing;
    }
    msgId = `scoop-${jid}-${uid()}`;
    this.currentMessageId.set(jid, msgId);

    const scoops = this.orchestrator?.getScoops() ?? [];
    const scoop = scoops.find((s) => s.jid === jid);
    const source = scoop ? sourceLabelFor(scoop) : 'unknown';

    const msg: BufferedChatMessage = {
      id: msgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      isStreaming: true,
      source,
    };
    buf.push(msg);
    return msg;
  }

  getLatestAssistantMetadata(jid: string): Pick<ChatMessage, 'model' | 'usage'> | null {
    const messages = this.orchestrator?.getScoopContext?.(jid)?.getAgentMessages() ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== 'assistant') continue;
      const metadata: Pick<ChatMessage, 'model' | 'usage'> = { model: message.model };
      const { usage } = message;
      if (usage) {
        metadata.usage = {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          cost: {
            input: usage.cost.input,
            output: usage.cost.output,
            cacheRead: usage.cost.cacheRead,
            cacheWrite: usage.cost.cacheWrite,
            total: usage.cost.total,
          },
        };
      }
      return metadata;
    }
    return null;
  }

  private setupMessageListener(): () => void {
    return this.transport.onMessage((msg) => {
      if (msg.source !== 'panel') return;

      this.handlePanelMessage(msg.payload as PanelToOffscreenMessage).catch((err) => {
        console.error('[kernel-bridge] handlePanelMessage error:', err);

        const scoopJid = (msg.payload as { scoopJid?: string }).scoopJid;
        if (scoopJid) {
          this.emit({
            type: 'error',
            scoopJid,
            error: err instanceof Error ? err.message : String(err),
          } satisfies ErrorMsg);
        }
      });
    });
  }

  private async handlePanelMessage(msg: PanelToOffscreenMessage): Promise<void> {
    if (!this.orchestrator) return;

    switch (msg.type) {
      case 'user-message': {
        await this.handleUserMessage(msg);
        break;
      }

      case 'cone-create':
        await this.handleConeCreate(msg.name, msg.description, msg.prompt, msg.model);
        break;

      case 'scoop-feed': {
        await this.orchestrator.delegateToScoop(msg.scoopJid, msg.prompt, 'sliccy');
        break;
      }

      case 'scoop-drop': {
        await this.handleScoopDrop(msg.scoopJid);
        break;
      }

      case 'abort': {
        this.orchestrator.stopScoop(msg.scoopJid);
        this.orchestrator.clearQueuedMessages(msg.scoopJid).catch((err) => {
          console.warn('[kernel-bridge] Failed to clear queued messages on abort:', err);
        });
        break;
      }

      case 'delete-queued-message': {
        this.handleDeleteQueuedMessage(msg.scoopJid, msg.messageId);
        break;
      }

      case 'request-state': {
        this.emit(this.buildStateSnapshot());
        break;
      }

      case 'request-scoop-messages': {
        await this.handleRequestScoopMessages(msg.scoopJid);
        break;
      }

      case 'request-scoop-transcript': {
        await this.handleRequestScoopTranscript(msg.requestId, msg.scoopJid);
        break;
      }

      case 'request-scoop-chat-messages':
        await this.handleRequestScoopChatMessages(msg.requestId, msg.scoopJid);
        break;

      case 'request-session-stats':
        void this.handleRequestSessionStats(msg.requestId);
        break;

      case 'request-sudo-approval':
        void this.handleRequestSudoApproval(msg.requestId, msg.request);
        break;

      case 'clear-chat': {
        await this.handleClearChat(msg.requestId, msg.scoopJid, msg.discardLiveSnapshot === true);
        break;
      }

      case 'agent-spawn-request': {
        await this.handleAgentSpawn(msg);
        break;
      }

      case 'agent-spawn-abort': {
        this.agentSpawnAborts.get(msg.requestId)?.abort();
        break;
      }

      case 'clear-filesystem':
        await this.orchestrator
          .resetFilesystem()
          .catch((err) => console.error('[kernel-bridge] clear-filesystem failed:', err));
        break;

      case 'set-model':
      case 'refresh-model':
        this.orchestrator.refreshModels();
        break;

      case 'set-scoop-model':
        await this.handleSetScoopModel(msg);
        break;

      case 'set-thinking-level': {
        await this.handleSetThinkingLevel(msg);
        break;
      }

      case 'sprinkle-lick': {
        await this.handleSprinkleLickMsg(msg);
        break;
      }

      case 'lick-webhook-event': {
        this.handleWebhookEventMsg(msg);
        break;
      }

      case 'set-follower-forwarding': {
        this.handleSetFollowerForwarding(msg.enabled);
        break;
      }

      case 'inject-forwarded-lick': {
        this.handleInjectForwardedLick(msg.event);
        break;
      }

      case 'lick-cherry-host-event': {
        this.orchestrator.handleCherryHostEvent(msg.cherryRuntimeId, msg.name, msg.detail);
        break;
      }

      case 'lick-preview': {
        this.orchestrator.handlePreviewLick(msg.event);
        break;
      }

      case 'reload-skills': {
        this.orchestrator.reloadAllSkills().catch((err) => {
          console.warn('[kernel-bridge] Skill reload failed:', err);
        });
        break;
      }

      case 'panel-cdp-command': {
        await this.handlePanelCdpCommand(msg);
        break;
      }

      case 'tool-ui-action': {
        await this.handleToolUIAction(msg as ToolUIActionMsg);
        break;
      }

      case 'local-storage-set': {
        this.applyLocalStorageOp(msg.type, (s) => s.setItem(msg.key, msg.value));
        readoptFeatureFlagsFromCache(msg.key);
        break;
      }

      case 'local-storage-remove': {
        this.applyLocalStorageOp(msg.type, (s) => s.removeItem(msg.key));
        readoptFeatureFlagsFromCache(msg.key);
        break;
      }

      case 'local-storage-clear': {
        this.applyLocalStorageOp(msg.type, (s) => s.clear());

        readoptFeatureFlagsFromCache();
        break;
      }
    }
  }

  private handleWebhookEventMsg(msg: WebhookEventMsg): void {
    const disposition = this.orchestrator?.handleWebhookEvent(msg.webhookId, msg.headers, msg.body);
    if (!msg.requestId) return;
    this.emit({
      type: 'lick-webhook-delivery',
      requestId: msg.requestId,

      disposition: disposition ?? 'unknown-webhook',
    });
  }

  private async handleAgentSpawn(
    msg: Extract<PanelToOffscreenMessage, { type: 'agent-spawn-request' }>
  ): Promise<void> {
    const agentBridge = getKernelFacadeGlobals()[AGENT_BRIDGE_GLOBAL_KEY];
    if (!agentBridge || typeof agentBridge.spawn !== 'function') {
      this.emit({
        type: 'agent-spawn-result',
        requestId: msg.requestId,
        ok: false,
        error: 'AgentBridge unavailable',
      } satisfies AgentSpawnResultMsg);
      return;
    }

    const controller = new AbortController();
    this.agentSpawnAborts.set(msg.requestId, controller);
    try {
      const result = await agentBridge.spawn({ ...msg.options, signal: controller.signal });
      this.emit({ type: 'agent-spawn-result', requestId: msg.requestId, ok: true, result });
    } catch (err) {
      this.emit({
        type: 'agent-spawn-result',
        requestId: msg.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies AgentSpawnResultMsg);
    } finally {
      this.agentSpawnAborts.delete(msg.requestId);
    }
  }

  private async handleSetScoopModel(msg: SetScoopModelMsg): Promise<void> {
    if (!this.orchestrator) return;
    let applied = false;
    try {
      applied = await this.orchestrator.setScoopModel(msg.scoopJid, msg.model);
    } catch (err) {
      console.error('[kernel-bridge] set-scoop-model failed:', err);
    }
    if (!msg.requestId) return;
    this.emit({
      type: 'set-scoop-model-ack',
      requestId: msg.requestId,
      scoopJid: msg.scoopJid,
      model: msg.model,
      applied,
    });
  }

  private async handleSetThinkingLevel(msg: SetThinkingLevelMsg): Promise<void> {
    if (!this.orchestrator) return;
    let applied = false;
    try {
      applied =
        (await this.orchestrator.setScoopThinkingLevel(
          msg.scoopJid,
          msg.level,
          msg.effortOverride
        )) !== null;
    } catch (err) {
      console.error('[kernel-bridge] set-thinking-level failed:', err);
    }
    if (!msg.requestId) return;
    this.emit({
      type: 'set-thinking-level-ack',
      requestId: msg.requestId,
      scoopJid: msg.scoopJid,
      level: msg.level,
      effortOverride: msg.effortOverride,
      applied,
    });
  }

  private handleDeleteQueuedMessage(scoopJid: string, messageId: string): void {
    if (!this.orchestrator) return;
    this.orchestrator.deleteQueuedMessage(scoopJid, messageId).catch((err) => {
      console.warn('[kernel-bridge] Failed to delete queued message:', err);
    });
    const buf = this.messageBuffers.get(scoopJid);
    if (!buf) return;
    const next = buf.filter((m) => m.id !== messageId);
    if (next.length === buf.length) return;
    this.messageBuffers.set(scoopJid, next);
  }

  private async handleUserMessage(
    msg: Extract<PanelToOffscreenMessage, { type: 'user-message' }>
  ): Promise<void> {
    this.getBuffer(msg.scoopJid).push({
      id: msg.messageId,
      role: 'user',
      content: msg.text,
      attachments: msg.attachments,
      timestamp: Date.now(),
    });
    if (this.followerSync) {
      if (msg.steer) {
        this.followerSync.sendMessage(msg.text, msg.messageId, msg.attachments, { steer: true });
      } else {
        this.followerSync.sendMessage(msg.text, msg.messageId, msg.attachments);
      }
      return;
    }
    const channelMsg: ChannelMessage = {
      id: msg.messageId,
      chatJid: msg.scoopJid,
      senderId: 'user',
      senderName: 'User',
      content: msg.text,
      attachments: msg.attachments,
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'web',
      ...(msg.guestGate ? { guestGate: msg.guestGate } : {}),
      ...(msg.steer ? { steer: true as const } : {}),
    };
    await this.orchestrator?.handleMessage(channelMsg);
    await this.orchestrator?.createScoopTab(msg.scoopJid);
  }

  private async handleScoopDrop(scoopJid: string): Promise<void> {
    if (!this.orchestrator) return;
    const scoops = this.orchestrator.getScoops();
    const droppedScoop = scoops.find((s) => s.jid === scoopJid);
    if (droppedScoop && isRootUnit(droppedScoop)) {
      if (rootsOf(scoops).length <= 1) {
        console.warn('[kernel-bridge] Refusing to drop the last cone:', scoopJid);
        this.emitScoopList();
        return;
      }
      const subtree = this.descendantsOf(scoops, scoopJid);
      await this.orchestrator.getWorkUnits().close(scoopJid);

      const remaining = new Set(this.orchestrator.getScoops().map((s) => s.jid));
      for (const scoop of [...subtree, droppedScoop]) {
        if (!remaining.has(scoop.jid)) this.forgetDroppedScoop(scoop);
      }
    } else {
      await this.orchestrator.unregisterScoop(scoopJid);
      this.forgetDroppedScoop(droppedScoop ?? { jid: scoopJid });
    }
    this.emitScoopList();
  }

  private descendantsOf(scoops: readonly RegisteredScoop[], jid: string): RegisteredScoop[] {
    const out: RegisteredScoop[] = [];
    for (const child of scoops) {
      if (child.parentJid !== jid) continue;
      out.push(...this.descendantsOf(scoops, child.jid), child);
    }
    return out;
  }

  private forgetDroppedScoop(scoop: Pick<RegisteredScoop, 'jid'> & Partial<RegisteredScoop>): void {
    this.messageBuffers.delete(scoop.jid);
    this.currentMessageId.delete(scoop.jid);
    this.agentEventStream.clear(scoop.jid);
    this.scoopPresentation.clearStatus(scoop.jid);
    if (scoop.folder && this.sessionStore) {
      const sessionId = chatSessionIdFor({ folder: scoop.folder });
      this.sessionStore.delete(sessionId).catch((err) => {
        console.warn('[kernel-bridge] Failed to delete session on scoop drop:', sessionId, err);
      });
    }
  }

  private async handleClearChat(
    requestId: string,
    scoopJid?: string,
    discardLiveSnapshot = false
  ): Promise<void> {
    const scoops = this.orchestrator?.getScoops() ?? [];
    const target =
      (scoopJid ? scoops.find((scoop) => scoop.jid === scoopJid) : undefined) ?? rootsOf(scoops)[0];
    const coneJid = target?.jid;
    if (coneJid) {
      if (discardLiveSnapshot) {
        await this.orchestrator?.clearScoopMessages(coneJid, { discardLiveSnapshot: true });
      } else {
        await this.orchestrator?.clearScoopMessages(coneJid);
      }
    }
    if (this.sessionStore) {
      await this.sessionStore.delete(
        chatSessionIdFor({ folder: target?.folder ?? PRIMARY_CONE_FOLDER })
      );
    }
    if (coneJid) {
      this.messageBuffers.delete(coneJid);
      this.currentMessageId.delete(coneJid);
      this.agentEventStream.clear(coneJid);
    }
    this.emit({ type: 'clear-chat-ack', requestId });
  }

  private async handleSprinkleLickMsg(lickMsg: {
    sprinkleName: string;
    body: unknown;
    targetScoop?: string;
    origin?: SprinkleLickOrigin;
  }): Promise<void> {
    if (this.followerActive) {
      if (this.followerSync) {
        this.followerSync.sendSprinkleLick(lickMsg.sprinkleName, lickMsg.body, lickMsg.targetScoop);
      } else {
        console.warn('[kernel-bridge] sprinkle-lick dropped: follower sync mid-reconnect', {
          sprinkleName: lickMsg.sprinkleName,
        });
      }
      return;
    }
    await this.routeSprinkleLick(
      lickMsg.sprinkleName,
      lickMsg.body,
      lickMsg.targetScoop,
      lickMsg.origin
    );
  }

  private handleSetFollowerForwarding(enabled: boolean): void {
    const lm = getKernelFacadeGlobals().__slicc_lickManager;
    if (!lm) {
      console.warn(
        '[kernel-bridge] set-follower-forwarding ignored: worker LickManager unavailable'
      );
      return;
    }
    if (enabled) {
      lm.setForwarder((event) => this.emit({ type: 'forward-lick', event }));
    } else {
      lm.setForwarder(null);
    }
  }

  private handleInjectForwardedLick(event: ForwardedLickEvent): void {
    const lm = getKernelFacadeGlobals().__slicc_lickManager;
    if (!lm) {
      console.warn(
        '[kernel-bridge] inject-forwarded-lick dropped: worker LickManager unavailable',
        { type: event.type }
      );
      return;
    }
    lm.handleForwardedEvent(event);
  }

  private async handlePanelCdpCommand(
    msg: Extract<PanelToOffscreenMessage, { type: 'panel-cdp-command' }>
  ): Promise<void> {
    const { id, method, params, sessionId } = msg;
    if (!this.browserAPI) {
      console.warn('[kernel-bridge] Panel CDP command received but BrowserAPI is null');
      this.emit({
        type: 'panel-cdp-response',
        id,
        error: 'BrowserAPI not available',
      } satisfies PanelCdpResponseMsg);
      return;
    }
    try {
      const result = await this.browserAPI.getTransport().send(method, params, sessionId);
      this.emit({ type: 'panel-cdp-response', id, result } satisfies PanelCdpResponseMsg);
    } catch (err) {
      this.emit({
        type: 'panel-cdp-response',
        id,
        error: err instanceof Error ? err.message : String(err),
      } satisfies PanelCdpResponseMsg);
    }
  }

  private async handleToolUIAction(msg: ToolUIActionMsg): Promise<void> {
    const { requestId, action, data } = msg;

    if (action === TOOL_UI_MOUNTED_ACTION) {
      toolUIRegistry.markMounted(requestId);
      return;
    }
    try {
      await toolUIRegistry.handleAction(requestId, { action, data });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[kernel-bridge] Tool UI action failed', {
        requestId,
        action,
        error: errMsg,
      });
      toolUIRegistry.cancel(requestId, `Action failed: ${errMsg}`);
    }
  }

  private applyLocalStorageOp(label: string, op: (storage: Storage) => void): void {
    try {
      const storage = (globalThis as { localStorage?: Storage }).localStorage;
      if (storage) op(storage);
    } catch (err) {
      console.warn(`[kernel-bridge] ${label} failed:`, err);
    }
  }

  emitScoopList(): void {
    const scoops = this.scoopPresentation.projectScoops(this.orchestrator?.getScoops() ?? []);
    this.emit({ type: 'scoop-list', scoops } satisfies ScoopListMsg);
  }

  private emit(payload: OffscreenToPanelMessage): void {
    this.transport.send(payload);

    if (payload.type === 'agent-event') {
      this.agentEventStream.publish(payload);
    }
  }
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatTranscript(messages: ReadonlyArray<{ role: string; content: string }>): string {
  const lines: string[] = [];
  for (const m of messages) {
    const text = (m.content ?? '').trim();
    if (text.length === 0) continue;
    lines.push(`${m.role}: ${text}`);
  }
  return lines.join('\n');
}

function toBufferedChatMessages(chatMessages: readonly ChatMessage[]): BufferedChatMessage[] {
  return chatMessages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    attachments: m.attachments,
    timestamp: m.timestamp,
    source: m.source,
    channel: m.channel,
    lickId: m.lickId,
    lickState: m.lickState,
    toolCalls: m.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
      result: tc.result,
      isError: tc.isError,
    })),
    model: m.model,
    usage: m.usage,
    isStreaming: false,
    compaction: m.compaction,
    error: m.error,
  }));
}

interface PersistedLickDecision {
  id: string;
  content: string;
  channel?: string;
  lickId?: string;
  lickState?: BufferedChatMessage['lickState'];
}

function isSettledLickState(
  state: BufferedChatMessage['lickState']
): state is 'confirmed' | 'dismissed' {
  return state === 'confirmed' || state === 'dismissed';
}

function isActionableLickRow(m: PersistedLickDecision): boolean {
  return (
    m.channel === 'sudo-request' || !!m.lickId || !!m.lickState || m.id.startsWith('sudo-request-')
  );
}

function lickIdOf(m: PersistedLickDecision): string | undefined {
  if (m.lickId) return m.lickId;
  if (!isActionableLickRow(m)) return undefined;
  const fromBody = /^(?:Lick ID|Request ID): (\S+)/m.exec(m.content)?.[1];
  if (fromBody) return fromBody;
  return m.id.startsWith('sudo-request-') ? m.id.slice('sudo-request-'.length) : undefined;
}

function rememberLickDecision(
  map: Map<string, PersistedLickDecision>,
  key: string,
  msg: PersistedLickDecision
): void {
  const existing = map.get(key);
  if (!existing || (isSettledLickState(msg.lickState) && !isSettledLickState(existing.lickState))) {
    map.set(key, msg);
  }
}

function overlayPersistedLickDecisions(
  rebuilt: BufferedChatMessage[],
  stored: readonly PersistedLickDecision[] | undefined
): BufferedChatMessage[] {
  if (!stored || stored.length === 0) return rebuilt;
  const byLickId = new Map<string, PersistedLickDecision>();
  const byId = new Map<string, PersistedLickDecision>();
  const byContent = new Map<string, PersistedLickDecision>();
  for (const m of stored) {
    if (!isActionableLickRow(m)) continue;
    const lickId = lickIdOf(m);
    if (lickId) rememberLickDecision(byLickId, lickId, m);
    rememberLickDecision(byId, m.id, m);
    rememberLickDecision(byContent, m.content, m);
  }
  return rebuilt.map((row) => {
    if (!isActionableLickRow(row)) return row;
    const rowLickId = lickIdOf(row);
    const prior =
      (rowLickId ? byLickId.get(rowLickId) : undefined) ??
      byId.get(row.id) ??
      byContent.get(row.content);
    if (!prior || (!prior.lickId && !prior.lickState)) return row;
    const lickId = prior.lickId ?? rowLickId ?? lickIdOf(prior);
    const lickState = isSettledLickState(prior.lickState)
      ? prior.lickState
      : (row.lickState ?? prior.lickState);
    if (lickId === row.lickId && lickState === row.lickState && prior.id === row.id) return row;
    return { ...row, id: prior.id, lickId, lickState };
  });
}
