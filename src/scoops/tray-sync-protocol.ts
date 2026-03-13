/**
 * Typed sync protocol for tray WebRTC data channels.
 *
 * Leader → Follower: snapshots of chat state + real-time agent events.
 * Follower → Leader: user input + abort requests.
 */

import type { AgentEvent, ChatMessage } from '../ui/types.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tray-sync');

// ---------------------------------------------------------------------------
// Protocol messages
// ---------------------------------------------------------------------------

export type LeaderToFollowerMessage =
  | { type: 'snapshot'; messages: ChatMessage[]; scoopJid: string }
  | { type: 'agent_event'; event: AgentEvent; scoopJid: string }
  | { type: 'user_message_echo'; text: string; messageId: string; scoopJid: string }
  | { type: 'status'; scoopStatus: string }
  | { type: 'error'; error: string }
  | { type: 'targets.registry'; targets: TrayTargetEntry[] }
  | { type: 'cdp.request'; requestId: string; localTargetId: string; method: string; params?: Record<string, unknown>; sessionId?: string }
  | { type: 'cdp.response'; requestId: string; result?: Record<string, unknown>; error?: string }
  | { type: 'tab.open'; requestId: string; url: string }
  | { type: 'tab.opened'; requestId: string; targetId: string }
  | { type: 'tab.open.error'; requestId: string; error: string };

export type FollowerToLeaderMessage =
  | { type: 'user_message'; text: string; messageId: string }
  | { type: 'abort' }
  | { type: 'request_snapshot' }
  | { type: 'targets.advertise'; targets: RemoteTargetInfo[]; runtimeId: string }
  | { type: 'cdp.request'; requestId: string; targetRuntimeId: string; localTargetId: string; method: string; params?: Record<string, unknown>; sessionId?: string }
  | { type: 'cdp.response'; requestId: string; result?: Record<string, unknown>; error?: string }
  | { type: 'tab.open'; requestId: string; targetRuntimeId: string; url: string }
  | { type: 'tab.opened'; requestId: string; targetId: string }
  | { type: 'tab.open.error'; requestId: string; error: string };

// ---------------------------------------------------------------------------
// Target advertisement types
// ---------------------------------------------------------------------------

export interface RemoteTargetInfo {
  targetId: string;
  title: string;
  url: string;
}

export interface TrayTargetEntry {
  targetId: string;       // Unique within the tray: "{runtimeId}:{localTargetId}"
  localTargetId: string;  // The original targetId on the owning runtime
  runtimeId: string;      // Which runtime owns this target
  title: string;
  url: string;
  isLocal: boolean;       // True if owned by the receiving runtime (set by consumer, not registry)
}

export type TraySyncMessage = LeaderToFollowerMessage | FollowerToLeaderMessage;

// ---------------------------------------------------------------------------
// TraySyncChannel — typed send/receive wrapper around TrayDataChannelLike
// ---------------------------------------------------------------------------

export class TraySyncChannel<
  TSend extends TraySyncMessage = TraySyncMessage,
  TReceive extends TraySyncMessage = TraySyncMessage,
> {
  private readonly listeners: Array<(message: TReceive) => void> = [];
  private closed = false;

  constructor(private readonly channel: TrayDataChannelLike) {
    this.channel.addEventListener('message', (event: { data: string }) => {
      if (this.closed) return;
      try {
        const parsed = JSON.parse(event.data) as TReceive;
        for (const listener of this.listeners) {
          listener(parsed);
        }
      } catch (error) {
        log.warn('Failed to parse tray sync message', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  send(message: TSend): void {
    if (this.closed) return;
    try {
      this.channel.send(JSON.stringify(message));
    } catch (error) {
      log.warn('Failed to send tray sync message', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  onMessage(callback: (message: TReceive) => void): () => void {
    this.listeners.push(callback);
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  close(): void {
    this.closed = true;
    this.listeners.length = 0;
    this.channel.close();
  }

  get isOpen(): boolean {
    return !this.closed && this.channel.readyState === 'open';
  }
}

// ---------------------------------------------------------------------------
// Typed factory helpers
// ---------------------------------------------------------------------------

export function createLeaderSyncChannel(
  channel: TrayDataChannelLike,
): TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage> {
  return new TraySyncChannel(channel);
}

export function createFollowerSyncChannel(
  channel: TrayDataChannelLike,
): TraySyncChannel<FollowerToLeaderMessage, LeaderToFollowerMessage> {
  return new TraySyncChannel(channel);
}
