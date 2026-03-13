/**
 * Follower sync manager — receives agent events from the leader over WebRTC
 * and provides an AgentHandle for the follower's ChatPanel.
 */

import type { AgentEvent, AgentHandle, ChatMessage } from '../ui/types.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';
import {
  createFollowerSyncChannel,
  type LeaderToFollowerMessage,
  type FollowerToLeaderMessage,
  type TraySyncChannel,
} from './tray-sync-protocol.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tray-follower-sync');

export interface FollowerSyncManagerOptions {
  /** Called when the leader sends a snapshot (full state replacement). */
  onSnapshot?: (messages: ChatMessage[], scoopJid: string) => void;
  /** Called when the leader sends a status update. */
  onStatus?: (scoopStatus: string) => void;
}

/**
 * FollowerSyncManager wraps a WebRTC data channel and implements AgentHandle
 * so the follower's ChatPanel can subscribe to events without knowing
 * it's talking to a remote leader instead of a local orchestrator.
 */
export class FollowerSyncManager implements AgentHandle {
  private readonly sync: TraySyncChannel<FollowerToLeaderMessage, LeaderToFollowerMessage>;
  private readonly eventListeners = new Set<(event: AgentEvent) => void>();
  private readonly unsubscribe: () => void;
  private latestSnapshot: { messages: ChatMessage[]; scoopJid: string } | null = null;

  constructor(
    channel: TrayDataChannelLike,
    private readonly options: FollowerSyncManagerOptions = {},
  ) {
    this.sync = createFollowerSyncChannel(channel);
    this.unsubscribe = this.sync.onMessage((message: LeaderToFollowerMessage) => {
      this.handleLeaderMessage(message);
    });
    // Emit an error event when the underlying channel drops
    channel.addEventListener('close', () => {
      log.warn('Data channel closed');
      this.emitEvent({ type: 'error', error: 'Connection to leader lost' });
    });
    channel.addEventListener('error', () => {
      log.warn('Data channel error');
      this.emitEvent({ type: 'error', error: 'Connection to leader failed' });
    });
  }

  // ---------------------------------------------------------------------------
  // AgentHandle implementation
  // ---------------------------------------------------------------------------

  sendMessage(text: string, messageId?: string): void {
    const id = messageId ?? `follower-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sync.send({ type: 'user_message', text, messageId: id });
    log.info('Sent user message to leader', { messageId: id });
  }

  onEvent(callback: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  stop(): void {
    this.sync.send({ type: 'abort' });
    log.info('Sent abort to leader');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Request a fresh snapshot from the leader. */
  requestSnapshot(): void {
    this.sync.send({ type: 'request_snapshot' });
  }

  /** Get the latest snapshot received from the leader, if any. */
  getLatestSnapshot(): { messages: ChatMessage[]; scoopJid: string } | null {
    return this.latestSnapshot;
  }

  /** Close the sync channel and clean up. */
  close(): void {
    this.unsubscribe();
    this.sync.close();
    this.eventListeners.clear();
    log.info('Follower sync closed');
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private handleLeaderMessage(message: LeaderToFollowerMessage): void {
    switch (message.type) {
      case 'snapshot':
        log.info('Snapshot received from leader', { messageCount: message.messages.length, scoopJid: message.scoopJid });
        this.latestSnapshot = { messages: message.messages, scoopJid: message.scoopJid };
        this.options.onSnapshot?.(message.messages, message.scoopJid);
        break;

      case 'agent_event':
        this.emitEvent(message.event);
        break;

      case 'status':
        this.options.onStatus?.(message.scoopStatus);
        break;

      case 'error':
        log.warn('Error from leader', { error: message.error });
        this.emitEvent({ type: 'error', error: message.error });
        break;
    }
  }

  private emitEvent(event: AgentEvent): void {
    for (const cb of this.eventListeners) {
      try {
        cb(event);
      } catch (err) {
        log.error('Listener error', { eventType: event.type, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
