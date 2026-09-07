/**
 * Bounded Client→Chrome frame buffer for the `/cdp` proxy.
 *
 * Frames a client sends while the Chrome leg is down (initial connect, or a
 * reconnect after `messageTooLarge`) are held here and flushed once Chrome is
 * back. The buffer is bounded and drops the OLDEST frame on overflow — same
 * policy and limit as swift-server's `CDPProxy.appendBufferedMessage`
 * (`maxBufferSize = 1_000`). Unbounded growth would turn a Chrome leg that
 * never comes back into a heap leak, and the oldest frames are the least
 * useful: the page reissues its commands after the `upstream-reset` close.
 */

/** Max frames held while the Chrome leg is down. Mirrors swift `maxBufferSize`. */
export const CDP_CLIENT_FRAME_BUFFER_LIMIT = 1000;

/**
 * Append `frame` to `buffer`, dropping the oldest entry when the limit is
 * reached. Returns true when a frame was dropped, so the caller can log it.
 */
export function appendBufferedClientFrame(
  buffer: unknown[],
  frame: unknown,
  limit = CDP_CLIENT_FRAME_BUFFER_LIMIT
): boolean {
  let dropped = false;
  while (buffer.length >= limit) {
    buffer.shift();
    dropped = true;
  }
  buffer.push(frame);
  return dropped;
}
