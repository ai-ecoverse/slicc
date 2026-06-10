/**
 * Offscreen Bridge — connects the Orchestrator to the chrome.runtime messaging layer.
 *
 * Translates:
 * - Incoming panel messages → Orchestrator API calls
 * - Orchestrator callbacks → outgoing messages to panels
 *
 * Also maintains an event buffer for state sync on panel reconnect.
 */

import type { BrowserAPI } from '../../../packages/webapp/src/cdp/index.js';
import type { MessageAttachment } from '../../../packages/webapp/src/core/attachments.js';
import { createLogger } from '../../../packages/webapp/src/core/logger.js';
import { createOffscreenChromeRuntimeTransport } from '../../../packages/webapp/src/kernel/transport-chrome-runtime.js';
import type { KernelFacade, KernelTransport } from '../../../packages/webapp/src/kernel/types.js';
import { HIDDEN_TOOL_NAMES } from '../../../packages/webapp/src/scoops/hidden-tools.js';
import { formatLickEventForCone } from '../../../packages/webapp/src/scoops/lick-formatting.js';
import type {
  Orchestrator,
  OrchestratorCallbacks,
} from '../../../packages/webapp/src/scoops/orchestrator.js';
import {
  capTranscriptToolInput,
  capTranscriptToolResultForBuffer,
  capTranscriptToolResultForEvent,
} from '../../../packages/webapp/src/scoops/transcript-limits.js';
import { getFollowerTrayRuntimeStatus } from '../../../packages/webapp/src/scoops/tray-follower-status.js';
import type { FollowerSyncManager } from '../../../packages/webapp/src/scoops/tray-follower-sync.js';
import { getLeaderTrayRuntimeStatus } from '../../../packages/webapp/src/scoops/tray-leader.js';
import type {
  ChannelMessage,
  RegisteredScoop,
  ScoopTabState,
} from '../../../packages/webapp/src/scoops/types.js';
import { toolUIRegistry } from '../../../packages/webapp/src/tools/tool-ui.js';
import { SessionStore } from '../../../packages/webapp/src/ui/session-store.js';
import type { AgentEvent, ChatMessage } from '../../../packages/webapp/src/ui/types.js';
import type {
  AgentEventMsg,
  ErrorMsg,
  ExtensionMessage,
  ForwardedLickEvent,
  IncomingMessageMsg,
  OffscreenToPanelMessage,
  PanelCdpResponseMsg,
  PanelToOffscreenMessage,
  ScoopCreatedMsg,
  ScoopListMsg,
  ScoopSnapshotConfig,
  ScoopStatusMsg,
  SetThinkingLevelMsg,
  StateSnapshotMsg,
  TrayFollowerStatusSnapshot,
  TrayLeaderStatusSnapshot,
  TrayRuntimeStatusMsg,
} from './messages.js';

const log = createLogger('offscreen-bridge');

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
   * Sticky "this offscreen is configured as a follower" flag. Set on entering
   * follower mode (whether or not a sync is live yet) and cleared only on
   * permanent leave. `followerSync` is null during transient WebRTC
   * reconnects; this flag stays true so handlers (e.g. `sprinkle-lick`) can
   * log+drop the lick rather than fall back to the local model-less cone.
   */
  private followerActive = false;
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
   * The panel's currently-viewed scoop jid. Single source of truth for
   * the leader-sync hub adapter (`OffscreenLeaderSyncBridge` in
   * `leader-sync-bridge.ts`), which writes this via `setActiveScoopJid()`
   * whenever a `leader-active-scoop` envelope arrives from the panel.
   * Read by snapshot/leader-broadcast paths to replace the always-cone
   * behavior previously baked into `state-snapshot.activeScoopJid`. The
   * bridge owns only the cache; no envelope handler lives on the
   * panel-message switch (the hub adapter is the single inbound route).
   */
  private activeScoopJid: string | null = null;
  /**
   * Subscribers to the post-emit `agent-event` fan-out. Each handler
   * receives the same `AgentEvent` shape the panel sees (`ui/types.ts`),
   * not the wire envelope — the bridge does the same wire→UI translation
   * server-side that `offscreen-client.ts` `handleAgentEvent` does.
   * Reused by `startExtensionLeaderTray` in `extension-leader-tray.ts`
   * to forward synchronized agent events to followers without
   * re-implementing the `message_start` gating.
   */
  private readonly agentEventListeners = new Set<(scoopJid: string, event: AgentEvent) => void>();
  /**
   * Per-scoop "current message id" tracking for the fan-out's
   * `message_start` gating. Held separately from the bridge's
   * buffer-keyed `currentMessageId` because the callbacks that produce
   * wire `agent-event` envelopes mutate `currentMessageId` BEFORE
   * `emit()` runs (e.g. `getOrCreateAssistantMsg` in `onResponse`),
   * which would short-circuit the fan-out's `message_start` emission.
   * Mirrors the panel-side `currentMessageId` in
   * `offscreen-client.ts:handleAgentEvent` exactly.
   */
  private readonly fanOutMessageId = new Map<string, string>();

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

      onCompactionStateChange: (scoopJid, state) => {
        bridge.emit({
          type: 'compaction-state',
          scoopJid,
          state,
        });
      },

      onError: (scoopJid, error) => {
        bridge.emit({
          type: 'error',
          scoopJid,
          error,
        } satisfies ErrorMsg);
      },

      onToolStart: (scoopJid, toolName, toolInput) => {
        if (HIDDEN_TOOL_NAMES.has(toolName)) return;

        // Transcript boundary: shallow-cap oversized string fields (e.g.
        // write_file's `content`) once, so BOTH the buffered transcript
        // and the emitted event carry the capped shape. The agent loop
        // keeps the full input; only the human-facing transcript is
        // capped — uncapped it grows ~1:1 with tool traffic and OOMs
        // long sessions (see transcript-limits.ts).
        const cappedInput = capTranscriptToolInput(toolInput);

        const msg = bridge.getOrCreateAssistantMsg(scoopJid);
        if (!msg.toolCalls) msg.toolCalls = [];
        msg.toolCalls.push({ id: uid(), name: toolName, input: cappedInput });

        bridge.emit({
          type: 'agent-event',
          scoopJid,
          eventType: 'tool_start',
          toolName,
          toolInput: cappedInput,
        });
      },

      onToolEnd: (scoopJid, toolName, result, isError) => {
        if (HIDDEN_TOOL_NAMES.has(toolName)) return;

        // Transcript boundary — same rationale as onToolStart. Two
        // variants: the BUFFER strips inline screenshot markers
        // entirely (the panel never persists them either; they are the
        // largest payload class), while the EMITTED event keeps the
        // markers whole so the live panel can extract the screenshot —
        // only the surrounding text is capped.
        const msgId = bridge.currentMessageId.get(scoopJid);
        if (msgId) {
          const buf = bridge.getBuffer(scoopJid);
          const msg = buf.find((m) => m.id === msgId);
          if (msg?.toolCalls) {
            const tc = [...msg.toolCalls]
              .reverse()
              .find((t) => t.name === toolName && t.result === undefined);
            if (tc) {
              tc.result = capTranscriptToolResultForBuffer(result);
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
          toolResult: capTranscriptToolResultForEvent(result),
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
        bridge.notifyPanelIncomingMessage(scoopJid, message);
      },

      onScoopUnregistered: (scoop) => {
        // Evict every per-scoop state slice the bridge keeps. The chat
        // buffer holds the scoop's full transcript INCLUDING complete
        // tool results — before this hook, programmatic teardown
        // (ephemeral `agent` spawns, the cone's `drop_scoop`, workflow
        // subagents) left it in the Map forever: ~1:1 retained bytes
        // per byte of tool output, straight to the V8 4GB OOM on
        // skill-heavy sessions. Only the panel's `scoop-drop` message
        // path cleaned up. Idempotent with that path.
        bridge.messageBuffers.delete(scoop.jid);
        bridge.currentMessageId.delete(scoop.jid);
        bridge.fanOutMessageId.delete(scoop.jid);
        bridge.scoopStatuses.delete(scoop.jid);
        // Drop the persisted UI session too — `persistScoop` writes
        // `session-<folder>` for every scoop with buffered messages,
        // so dead ephemeral scoops otherwise pile up in the
        // `browser-coding-agent` store. The cone never unregisters,
        // but guard anyway: its session must survive.
        if (!scoop.isCone && bridge.sessionStore) {
          bridge.sessionStore.delete(`session-${scoop.folder}`).catch((err) => {
            console.warn(
              '[offscreen-bridge] Failed to delete session for unregistered scoop:',
              scoop.folder,
              err
            );
          });
        }
        bridge.emitScoopList();
      },
    };
  }

  /**
   * Emit a canonical `incoming-message` wire envelope to the panel.
   *
   * Extracted from the `onIncomingMessage` orchestrator callback so the
   * leader factory's `onFollowerMessage` in `extension-leader-tray.ts`
   * can emit this envelope explicitly — `'web'`-channel messages don't
   * trigger `orchestrator.onIncomingMessage` (gated by
   * `isExternalLickChannel`; `'web'` is excluded from
   * `EXTERNAL_LICK_CHANNELS`), so the panel echo path needs a direct
   * helper.
   *
   * Purely envelope construction — does not buffer, persist, or
   * format. Callers are responsible for any side effects they need.
   */
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
      },
    } satisfies IncomingMessageMsg);
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
      // Honour the panel's leader-pushed selection when present so a
      // sub-scoop survives panel reload; fall back to the cone for
      // first-boot / pre-leader cases.
      activeScoopJid: this.getActiveScoopJid() ?? cone?.jid ?? null,
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
   * Sticky follower-mode signal. Caller (offscreen.ts) sets `true` on
   * entering the follower branch (regardless of whether a sync is live yet)
   * and `false` only on permanent leave. Used by handlers that must
   * distinguish "transient reconnect, log+drop" from "not a follower at
   * all, handle locally" — see `case 'sprinkle-lick'` in `handlePanelMessage`.
   */
  setFollowerActive(active: boolean): void {
    this.followerActive = active;
  }

  /**
   * Update the cached active-scoop jid. Called by the leader-sync hub
   * adapter (`OffscreenLeaderSyncBridge` in `leader-sync-bridge.ts`)
   * when a `leader-active-scoop` envelope arrives from the panel. Pass
   * `null` to clear.
   */
  setActiveScoopJid(jid: string | null): void {
    this.activeScoopJid = jid;
  }

  /**
   * Read the cached active-scoop jid. Returns `null` if no panel signal
   * has been observed yet.
   */
  getActiveScoopJid(): string | null {
    return this.activeScoopJid;
  }

  /**
   * Subscribe to the bridge's `agent-event` stream as translated UI
   * `AgentEvent`s. Mirrors `offscreen-client.ts:handleAgentEvent`
   * server-side so callers don't have to re-implement the wire→UI
   * mapping or the `message_start` gating against `currentMessageId`.
   * Returns an unsubscribe function.
   *
   * Used by `startExtensionLeaderTray` (in `extension-leader-tray.ts`)
   * to broadcast synchronized agent events to followers — the
   * active-scoop filter lives in the caller, not here.
   *
   * The fan-out runs AFTER the panel-bound `chrome.runtime.sendMessage`
   * in `emit()`, so a slow/throwing listener can't gate panel delivery.
   * Per-listener errors are caught and logged.
   *
   * NB: `turn_end` synthesis is intentionally NOT emitted — the wire
   * envelope only carries `response_done`. Do NOT synthesize `turn_end`
   * here without first capturing the standalone leader's `agent.event`
   * wire payload under a multi-turn scenario and diffing against the
   * events this synthesizer produces — adding a phantom `turn_end`
   * risks duplicate events on followers that already see one from the
   * standalone wire path.
   */
  onAgentEvent(handler: (scoopJid: string, event: AgentEvent) => void): () => void {
    this.agentEventListeners.add(handler);
    return () => {
      this.agentEventListeners.delete(handler);
    };
  }

  /**
   * @internal — called from `emit()` whenever a wire `agent-event`
   * envelope flows out to the panel. Translates the envelope to the
   * matching `AgentEvent` (or pair of events when `message_start`
   * needs to be synthesized) and notifies each registered listener.
   * Uses its own `fanOutMessageId` map (instead of the bridge's
   * buffer-keyed `currentMessageId`) so the gating matches the
   * panel's `handleAgentEvent` step for step — the callbacks that
   * produce wire envelopes pre-populate `currentMessageId` BEFORE
   * `emit()` runs, which would otherwise suppress every synthesized
   * `message_start`.
   */
  private fanOutAgentEvent(msg: AgentEventMsg): void {
    // Don't early-return on `agentEventListeners.size === 0`: the
    // gating state (`fanOutMessageId`) must track every wire envelope
    // even when nobody is subscribed, so a listener that subscribes
    // mid-stream sees a consistent view (e.g. a subsequent `text_delta`
    // continues the existing message instead of synthesizing a stray
    // `message_start`).
    const { scoopJid, eventType } = msg;
    const events: AgentEvent[] = [];
    const ensureMessageStart = (): string => {
      let msgId = this.fanOutMessageId.get(scoopJid);
      if (!msgId) {
        msgId = `scoop-${scoopJid}-${uid()}`;
        this.fanOutMessageId.set(scoopJid, msgId);
        events.push({ type: 'message_start', messageId: msgId });
      }
      return msgId;
    };

    switch (eventType) {
      case 'text_delta': {
        const messageId = ensureMessageStart();
        events.push({ type: 'content_delta', messageId, text: msg.text ?? '' });
        break;
      }
      case 'tool_start': {
        const messageId = ensureMessageStart();
        events.push({
          type: 'tool_use_start',
          messageId,
          toolName: msg.toolName ?? '',
          toolInput: msg.toolInput,
        });
        break;
      }
      case 'tool_end': {
        const messageId = this.fanOutMessageId.get(scoopJid);
        if (!messageId) return;
        events.push({
          type: 'tool_result',
          messageId,
          toolName: msg.toolName ?? '',
          result: msg.toolResult ?? '',
          isError: msg.isError,
        });
        break;
      }
      case 'tool_ui': {
        const messageId = ensureMessageStart();
        events.push({
          type: 'tool_ui',
          messageId,
          toolName: msg.toolName ?? '',
          requestId: msg.requestId ?? '',
          html: msg.html ?? '',
        });
        break;
      }
      case 'tool_ui_done': {
        const messageId = this.fanOutMessageId.get(scoopJid);
        if (!messageId) return;
        events.push({ type: 'tool_ui_done', messageId, requestId: msg.requestId ?? '' });
        break;
      }
      case 'response_done': {
        const messageId = this.fanOutMessageId.get(scoopJid);
        if (!messageId) return;
        events.push({ type: 'content_done', messageId });
        this.fanOutMessageId.delete(scoopJid);
        // NB: `turn_end` synthesis is deliberately deferred. Do NOT
        // synthesize `turn_end` here without first capturing the
        // standalone leader's `agent.event` wire payload under a
        // multi-turn scenario and diffing against the events this
        // synthesizer produces — adding a phantom `turn_end` risks
        // duplicate events on followers that already see one from the
        // standalone wire path.
        break;
      }
      case 'turn_end': {
        // No emit — `turn_end` synthesis is deferred (see comment
        // above). The gating-state still needs cleanup, mirroring the
        // panel-side reference in `offscreen-client.ts` `handleAgentEvent`.
        this.fanOutMessageId.delete(scoopJid);
        break;
      }
    }

    for (const event of events) {
      for (const fn of this.agentEventListeners) {
        try {
          fn(scoopJid, event);
        } catch (err) {
          log.error('onAgentEvent listener threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /**
   * Public wrapper over the `@internal getBuffer(jid)` that casts the
   * structurally-compatible `BufferedChatMessage[]` to `ChatMessage[]`.
   * Used by `startExtensionLeaderTray` in `extension-leader-tray.ts` to
   * read chat state without reaching for `@internal` helpers. Same cast
   * pattern as `persistScoop` (this file).
   */
  getMessagesForJid(jid: string): ChatMessage[] {
    return this.getBuffer(jid) as unknown as ChatMessage[];
  }

  /**
   * Route a sprinkle-lick event into the orchestrator. Resolves
   * `targetScoop` by name/folder/`${folder}-scoop`, falling back to the
   * cone when no match is found (or `targetScoop` is omitted). Builds a
   * `ChannelMessage`, appends a buffered lick entry, persists, and
   * dispatches via `orchestrator.handleMessage`.
   *
   * Extracted from the `sprinkle-lick` envelope handler so
   * `startExtensionLeaderTray`'s `onSprinkleLick` callback can share the
   * same routing logic without duplicating channel-message construction.
   * No-op if no orchestrator is bound.
   */
  async routeSprinkleLick(
    sprinkleName: string,
    body: unknown,
    targetScoop?: string,
    originLabel?: string
  ): Promise<void> {
    if (!this.orchestrator) return;
    const scoops = this.orchestrator.getScoops();
    let target = targetScoop
      ? scoops.find(
          (s) =>
            s.name === targetScoop ||
            s.folder === targetScoop ||
            s.folder === `${targetScoop}-scoop`
        )
      : undefined;
    if (!target) {
      target = scoops.find((s) => s.isCone);
    }
    if (!target) return;
    const msgId = `sprinkle-${sprinkleName}-${Date.now()}`;
    const formatted = formatLickEventForCone({
      type: 'sprinkle',
      sprinkleName,
      timestamp: new Date().toISOString(),
      body,
      originLabel,
    } as Parameters<typeof formatLickEventForCone>[0]);
    const content =
      formatted?.content ??
      `[Sprinkle Event: ${sprinkleName}]\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``;
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
    } as any);
    this.persistScoop(target.jid);
    await this.orchestrator.handleMessage(channelMsg);
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
    this.fanOutMessageId.delete(cone.jid);
    if (this.sessionStore) {
      const sessionId = cone.isCone ? 'session-cone' : `session-${cone.folder}`;
      this.sessionStore.saveMessages(sessionId, messages).catch((err) => {
        log.error('applyFollowerSnapshot persist failed', {
          error: err instanceof Error ? err.message : String(err),
        });
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
   * Translate a scoop's restored canonical `AgentMessage[]` into the
   * buffered chat shape. Returns `null` when there is no context or no
   * agent messages yet. Lazy-imports the translator so it doesn't pull
   * pi-ai types into the bridge's hot path until needed. Shared by
   * {@link handleRequestScoopMessages} and {@link seedBuffersFromAgentState}.
   */
  private async buildBufferFromAgentMessages(
    scoop: RegisteredScoop
  ): Promise<BufferedChatMessage[] | null> {
    const context = this.orchestrator?.getScoopContext(scoop.jid);
    if (!context) return null;
    const agentMessages = context.getAgentMessages();
    if (agentMessages.length === 0) return null;
    const { agentMessagesToChatMessages } = await import(
      '../../../packages/webapp/src/scoops/agent-message-to-chat.js'
    );
    const chatMessages = agentMessagesToChatMessages(agentMessages, {
      source: scoop.isCone ? 'cone' : (scoop.name ?? scoop.folder),
    });
    return chatMessages.map((m) => ({
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
  }

  /**
   * Seed each registered scoop's chat buffer from its agent's restored
   * canonical history at boot, BEFORE any post-boot turn can run
   * `persistScoop`. The bridge's `messageBuffers` otherwise start empty
   * on a fresh boot, so the first agent turn after a reload would
   * persist only the new messages and overwrite the full conversation
   * in the `browser-coding-agent` UI store — the "only the last few
   * messages after a reboot" truncation. Non-destructive: only seeds
   * scoops whose buffer is still empty, and AWAITS the persist of the
   * seeded buffer so the `browser-coding-agent` store is repaired before
   * `createKernelHost` signals `kernel-worker-ready` — otherwise a panel
   * that mounts and reads the store on the next tick could still see the
   * truncated snapshot.
   */
  async seedBuffersFromAgentState(): Promise<void> {
    if (!this.orchestrator) return;
    for (const scoop of this.orchestrator.getScoops()) {
      const existing = this.messageBuffers.get(scoop.jid);
      if (existing && existing.length > 0) continue;
      const buf = await this.buildBufferFromAgentMessages(scoop);
      if (!buf) continue;
      this.messageBuffers.set(scoop.jid, buf);
      this.currentMessageId.delete(scoop.jid);
      this.fanOutMessageId.delete(scoop.jid);
      await this.persistScoopAwait(scoop.jid);
    }
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

    // Translate from the agent's canonical conversation.
    const buf = await this.buildBufferFromAgentMessages(scoop);
    if (buf) {
      // Hydrate the buffer so subsequent agent events extend the
      // restored history instead of starting from empty (which would
      // silently overwrite the UI store via persistScoop). Clear
      // `currentMessageId`/`fanOutMessageId` for the same reason: a
      // stale id pointing at a (now non-existent) buffer entry would
      // have `getOrCreateAssistantMsg` write into the rehydrated buffer
      // under an unrelated id.
      this.messageBuffers.set(scoopJid, buf);
      this.currentMessageId.delete(scoopJid);
      this.fanOutMessageId.delete(scoopJid);
      // Persist the rebuilt buffer back to the UI session store so
      // a subsequent panel reload (without further agent activity)
      // sees the canonical history instead of whatever truncated
      // snapshot the panel last wrote during the remount race.
      this.persistScoop(scoopJid);
      this.emit({
        type: 'scoop-messages-replaced',
        scoopJid,
        messages: buf,
      });
      return;
    }

    // Last resort: load from the UI session store. Hydrate the buffer
    // (and clear `currentMessageId`) here too — without this, a later
    // agent event would call `getOrCreateAssistantMsg` against an
    // empty buffer and `persistScoop` would overwrite IDB with only
    // the new entries, reintroducing the truncation race this
    // handler exists to prevent.
    if (this.sessionStore) {
      const sessionId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
      try {
        const session = await this.sessionStore.load(sessionId);
        const messages = session?.messages ?? [];
        if (messages.length > 0) {
          this.messageBuffers.set(scoopJid, messages as unknown as BufferedChatMessage[]);
          this.currentMessageId.delete(scoopJid);
          this.fanOutMessageId.delete(scoopJid);
          this.emit({
            type: 'scoop-messages-replaced',
            scoopJid,
            messages: messages as unknown as BufferedChatMessage[],
          });
        }
      } catch (err) {
        log.error('sessionStore load failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Side-effect-free transcript fetch for the scoop-switcher's scope
   * label tooltip. Distinct from {@link handleRequestScoopMessages},
   * which emits a `scoop-messages-replaced` that the chat panel
   * wholesale-applies. Replies with a `scoop-transcript` envelope
   * (correlated by `requestId`) carrying a flattened `user: …` /
   * `assistant: …` transcript string — empty on unknown scoop or no
   * history yet.
   *
   * Resolution order mirrors the message-replace path:
   *   1. In-flight `messageBuffers` (current session, including
   *      streaming tail).
   *   2. Live `ScoopContext.getAgentMessages()` translated to the
   *      chat shape so tool-use blocks become readable text.
   */
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
      const { agentMessagesToChatMessages } = await import(
        '../../../packages/webapp/src/scoops/agent-message-to-chat.js'
      );
      const agentMessages = context.getAgentMessages();
      if (agentMessages.length > 0) {
        const chatMessages = agentMessagesToChatMessages(agentMessages, {
          source: scoop.isCone ? 'cone' : (scoop.name ?? scoop.folder),
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

  /**
   * Persist a scoop's message buffer to the shared UI session store.
   * Fire-and-forget — errors are swallowed to avoid blocking agent processing.
   *
   * Public so `ExtensionLeaderBridge` (consumed by `startExtensionLeaderTray`)
   * can call it from the leader-tray adapter — same buffer-persistence
   * semantics as the standalone leader.
   */
  persistScoop(jid: string): void {
    void this.persistScoopAwait(jid);
  }

  /**
   * Awaitable variant of {@link persistScoop}. Callers that must KNOW the
   * UI store has been written before proceeding — e.g. boot-time
   * {@link seedBuffersFromAgentState}, which runs inside `createKernelHost`
   * before `kernel-worker-ready` is signaled so the panel never mounts
   * against a stale/truncated `browser-coding-agent` snapshot — await this
   * instead. Errors are still swallowed so a failed write can't break boot.
   */
  private async persistScoopAwait(jid: string): Promise<void> {
    if (!this.sessionStore || !this.orchestrator) return;
    const scoop = this.orchestrator.getScoops().find((s) => s.jid === jid);
    if (!scoop) return;
    const sessionId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
    const buf = this.messageBuffers.get(jid);
    if (!buf || buf.length === 0) return;
    try {
      // BufferedChatMessage is structurally compatible with ChatMessage
      await this.sessionStore.saveMessages(sessionId, buf as unknown as ChatMessage[]);
    } catch (err) {
      log.error('persistScoop failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
        this.fanOutMessageId.delete(msg.scoopJid);
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

      case 'request-scoop-transcript': {
        await this.handleRequestScoopTranscript(msg.requestId, msg.scoopJid);
        break;
      }

      case 'clear-chat': {
        // Cone-only clear (the "New session" path). Scoops keep their
        // conversations and continue to run; the fresh cone inherits
        // the existing roster.
        const coneJid = this.orchestrator.getScoops().find((s) => s.isCone)?.jid;
        if (coneJid) {
          await this.orchestrator.clearScoopMessages(coneJid);
        }
        if (this.sessionStore) {
          await this.sessionStore.delete('session-cone');
        }
        if (coneJid) {
          this.messageBuffers.delete(coneJid);
          this.currentMessageId.delete(coneJid);
          this.fanOutMessageId.delete(coneJid);
        }
        // Acknowledge so the panel knows the clear completed before it
        // calls `location.reload()` — important in extension mode where
        // the offscreen document survives a panel reload.
        this.emit({ type: 'clear-chat-ack', requestId: msg.requestId });
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
        // Sprinkle lick event from the side panel — route through the
        // shared `routeSprinkleLick` so `startExtensionLeaderTray`'s
        // `onSprinkleLick` callback can share the same routing.
        const lickMsg = msg as any;
        // Follower mode: the dip lives in the leader's mirrored chat, so
        // its lick belongs to the leader's cone (sending it locally would
        // record a click against a conversation that doesn't contain the
        // dip; on a typical follower the local cone also has no provider
        // login). Mirrors how follower-panel sprinkles forward via
        // follower-sprinkle-bridge.
        // Predicate is `followerActive` (sticky across reconnects) not
        // `followerSync` (transiently null during WebRTC reconnects) so a
        // flicker doesn't reroute us back to the local model-less cone.
        // `originLabel` is intentionally not forwarded — the leader is the
        // origin authority and re-stamps it from the connection on receive
        // (see `tray-leader-sync.ts case 'sprinkle.lick'`).
        if (this.followerActive) {
          if (this.followerSync) {
            this.followerSync.sendSprinkleLick(
              lickMsg.sprinkleName,
              lickMsg.body,
              lickMsg.targetScoop
            );
          } else {
            console.warn('[offscreen-bridge] sprinkle-lick dropped: follower sync mid-reconnect', {
              sprinkleName: lickMsg.sprinkleName,
            });
          }
          break;
        }
        await this.routeSprinkleLick(
          lickMsg.sprinkleName,
          lickMsg.body,
          lickMsg.targetScoop,
          lickMsg.originLabel
        );
        break;
      }

      case 'lick-webhook-event': {
        // Page-side LeaderTrayManager received a `webhook.event` control
        // message from the tray and relayed it here. Dispatch into the
        // worker-side LickManager via the orchestrator. Fire-and-forget;
        // matches the pre-regression direct-call semantics.
        this.orchestrator.handleWebhookEvent(msg.webhookId, msg.headers, msg.body);
        break;
      }

      case 'set-follower-forwarding': {
        // Standalone follower: install/clear a forwarder on the worker's
        // LickManager that relays forwardable licks to the page (which hands
        // them to the FollowerSyncManager). Extension never sends this — it
        // installs the forwarder directly in offscreen.ts.
        const lm = (globalThis as Record<string, unknown>).__slicc_lickManager as
          | { setForwarder(fn: ((e: ForwardedLickEvent) => void) | null): void }
          | undefined;
        if (!lm) {
          console.warn(
            '[offscreen-bridge] set-follower-forwarding ignored: worker LickManager unavailable'
          );
          break;
        }
        if (msg.enabled) {
          lm.setForwarder((event) => this.emit({ type: 'forward-lick', event }));
        } else {
          lm.setForwarder(null);
        }
        break;
      }

      case 'inject-forwarded-lick': {
        // Standalone leader: route a follower-forwarded lick into the
        // worker's LickManager (→ defaultLickEventHandler → cone).
        // Re-emitting through emitEvent is TERMINAL here only because a
        // leader never has a forwarder installed (see set-follower-forwarding).
        const lm = (globalThis as Record<string, unknown>).__slicc_lickManager as
          | { emitEvent(e: ForwardedLickEvent): void }
          | undefined;
        if (!lm) {
          console.warn(
            '[offscreen-bridge] inject-forwarded-lick dropped: worker LickManager unavailable',
            { type: msg.event.type }
          );
          break;
        }
        lm.emitEvent(msg.event);
        break;
      }

      case 'lick-cherry-host-event': {
        // Page-side LeaderSyncManager received a `cherry.host_event` over a
        // follower's data channel (its embedded cherry host page called
        // `emitHostEvent`) and relayed it here. Dispatch into the worker-side
        // LickManager via the orchestrator as a `'cherry'` lick.
        this.orchestrator.handleCherryHostEvent(msg.cherryRuntimeId, msg.name, msg.detail);
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
    // Fan out to leader-sync subscribers when the payload is an
    // agent-event. Cheap when it isn't — the type check skips
    // `fanOutAgentEvent` entirely. (Listener count is deliberately NOT
    // checked here; the fan-out maintains `fanOutMessageId` gating
    // state for every wire envelope regardless of subscriber presence
    // — see the comment in `fanOutAgentEvent`.)
    if ((payload as { type?: string }).type === 'agent-event') {
      this.fanOutAgentEvent(payload as AgentEventMsg);
    }
  }
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Flatten a list of chat-shaped messages into a single `role: content`
 * transcript string suitable for the scope-label LLM call. Empty
 * `content` entries are skipped so a streaming-only assistant message
 * with no text yet doesn't insert blank lines.
 */
function formatTranscript(messages: ReadonlyArray<{ role: string; content: string }>): string {
  const lines: string[] = [];
  for (const m of messages) {
    const text = (m.content ?? '').trim();
    if (text.length === 0) continue;
    lines.push(`${m.role}: ${text}`);
  }
  return lines.join('\n');
}
