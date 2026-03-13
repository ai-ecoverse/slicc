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
  | { type: 'error'; error: string };

export type FollowerToLeaderMessage =
  | { type: 'user_message'; text: string; messageId: string }
  | { type: 'abort' }
  | { type: 'request_snapshot' };

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
