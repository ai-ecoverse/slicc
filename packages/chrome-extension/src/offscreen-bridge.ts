/**
 * Offscreen Bridge — connects the Orchestrator to the chrome.runtime messaging layer.
 *
 * Translates:
 * - Incoming panel messages → Orchestrator API calls
 * - Orchestrator callbacks → outgoing messages to panels
 *
 * Also maintains an event buffer for state sync on panel reconnect.
 */

import type {
  Orchestrator,
  OrchestratorCallbacks,
} from '../../../packages/webapp/src/scoops/orchestrator.js';
import type {
  RegisteredScoop,
  ChannelMessage,
  ScoopTabState,
} from '../../../packages/webapp/src/scoops/types.js';
import type {
  ExtensionMessage,
  PanelToOffscreenMessage,
  PanelCdpResponseMsg,
  ScoopStatusMsg,
  ScoopListMsg,
  ScoopSnapshotConfig,
  SetThinkingLevelMsg,
  StateSnapshotMsg,
  ErrorMsg,
  ScoopCreatedMsg,
  IncomingMessageMsg,
  TrayFollowerStatusSnapshot,
  TrayLeaderStatusSnapshot,
  TrayRuntimeStatusMsg,
  OffscreenToPanelMessage,
} from './messages.js';
import { getLeaderTrayRuntimeStatus } from '../../../packages/webapp/src/scoops/tray-leader.js';
import { getFollowerTrayRuntimeStatus } from '../../../packages/webapp/src/scoops/tray-follower-status.js';
import { SessionStore } from '../../../packages/webapp/src/ui/session-store.js';
import { toolUIRegistry } from '../../../packages/webapp/src/tools/tool-ui.js';
import type { ChatMessage } from '../../../packages/webapp/src/ui/types.js';
import type { MessageAttachment } from '../../../packages/webapp/src/core/attachments.js';
import type { BrowserAPI } from '../../../packages/webapp/src/cdp/index.js';
import type { FollowerSyncManager } from '../../../packages/webapp/src/scoops/tray-follower-sync.js';
import type {
  KernelFacade,
  KernelTransport,
  FollowerAgentEvent,
} from '../../../packages/webapp/src/kernel/types.js';
import { createOffscreenChromeRuntimeTransport } from '../../../packages/webapp/src/kernel/transport-chrome-runtime.js';

/** Buffered message for state sync */
interface BufferedChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: MessageAttachment[];
  timestamp: number;
  source?: string;
  channel?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: unknown;
    result?: string;
    isError?: boolean;
  }>;
  isStreaming?: boolean;
}

export class OffscreenBridge implements KernelFacade {
  private orchestrator: Orchestrator | null = null;
  private browserAPI: BrowserAPI | null = null;
  /** Per-scoop message buffers (mirrors main.ts pattern) */
  private messageBuffers = new Map<string, BufferedChatMessage[]>();
  /** Current assistant message ID per scoop */
  private currentMessageId = new Map<string, string>();
  /** Status per scoop */
  private scoopStatuses = new Map<string, ScoopTabState['status']>();
  /** Shared UI session store — writes to browser-coding-agent IndexedDB */
  private sessionStore: SessionStore | null = null;
  /**
   * When set, the offscreen is acting as a tray follower: user messages
   * from the panel are forwarded to the leader over WebRTC instead of
   * being handed to the local orchestrator, and snapshots/agent events
   * coming back from the leader are bridged into the panel via the same
   * messages the local orchestrator would emit.
   */
  private followerSync: FollowerSyncManager | null = null;
  /**
   * KernelTransport — defaults to the chrome.runtime adapter (lazily
   * constructed on first `emit()` so a `new OffscreenBridge()` doesn't
   * throw when imported in a context without `chrome.runtime`, e.g. a
   * standalone DedicatedWorker). A `MessageChannel`-backed transport
   * can be passed into the constructor so the same `OffscreenBridge`
   * runs worker-side. The transport delivers raw `ExtensionMessage`
   * envelopes either way so the existing source filter and
   * sprinkle-op-response peek (in `setupMessageListener`) stay intact.
   */
  private _transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage> | null;
  /**
   * Unsubscribe handle from `transport.onMessage`. Invoked on rebind so
   * a second `bind()` doesn't double-register the listener.
   */
  private transportUnsubscribe: (() => void) | null = null;

  /**
   * Optional transport injection. If omitted (today's extension
   * path), the bridge lazily constructs the chrome.runtime adapter
   * on first emit/bind. If provided (standalone kernel-worker path),
   * the bridge uses the supplied transport and never touches
   * chrome.runtime.
   */
  constructor(transport?: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>) {
    this._transport = transport ?? null;
  }

  private get transport(): KernelTransport<ExtensionMessage, OffscreenToPanelMessage> {
    if (!this._transport) {
      this._transport = createOffscreenChromeRuntimeTransport<OffscreenToPanelMessage>();
    }
    return this._transport;
  }

  /**
   * Bind the orchestrator and start listening for panel messages.
   * Called after the Orchestrator is constructed with callbacks from createCallbacks().
   */
  async bind(orchestrator: Orchestrator, browserAPI?: BrowserAPI): Promise<void> {
    this.orchestrator = orchestrator;
    this.browserAPI = browserAPI ?? null;
    this.transportUnsubscribe?.();
    this.transportUnsubscribe = this.setupMessageListener();
    const store = new SessionStore();
    await store.init();
    this.sessionStore = store;
  }

  /**
   * Build OrchestratorCallbacks that emit chrome.runtime messages.
   * The bridge instance captures references via closure — the orchestrator
   * doesn't need to exist yet (callbacks are invoked later, after bind()).
   */
  static createCallbacks(bridge: OffscreenBridge): Omit<OrchestratorCallbacks, 'getBrowserAPI'> {
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
        const msgId = bridge.currentMessageId.get(scoopJid);
        if (msgId) {
          const buf = bridge.getBuffer(scoopJid);
          const msg = buf.find((m) => m.id === msgId);
          if (msg) msg.isStreaming = false;
          bridge.currentMessageId.delete(scoopJid);
        }

        bridge.persistScoop(scoopJid);

        bridge.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'response_done',
        });
      },

      onSendMessage: (targetJid, text) => {
        const buf = bridge.getBuffer(targetJid);
        const msgId = `msg-${uid()}`;
        buf.push({ id: msgId, role: 'assistant', content: text, timestamp: Date.now() });
        bridge.persistScoop(targetJid);

        // Emit agent events so the panel renders the message in real-time
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
        bridge.scoopStatuses.set(scoopJid, status);

        if (status === 'ready') {
          bridge.currentMessageId.delete(scoopJid);
        }

        bridge.emit({
          type: 'scoop-status',
          scoopJid,
          status,
        } satisfies ScoopStatusMsg);

        // Also emit the full scoop list so the panel can update its switcher.
        // This catches agent-created scoops (via scoop_scoop tool) that bypass
        // the panel's cone-create → scoop-created flow.
        bridge.emitScoopList();
      },

      onError: (scoopJid, error) => {
        bridge.emit({
          type: 'error',
          scoopJid,
          error,
        } satisfies ErrorMsg);
      },

      onToolStart: (scoopJid, toolName, toolInput) => {
        const hiddenTools = new Set(['send_message', 'list_scoops', 'list_tasks']);
        if (hiddenTools.has(toolName)) return;

        const msg = bridge.getOrCreateAssistantMsg(scoopJid);
        if (!msg.toolCalls) msg.toolCalls = [];
        msg.toolCalls.push({ id: uid(), name: toolName, input: toolInput });

        bridge.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'tool_start',
          toolName,
          toolInput,
        });
      },

      onToolEnd: (scoopJid, toolName, result, isError) => {
        const hiddenTools = new Set(['send_message', 'list_scoops', 'list_tasks']);
        if (hiddenTools.has(toolName)) return;

        const msgId = bridge.currentMessageId.get(scoopJid);
        if (msgId) {
          const buf = bridge.getBuffer(scoopJid);
          const msg = buf.find((m) => m.id === msgId);
          if (msg?.toolCalls) {
            const tc = [...msg.toolCalls]
              .reverse()
              .find((t) => t.name === toolName && t.result === undefined);
            if (tc) {
              tc.result = result;
              tc.isError = isError;
            }
          }
        }

        bridge.persistScoop(scoopJid);

        bridge.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'tool_end',
          toolName,
          toolResult: result,
          isError,
        });
      },

      onToolUI: (scoopJid, toolName, requestId, html) => {
        bridge.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'tool_ui',
          toolName,
          requestId,
          html,
        });
      },

      onToolUIDone: (scoopJid, requestId) => {
        bridge.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'tool_ui_done',
          requestId,
        });
      },

      onIncomingMessage: (scoopJid, message) => {
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
        };
        bridge.getBuffer(scoopJid).push(chatMsg);
        bridge.persistScoop(scoopJid);

        bridge.emit({
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
          },
        } satisfies IncomingMessageMsg);
      },
    };
  }

  /**
   * Project an orchestrator `RegisteredScoop` down to the snapshot shape
   * the panel sees. Carries `config.modelId` / `config.thinkingLevel`
   * (the only config bits the panel reads — see `ScoopSnapshotConfig`)
   * so the brain icon and model pill rehydrate correctly across
   * reconnects and scoop switches.
   */
  private toScoopSnapshot(s: RegisteredScoop): ScoopListMsg['scoops'][number] {
    const config: ScoopSnapshotConfig | undefined =
      s.config && (s.config.modelId !== undefined || s.config.thinkingLevel !== undefined)
        ? {
            ...(s.config.modelId !== undefined ? { modelId: s.config.modelId } : {}),
            ...(s.config.thinkingLevel !== undefined
              ? { thinkingLevel: s.config.thinkingLevel }
              : {}),
          }
        : undefined;
    return {
      jid: s.jid,
      name: s.name,
      folder: s.folder,
      isCone: s.isCone,
      assistantLabel: s.assistantLabel,
      status: (this.scoopStatuses.get(s.jid) ?? 'ready') as ScoopTabState['status'],
      ...(config ? { config } : {}),
    };
  }

  /** Build a full state snapshot for panel reconnect. */
  buildStateSnapshot(): StateSnapshotMsg {
    const scoops = this.orchestrator?.getScoops().map((s) => this.toScoopSnapshot(s)) ?? [];

    const cone = scoops.find((s) => s.isCone);

    return {
      type: 'state-snapshot',
      scoops,
      activeScoopJid: cone?.jid ?? null,
      trayRuntimeStatus: this.buildTrayRuntimeStatus(),
    };
  }

  /**
   * Read the offscreen-side tray status singletons and emit them to the
   * panel. Called whenever the underlying status changes (subscribed in
   * offscreen.ts) so the panel's avatar popover can render the same
   * "Enable multi-browser sync" surface that standalone has.
   */
  emitTrayRuntimeStatus(): void {
    const status = this.buildTrayRuntimeStatus();
    const msg: TrayRuntimeStatusMsg = {
      type: 'tray-runtime-status',
      leader: status.leader,
      follower: status.follower,
    };
    this.emit(msg);
  }

  private buildTrayRuntimeStatus(): {
    leader: TrayLeaderStatusSnapshot;
    follower: TrayFollowerStatusSnapshot;
  } {
    const leader = getLeaderTrayRuntimeStatus();
    const follower = getFollowerTrayRuntimeStatus();
    return {
      leader: {
        state: leader.state,
        // Carry the whole session so the panel singleton matches
        // offscreen field-for-field. `getLeaderTrayRuntimeStatus()`
        // already returns a defensive copy.
        session: leader.session,
        error: leader.error ?? null,
        reconnectAttempts: leader.reconnectAttempts ?? 0,
      },
      follower: {
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
      },
    };
  }

  /**
   * Switch to / out of follower mode. When `sync` is set, panel-issued
   * user messages are forwarded to the leader instead of the local
   * orchestrator. Pass `null` to detach.
   */
  setFollowerSync(sync: FollowerSyncManager | null): void {
    this.followerSync = sync;
  }

  /**
   * Replace the local cone scoop's chat history with `messages` (typically
   * from a leader snapshot), persist them to IndexedDB so panel reloads
   * see them, and notify the panel to update its open chat.
   */
  applyFollowerSnapshot(messages: ChatMessage[]): void {
    if (!this.orchestrator) return;
    const cone = this.orchestrator.getScoops().find((s) => s.isCone);
    if (!cone) return;
    const buf = messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      attachments: m.attachments,
      timestamp: m.timestamp,
      source: m.source,
      channel: m.channel,
      toolCalls: m.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
        result: tc.result,
        isError: tc.isError,
      })),
      isStreaming: m.isStreaming,
    }));
    this.messageBuffers.set(cone.jid, buf);
    this.currentMessageId.delete(cone.jid);
    if (this.sessionStore) {
      const sessionId = cone.isCone ? 'session-cone' : `session-${cone.folder}`;
      this.sessionStore.saveMessages(sessionId, messages).catch((err) => {
        console.warn('[offscreen-bridge] applyFollowerSnapshot persist failed:', err);
      });
    }
    this.emit({
      type: 'scoop-messages-replaced',
      scoopJid: cone.jid,
      messages: buf,
    });
  }

  /** Resolve the local cone scoop's jid (panel-known), if any. */
  getConeJid(): string | null {
    return this.orchestrator?.getScoops().find((s) => s.isCone)?.jid ?? null;
  }

  /** Bridge follower-side AgentEvents into panel-bound agent-event messages. */
  emitFollowerAgentEvent(
    event: import('../../../packages/webapp/src/ui/types.js').AgentEvent
  ): void {
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
        this.emit({ type: 'agent-event', scoopJid, eventType: 'response_done' });
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

  /** Emit an incoming-message for the cone (used by follower mode for echoes). */
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

  /** Bridge a follower status string to a scoop-status emission for the cone. */
  emitFollowerStatus(scoopStatus: string): void {
    const scoopJid = this.getConeJid();
    if (!scoopJid) return;
    const status: ScoopTabState['status'] = scoopStatus === 'processing' ? 'processing' : 'ready';
    this.scoopStatuses.set(scoopJid, status);
    this.emit({ type: 'scoop-status', scoopJid, status });
  }

  /**
   * Rebuild the panel's chat history for a scoop from the live agent
   * state. Replies via `scoop-messages-replaced`. Used after a panel
   * remount (HMR or full reload) to override the panel's own
   * `browser-coding-agent` IDB snapshot, which may have been
   * truncated by save races during the remount.
   *
   * Resolution order:
   *   1. In-flight `messageBuffers` (current session, possibly with
   *      a streaming tail).
   *   2. Translate the scoop's `AgentMessage[]` into the chat shape.
   *   3. Fall back to whatever the UI `sessionStore` has on disk.
   */
  private async handleRequestScoopMessages(scoopJid: string): Promise<void> {
    if (!this.orchestrator) return;
    const scoop = this.orchestrator.getScoops().find((s) => s.jid === scoopJid);
    if (!scoop) return;

    const buffered = this.messageBuffers.get(scoopJid);
    if (buffered && buffered.length > 0) {
      this.emit({
        type: 'scoop-messages-replaced',
        scoopJid,
        messages: buffered,
      });
      return;
    }

    // Translate from the agent's canonical conversation. Lazy-import the
    // translator so it doesn't pull pi-ai types into the bridge's hot
    // path until needed.
    const context = this.orchestrator.getScoopContext(scoopJid);
    if (context) {
      const { agentMessagesToChatMessages } =
        await import('../../../packages/webapp/src/scoops/agent-message-to-chat.js');
      const agentMessages = context.getAgentMessages();
      if (agentMessages.length > 0) {
        const chatMessages = agentMessagesToChatMessages(agentMessages, {
          source: scoop.isCone ? 'cone' : (scoop.name ?? scoop.folder),
        });
        // Hydrate the buffer so subsequent agent events extend the
        // restored history instead of starting from empty (which
        // would silently overwrite the UI store via persistScoop).
        const buf: BufferedChatMessage[] = chatMessages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          attachments: m.attachments,
          timestamp: m.timestamp,
          source: m.source,
          channel: m.channel,
          toolCalls: m.toolCalls?.map((tc) => ({
            id: tc.id,
            name: tc.name,
            input: tc.input,
            result: tc.result,
            isError: tc.isError,
          })),
          isStreaming: false,
        }));
        this.messageBuffers.set(scoopJid, buf);
        this.emit({
          type: 'scoop-messages-replaced',
          scoopJid,
          messages: buf,
        });
        return;
      }
    }

    // Last resort: load from the UI session store.
    if (this.sessionStore) {
      const sessionId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
      try {
        const session = await this.sessionStore.load(sessionId);
        const messages = session?.messages ?? [];
        if (messages.length > 0) {
          this.emit({
            type: 'scoop-messages-replaced',
            scoopJid,
            messages: messages as unknown as BufferedChatMessage[],
          });
        }
      } catch (err) {
        console.warn('[offscreen-bridge] sessionStore load failed:', sessionId, err);
      }
    }
  }

  /**
   * Persist a scoop's message buffer to the shared UI session store.
   * Fire-and-forget — errors are swallowed to avoid blocking agent processing.
   */
  private persistScoop(jid: string): void {
    if (!this.sessionStore || !this.orchestrator) return;
    const scoop = this.orchestrator.getScoops().find((s) => s.jid === jid);
    if (!scoop) return;
    const sessionId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
    const buf = this.messageBuffers.get(jid);
    if (!buf || buf.length === 0) return;
    // BufferedChatMessage is structurally compatible with ChatMessage
    this.sessionStore.saveMessages(sessionId, buf as unknown as ChatMessage[]).catch((err) => {
      console.warn('[offscreen-bridge] persistScoop failed:', sessionId, err);
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers (accessed by createCallbacks via closure)
  // -------------------------------------------------------------------------

  /** @internal */ getBuffer(jid: string): BufferedChatMessage[] {
    let buf = this.messageBuffers.get(jid);
    if (!buf) {
      buf = [];
      this.messageBuffers.set(jid, buf);
    }
    return buf;
  }

  /** @internal */ getOrCreateAssistantMsg(jid: string): BufferedChatMessage {
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
    const source = scoop?.isCone ? 'cone' : (scoop?.name ?? 'unknown');

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

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private setupMessageListener(): () => void {
    return this.transport.onMessage((msg) => {
      // Only handle messages from the panel (relayed by service worker)
      if (msg.source !== 'panel') return;

      // Route sprinkle-op-response to the proxy's pending request map.
      // The sprinkle-op-response shape isn't part of `PanelToOffscreenMessage`
      // (it's a panel→offscreen reply to a sprinkle-op the offscreen sent),
      // so we reach for the proxy's typed handler via `unknown`.
      if ((msg.payload as { type?: string })?.type === 'sprinkle-op-response') {
        import('./sprinkle-proxy.js').then(({ handleSprinkleOpResponse }) => {
          handleSprinkleOpResponse(
            msg.payload as unknown as Parameters<typeof handleSprinkleOpResponse>[0]
          );
        });
        return;
      }

      this.handlePanelMessage(msg.payload as PanelToOffscreenMessage).catch((err) => {
        console.error('[offscreen-bridge] handlePanelMessage error:', err);
        // Surface error to the panel so the user sees something instead of a silent hang
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
        // In follower mode, route the message to the leader over WebRTC
        // and let the leader's echo populate our buffer; the local
        // orchestrator must stay out of the way.
        if (this.followerSync) {
          this.getBuffer(msg.scoopJid).push({
            id: msg.messageId,
            role: 'user',
            content: msg.text,
            attachments: msg.attachments,
            timestamp: Date.now(),
          });
          this.persistScoop(msg.scoopJid);
          this.followerSync.sendMessage(msg.text, msg.messageId, msg.attachments);
          break;
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
        };
        this.getBuffer(msg.scoopJid).push({
          id: msg.messageId,
          role: 'user',
          content: msg.text,
          attachments: msg.attachments,
          timestamp: Date.now(),
        });
        this.persistScoop(msg.scoopJid);
        await this.orchestrator.handleMessage(channelMsg);
        this.orchestrator.createScoopTab(msg.scoopJid);
        break;
      }

      case 'cone-create': {
        // This path is cone-only. Non-cone scoops are created inside the
        // offscreen orchestrator by the agent's `scoop_scoop` tool, which is
        // where their path-config defaults (visiblePaths / writablePaths) get
        // injected. Building a non-cone scoop here would bypass that layer
        // and yield a sandbox with no writable paths; see #436.
        const scoop: RegisteredScoop = {
          jid: `cone_${Date.now()}`,
          name: msg.name,
          folder: 'cone',
          isCone: true,
          type: 'cone',
          requiresTrigger: false,
          assistantLabel: 'sliccy',
          addedAt: new Date().toISOString(),
        };
        await this.orchestrator.registerScoop(scoop);
        this.emit({
          type: 'scoop-created',
          scoop: this.toScoopSnapshot(scoop),
        } satisfies ScoopCreatedMsg);
        break;
      }

      case 'scoop-feed': {
        await this.orchestrator.delegateToScoop(msg.scoopJid, msg.prompt, 'sliccy');
        break;
      }

      case 'scoop-drop': {
        const droppedScoop = this.orchestrator.getScoops().find((s) => s.jid === msg.scoopJid);
        await this.orchestrator.unregisterScoop(msg.scoopJid);
        this.messageBuffers.delete(msg.scoopJid);
        this.currentMessageId.delete(msg.scoopJid);
        this.scoopStatuses.delete(msg.scoopJid);
        if (droppedScoop && this.sessionStore) {
          const sessionId = droppedScoop.isCone ? 'session-cone' : `session-${droppedScoop.folder}`;
          this.sessionStore.delete(sessionId).catch((err) => {
            console.warn(
              '[offscreen-bridge] Failed to delete session on scoop drop:',
              sessionId,
              err
            );
          });
        }
        this.emitScoopList();
        break;
      }

      case 'abort': {
        this.orchestrator.stopScoop(msg.scoopJid);
        this.orchestrator.clearQueuedMessages(msg.scoopJid).catch((err) => {
          console.warn('[offscreen-bridge] Failed to clear queued messages on abort:', err);
        });
        break;
      }

      case 'set-model': {
        // Side panel already wrote to localStorage (shared origin).
        // Just tell all running ScoopContexts to re-read the model.
        this.orchestrator.updateModel();
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

      case 'clear-chat': {
        await this.orchestrator.clearAllMessages();
        // Clear session store for all known scoops — must await so deletions
        // complete before the panel reloads and re-reads from IndexedDB
        if (this.sessionStore) {
          const scoops = this.orchestrator.getScoops();
          await Promise.all(
            scoops.map((scoop) => {
              const sessionId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
              return this.sessionStore!.delete(sessionId);
            })
          );
        }
        this.messageBuffers.clear();
        this.currentMessageId.clear();
        break;
      }

      case 'clear-filesystem': {
        try {
          await this.orchestrator.resetFilesystem();
        } catch (err) {
          console.error('[offscreen-bridge] clear-filesystem failed:', err);
        }
        break;
      }

      case 'refresh-model': {
        // Side panel already wrote to localStorage (shared origin).
        // Just tell all running ScoopContexts to re-read the model.
        this.orchestrator.updateModel();
        break;
      }

      case 'set-thinking-level': {
        // `msg` is already narrowed to `SetThinkingLevelMsg` by the union
        // tag — the explicit annotation makes that obvious to readers and
        // ensures the orchestrator call site receives a typed
        // `ThinkingLevel | undefined` (the message field's literal union
        // is the same shape the orchestrator expects).
        const tlMsg: SetThinkingLevelMsg = msg;
        try {
          await this.orchestrator.setScoopThinkingLevel(tlMsg.scoopJid, tlMsg.level);
        } catch (err) {
          console.error('[offscreen-bridge] set-thinking-level failed:', err);
        }
        break;
      }

      case 'sprinkle-lick': {
        // Sprinkle lick event from the side panel — route to targetScoop or fall back to cone
        const scoops = this.orchestrator.getScoops();
        const lickMsg = msg as any;
        let target = lickMsg.targetScoop
          ? scoops.find(
              (s) =>
                s.name === lickMsg.targetScoop ||
                s.folder === lickMsg.targetScoop ||
                s.folder === `${lickMsg.targetScoop}-scoop`
            )
          : undefined;
        if (!target) {
          target = scoops.find((s) => s.isCone);
        }
        if (target) {
          const msgId = `sprinkle-${lickMsg.sprinkleName}-${Date.now()}`;
          const content = `[Sprinkle Event: ${lickMsg.sprinkleName}]\n\`\`\`json\n${JSON.stringify(lickMsg.body, null, 2)}\n\`\`\``;
          const channelMsg: ChannelMessage = {
            id: msgId,
            chatJid: target.jid,
            senderId: 'sprinkle',
            senderName: `sprinkle:${lickMsg.sprinkleName}`,
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
          } as any);
          this.persistScoop(target.jid);
          await this.orchestrator.handleMessage(channelMsg);
        }
        break;
      }

      case 'reload-skills': {
        this.orchestrator.reloadAllSkills().catch((err) => {
          console.warn('[offscreen-bridge] Skill reload failed:', err);
        });
        break;
      }

      case 'panel-cdp-command': {
        const { id, method, params, sessionId } = msg;
        if (!this.browserAPI) {
          console.warn('[offscreen-bridge] Panel CDP command received but BrowserAPI is null');
          this.emit({
            type: 'panel-cdp-response',
            id,
            error: 'BrowserAPI not available',
          } satisfies PanelCdpResponseMsg);
          break;
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
        break;
      }

      case 'tool-ui-action': {
        const { requestId, action, data } = msg as import('./messages.js').ToolUIActionMsg;
        try {
          await toolUIRegistry.handleAction(requestId, { action, data });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error('[offscreen-bridge] Tool UI action failed', {
            requestId,
            action,
            error: errMsg,
          });
          toolUIRegistry.cancel(requestId, `Action failed: ${errMsg}`);
        }
        break;
      }

      // Live localStorage sync from the page to the worker. In
      // standalone-worker mode, the page intercepts its own
      // localStorage writes (and listens for storage events from other
      // tabs) and forwards them through the kernel transport. The
      // worker's `localStorage` is a Map-backed shim installed during
      // boot — direct setItem/removeItem here mutates that shim. In
      // extension mode the panel and offscreen share the extension
      // origin's localStorage, so the panel never sends these
      // messages; the case branches stay no-ops on that path.
      case 'local-storage-set': {
        try {
          (globalThis as { localStorage?: Storage }).localStorage?.setItem(msg.key, msg.value);
        } catch (err) {
          console.warn('[offscreen-bridge] local-storage-set failed:', err);
        }
        break;
      }

      case 'local-storage-remove': {
        try {
          (globalThis as { localStorage?: Storage }).localStorage?.removeItem(msg.key);
        } catch (err) {
          console.warn('[offscreen-bridge] local-storage-remove failed:', err);
        }
        break;
      }

      case 'local-storage-clear': {
        try {
          (globalThis as { localStorage?: Storage }).localStorage?.clear();
        } catch (err) {
          console.warn('[offscreen-bridge] local-storage-clear failed:', err);
        }
        break;
      }
    }
  }

  /** @internal */ emitScoopList(): void {
    const scoops = this.orchestrator?.getScoops().map((s) => this.toScoopSnapshot(s)) ?? [];
    this.emit({ type: 'scoop-list', scoops } satisfies ScoopListMsg);
  }

  /** Send a message to all panels via the kernel transport. */
  private emit(payload: OffscreenToPanelMessage): void {
    this.transport.send(payload);
  }
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
