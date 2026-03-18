import { describe, expect, it, vi } from 'vitest';

import {
  createLeaderSyncChannel,
  createFollowerSyncChannel,
  TraySyncChannel,
  sendCDPResponse,
  reassembleCDPResponse,
  CDP_CHUNK_THRESHOLD,
  type LeaderToFollowerMessage,
  type FollowerToLeaderMessage,
  type TraySyncMessage,
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

    it('gracefully handles send errors and returns false', () => {
      const dc = new FakeSyncDataChannel();
      dc.send = () => { throw new Error('send failed'); };
      const sync = new TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>(dc);
      // Should not throw, and should return false
      const result = sync.send({ type: 'status', scoopStatus: 'idle' });
      expect(result).toBe(false);
    });

    it('returns true on successful send', () => {
      const dc = new FakeSyncDataChannel();
      const sync = new TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>(dc);
      const result = sync.send({ type: 'status', scoopStatus: 'idle' });
      expect(result).toBe(true);
    });

    it('returns false when closed', () => {
      const dc = new FakeSyncDataChannel();
      const sync = new TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>(dc);
      sync.close();
      const result = sync.send({ type: 'status', scoopStatus: 'idle' });
      expect(result).toBe(false);
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

    it('receives user_message_echo from leader', () => {
      const dc = new FakeSyncDataChannel();
      const sync = createFollowerSyncChannel(dc);
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage(msg => received.push(msg));

      const echo: LeaderToFollowerMessage = {
        type: 'user_message_echo',
        text: 'echoed',
        messageId: 'e1',
        scoopJid: 'cone',
      };
      dc.simulateMessage(JSON.stringify(echo));
      expect(received).toEqual([echo]);
    });
  });

  describe('sendCDPResponse', () => {
    it('sends small responses as a single message without chunking', () => {
      const sent: TraySyncMessage[] = [];
      const channel = { send: (msg: TraySyncMessage) => { sent.push(msg); return true; } };

      const result = { data: 'small' };
      sendCDPResponse(channel, 'req-1', result);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({ type: 'cdp.response', requestId: 'req-1', result });
    });

    it('sends error responses directly without chunking', () => {
      const sent: TraySyncMessage[] = [];
      const channel = { send: (msg: TraySyncMessage) => { sent.push(msg); return true; } };

      sendCDPResponse(channel, 'req-1', undefined, 'Something broke');

      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({ type: 'cdp.response', requestId: 'req-1', result: undefined, error: 'Something broke' });
    });

    it('chunks large responses and includes chunkIndex/totalChunks', () => {
      const sent: TraySyncMessage[] = [];
      const channel = { send: (msg: TraySyncMessage) => { sent.push(msg); return true; } };

      // Create a result larger than CDP_CHUNK_THRESHOLD
      const largePayload = 'x'.repeat(CDP_CHUNK_THRESHOLD + 1000);
      const result = { data: largePayload };

      sendCDPResponse(channel, 'req-big', result);

      expect(sent.length).toBeGreaterThan(1);
      for (let i = 0; i < sent.length; i++) {
        const msg = sent[i] as Extract<TraySyncMessage, { type: 'cdp.response' }>;
        expect(msg.type).toBe('cdp.response');
        expect(msg.requestId).toBe('req-big');
        expect(msg.chunkIndex).toBe(i);
        expect(msg.totalChunks).toBe(sent.length);
        expect(typeof msg.chunkData).toBe('string');
        expect(msg.result).toBeUndefined();
      }
    });

    it('sends error response when a chunk send fails', () => {
      const sent: TraySyncMessage[] = [];
      let sendCount = 0;
      const channel = {
        send: (msg: TraySyncMessage) => {
          sent.push(msg);
          sendCount++;
          // Fail on the second chunk
          return sendCount !== 2;
        },
      };

      const largePayload = 'y'.repeat(CDP_CHUNK_THRESHOLD + 1000);
      sendCDPResponse(channel, 'req-fail', { data: largePayload });

      // Should have: chunk 0 (success), chunk 1 (fail), error message
      expect(sent.length).toBe(3);
      const lastMsg = sent[sent.length - 1] as Extract<TraySyncMessage, { type: 'cdp.response' }>;
      expect(lastMsg.type).toBe('cdp.response');
      expect(lastMsg.error).toContain('Failed to send CDP response chunk');
    });

    it('returns true when all chunks sent successfully', () => {
      const channel = { send: () => true };
      const largePayload = 'z'.repeat(CDP_CHUNK_THRESHOLD + 1000);
      const ok = sendCDPResponse(channel, 'req', { data: largePayload });
      expect(ok).toBe(true);
    });

    it('returns false when a chunk fails', () => {
      let sendCount = 0;
      const channel = { send: () => { sendCount++; return sendCount !== 2; } };
      const largePayload = 'z'.repeat(CDP_CHUNK_THRESHOLD + 1000);
      const ok = sendCDPResponse(channel, 'req', { data: largePayload });
      expect(ok).toBe(false);
    });
  });

  describe('reassembleCDPResponse', () => {
    it('returns non-chunked responses directly', () => {
      const buffers = new Map();
      const result = reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-1',
        result: { data: 'hello' },
      });
      expect(result).toEqual({ result: { data: 'hello' }, error: undefined });
    });

    it('returns error responses directly', () => {
      const buffers = new Map();
      const result = reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-1',
        error: 'Something failed',
      });
      expect(result).toEqual({ result: undefined, error: 'Something failed' });
    });

    it('accumulates chunks and returns null until complete', () => {
      const buffers = new Map();
      const original = { data: 'hello world' };
      const serialized = JSON.stringify(original);
      const mid = Math.ceil(serialized.length / 2);

      // First chunk
      const r1 = reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-2',
        chunkData: serialized.slice(0, mid),
        chunkIndex: 0,
        totalChunks: 2,
      });
      expect(r1).toBeNull();
      expect(buffers.size).toBe(1);

      // Second chunk
      const r2 = reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-2',
        chunkData: serialized.slice(mid),
        chunkIndex: 1,
        totalChunks: 2,
      });
      expect(r2).toEqual({ result: original });
      expect(buffers.size).toBe(0); // cleaned up
    });

    it('handles out-of-order chunk delivery', () => {
      const buffers = new Map();
      const original = { a: 1, b: 2, c: 3 };
      const serialized = JSON.stringify(original);
      const third = Math.ceil(serialized.length / 3);

      // Send chunk 2 first, then 0, then 1
      expect(reassembleCDPResponse(buffers, {
        type: 'cdp.response', requestId: 'req-3',
        chunkData: serialized.slice(2 * third), chunkIndex: 2, totalChunks: 3,
      })).toBeNull();

      expect(reassembleCDPResponse(buffers, {
        type: 'cdp.response', requestId: 'req-3',
        chunkData: serialized.slice(0, third), chunkIndex: 0, totalChunks: 3,
      })).toBeNull();

      const result = reassembleCDPResponse(buffers, {
        type: 'cdp.response', requestId: 'req-3',
        chunkData: serialized.slice(third, 2 * third), chunkIndex: 1, totalChunks: 3,
      });
      expect(result).toEqual({ result: original });
    });

    it('handles error during chunked transfer', () => {
      const buffers = new Map();

      // First chunk arrives
      reassembleCDPResponse(buffers, {
        type: 'cdp.response', requestId: 'req-4',
        chunkData: '{"partial":', chunkIndex: 0, totalChunks: 2,
      });
      expect(buffers.size).toBe(1);

      // Error arrives for the same request
      const result = reassembleCDPResponse(buffers, {
        type: 'cdp.response', requestId: 'req-4',
        error: 'Failed to send chunk 1',
        chunkIndex: 1, totalChunks: 2,
      });
      expect(result).toEqual({ error: 'Failed to send chunk 1' });
      expect(buffers.size).toBe(0); // cleaned up
    });

    it('ignores duplicate chunk deliveries', () => {
      const buffers = new Map();
      const original = { dup: 'test' };
      const serialized = JSON.stringify(original);
      const mid = Math.ceil(serialized.length / 2);

      // Deliver chunk 0 twice
      reassembleCDPResponse(buffers, {
        type: 'cdp.response', requestId: 'req-5',
        chunkData: serialized.slice(0, mid), chunkIndex: 0, totalChunks: 2,
      });
      reassembleCDPResponse(buffers, {
        type: 'cdp.response', requestId: 'req-5',
        chunkData: serialized.slice(0, mid), chunkIndex: 0, totalChunks: 2,
      });

      // Complete with chunk 1
      const result = reassembleCDPResponse(buffers, {
        type: 'cdp.response', requestId: 'req-5',
        chunkData: serialized.slice(mid), chunkIndex: 1, totalChunks: 2,
      });
      expect(result).toEqual({ result: original });
    });
  });
});
