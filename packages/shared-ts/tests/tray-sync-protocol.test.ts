import { describe, expect, it } from 'vitest';
import type {
  ComputerNativeFrameMessage,
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
  TraySyncMessage,
} from '../src/tray-sync-protocol.js';
import {
  CDP_CHUNK_THRESHOLD,
  CHERRY_RUNTIME_TAG,
  isCherryHostEventMessage,
  isCherrySliccEventMessage,
  reassembleCDPResponse,
  reassembleComputerFrame,
  reassembleComputerNativeFrame,
  sendCDPResponse,
  sendComputerFrame,
  sendComputerNativeFrame,
  TRAY_MAX_CHUNK_COUNT,
  TRAY_MAX_PENDING_REASSEMBLIES,
  TRAY_SEND_HIGH_WATER_BYTES,
  TRAY_SYNC_PROTOCOL_VERSION,
  unhandledProtocolMessage,
} from '../src/tray-sync-protocol.js';

describe('tray-sync-protocol', () => {
  it('exposes protocol version 8 and the cherry runtime tag', () => {
    expect(TRAY_SYNC_PROTOCOL_VERSION).toBe(10);
    expect(CHERRY_RUNTIME_TAG).toBe('slicc-cherry');
  });

  it('includes model catalog and selection state in leader messages', () => {
    const messages: LeaderToFollowerMessage[] = [
      {
        type: 'models.list',
        models: [
          {
            providerName: 'Example Provider',
            modelId: 'example:reasoner',
            modelName: 'Reasoner',
            reasoning: true,
          },
        ],
      },
      {
        type: 'model.state',
        state: {
          activeModelId: 'example:reasoner',
          scoopJid: 'scoop@example',
          thinkingLevel: 'xhigh',
          effortOverride: 'max',
        },
      },
    ];

    expect(messages.map((message) => message.type)).toEqual(['models.list', 'model.state']);
  });

  it('includes model catalog requests and model/thinking selection in follower messages', () => {
    const messages: FollowerToLeaderMessage[] = [
      { type: 'models.request' },
      { type: 'model.select', modelId: 'example:reasoner' },
      {
        type: 'thinking.set',
        scoopJid: 'scoop@example',
        thinkingLevel: 'xhigh',
        effortOverride: 'max',
      },
    ];

    expect(messages.map((message) => message.type)).toEqual([
      'models.request',
      'model.select',
      'thinking.set',
    ]);
  });

  describe('isCherryHostEventMessage', () => {
    it('accepts a cherry.host_event message', () => {
      expect(
        isCherryHostEventMessage({ type: 'cherry.host_event', targetId: 't1', name: 'ready' })
      ).toBe(true);
    });

    it('rejects other message types, null, and non-objects', () => {
      expect(isCherryHostEventMessage({ type: 'cherry.slicc_event' })).toBe(false);
      expect(isCherryHostEventMessage({ type: 'ping' })).toBe(false);
      expect(isCherryHostEventMessage(null)).toBe(false);
      expect(isCherryHostEventMessage('cherry.host_event')).toBe(false);
      expect(isCherryHostEventMessage(undefined)).toBe(false);
    });
  });

  describe('isCherrySliccEventMessage', () => {
    it('accepts a cherry.slicc_event message', () => {
      expect(
        isCherrySliccEventMessage({ type: 'cherry.slicc_event', targetId: 't1', name: 'go' })
      ).toBe(true);
    });

    it('rejects other message types, null, and non-objects', () => {
      expect(isCherrySliccEventMessage({ type: 'cherry.host_event' })).toBe(false);
      expect(isCherrySliccEventMessage(null)).toBe(false);
      expect(isCherrySliccEventMessage(42)).toBe(false);
    });
  });

  describe('unhandledProtocolMessage', () => {
    it('returns the message without throwing (version-skewed peers are legitimate)', () => {
      const skewed = { type: 'future.message' } as never;
      expect(unhandledProtocolMessage(skewed)).toEqual({ type: 'future.message' });
    });
  });

  describe('sendCDPResponse', () => {
    it('sends small responses as a single message without chunking', () => {
      const sent: TraySyncMessage[] = [];
      const channel = {
        send: (msg: TraySyncMessage) => {
          sent.push(msg);
          return true;
        },
      };

      const result = { data: 'small' };
      sendCDPResponse(channel, 'req-1', result);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({ type: 'cdp.response', requestId: 'req-1', result });
    });

    it('sends error responses directly without chunking', () => {
      const sent: TraySyncMessage[] = [];
      const channel = {
        send: (msg: TraySyncMessage) => {
          sent.push(msg);
          return true;
        },
      };

      sendCDPResponse(channel, 'req-1', undefined, 'Something broke');

      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        type: 'cdp.response',
        requestId: 'req-1',
        result: undefined,
        error: 'Something broke',
      });
    });

    it('chunks large responses and includes chunkIndex/totalChunks', () => {
      const sent: TraySyncMessage[] = [];
      const channel = {
        send: (msg: TraySyncMessage) => {
          sent.push(msg);
          return true;
        },
      };

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

          return sendCount !== 2;
        },
      };

      const largePayload = 'y'.repeat(CDP_CHUNK_THRESHOLD + 1000);
      sendCDPResponse(channel, 'req-fail', { data: largePayload });

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
      const channel = {
        send: () => {
          sendCount++;
          return sendCount !== 2;
        },
      };
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

      const r1 = reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-2',
        chunkData: serialized.slice(0, mid),
        chunkIndex: 0,
        totalChunks: 2,
      });
      expect(r1).toBeNull();
      expect(buffers.size).toBe(1);

      const r2 = reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-2',
        chunkData: serialized.slice(mid),
        chunkIndex: 1,
        totalChunks: 2,
      });
      expect(r2).toEqual({ result: original });
      expect(buffers.size).toBe(0);
    });

    it('handles out-of-order chunk delivery', () => {
      const buffers = new Map();
      const original = { a: 1, b: 2, c: 3 };
      const serialized = JSON.stringify(original);
      const third = Math.ceil(serialized.length / 3);

      expect(
        reassembleCDPResponse(buffers, {
          type: 'cdp.response',
          requestId: 'req-3',
          chunkData: serialized.slice(2 * third),
          chunkIndex: 2,
          totalChunks: 3,
        })
      ).toBeNull();

      expect(
        reassembleCDPResponse(buffers, {
          type: 'cdp.response',
          requestId: 'req-3',
          chunkData: serialized.slice(0, third),
          chunkIndex: 0,
          totalChunks: 3,
        })
      ).toBeNull();

      const result = reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-3',
        chunkData: serialized.slice(third, 2 * third),
        chunkIndex: 1,
        totalChunks: 3,
      });
      expect(result).toEqual({ result: original });
    });

    it('handles error during chunked transfer', () => {
      const buffers = new Map();

      reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-4',
        chunkData: '{"partial":',
        chunkIndex: 0,
        totalChunks: 2,
      });
      expect(buffers.size).toBe(1);

      const result = reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-4',
        error: 'Failed to send chunk 1',
        chunkIndex: 1,
        totalChunks: 2,
      });
      expect(result).toEqual({ error: 'Failed to send chunk 1' });
      expect(buffers.size).toBe(0);
    });

    it('ignores duplicate chunk deliveries', () => {
      const buffers = new Map();
      const original = { dup: 'test' };
      const serialized = JSON.stringify(original);
      const mid = Math.ceil(serialized.length / 2);

      reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-5',
        chunkData: serialized.slice(0, mid),
        chunkIndex: 0,
        totalChunks: 2,
      });
      reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-5',
        chunkData: serialized.slice(0, mid),
        chunkIndex: 0,
        totalChunks: 2,
      });

      const result = reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-5',
        chunkData: serialized.slice(mid),
        chunkIndex: 1,
        totalChunks: 2,
      });
      expect(result).toEqual({ result: original });
    });

    it('reports a parse failure when the reassembled chunks are not valid JSON', () => {
      const buffers = new Map();
      reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-6',
        chunkData: '{"broken":',
        chunkIndex: 0,
        totalChunks: 2,
      });
      const result = reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-6',
        chunkData: 'nope',
        chunkIndex: 1,
        totalChunks: 2,
      });
      expect(result?.error).toContain('Failed to reassemble CDP response');
      expect(buffers.size).toBe(0);
    });
  });

  describe('sendComputerFrame', () => {
    it('sends a small frame as a single computer.frame', () => {
      const sent: TraySyncMessage[] = [];
      const channel = {
        send: (msg: TraySyncMessage) => {
          sent.push(msg);
          return true;
        },
      };
      sendComputerFrame(channel, {
        id: 'jsh:fake',
        seq: 1,
        mime: 'image/jpeg',
        width: 8,
        height: 8,
        data: 'QUJD',
      });
      expect(sent).toEqual([
        {
          type: 'computer.frame',
          id: 'jsh:fake',
          seq: 1,
          mime: 'image/jpeg',
          width: 8,
          height: 8,
          data: 'QUJD',
        },
      ]);
    });

    it('chunks an oversize frame and reassembles it', () => {
      const sent: TraySyncMessage[] = [];
      const channel = {
        send: (msg: TraySyncMessage) => {
          sent.push(msg);
          return true;
        },
      };
      const data = 'x'.repeat(CDP_CHUNK_THRESHOLD + 10);
      sendComputerFrame(channel, {
        id: 'jsh:fake',
        seq: 2,
        mime: 'image/png',
        width: 16,
        height: 16,
        data,
      });
      expect(sent.length).toBeGreaterThan(1);
      expect(sent.every((m) => m.type === 'computer.frame')).toBe(true);
      const buffers = new Map();
      let assembled: ReturnType<typeof reassembleComputerFrame> = null;
      for (const msg of sent) {
        if (msg.type !== 'computer.frame') continue;
        assembled = reassembleComputerFrame(buffers, msg);
      }
      expect(assembled).toEqual({
        type: 'computer.frame',
        id: 'jsh:fake',
        seq: 2,
        mime: 'image/png',
        width: 16,
        height: 16,
        data,
      });
    });

    it('refuses to semantic-chunk a frame when the channel is past high-water', () => {
      const sent: TraySyncMessage[] = [];
      const channel = {
        bufferedAmount: TRAY_SEND_HIGH_WATER_BYTES,
        send: (msg: TraySyncMessage) => {
          sent.push(msg);
          return true;
        },
      };
      const ok = sendComputerFrame(channel, {
        id: 'jsh:fake',
        seq: 3,
        mime: 'image/jpeg',
        width: 16,
        height: 16,
        data: 'x'.repeat(CDP_CHUNK_THRESHOLD + 10),
      });
      expect(ok).toBe(false);
      expect(sent).toEqual([]);
    });
  });

  describe('sendComputerNativeFrame', () => {
    it('sends a small native frame as a single computer.native.frame', () => {
      const sent: TraySyncMessage[] = [];
      const channel = {
        send: (msg: TraySyncMessage) => {
          sent.push(msg);
          return true;
        },
      };
      sendComputerNativeFrame(channel, {
        requestId: 'cap-1',
        seq: 1,
        mime: 'image/jpeg',
        width: 8,
        height: 8,
        nativeWidth: 1440,
        nativeHeight: 900,
        data: 'QUJD',
      });
      expect(sent).toEqual([
        {
          type: 'computer.native.frame',
          requestId: 'cap-1',
          seq: 1,
          mime: 'image/jpeg',
          width: 8,
          height: 8,
          nativeWidth: 1440,
          nativeHeight: 900,
          data: 'QUJD',
        },
      ]);
    });

    it('chunks an oversize native frame and reassembles it', () => {
      const sent: TraySyncMessage[] = [];
      const channel = {
        send: (msg: TraySyncMessage) => {
          sent.push(msg);
          return true;
        },
      };
      const data = 'x'.repeat(CDP_CHUNK_THRESHOLD + 10);
      sendComputerNativeFrame(channel, {
        requestId: 'cap-1',
        seq: 2,
        mime: 'image/jpeg',
        width: 16,
        height: 16,
        nativeWidth: 1440,
        nativeHeight: 900,
        data,
      });
      expect(sent.length).toBeGreaterThan(1);
      expect(sent.every((m) => m.type === 'computer.native.frame')).toBe(true);
      const buffers = new Map();
      let assembled: ReturnType<typeof reassembleComputerNativeFrame> = null;
      for (const msg of sent) {
        if (msg.type !== 'computer.native.frame') continue;
        assembled = reassembleComputerNativeFrame(buffers, msg);
      }
      expect(assembled).toEqual({
        type: 'computer.native.frame',
        requestId: 'cap-1',
        seq: 2,
        mime: 'image/jpeg',
        width: 16,
        height: 16,
        nativeWidth: 1440,
        nativeHeight: 900,
        data,
      });
    });

    it('rejects peer-controlled totalChunks above the transport ceiling', () => {
      const buffers = new Map();
      const assembled = reassembleComputerNativeFrame(buffers, {
        type: 'computer.native.frame',
        requestId: 'cap-1',
        seq: 1,
        mime: 'image/jpeg',
        width: 8,
        height: 8,
        nativeWidth: 8,
        nativeHeight: 8,
        chunkData: 'AA',
        chunkIndex: 0,
        totalChunks: TRAY_MAX_CHUNK_COUNT + 1,
      });
      expect(assembled).toBeNull();
      expect(buffers.size).toBe(0);
    });

    it('evicts the oldest incomplete native frame when pending reassemblies overflow', () => {
      const buffers = new Map();
      for (let seq = 0; seq < TRAY_MAX_PENDING_REASSEMBLIES + 1; seq++) {
        reassembleComputerNativeFrame(buffers, {
          type: 'computer.native.frame',
          requestId: 'cap-1',
          seq,
          mime: 'image/jpeg',
          width: 8,
          height: 8,
          nativeWidth: 8,
          nativeHeight: 8,
          chunkData: 'AA',
          chunkIndex: 0,
          totalChunks: 2,
        });
      }
      expect(buffers.size).toBe(TRAY_MAX_PENDING_REASSEMBLIES);
      expect(buffers.has('cap-1:0')).toBe(false);
      const completed = reassembleComputerNativeFrame(buffers, {
        type: 'computer.native.frame',
        requestId: 'cap-1',
        seq: 0,
        mime: 'image/jpeg',
        width: 8,
        height: 8,
        nativeWidth: 8,
        nativeHeight: 8,
        chunkData: 'BB',
        chunkIndex: 1,
        totalChunks: 2,
      });
      expect(completed).toBeNull();
    });

    it('refuses to semantic-chunk a native frame when the channel is past high-water', () => {
      const sent: TraySyncMessage[] = [];
      const channel = {
        bufferedAmount: TRAY_SEND_HIGH_WATER_BYTES,
        send: (msg: TraySyncMessage) => {
          sent.push(msg);
          return true;
        },
      };
      const ok = sendComputerNativeFrame(channel, {
        requestId: 'cap-1',
        seq: 3,
        mime: 'image/jpeg',
        width: 16,
        height: 16,
        nativeWidth: 1440,
        nativeHeight: 900,
        data: 'x'.repeat(CDP_CHUNK_THRESHOLD + 10),
      });
      expect(ok).toBe(false);
      expect(sent).toEqual([]);
    });

    it('stops chunking a native frame when a send fails', () => {
      const sent: TraySyncMessage[] = [];
      const channel = {
        send: (msg: TraySyncMessage) => {
          sent.push(msg);
          return sent.length < 2;
        },
      };
      const ok = sendComputerNativeFrame(channel, {
        requestId: 'cap-1',
        seq: 4,
        mime: 'image/jpeg',
        width: 16,
        height: 16,
        nativeWidth: 1440,
        nativeHeight: 900,
        data: 'x'.repeat(CDP_CHUNK_THRESHOLD + CDP_CHUNK_THRESHOLD),
      });
      expect(ok).toBe(false);
      expect(sent.length).toBe(2);
    });
  });

  describe('reassembleComputerNativeFrame', () => {
    const tight = { maxChunkCount: 4, maxPending: 2, maxBytes: 8 };

    function nativeChunk(
      overrides: Partial<ComputerNativeFrameMessage> &
        Pick<ComputerNativeFrameMessage, 'seq' | 'chunkIndex' | 'totalChunks'>
    ): ComputerNativeFrameMessage {
      return {
        type: 'computer.native.frame',
        requestId: 'cap-1',
        mime: 'image/jpeg',
        width: 8,
        height: 8,
        nativeWidth: 8,
        nativeHeight: 8,
        chunkData: 'AA',
        ...overrides,
      };
    }

    it('returns an unchunked native frame as-is', () => {
      const message: ComputerNativeFrameMessage = {
        type: 'computer.native.frame',
        requestId: 'cap-1',
        seq: 1,
        mime: 'image/jpeg',
        width: 8,
        height: 8,
        nativeWidth: 8,
        nativeHeight: 8,
        data: 'QUJD',
      };
      expect(reassembleComputerNativeFrame(new Map(), message)).toBe(message);
    });

    it('rejects malformed chunk counts and indices', () => {
      const buffers = new Map();
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 1, chunkIndex: 0, totalChunks: 0 })
        )
      ).toBeNull();
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 1, chunkIndex: 0, totalChunks: 1.5 })
        )
      ).toBeNull();
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 1, chunkIndex: -1, totalChunks: 2 })
        )
      ).toBeNull();
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 1, chunkIndex: 2, totalChunks: 2 })
        )
      ).toBeNull();
      expect(buffers.size).toBe(0);
    });

    it('assembles out-of-order chunks and ignores duplicates', () => {
      const buffers = new Map();
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 1, chunkIndex: 1, totalChunks: 2, chunkData: 'BB' })
        )
      ).toBeNull();
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 1, chunkIndex: 1, totalChunks: 2, chunkData: 'XX' })
        )
      ).toBeNull();
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 1, chunkIndex: 0, totalChunks: 2, chunkData: 'AA' })
        )
      ).toEqual({
        type: 'computer.native.frame',
        requestId: 'cap-1',
        seq: 1,
        mime: 'image/jpeg',
        width: 8,
        height: 8,
        nativeWidth: 8,
        nativeHeight: 8,
        data: 'AABB',
      });
      expect(buffers.size).toBe(0);
    });

    it('restarts when a later chunk redeclares totalChunks', () => {
      const buffers = new Map();
      reassembleComputerNativeFrame(
        buffers,
        nativeChunk({ seq: 1, chunkIndex: 0, totalChunks: 2, chunkData: 'AA' })
      );
      expect(buffers.get('cap-1:1')?.totalChunks).toBe(2);
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 1, chunkIndex: 0, totalChunks: 3, chunkData: 'AA' })
        )
      ).toBeNull();
      expect(buffers.get('cap-1:1')?.totalChunks).toBe(3);
      expect(buffers.get('cap-1:1')?.received).toBe(1);
    });

    it('holds a partial whose chunkData is missing', () => {
      const buffers = new Map();
      expect(
        reassembleComputerNativeFrame(buffers, {
          type: 'computer.native.frame',
          requestId: 'cap-1',
          seq: 1,
          mime: 'image/jpeg',
          width: 8,
          height: 8,
          nativeWidth: 8,
          nativeHeight: 8,
          chunkIndex: 0,
          totalChunks: 2,
        })
      ).toBeNull();
      expect(buffers.size).toBe(1);
      expect(buffers.get('cap-1:1')?.received).toBe(0);
    });

    it('refuses a first chunk that already exceeds the byte cap', () => {
      const buffers = new Map();
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 1, chunkIndex: 0, totalChunks: 2, chunkData: 'TOO-BIG!!' }),
          tight
        )
      ).toBeNull();
      expect(buffers.size).toBe(0);
    });

    it('evicts the current partial when a later chunk overflows the byte cap', () => {
      const buffers = new Map();
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 1, chunkIndex: 0, totalChunks: 2, chunkData: 'AAAA' }),
          tight
        )
      ).toBeNull();
      expect(buffers.size).toBe(1);
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 1, chunkIndex: 1, totalChunks: 2, chunkData: 'BBBBBBBB' }),
          tight
        )
      ).toBeNull();
      expect(buffers.size).toBe(0);
    });

    it('evicts an older partial so a later chunk can finish the current frame', () => {
      const buffers = new Map();
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 1, chunkIndex: 0, totalChunks: 2, chunkData: 'AAAA' }),
          tight
        )
      ).toBeNull();
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 2, chunkIndex: 0, totalChunks: 2, chunkData: 'AAAA' }),
          tight
        )
      ).toBeNull();
      expect(
        reassembleComputerNativeFrame(
          buffers,
          nativeChunk({ seq: 2, chunkIndex: 1, totalChunks: 2, chunkData: 'BB' }),
          tight
        )
      ).toEqual({
        type: 'computer.native.frame',
        requestId: 'cap-1',
        seq: 2,
        mime: 'image/jpeg',
        width: 8,
        height: 8,
        nativeWidth: 8,
        nativeHeight: 8,
        data: 'AAAABB',
      });
      expect(buffers.has('cap-1:1')).toBe(false);
    });
    const leader: LeaderToFollowerMessage[] = [
      { type: 'computers.list', computers: [] },
      {
        type: 'computer.frame',
        id: 'jsh:x',
        seq: 1,
        mime: 'image/jpeg',
        width: 1,
        height: 1,
        data: 'AA',
      },
      { type: 'computer.native.capture', requestId: 'r1' },
      { type: 'computer.native.unwatch' },
      {
        type: 'computer.native.input',
        requestId: 'r1',
        events: [{ type: 'wait', ms: 1 }],
      },
    ];
    const follower: FollowerToLeaderMessage[] = [
      { type: 'computer.watch', id: 'jsh:x' },
      { type: 'computer.unwatch', id: 'jsh:x' },
      { type: 'computer.input', id: 'jsh:x', events: [{ type: 'text', text: 'a' }] },
      {
        type: 'computer.native.frame',
        requestId: 'r',
        seq: 1,
        mime: 'image/jpeg',
        width: 1,
        height: 1,
        nativeWidth: 1,
        nativeHeight: 1,
        data: 'AA',
      },
      { type: 'computer.native.error', requestId: 'r', error: 'denied' },
      { type: 'computer.native.input.result', requestId: 'r' },
      { type: 'computer.native.input.result', requestId: 'r', error: 'denied' },
    ];
    expect(leader.map((m) => m.type)).toEqual([
      'computers.list',
      'computer.frame',
      'computer.native.capture',
      'computer.native.unwatch',
      'computer.native.input',
    ]);
    expect(follower.map((m) => m.type)).toContain('computer.native.input.result');
  });
});
