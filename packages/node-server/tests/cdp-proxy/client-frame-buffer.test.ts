/**
 * Generation-tagged Client→Chrome frame buffer used while the `/cdp` proxy's
 * Chrome leg is unavailable (issue #2417, review finding 1). Two halves:
 *
 *   - the bound itself — 1,000 frames, drop-oldest, mirroring swift-server's
 *     `appendBufferedMessage`;
 *   - the generation policy — a buffer is flushed only onto the exact
 *     `{chromeConnection, client}` pair it was written for, so frames buffered
 *     across a Chrome-leg reset or a client supersession are discarded instead
 *     of replayed against sessions Chrome already dropped.
 */
import { describe, expect, it } from 'vitest';
import {
  adoptClientSlot,
  appendBufferedClientFrame,
  CDP_CLIENT_FRAME_BUFFER_LIMIT,
  type ClientFrameBufferHost,
  clientFrameBufferDropReason,
  clientHoldsSlot,
  createClientFrameBuffer,
  currentBufferGeneration,
  describeDroppedClientFrames,
  releaseClientSlot,
  takeClientFrameBuffer,
} from '../../src/cdp-proxy/client-frame-buffer.js';

const CHROME_SOCKET = { id: 'chrome' };

function makeHost(overrides: Partial<ClientFrameBufferHost> = {}): ClientFrameBufferHost {
  return {
    chromeWs: CHROME_SOCKET,
    chromeConnectionId: 1,
    activeClientId: 1,
    messageBuffer: null,
    ...overrides,
  };
}

describe('appendBufferedClientFrame', () => {
  it('appends while below the limit and reports no drop', () => {
    const buffer: unknown[] = [];
    expect(appendBufferedClientFrame(buffer, 'a')).toBe(false);
    expect(appendBufferedClientFrame(buffer, 'b')).toBe(false);
    expect(buffer).toEqual(['a', 'b']);
  });

  it('drops the OLDEST frame at the limit', () => {
    const buffer: unknown[] = ['a', 'b', 'c'];
    expect(appendBufferedClientFrame(buffer, 'd', 3)).toBe(true);
    expect(buffer).toEqual(['b', 'c', 'd']);
  });

  it('keeps the buffer bounded under sustained overflow', () => {
    const buffer: unknown[] = [];
    for (let i = 0; i < 2500; i++) appendBufferedClientFrame(buffer, i);

    expect(buffer).toHaveLength(CDP_CLIENT_FRAME_BUFFER_LIMIT);
    expect(buffer[0]).toBe(2500 - CDP_CLIENT_FRAME_BUFFER_LIMIT);
    expect(buffer.at(-1)).toBe(2499);
  });

  it('trims an over-long buffer down to the limit', () => {
    const buffer: unknown[] = Array.from({ length: 5 }, (_, i) => i);
    expect(appendBufferedClientFrame(buffer, 'x', 3)).toBe(true);
    expect(buffer).toEqual([3, 4, 'x']);
  });

  it('defaults to the swift-parity limit of 1000', () => {
    expect(CDP_CLIENT_FRAME_BUFFER_LIMIT).toBe(1000);
  });
});

describe('currentBufferGeneration', () => {
  it('records the live Chrome connection when there is one', () => {
    expect(currentBufferGeneration(makeHost({ chromeConnectionId: 4, activeClientId: 9 }))).toEqual(
      {
        chromeConnectionId: 4,
        clientId: 9,
      }
    );
  });

  it('records a null connection while the leg is down — nothing was lost yet', () => {
    // The initial-connect case: no sessions existed, so any connection will do.
    expect(currentBufferGeneration(makeHost({ chromeWs: null, chromeConnectionId: 4 }))).toEqual({
      chromeConnectionId: null,
      clientId: 1,
    });
  });
});

describe('clientFrameBufferDropReason', () => {
  it('allows the flush when both halves of the generation still match', () => {
    const buffer = createClientFrameBuffer({ chromeConnectionId: 2, clientId: 5 });
    expect(clientFrameBufferDropReason(buffer, { chromeConnectionId: 2, clientId: 5 })).toBeNull();
  });

  it('allows an initial-connect buffer onto any connection', () => {
    const buffer = createClientFrameBuffer({ chromeConnectionId: null, clientId: 5 });
    expect(clientFrameBufferDropReason(buffer, { chromeConnectionId: 9, clientId: 5 })).toBeNull();
  });

  it('drops frames written for a Chrome connection that has been replaced', () => {
    const buffer = createClientFrameBuffer({ chromeConnectionId: 2, clientId: 5 });
    expect(clientFrameBufferDropReason(buffer, { chromeConnectionId: 3, clientId: 5 })).toBe(
      'chrome-leg-reset'
    );
  });

  it('drops frames written by a client that lost the slot', () => {
    const buffer = createClientFrameBuffer({ chromeConnectionId: 2, clientId: 5 });
    expect(clientFrameBufferDropReason(buffer, { chromeConnectionId: 2, clientId: 6 })).toBe(
      'client-superseded'
    );
  });

  it('drops frames when nobody holds the slot any more', () => {
    const buffer = createClientFrameBuffer({ chromeConnectionId: 2, clientId: 5 });
    expect(clientFrameBufferDropReason(buffer, { chromeConnectionId: 2, clientId: null })).toBe(
      'no-client'
    );
  });
});

describe('takeClientFrameBuffer', () => {
  it('flushes an initial-connect buffer onto the first connection', () => {
    // A client that connected before Chrome was ready lost no sessions, so its
    // frames still mean what they meant — this path is unchanged by #2417.
    const state = makeHost({ chromeWs: null, chromeConnectionId: 0 });
    state.messageBuffer = createClientFrameBuffer(currentBufferGeneration(state));
    state.messageBuffer.frames.push('{"id":1,"method":"Target.getTargets"}');

    state.chromeWs = CHROME_SOCKET;
    state.chromeConnectionId = 1;
    expect(takeClientFrameBuffer(state, 1)).toEqual({
      frames: ['{"id":1,"method":"Target.getTargets"}'],
      dropped: null,
    });
    expect(state.messageBuffer).toBeNull();
  });

  it('drops frames buffered across a Chrome-leg reset', () => {
    // `Target.createTarget` buffered here would open a SECOND tab: the caller
    // was already rejected with 4002 and retried on the fresh connection.
    const state = makeHost({ chromeConnectionId: 1 });
    state.messageBuffer = createClientFrameBuffer({ chromeConnectionId: 1, clientId: 1 });
    state.messageBuffer.frames.push('{"id":1,"method":"Target.createTarget"}');

    expect(takeClientFrameBuffer(state, 2)).toEqual({
      frames: [],
      dropped: { count: 1, reason: 'chrome-leg-reset' },
    });
    expect(state.messageBuffer).toBeNull();
  });

  it('flushes what a client that connected DURING the outage buffered', () => {
    // Client 1 saw the leg die, so its buffer names the dead connection. Client
    // 2 then took the slot mid-outage: it lost no sessions, so its frames run
    // on the replacement connection — and `ChromeReconnectController` leaves it
    // connected rather than closing it with 4002 (it would otherwise retry the
    // `Target.createTarget` that just ran and open a duplicate tab).
    const state = makeHost({ chromeWs: null, chromeConnectionId: 1, activeClientId: 1 });
    state.messageBuffer = createClientFrameBuffer({ chromeConnectionId: 1, clientId: 1 });
    state.messageBuffer.frames.push('{"id":1,"method":"Target.createTarget"}');

    expect(adoptClientSlot(state, 2)).toEqual({ count: 1, reason: 'client-superseded' });
    state.messageBuffer?.frames.push('{"id":9,"method":"Target.createTarget"}');

    state.chromeWs = CHROME_SOCKET;
    state.chromeConnectionId = 2;
    expect(takeClientFrameBuffer(state, 2)).toEqual({
      frames: ['{"id":9,"method":"Target.createTarget"}'],
      dropped: null,
    });
    expect(state.messageBuffer).toBeNull();
  });

  it('drops frames buffered by a client that has since been superseded', () => {
    const state = makeHost({ activeClientId: 2 });
    state.messageBuffer = createClientFrameBuffer({ chromeConnectionId: 1, clientId: 1 });
    state.messageBuffer.frames.push('{"id":1,"method":"Input.insertText"}');

    expect(takeClientFrameBuffer(state, 1)).toEqual({
      frames: [],
      dropped: { count: 1, reason: 'client-superseded' },
    });
  });

  it('drops frames when the slot is empty', () => {
    const state = makeHost({ activeClientId: null });
    state.messageBuffer = createClientFrameBuffer({ chromeConnectionId: 1, clientId: 1 });
    state.messageBuffer.frames.push('a', 'b');

    expect(takeClientFrameBuffer(state, 1)).toEqual({
      frames: [],
      dropped: { count: 2, reason: 'no-client' },
    });
  });

  it('reports no drop for an empty stale buffer — nothing was lost', () => {
    const state = makeHost({ activeClientId: null });
    state.messageBuffer = createClientFrameBuffer({ chromeConnectionId: 1, clientId: 1 });

    expect(takeClientFrameBuffer(state, 1)).toEqual({ frames: [], dropped: null });
  });

  it('is a no-op without a buffer', () => {
    const state = makeHost();
    expect(takeClientFrameBuffer(state, 1)).toEqual({ frames: [], dropped: null });
  });
});

describe('adoptClientSlot', () => {
  it('drops what the superseded client buffered and opens a fresh buffer', () => {
    const state = makeHost({ chromeWs: null, chromeConnectionId: 1, activeClientId: 1 });
    state.messageBuffer = createClientFrameBuffer({ chromeConnectionId: 1, clientId: 1 });
    state.messageBuffer.frames.push('{"id":1}', '{"id":2}');

    expect(adoptClientSlot(state, 2)).toEqual({ count: 2, reason: 'client-superseded' });
    expect(state.activeClientId).toBe(2);
    // The new client's own frames buffer normally, and flush: it lost no
    // sessions, so its generation names no Chrome connection.
    expect(state.messageBuffer).toEqual({
      generation: { chromeConnectionId: null, clientId: 2 },
      frames: [],
    });
  });

  it('keeps the buffer this client already owns', () => {
    const state = makeHost({ activeClientId: 2 });
    const existing = createClientFrameBuffer({ chromeConnectionId: 1, clientId: 2 });
    existing.frames.push('{"id":1}');
    state.messageBuffer = existing;

    expect(adoptClientSlot(state, 2)).toBeNull();
    expect(state.messageBuffer).toBe(existing);
  });

  it('opens a buffer tagged with the live leg when there is no buffer yet', () => {
    const state = makeHost({ chromeConnectionId: 4, activeClientId: null });

    expect(adoptClientSlot(state, 7)).toBeNull();
    expect(state.messageBuffer?.generation).toEqual({ chromeConnectionId: 4, clientId: 7 });
  });
});

describe('clientHoldsSlot', () => {
  it('is true only for the current slot holder', () => {
    const state = makeHost({ activeClientId: 3 });
    expect(clientHoldsSlot(state, 3)).toBe(true);
    expect(clientHoldsSlot(state, 2)).toBe(false);
  });

  it('is false for everyone once the slot was released (4002 reset / disconnect)', () => {
    const state = makeHost({ activeClientId: 3 });
    releaseClientSlot(state, 'upstream-reset');
    expect(clientHoldsSlot(state, 3)).toBe(false);
  });
});

describe('releaseClientSlot', () => {
  it('never leaves a clientless buffer behind on disconnect', () => {
    const state = makeHost();
    state.messageBuffer = createClientFrameBuffer({ chromeConnectionId: 1, clientId: 1 });
    state.messageBuffer.frames.push('a');

    expect(releaseClientSlot(state, 'client-disconnected')).toEqual({
      count: 1,
      reason: 'client-disconnected',
    });
    expect(state.activeClientId).toBeNull();
    expect(state.messageBuffer).toBeNull();
  });

  it('drops the buffer with the client the proxy resets with 4002', () => {
    const state = makeHost();
    state.messageBuffer = createClientFrameBuffer({ chromeConnectionId: 1, clientId: 1 });
    state.messageBuffer.frames.push('a', 'b', 'c');

    expect(releaseClientSlot(state, 'upstream-reset')).toEqual({
      count: 3,
      reason: 'upstream-reset',
    });
  });

  it('reports nothing when the departing client buffered nothing', () => {
    const state = makeHost();
    state.messageBuffer = createClientFrameBuffer({ chromeConnectionId: 1, clientId: 1 });

    expect(releaseClientSlot(state, 'client-disconnected')).toBeNull();
    expect(state.messageBuffer).toBeNull();
  });
});

describe('describeDroppedClientFrames', () => {
  it('names the count and the reason', () => {
    expect(describeDroppedClientFrames({ count: 12, reason: 'chrome-leg-reset' })).toBe(
      '[cdp-proxy] Dropped 12 buffered client frame(s) — chrome-leg-reset'
    );
  });
});
