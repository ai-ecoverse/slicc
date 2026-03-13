import { describe, expect, it, vi } from 'vitest';

import {
  createLeaderSyncChannel,
  createFollowerSyncChannel,
  TraySyncChannel,
  type LeaderToFollowerMessage,
  type FollowerToLeaderMessage,
} from './tray-sync-protocol.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';
import type { ChatMessage } from '../ui/types.js';

// ---------------------------------------------------------------------------
// Fake data channel for testing
// ---------------------------------------------------------------------------

class FakeSyncDataChannel implements TrayDataChannelLike {
  readyState = 'open';
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<Function>>();

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: string, listener: Function): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
  }

  simulateMessage(data: string): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data });
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tray-sync-protocol', () => {
  describe('TraySyncChannel', () => {
    it('sends messages as JSON over the data channel', () => {
      const dc = new FakeSyncDataChannel();
      const sync = new TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>(dc);
      const msg: LeaderToFollowerMessage = {
        type: 'snapshot',
        messages: [],
        scoopJid: 'cone',
      };
      sync.send(msg);
      expect(dc.sent).toHaveLength(1);
      expect(JSON.parse(dc.sent[0])).toEqual(msg);
    });

    it('receives and parses incoming JSON messages', () => {
      const dc = new FakeSyncDataChannel();
      const sync = new TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>(dc);
      const received: FollowerToLeaderMessage[] = [];
      sync.onMessage(msg => received.push(msg));

      dc.simulateMessage(JSON.stringify({ type: 'request_snapshot' }));
      expect(received).toEqual([{ type: 'request_snapshot' }]);
    });

    it('ignores malformed JSON without throwing', () => {
      const dc = new FakeSyncDataChannel();
      const sync = new TraySyncChannel(dc);
      const received: unknown[] = [];
      sync.onMessage(msg => received.push(msg));

      dc.simulateMessage('not-json');
      expect(received).toEqual([]);
    });

    it('unsubscribe removes the listener', () => {
      const dc = new FakeSyncDataChannel();
      const sync = new TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>(dc);
      const received: FollowerToLeaderMessage[] = [];
      const unsub = sync.onMessage(msg => received.push(msg));

      dc.simulateMessage(JSON.stringify({ type: 'abort' }));
      expect(received).toHaveLength(1);

      unsub();
      dc.simulateMessage(JSON.stringify({ type: 'abort' }));
      expect(received).toHaveLength(1);
    });

    it('does not send or receive after close', () => {
      const dc = new FakeSyncDataChannel();
      const sync = new TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>(dc);
      const received: FollowerToLeaderMessage[] = [];
      sync.onMessage(msg => received.push(msg));

      sync.close();

      sync.send({ type: 'status', scoopStatus: 'idle' });
      expect(dc.sent).toHaveLength(0);

      dc.simulateMessage(JSON.stringify({ type: 'abort' }));
      expect(received).toHaveLength(0);
    });

    it('reports isOpen based on channel readyState and closed flag', () => {
      const dc = new FakeSyncDataChannel();
      dc.readyState = 'open';
      const sync = new TraySyncChannel(dc);
      expect(sync.isOpen).toBe(true);

      dc.readyState = 'closed';
      expect(sync.isOpen).toBe(false);

      dc.readyState = 'open';
      sync.close();
      expect(sync.isOpen).toBe(false);
    });

    it('gracefully handles send errors', () => {
      const dc = new FakeSyncDataChannel();
      dc.send = () => { throw new Error('send failed'); };
      const sync = new TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>(dc);
      // Should not throw
      sync.send({ type: 'status', scoopStatus: 'idle' });
    });
  });

  describe('createLeaderSyncChannel', () => {
    it('creates a channel typed for leader→follower send and follower→leader receive', () => {
      const dc = new FakeSyncDataChannel();
      const sync = createLeaderSyncChannel(dc);
      const received: FollowerToLeaderMessage[] = [];
      sync.onMessage(msg => received.push(msg));

      const snapshot: LeaderToFollowerMessage = {
        type: 'snapshot',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }] as ChatMessage[],
        scoopJid: 'cone',
      };
      sync.send(snapshot);
      expect(JSON.parse(dc.sent[0])).toEqual(snapshot);

      dc.simulateMessage(JSON.stringify({ type: 'user_message', text: 'hello', messageId: 'm1' }));
      expect(received).toEqual([{ type: 'user_message', text: 'hello', messageId: 'm1' }]);
    });
  });

  describe('createFollowerSyncChannel', () => {
    it('creates a channel typed for follower→leader send and leader→follower receive', () => {
      const dc = new FakeSyncDataChannel();
      const sync = createFollowerSyncChannel(dc);
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage(msg => received.push(msg));

      sync.send({ type: 'user_message', text: 'test', messageId: 'm2' });
      expect(JSON.parse(dc.sent[0])).toEqual({ type: 'user_message', text: 'test', messageId: 'm2' });

      dc.simulateMessage(JSON.stringify({ type: 'status', scoopStatus: 'processing' }));
      expect(received).toEqual([{ type: 'status', scoopStatus: 'processing' }]);
    });
  });
});
