import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import {
  createFollowerSyncChannel,
  createLeaderSyncChannel,
  type FollowerToLeaderMessage,
  isCherryHostEventMessage,
  isCherrySliccEventMessage,
  type LeaderToFollowerMessage,
  type RemoteTargetInfo,
  reassembleSnapshot,
  sendSnapshot,
  TraySyncChannel,
} from '../../src/scoops/tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../../src/scoops/tray-webrtc.js';

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
      sync.onMessage((msg) => received.push(msg));

      dc.simulateMessage(JSON.stringify({ type: 'request_snapshot' }));
      expect(received).toEqual([{ type: 'request_snapshot' }]);
    });

    it('ignores malformed JSON without throwing', () => {
      const dc = new FakeSyncDataChannel();
      const sync = new TraySyncChannel(dc);
      const received: unknown[] = [];
      sync.onMessage((msg) => received.push(msg));

      dc.simulateMessage('not-json');
      expect(received).toEqual([]);
    });

    it('unsubscribe removes the listener', () => {
      const dc = new FakeSyncDataChannel();
      const sync = new TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>(dc);
      const received: FollowerToLeaderMessage[] = [];
      const unsub = sync.onMessage((msg) => received.push(msg));

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
      sync.onMessage((msg) => received.push(msg));

      sync.close();

      sync.send({ type: 'status', scoopStatus: 'idle', scoopJid: 'cone' });
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
      dc.send = () => {
        throw new Error('send failed');
      };
      const sync = new TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>(dc);

      const result = sync.send({ type: 'status', scoopStatus: 'idle', scoopJid: 'cone' });
      expect(result).toBe(false);
    });

    it('returns true on successful send', () => {
      const dc = new FakeSyncDataChannel();
      const sync = new TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>(dc);
      const result = sync.send({ type: 'status', scoopStatus: 'idle', scoopJid: 'cone' });
      expect(result).toBe(true);
    });

    it('returns false when closed', () => {
      const dc = new FakeSyncDataChannel();
      const sync = new TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>(dc);
      sync.close();
      const result = sync.send({ type: 'status', scoopStatus: 'idle', scoopJid: 'cone' });
      expect(result).toBe(false);
    });

    it('round-trips a generic lick message follower→leader', () => {
      const dc = new FakeSyncDataChannel();
      const sync = new TraySyncChannel<FollowerToLeaderMessage, LeaderToFollowerMessage>(dc);
      sync.send({
        type: 'lick',
        event: { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: { v: 1 } },
      });
      expect(JSON.parse(dc.sent[0])).toEqual({
        type: 'lick',
        event: { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: { v: 1 } },
      });
    });
  });

  describe('createLeaderSyncChannel', () => {
    it('creates a channel typed for leader→follower send and follower→leader receive', () => {
      const dc = new FakeSyncDataChannel();
      const sync = createLeaderSyncChannel(dc);
      const received: FollowerToLeaderMessage[] = [];
      sync.onMessage((msg) => received.push(msg));

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
      sync.onMessage((msg) => received.push(msg));

      sync.send({ type: 'user_message', text: 'test', messageId: 'm2' });
      expect(JSON.parse(dc.sent[0])).toEqual({
        type: 'user_message',
        text: 'test',
        messageId: 'm2',
      });

      dc.simulateMessage(
        JSON.stringify({ type: 'status', scoopStatus: 'processing', scoopJid: 'cone' })
      );
      expect(received).toEqual([{ type: 'status', scoopStatus: 'processing', scoopJid: 'cone' }]);
    });

    it('decodes a legacy status without scoopJid', () => {
      const dc = new FakeSyncDataChannel();
      const sync = createFollowerSyncChannel(dc);
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage((msg) => received.push(msg));

      dc.simulateMessage(JSON.stringify({ type: 'status', scoopStatus: 'ready' }));

      expect(received).toEqual([{ type: 'status', scoopStatus: 'ready' }]);
    });

    it('receives user_message_echo from leader', () => {
      const dc = new FakeSyncDataChannel();
      const sync = createFollowerSyncChannel(dc);
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage((msg) => received.push(msg));

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

  describe('sendSnapshot', () => {
    it('sends small snapshots as a single message', () => {
      const sent: LeaderToFollowerMessage[] = [];
      const channel = {
        send: (msg: LeaderToFollowerMessage) => {
          sent.push(msg);
          return true;
        },
      };

      const messages = [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }] as ChatMessage[];
      sendSnapshot(channel, messages, 'cone');

      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({ type: 'snapshot', messages, scoopJid: 'cone' });
    });

    it('chunks large snapshots into snapshot_chunk messages', () => {
      const sent: LeaderToFollowerMessage[] = [];
      const channel = {
        send: (msg: LeaderToFollowerMessage) => {
          sent.push(msg);
          return true;
        },
      };

      const bigContent = 'x'.repeat(2000);
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 50; i++) {
        messages.push({
          id: `m${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: bigContent,
          timestamp: i,
        } as ChatMessage);
      }

      const ok = sendSnapshot(channel, messages, 'cone');
      expect(ok).toBe(true);
      expect(sent.length).toBeGreaterThan(1);

      for (let i = 0; i < sent.length; i++) {
        const msg = sent[i] as Extract<LeaderToFollowerMessage, { type: 'snapshot_chunk' }>;
        expect(msg.type).toBe('snapshot_chunk');
        expect(msg.chunkIndex).toBe(i);
        expect(msg.totalChunks).toBe(sent.length);
        expect(msg.scoopJid).toBe('cone');
        expect(typeof msg.chunkData).toBe('string');
      }

      const serialized = JSON.stringify({ messages, scoopJid: 'cone' });
      const reassembled = sent
        .map((m) => (m as Extract<LeaderToFollowerMessage, { type: 'snapshot_chunk' }>).chunkData)
        .join('');
      expect(reassembled).toBe(serialized);
    });

    it('returns false and stops when a chunk send fails', () => {
      const sent: LeaderToFollowerMessage[] = [];
      let sendCount = 0;
      const channel = {
        send: (msg: LeaderToFollowerMessage) => {
          sent.push(msg);
          sendCount++;
          return sendCount !== 2;
        },
      };

      const bigContent = 'y'.repeat(2000);
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 50; i++) {
        messages.push({
          id: `m${i}`,
          role: 'user',
          content: bigContent,
          timestamp: i,
        } as ChatMessage);
      }

      const ok = sendSnapshot(channel, messages, 'cone');
      expect(ok).toBe(false);

      expect(sent).toHaveLength(2);
    });
  });

  describe('reassembleSnapshot', () => {
    it('reassembles chunks in order', () => {
      const original = {
        messages: [{ id: '1', role: 'user', content: 'hello', timestamp: 1 }] as ChatMessage[],
        scoopJid: 'cone',
      };
      const serialized = JSON.stringify(original);
      const mid = Math.ceil(serialized.length / 2);
      const buffers = new Map();

      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: serialized.slice(0, mid),
          chunkIndex: 0,
          totalChunks: 2,
          scoopJid: 'cone',
        })
      ).toBeNull();
      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: serialized.slice(mid),
          chunkIndex: 1,
          totalChunks: 2,
          scoopJid: 'cone',
        })
      ).toEqual(original);
    });

    it('handles out-of-order chunk delivery', () => {
      const original = {
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: 1 }] as ChatMessage[],
        scoopJid: 'cone',
      };
      const serialized = JSON.stringify(original);
      const third = Math.ceil(serialized.length / 3);
      const buffers = new Map();

      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: serialized.slice(2 * third),
          chunkIndex: 2,
          totalChunks: 3,
          scoopJid: 'cone',
        })
      ).toBeNull();
      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: serialized.slice(0, third),
          chunkIndex: 0,
          totalChunks: 3,
          scoopJid: 'cone',
        })
      ).toBeNull();
      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: serialized.slice(third, 2 * third),
          chunkIndex: 1,
          totalChunks: 3,
          scoopJid: 'cone',
        })
      ).toEqual(original);
    });

    it('ignores duplicate chunk deliveries', () => {
      const original = { messages: [] as ChatMessage[], scoopJid: 'cone' };
      const serialized = JSON.stringify(original);
      const mid = Math.ceil(serialized.length / 2);
      const buffers = new Map();

      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: serialized.slice(0, mid),
          chunkIndex: 0,
          totalChunks: 2,
          scoopJid: 'cone',
        })
      ).toBeNull();
      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: serialized.slice(0, mid),
          chunkIndex: 0,
          totalChunks: 2,
          scoopJid: 'cone',
        })
      ).toBeNull();
      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: serialized.slice(mid),
          chunkIndex: 1,
          totalChunks: 2,
          scoopJid: 'cone',
        })
      ).toEqual(original);
    });

    it('returns empty messages on corrupt JSON', () => {
      const buffers = new Map();
      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: '{"messages":',
          chunkIndex: 0,
          totalChunks: 2,
          scoopJid: 'cone',
        })
      ).toBeNull();
      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: 'INVALID}}}',
          chunkIndex: 1,
          totalChunks: 2,
          scoopJid: 'cone',
        })
      ).toEqual({ messages: [], scoopJid: 'cone' });
    });

    it('keeps concurrent snapshots for different cones isolated', () => {
      const primary = {
        messages: [
          { id: 'p', role: 'assistant', content: 'PRIMARY', timestamp: 1 },
        ] as ChatMessage[],
        scoopJid: 'primary',
      };
      const reviewer = {
        messages: [
          { id: 'r', role: 'assistant', content: 'REVIEWER', timestamp: 1 },
        ] as ChatMessage[],
        scoopJid: 'reviewer',
      };
      const primaryJson = JSON.stringify(primary);
      const reviewerJson = JSON.stringify(reviewer);
      const midP = Math.ceil(primaryJson.length / 2);
      const midR = Math.ceil(reviewerJson.length / 2);
      const buffers = new Map();

      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: primaryJson.slice(0, midP),
          chunkIndex: 0,
          totalChunks: 2,
          scoopJid: 'primary',
        })
      ).toBeNull();
      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: reviewerJson.slice(0, midR),
          chunkIndex: 0,
          totalChunks: 2,
          scoopJid: 'reviewer',
        })
      ).toBeNull();
      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: primaryJson.slice(midP),
          chunkIndex: 1,
          totalChunks: 2,
          scoopJid: 'primary',
        })
      ).toEqual(primary);
      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: reviewerJson.slice(midR),
          chunkIndex: 1,
          totalChunks: 2,
          scoopJid: 'reviewer',
        })
      ).toEqual(reviewer);
    });

    it('starts a fresh assembly when totalChunks changes for the same cone', () => {
      const original = {
        messages: [{ id: '1', role: 'user', content: 'hello', timestamp: 1 }] as ChatMessage[],
        scoopJid: 'cone',
      };
      const serialized = JSON.stringify(original);
      const mid = Math.ceil(serialized.length / 2);
      const buffers = new Map();

      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: serialized.slice(0, Math.ceil(serialized.length / 3)),
          chunkIndex: 0,
          totalChunks: 3,
          scoopJid: 'cone',
        })
      ).toBeNull();
      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: serialized.slice(0, mid),
          chunkIndex: 0,
          totalChunks: 2,
          scoopJid: 'cone',
        })
      ).toBeNull();
      expect(
        reassembleSnapshot(buffers, {
          type: 'snapshot_chunk',
          chunkData: serialized.slice(mid),
          chunkIndex: 1,
          totalChunks: 2,
          scoopJid: 'cone',
        })
      ).toEqual(original);
    });

    it('round-trips with sendSnapshot for large payloads', () => {
      const sent: LeaderToFollowerMessage[] = [];
      const channel = {
        send: (msg: LeaderToFollowerMessage) => {
          sent.push(msg);
          return true;
        },
      };

      const bigContent = 'z'.repeat(3000);
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 40; i++) {
        messages.push({
          id: `m${i}`,
          role: 'user',
          content: bigContent,
          timestamp: i,
        } as ChatMessage);
      }

      sendSnapshot(channel, messages, 'test-scoop');

      expect(sent.every((m) => m.type === 'snapshot_chunk')).toBe(true);

      const buffers = new Map();
      let result: { messages: ChatMessage[]; scoopJid: string } | null = null;
      for (const msg of sent) {
        const assembled = reassembleSnapshot(
          buffers,
          msg as Extract<LeaderToFollowerMessage, { type: 'snapshot_chunk' }>
        );
        if (assembled) result = assembled;
      }

      expect(result).not.toBeNull();
      expect(result!.messages).toEqual(messages);
      expect(result!.scoopJid).toBe('test-scoop');
    });
  });

  describe('cherry target tagging', () => {
    it('RemoteTargetInfo carries kind and capabilities', () => {
      const t: RemoteTargetInfo = {
        targetId: 't1',
        title: 'Host',
        url: 'https://host.example',
        kind: 'cherry',
        capabilities: { navigate: true, network: false, screenshot: true },
      };
      expect(t.kind).toBe('cherry');
      expect(t.capabilities?.network).toBe(false);
    });

    it('isCherrySliccEventMessage narrows the union', () => {
      expect(
        isCherrySliccEventMessage({
          type: 'cherry.slicc_event',
          targetId: 't1',
          name: 'open-url',
          detail: { url: 'https://x' },
        })
      ).toBe(true);
      expect(isCherrySliccEventMessage({ type: 'cdp.request' })).toBe(false);
    });

    it('isCherryHostEventMessage narrows the union', () => {
      expect(
        isCherryHostEventMessage({
          type: 'cherry.host_event',
          targetId: 't1',
          name: 'checkout',
          detail: {},
        })
      ).toBe(true);
      expect(isCherryHostEventMessage({ type: 'cherry.slicc_event' })).toBe(false);
    });
  });
});
