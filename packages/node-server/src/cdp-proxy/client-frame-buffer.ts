/**
 * Bounded, generation-tagged Client→Chrome frame buffer for the `/cdp` proxy.
 *
 * Frames a client sends while the Chrome leg is unavailable are held here. The
 * buffer is bounded and drops the OLDEST frame on overflow — same policy and
 * limit as swift-server's `CDPProxy.appendBufferedMessage` (`maxBufferSize =
 * 1_000`). Unbounded growth would turn a Chrome leg that never comes back into
 * a heap leak.
 *
 * The generation tag decides whether the buffer may be flushed at all. A
 * buffered frame is only meaningful on the exact `{chromeConnection, client}`
 * pair it was written for:
 *
 *   - Chrome discards EVERY CDP session when its browser-level socket closes,
 *     so frames buffered after a leg drop name sessions the replacement
 *     connection has never heard of. Worse, a browser-level `Target.createTarget`
 *     would still execute — after its caller was already rejected with 4002 —
 *     and the caller's retry opens a duplicate tab.
 *   - Frames buffered by a client that has since been superseded or closed must
 *     not run under whoever holds the slot now.
 *
 * So a buffer is flushed only when both halves of its generation still match at
 * flush time, and dropped (the caller logs the count and the reason) otherwise.
 * The one case that still flushes is the original initial-connect buffering — a
 * client that connected before Chrome was ready lost no sessions, so its
 * `chromeConnectionId` is `null` and any connection will do.
 *
 * The state transitions live here rather than in `index.ts` so the whole policy
 * is unit-testable without booting a server. Mirrors `CDPProxy`'s
 * `clientFrameBufferDropReason` / `discardBufferedMessages` in swift-server.
 */

/** Max frames held while the Chrome leg is down. Mirrors swift `maxBufferSize`. */
export const CDP_CLIENT_FRAME_BUFFER_LIMIT = 1000;

/** The `{chromeConnection, client}` pair a buffer's frames were written for. */
export interface CdpBufferGeneration {
  /**
   * Id of the Chrome connection that was live when buffering started, or
   * `null` when no leg was live at all (initial connect / a leg that never
   * opened). `null` flushes onto any connection; a concrete id only flushes
   * onto that same connection, which a post-drop replacement never is.
   */
  chromeConnectionId: number | null;
  /** Id of the client that held the single `/cdp` slot, or `null` for none. */
  clientId: number | null;
}

/** Buffered Client→Chrome frames plus the generation they belong to. */
export interface ClientFrameBuffer {
  readonly generation: CdpBufferGeneration;
  readonly frames: unknown[];
}

/** Why a buffer was dropped rather than flushed. Used verbatim in log lines. */
export type ClientFrameBufferDropReason =
  | 'chrome-leg-reset'
  | 'client-superseded'
  | 'client-disconnected'
  | 'upstream-reset'
  | 'no-client';

/** How many frames were thrown away, and why. `null` when nothing was lost. */
export interface DroppedClientFrames {
  count: number;
  reason: ClientFrameBufferDropReason;
}

/** The slice of `ServerState` the buffer lifecycle reads and mutates. */
export interface ClientFrameBufferHost {
  /** The Chrome leg, or null while it is down. Only its presence matters here. */
  chromeWs: unknown;
  /** Monotonic id of `chromeWs`, assigned when the socket is created. */
  chromeConnectionId: number;
  /** Monotonic id of the client holding the single slot; null when empty. */
  activeClientId: number | null;
  messageBuffer: ClientFrameBuffer | null;
}

export function createClientFrameBuffer(generation: CdpBufferGeneration): ClientFrameBuffer {
  return { generation, frames: [] };
}

/**
 * Append `frame` to `frames`, dropping the oldest entry when the limit is
 * reached. Returns true when a frame was dropped, so the caller can log it.
 */
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

/** The generation a buffer opened right now belongs to. */
export function currentBufferGeneration(state: ClientFrameBufferHost): CdpBufferGeneration {
  return {
    // No live leg = nothing was lost, so the frames may flush onto whatever
    // connection comes up next (the original initial-connect buffering).
    chromeConnectionId: state.chromeWs ? state.chromeConnectionId : null,
    clientId: state.activeClientId,
  };
}

/**
 * Decide whether `buffer` may be flushed onto the connection identified by
 * `current`. Returns `null` when the flush is safe, otherwise the drop reason.
 */
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

/** Frames to send now, plus what was thrown away instead of being sent. */
export interface ClientFrameFlush {
  frames: unknown[];
  dropped: DroppedClientFrames | null;
}

/**
 * Clear the buffer and report what may be delivered onto `targetConnectionId`.
 * Always leaves `state.messageBuffer` null: either the frames go out now, or
 * they are gone.
 */
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

/**
 * Whether `clientId` still holds the single `/cdp` slot. A frame from a
 * client that was superseded, closed, or reset with 4002 must not reach
 * Chrome even if it arrives before that client's socket has finished
 * closing — swift-server's `receive` guard, mirrored here.
 */
export function clientHoldsSlot(state: ClientFrameBufferHost, clientId: number): boolean {
  return state.activeClientId === clientId;
}

/**
 * Give the single `/cdp` slot to `clientId`. Anything the previous holder
 * buffered belongs to IT — running those frames under the new client is the
 * duplicate-tab bug from issue #2417 — so it is dropped, and a fresh buffer is
 * opened so frames arriving during the Chrome handshake are still captured.
 */
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

/**
 * Empty the slot. Whatever the departing client buffered dies with it — a
 * clientless buffer must never reach a Chrome leg, and after a 4002 reset the
 * page re-issues whatever it still needs.
 */
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

/** The `[cdp-proxy]` line emitted whenever buffered frames are thrown away. */
export function describeDroppedClientFrames(dropped: DroppedClientFrames): string {
  return `[cdp-proxy] Dropped ${dropped.count} buffered client frame(s) — ${dropped.reason}`;
}
