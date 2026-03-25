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
  StateSnapshotMsg,
  ErrorMsg,
  ScoopCreatedMsg,
  IncomingMessageMsg,
} from './messages.js';
import { SessionStore } from '../../../packages/webapp/src/ui/session-store.js';
import type { ChatMessage } from '../../../packages/webapp/src/ui/types.js';
import type { BrowserAPI } from '../../../packages/webapp/src/cdp/index.js';

/** Buffered message for state sync */
interface BufferedChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
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

export class OffscreenBridge {
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
   * Bind the orchestrator and start listening for panel messages.
   * Called after the Orchestrator is constructed with callbacks from createCallbacks().
   */
  async bind(orchestrator: Orchestrator, browserAPI?: BrowserAPI): Promise<void> {
    this.orchestrator = orchestrator;
    this.browserAPI = browserAPI ?? null;
    this.setupMessageListener();
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
        // the panel's scoop-create → scoop-created flow.
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

      onIncomingMessage: (scoopJid, message) => {
        const chatMsg: BufferedChatMessage = {
          id: message.id,
          role: 'user',
          content:
            message.channel === 'delegation'
              ? `**[Instructions from sliccy]**\n\n${message.content}`
              : message.content,
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
            channel: message.channel,
            senderName: message.senderName,
            fromAssistant: message.fromAssistant,
            timestamp: message.timestamp,
          },
        } satisfies IncomingMessageMsg);
      },
    };
  }

  /** Build a full state snapshot for panel reconnect. */
  buildStateSnapshot(): StateSnapshotMsg {
    const scoops =
      this.orchestrator?.getScoops().map((s) => ({
        jid: s.jid,
        name: s.name,
        folder: s.folder,
        isCone: s.isCone,
        assistantLabel: s.assistantLabel,
        status: (this.scoopStatuses.get(s.jid) ?? 'ready') as ScoopTabState['status'],
      })) ?? [];

    const cone = scoops.find((s) => s.isCone);

    return {
      type: 'state-snapshot',
      scoops,
      activeScoopJid: cone?.jid ?? null,
    };
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

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener(
      (
        message: unknown,
        _sender: ChromeMessageSender,
        _sendResponse: (response?: unknown) => void
      ) => {
        if (!isExtMsg(message)) return false;
        const msg = message as ExtensionMessage;

        // Only handle messages from the panel (relayed by service worker)
        if (msg.source !== 'panel') return false;

        // Route sprinkle-op-response to the proxy's pending request map
        if ((msg.payload as any)?.type === 'sprinkle-op-response') {
          import('./sprinkle-proxy.js').then(({ handleSprinkleOpResponse }) => {
            handleSprinkleOpResponse(msg.payload as any);
          });
          return false;
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
            } as import('./messages.js').ErrorMsg);
          }
        });
        return false;
      }
    );
  }

  private async handlePanelMessage(msg: PanelToOffscreenMessage): Promise<void> {
    if (!this.orchestrator) return;

    switch (msg.type) {
      case 'user-message': {
        const channelMsg: ChannelMessage = {
          id: msg.messageId,
          chatJid: msg.scoopJid,
          senderId: 'user',
          senderName: 'User',
          content: msg.text,
          timestamp: new Date().toISOString(),
          fromAssistant: false,
          channel: 'web',
        };
        this.getBuffer(msg.scoopJid).push({
          id: msg.messageId,
          role: 'user',
          content: msg.text,
          timestamp: Date.now(),
        });
        this.persistScoop(msg.scoopJid);
        await this.orchestrator.handleMessage(channelMsg);
        this.orchestrator.createScoopTab(msg.scoopJid);
        break;
      }

      case 'scoop-create': {
        const folder =
          msg.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/-+$/, '') + (msg.isCone ? '' : '-scoop');
        const scoop: RegisteredScoop = {
          jid: msg.isCone ? `cone_${Date.now()}` : `scoop_${folder}_${Date.now()}`,
          name: msg.name,
          folder,
          isCone: msg.isCone,
          type: msg.isCone ? 'cone' : 'scoop',
          trigger: msg.isCone ? undefined : `@${folder}`,
          requiresTrigger: !msg.isCone,
          assistantLabel: msg.isCone ? 'sliccy' : folder,
          addedAt: new Date().toISOString(),
        };
        await this.orchestrator.registerScoop(scoop);
        this.emit({
          type: 'scoop-created',
          scoop: {
            jid: scoop.jid,
            name: scoop.name,
            folder: scoop.folder,
            isCone: scoop.isCone,
            assistantLabel: scoop.assistantLabel,
            status: 'ready',
          },
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

      case 'sprinkle-lick': {
        // Sprinkle click event from the side panel — route to the cone
        const scoops = this.orchestrator.getScoops();
        const cone = scoops.find((s) => s.isCone);
        if (cone) {
          const lickMsg = msg as any;
          const msgId = `sprinkle-${lickMsg.sprinkleName}-${Date.now()}`;
          const content = `[Sprinkle Event: ${lickMsg.sprinkleName}]\n\`\`\`json\n${JSON.stringify(lickMsg.body, null, 2)}\n\`\`\``;
          const channelMsg: ChannelMessage = {
            id: msgId,
            chatJid: cone.jid,
            senderId: 'sprinkle',
            senderName: `sprinkle:${lickMsg.sprinkleName}`,
            content,
            timestamp: new Date().toISOString(),
            fromAssistant: false,
            channel: 'sprinkle',
          };
          this.getBuffer(cone.jid).push({
            id: msgId,
            role: 'user',
            content,
            timestamp: Date.now(),
            source: 'lick',
            channel: 'sprinkle',
          } as any);
          this.persistScoop(cone.jid);
          await this.orchestrator.handleMessage(channelMsg);
        }
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
    }
  }

  /** @internal */ emitScoopList(): void {
    const scoops =
      this.orchestrator?.getScoops().map((s) => ({
        jid: s.jid,
        name: s.name,
        folder: s.folder,
        isCone: s.isCone,
        assistantLabel: s.assistantLabel,
        status: (this.scoopStatuses.get(s.jid) ?? 'ready') as ScoopTabState['status'],
      })) ?? [];
    this.emit({ type: 'scoop-list', scoops } satisfies ScoopListMsg);
  }

  /** Send a message to all panels via the service worker relay. */
  private emit(payload: import('./messages.js').OffscreenToPanelMessage | StateSnapshotMsg): void {
    chrome.runtime
      .sendMessage({
        source: 'offscreen' as const,
        payload,
      })
      .catch(() => {
        // No panel open — that's expected
      });
  }
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function isExtMsg(msg: unknown): boolean {
  return typeof msg === 'object' && msg !== null && 'source' in msg && 'payload' in msg;
}
