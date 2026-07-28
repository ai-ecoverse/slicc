/**
 * Transport-level chunk framing (#1700).
 *
 * Before this, `TraySyncChannel.send` handed any message straight to
 * `RTCDataChannel.send()`. Chrome throws `TypeError: Trying to send message
 * larger than max-message-size` above `sctp.maxMessageSize` (262144 in Chrome
 * 152) and `OperationError: send queue is full` at ~16 MB buffered; both were
 * caught, logged, and reported through a return value every non-chunked caller
 * ignored. Followers silently never saw screenshots or large tool results.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type FollowerToLeaderMessage,
  frameChunks,
  type LeaderToFollowerMessage,
  TRAY_CHUNK_FRAME_TYPE,
  TRAY_DEFAULT_MAX_MESSAGE_BYTES,
  TRAY_MAX_MESSAGE_BYTES,
  TraySyncChannel,
} from '../../src/scoops/tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../../src/scoops/tray-webrtc.js';

/**
 * A channel that enforces the same limits a real `RTCDataChannel` does, so the
 * tests fail the way Chrome fails rather than the way a permissive double does.
 */
class LimitedDataChannel implements TrayDataChannelLike {
  readyState = 'open';
  readonly sent: string[] = [];
  bufferedAmount = 0;
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  constructor(
    private readonly maxMessageSize: number = TRAY_DEFAULT_MAX_MESSAGE_BYTES,
    private readonly reportLimit = true
  ) {}

  getMaxMessageSize(): number | undefined {
    return this.reportLimit ? this.maxMessageSize : undefined;
  }

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    const bytes = new TextEncoder().encode(data).length;
    if (bytes > this.maxMessageSize) {
      throw new TypeError('Trying to send message larger than max-message-size');
    }
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
  }

  /** Replay everything this channel sent into a peer, as the transport would. */
  deliverTo(peer: LimitedDataChannel): void {
    for (const data of this.sent) peer.simulateMessage(data);
  }

  simulateMessage(data: string): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data });
  }
}

/**
 * A high surrogate not followed by a low one, or a low surrogate not preceded
 * by a high one — i.e. half of an astral character. `JSON.stringify` emits
 * these as lone `\udXXX` escapes, which Go decodes to U+FFFD.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function bigEvent(bytes: number, scoopJid = 'cone'): LeaderToFollowerMessage {
  return {
    type: 'agent_event',
    event: { type: 'tool_result', messageId: 'm1', toolName: 'bash', result: 'x'.repeat(bytes) },
    scoopJid,
  };
}

describe('tray sync transport chunking', () => {
  describe('frameChunks', () => {
    it('keeps every frame within the transport limit, measured in bytes', () => {
      // CJK: 1 UTF-16 unit but 3 UTF-8 bytes. The pre-existing per-type
      // chunkers compare `.length` against a byte budget and under-count these
      // 3x; framing must not inherit that.
      const payload = JSON.stringify({ text: '\u6f22'.repeat(120_000) });
      const frames = frameChunks(payload, TRAY_DEFAULT_MAX_MESSAGE_BYTES, 'fixed');

      expect(frames.length).toBeGreaterThan(1);
      for (const frame of frames) {
        const bytes = new TextEncoder().encode(JSON.stringify(frame)).length;
        expect(bytes).toBeLessThanOrEqual(TRAY_DEFAULT_MAX_MESSAGE_BYTES);
      }
    });

    it('round-trips the payload exactly', () => {
      const payload = JSON.stringify({ mixed: `a"\\b${'\u6f22'.repeat(50_000)}\u{1f366}` });
      const frames = frameChunks(payload, TRAY_DEFAULT_MAX_MESSAGE_BYTES, 'fixed');
      expect(frames.map((f) => f.chunkData).join('')).toBe(payload);
    });

    it('never splits a surrogate pair across frames', () => {
      // JS slicing is by UTF-16 code unit, so an astral character can be cut in
      // half. JSON.stringify emits each half as a lone \udXXX escape; JS rejoins
      // those losslessly (so a same-runtime round-trip is blind to this), but
      // Go's encoding/json decodes an unpaired escape to U+FFFD and the
      // character arrives destroyed. Assert well-formedness per frame, which is
      // what a non-JS decoder actually requires.
      const unitsPerChunk = Math.floor((TRAY_DEFAULT_MAX_MESSAGE_BYTES - 512) / 4);
      // Place an emoji so its two halves straddle the first cut exactly.
      const payload = `${'a'.repeat(unitsPerChunk - 1)}\u{1f366}${'b'.repeat(unitsPerChunk)}`;

      const frames = frameChunks(payload, TRAY_DEFAULT_MAX_MESSAGE_BYTES, 'surrogate');

      expect(frames.length).toBeGreaterThan(1);
      for (const frame of frames) {
        expect(LONE_SURROGATE.test(frame.chunkData), `frame ${frame.chunkIndex}`).toBe(false);
      }
      expect(frames.map((f) => f.chunkData).join('')).toBe(payload);
    });

    it('keeps frames well-formed with astral characters at many offsets', () => {
      // Emoji every 7 units guarantees some land on a boundary regardless of
      // how the chunk size is tuned.
      const payload = `${'\u{1f366}xxxxx'.repeat(30_000)}`;

      for (const frame of frameChunks(payload, TRAY_DEFAULT_MAX_MESSAGE_BYTES, 'astral')) {
        expect(LONE_SURROGATE.test(frame.chunkData), `frame ${frame.chunkIndex}`).toBe(false);
      }
    });

    it('numbers frames consistently and shares one chunkId', () => {
      const frames = frameChunks('y'.repeat(200_000), TRAY_DEFAULT_MAX_MESSAGE_BYTES, 'shared-id');
      expect(new Set(frames.map((f) => f.chunkId))).toEqual(new Set(['shared-id']));
      expect(frames.map((f) => f.chunkIndex)).toEqual(frames.map((_, i) => i));
      for (const frame of frames) expect(frame.totalChunks).toBe(frames.length);
    });

    it('emits a single frame for an empty payload rather than none', () => {
      expect(frameChunks('', TRAY_DEFAULT_MAX_MESSAGE_BYTES, 'e')).toHaveLength(1);
    });
  });

  describe('send', () => {
    it('sends a small message unframed', () => {
      const dc = new LimitedDataChannel();
      const sync = new TraySyncChannel<LeaderToFollowerMessage>(dc);

      expect(sync.send({ type: 'ping' } as LeaderToFollowerMessage)).toBe(true);
      expect(dc.sent).toHaveLength(1);
      expect(JSON.parse(dc.sent[0]!).type).toBe('ping');
    });

    it('frames an oversize message instead of dropping it', () => {
      // 400 KB: over Chrome 152's real 262144 ceiling. Pre-fix this threw
      // inside send(), got logged, and returned false that nobody checked.
      const dc = new LimitedDataChannel(262_144);
      const sync = new TraySyncChannel<LeaderToFollowerMessage>(dc);

      expect(sync.send(bigEvent(400_000))).toBe(true);
      expect(dc.sent.length).toBeGreaterThan(1);
      for (const raw of dc.sent) expect(JSON.parse(raw).type).toBe(TRAY_CHUNK_FRAME_TYPE);
    });

    it('frames a message that only exceeds the limit once encoded as UTF-8', () => {
      // 30k CJK characters: 30k UTF-16 units but 90k UTF-8 bytes. SCTP measures
      // bytes, so deciding with `.length` sends this unframed and the transport
      // rejects it — the under-counting bug the pre-existing per-type chunkers
      // still carry.
      const dc = new LimitedDataChannel(TRAY_DEFAULT_MAX_MESSAGE_BYTES);
      const sync = new TraySyncChannel<LeaderToFollowerMessage>(dc);
      const message: LeaderToFollowerMessage = {
        type: 'agent_event',
        event: { type: 'content_delta', messageId: 'm1', text: '\u6f22'.repeat(30_000) },
        scoopJid: 'cone',
      };

      expect(JSON.stringify(message).length).toBeLessThan(TRAY_DEFAULT_MAX_MESSAGE_BYTES);
      expect(sync.send(message)).toBe(true);
      expect(dc.sent.length).toBeGreaterThan(1);
    });

    it('falls back to the RFC 8831 floor when the transport reports no limit', () => {
      const dc = new LimitedDataChannel(TRAY_DEFAULT_MAX_MESSAGE_BYTES, false);
      const sync = new TraySyncChannel<LeaderToFollowerMessage>(dc);

      // Would throw if it assumed a larger limit than the channel enforces.
      expect(sync.send(bigEvent(200_000))).toBe(true);
      expect(dc.sent.length).toBeGreaterThan(1);
    });

    it('uses the larger negotiated limit when the transport reports one', () => {
      const small = new LimitedDataChannel(TRAY_DEFAULT_MAX_MESSAGE_BYTES);
      const large = new LimitedDataChannel(262_144);
      new TraySyncChannel<LeaderToFollowerMessage>(small).send(bigEvent(400_000));
      new TraySyncChannel<LeaderToFollowerMessage>(large).send(bigEvent(400_000));

      expect(large.sent.length).toBeLessThan(small.sent.length);
    });

    it('refuses past the hard cap instead of flooding the buffer', () => {
      const dc = new LimitedDataChannel(262_144);
      const sync = new TraySyncChannel<LeaderToFollowerMessage>(dc);

      expect(sync.send(bigEvent(TRAY_MAX_MESSAGE_BYTES + 1))).toBe(false);
      expect(dc.sent).toHaveLength(0);
    });

    it('refuses a chunked send while the channel is congested', () => {
      const dc = new LimitedDataChannel(262_144);
      dc.bufferedAmount = 8 * 1024 * 1024;
      const sync = new TraySyncChannel<LeaderToFollowerMessage>(dc);

      expect(sync.send(bigEvent(400_000))).toBe(false);
      expect(dc.sent).toHaveLength(0);
    });

    it('still passes small messages while congested, so keepalive survives', () => {
      // A congested peer must not be mistaken for a dead one (#1696).
      const dc = new LimitedDataChannel(262_144);
      dc.bufferedAmount = 8 * 1024 * 1024;
      const sync = new TraySyncChannel<LeaderToFollowerMessage>(dc);

      expect(sync.send({ type: 'ping' } as LeaderToFollowerMessage)).toBe(true);
    });

    it('reports failure when a frame is rejected part-way', () => {
      const dc = new LimitedDataChannel(262_144);
      const sync = new TraySyncChannel<LeaderToFollowerMessage>(dc);
      let calls = 0;
      vi.spyOn(dc, 'send').mockImplementation(() => {
        calls++;
        if (calls > 2) throw new Error('InvalidStateError');
      });

      expect(sync.send(bigEvent(400_000))).toBe(false);
    });
  });

  describe('receive', () => {
    it('reassembles a framed message transparently', () => {
      const leaderChannel = new LimitedDataChannel(262_144);
      const followerChannel = new LimitedDataChannel(262_144);
      const leader = new TraySyncChannel<LeaderToFollowerMessage>(leaderChannel);
      const follower = new TraySyncChannel<FollowerToLeaderMessage, LeaderToFollowerMessage>(
        followerChannel
      );

      const received: LeaderToFollowerMessage[] = [];
      follower.onMessage((m) => received.push(m));

      const sent = bigEvent(400_000);
      expect(leader.send(sent)).toBe(true);
      leaderChannel.deliverTo(followerChannel);

      // Listeners see the original message, never the framing.
      expect(received).toEqual([sent]);
    });

    it('reassembles out-of-order frames', () => {
      const dc = new LimitedDataChannel(262_144);
      const sync = new TraySyncChannel<LeaderToFollowerMessage, LeaderToFollowerMessage>(dc);
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage((m) => received.push(m));

      const message = bigEvent(200_000);
      const frames = frameChunks(JSON.stringify(message), 262_144, 'ooo');
      for (const frame of [...frames].reverse()) dc.simulateMessage(JSON.stringify(frame));

      expect(received).toEqual([message]);
    });

    it('ignores duplicate frames', () => {
      const dc = new LimitedDataChannel(262_144);
      const sync = new TraySyncChannel<LeaderToFollowerMessage, LeaderToFollowerMessage>(dc);
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage((m) => received.push(m));

      const message = bigEvent(200_000);
      const frames = frameChunks(JSON.stringify(message), 262_144, 'dup');
      for (const frame of frames) {
        dc.simulateMessage(JSON.stringify(frame));
        dc.simulateMessage(JSON.stringify(frame));
      }

      expect(received).toEqual([message]);
    });

    it('emits nothing until the final frame arrives', () => {
      const dc = new LimitedDataChannel(262_144);
      const sync = new TraySyncChannel<LeaderToFollowerMessage, LeaderToFollowerMessage>(dc);
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage((m) => received.push(m));

      const frames = frameChunks(JSON.stringify(bigEvent(200_000)), 262_144, 'partial');
      for (const frame of frames.slice(0, -1)) dc.simulateMessage(JSON.stringify(frame));

      expect(received).toEqual([]);
    });

    it('keeps concurrent reassemblies separate', () => {
      const dc = new LimitedDataChannel(262_144);
      const sync = new TraySyncChannel<LeaderToFollowerMessage, LeaderToFollowerMessage>(dc);
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage((m) => received.push(m));

      const first = bigEvent(200_000);
      const second = bigEvent(180_000, 'scoop-b');
      const a = frameChunks(JSON.stringify(first), 262_144, 'A');
      const b = frameChunks(JSON.stringify(second), 262_144, 'B');

      // Interleave the two streams.
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i]) dc.simulateMessage(JSON.stringify(a[i]));
        if (b[i]) dc.simulateMessage(JSON.stringify(b[i]));
      }

      expect(received).toHaveLength(2);
      expect(received).toContainEqual(first);
      expect(received).toContainEqual(second);
    });

    it('drops a single reassembly that grows past the per-message cap', () => {
      // The aggregate bound (32 MiB) is four times what any sender will emit,
      // so without a per-message cap one stream could climb to it. Go and Swift
      // cap per message; this keeps the three receivers consistent.
      const dc = new LimitedDataChannel(262_144);
      const sync = new TraySyncChannel<LeaderToFollowerMessage, LeaderToFollowerMessage>(dc);
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage((m) => received.push(m));

      // A *valid* message past the cap, framed as a foreign peer could send it
      // (our own sender refuses at this size). Without the cap this reassembles
      // and emits; with it, it is dropped.
      const oversize = bigEvent(TRAY_MAX_MESSAGE_BYTES + 1024);
      for (const frame of frameChunks(JSON.stringify(oversize), 262_144, 'flood')) {
        dc.simulateMessage(JSON.stringify(frame));
      }

      expect(received).toEqual([]);
    });

    it('drops incomplete reassemblies once too many are in flight', () => {
      const dc = new LimitedDataChannel(262_144);
      const sync = new TraySyncChannel<LeaderToFollowerMessage, LeaderToFollowerMessage>(dc);
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage((m) => received.push(m));

      // Start 10 messages (limit is 8) and finish none of them.
      const started = Array.from({ length: 10 }, (_, i) =>
        frameChunks(JSON.stringify(bigEvent(200_000)), 262_144, `id-${i}`)
      );
      for (const frames of started) dc.simulateMessage(JSON.stringify(frames[0]!));

      // The two oldest were evicted: completing the first emits nothing.
      for (const frame of started[0]!.slice(1)) dc.simulateMessage(JSON.stringify(frame));
      expect(received).toEqual([]);
    });

    it('drops a frame that re-declares totalChunks mid-message', () => {
      // Peer-controlled metadata must not resize a buffer already in flight.
      // The Go receiver panicked on exactly this shape before it was guarded.
      const dc = new LimitedDataChannel(262_144);
      const sync = new TraySyncChannel<LeaderToFollowerMessage, LeaderToFollowerMessage>(dc);
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage((m) => received.push(m));

      const frame = (chunkIndex: number, totalChunks: number, chunkData: string) =>
        JSON.stringify({
          type: TRAY_CHUNK_FRAME_TYPE,
          chunkId: 'x',
          chunkIndex,
          totalChunks,
          chunkData,
        });
      dc.simulateMessage(frame(0, 2, 'a'));
      dc.simulateMessage(frame(99, 100, 'b'));

      expect(received).toEqual([]);
    });

    it('rejects a frame claiming an excessive chunk count', () => {
      const dc = new LimitedDataChannel(262_144);
      const sync = new TraySyncChannel<LeaderToFollowerMessage, LeaderToFollowerMessage>(dc);
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage((m) => received.push(m));

      dc.simulateMessage(
        JSON.stringify({
          type: TRAY_CHUNK_FRAME_TYPE,
          chunkId: 'huge',
          chunkIndex: 0,
          totalChunks: 1_000_000_000,
          chunkData: 'a',
        })
      );
      dc.simulateMessage(JSON.stringify({ type: 'ping' }));

      // Rejected as malformed, and the channel keeps working.
      expect(received).toEqual([{ type: 'ping' }]);
    });

    it('ignores a malformed frame without disturbing the channel', () => {
      const dc = new LimitedDataChannel(262_144);
      const sync = new TraySyncChannel<LeaderToFollowerMessage, LeaderToFollowerMessage>(dc);
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage((m) => received.push(m));

      dc.simulateMessage(
        JSON.stringify({
          type: TRAY_CHUNK_FRAME_TYPE,
          chunkId: 'bad',
          chunkIndex: 5,
          totalChunks: 2,
          chunkData: 'x',
        })
      );
      dc.simulateMessage(JSON.stringify({ type: 'ping' }));

      expect(received).toEqual([{ type: 'ping' }]);
    });

    it('clears in-flight reassemblies on close', () => {
      const dc = new LimitedDataChannel(262_144);
      const sync = new TraySyncChannel<LeaderToFollowerMessage, LeaderToFollowerMessage>(dc);
      const frames = frameChunks(JSON.stringify(bigEvent(200_000)), 262_144, 'closing');
      dc.simulateMessage(JSON.stringify(frames[0]!));

      sync.close();

      // No listener can fire after close, and the buffer is gone.
      const received: LeaderToFollowerMessage[] = [];
      sync.onMessage((m) => received.push(m));
      for (const frame of frames.slice(1)) dc.simulateMessage(JSON.stringify(frame));
      expect(received).toEqual([]);
    });
  });
});
