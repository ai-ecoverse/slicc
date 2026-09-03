import { describe, expect, it } from 'vitest';
import type {
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
  sendCDPResponse,
  TRAY_SYNC_PROTOCOL_VERSION,
  unhandledProtocolMessage,
} from '../src/tray-sync-protocol.js';

describe('tray-sync-protocol', () => {
  it('exposes protocol version 8 and the cherry runtime tag', () => {
    // v6 added `tab.teleport.request` (follower-initiated state-carrying tab
    // pull). v8 says this peer derives a unit's role from `ScoopSummary.parentId`
    // and does not need the deprecated `isCone` flag (#2358). The Swift mirror
    // asserts the same constant — bump both together.
    expect(TRAY_SYNC_PROTOCOL_VERSION).toBe(8);
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

      // First chunk arrives
      reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-4',
        chunkData: '{"partial":',
        chunkIndex: 0,
        totalChunks: 2,
      });
      expect(buffers.size).toBe(1);

      // Error arrives for the same request
      const result = reassembleCDPResponse(buffers, {
        type: 'cdp.response',
        requestId: 'req-4',
        error: 'Failed to send chunk 1',
        chunkIndex: 1,
        totalChunks: 2,
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

      // Complete with chunk 1
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
});
