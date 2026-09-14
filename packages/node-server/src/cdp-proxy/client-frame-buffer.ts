export const CDP_CLIENT_FRAME_BUFFER_LIMIT = 1000;

export interface CdpBufferGeneration {
  chromeConnectionId: number | null;

  clientId: number | null;
}

export interface ClientFrameBuffer {
  readonly generation: CdpBufferGeneration;
  readonly frames: unknown[];
}

export type ClientFrameBufferDropReason =
  | 'chrome-leg-reset'
  | 'client-superseded'
  | 'client-disconnected'
  | 'upstream-reset'
  | 'no-client';

export interface DroppedClientFrames {
  count: number;
  reason: ClientFrameBufferDropReason;
}

const SOCKET_OPEN = 1;

export interface ClientFrameBufferHost {
  chromeWs: { readyState: number } | null;

  chromeConnectionId: number;

  activeClientId: number | null;
  messageBuffer: ClientFrameBuffer | null;
}

export function createClientFrameBuffer(generation: CdpBufferGeneration): ClientFrameBuffer {
  return { generation, frames: [] };
}

export function appendBufferedClientFrame(
  frames: unknown[],
  frame: unknown,
  limit = CDP_CLIENT_FRAME_BUFFER_LIMIT
): boolean {
  let dropped = false;
  while (frames.length >= limit) {
    frames.shift();
    dropped = true;
  }
  frames.push(frame);
  return dropped;
}

export function currentBufferGeneration(state: ClientFrameBufferHost): CdpBufferGeneration {
  return {
    chromeConnectionId:
      state.chromeWs?.readyState === SOCKET_OPEN ? state.chromeConnectionId : null,
    clientId: state.activeClientId,
  };
}

export function clientFrameBufferDropReason(
  buffer: ClientFrameBuffer,
  current: CdpBufferGeneration
): ClientFrameBufferDropReason | null {
  const { chromeConnectionId, clientId } = buffer.generation;
  if (chromeConnectionId !== null && chromeConnectionId !== current.chromeConnectionId) {
    return 'chrome-leg-reset';
  }
  if (current.clientId === null) return 'no-client';
  if (clientId !== current.clientId) return 'client-superseded';
  return null;
}

export interface ClientFrameFlush {
  frames: unknown[];
  dropped: DroppedClientFrames | null;
}

export function takeClientFrameBuffer(
  state: ClientFrameBufferHost,
  targetConnectionId: number
): ClientFrameFlush {
  const buffer = state.messageBuffer;
  state.messageBuffer = null;
  if (!buffer) return { frames: [], dropped: null };

  const reason = clientFrameBufferDropReason(buffer, {
    chromeConnectionId: targetConnectionId,
    clientId: state.activeClientId,
  });
  if (!reason) return { frames: buffer.frames, dropped: null };
  return {
    frames: [],
    dropped: buffer.frames.length > 0 ? { count: buffer.frames.length, reason } : null,
  };
}

export function clientHoldsSlot(state: ClientFrameBufferHost, clientId: number): boolean {
  return state.activeClientId === clientId;
}

export function adoptClientSlot(
  state: ClientFrameBufferHost,
  clientId: number
): DroppedClientFrames | null {
  state.activeClientId = clientId;
  let dropped: DroppedClientFrames | null = null;
  if (state.messageBuffer && state.messageBuffer.generation.clientId !== clientId) {
    dropped = releaseClientFrameBuffer(state, 'client-superseded');
  }
  state.messageBuffer ??= createClientFrameBuffer(currentBufferGeneration(state));
  return dropped;
}

export function releaseClientSlot(
  state: ClientFrameBufferHost,
  reason: Extract<ClientFrameBufferDropReason, 'client-disconnected' | 'upstream-reset'>
): DroppedClientFrames | null {
  state.activeClientId = null;
  return releaseClientFrameBuffer(state, reason);
}

function releaseClientFrameBuffer(
  state: ClientFrameBufferHost,
  reason: ClientFrameBufferDropReason
): DroppedClientFrames | null {
  const buffer = state.messageBuffer;
  state.messageBuffer = null;
  if (!buffer || buffer.frames.length === 0) return null;
  return { count: buffer.frames.length, reason };
}

export function describeDroppedClientFrames(dropped: DroppedClientFrames): string {
  return `[cdp-proxy] Dropped ${dropped.count} buffered client frame(s) — ${dropped.reason}`;
}
