/**
 * Shared contract for the service worker's single `chrome.runtime.onMessage`
 * listener.
 *
 * The SW used to register three independent `onMessage` listeners (relay,
 * mount backends, secrets) that all raced on the same channel. Each backend
 * now exports a handler returning an explicit outcome, and the SW entry
 * registers ONE listener that walks them in order — so the reply-channel
 * contract (`return true` keeps `sendResponse` alive) is decided in exactly
 * one place.
 */

/** Read the `type` discriminant off an untrusted message, or undefined. */
export function getMsgType(msg: unknown): string | undefined {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) return undefined;
  const t = (msg as { type: unknown }).type;
  return typeof t === 'string' ? t : undefined;
}

export type SwMessageOutcome =
  /** Not this backend's message — the router tries the next handler. */
  | 'not-handled'
  /** Consumed; the reply channel is not used (or was answered synchronously). */
  | 'handled'
  /** Consumed; `sendResponse` will be called later, so keep the channel open. */
  | 'handled-async';

export type SwMessageHandler = (
  message: unknown,
  sender: ChromeMessageSender,
  sendResponse: (response?: unknown) => void
) => SwMessageOutcome;

/**
 * Walk `handlers` in order and translate the first non-`'not-handled'`
 * outcome into the boolean Chrome expects from an `onMessage` listener:
 * `true` keeps the `sendResponse` channel open, `false` releases it.
 */
export function routeSwMessage(
  handlers: readonly SwMessageHandler[],
  message: unknown,
  sender: ChromeMessageSender,
  sendResponse: (response?: unknown) => void
): boolean {
  for (const handler of handlers) {
    const outcome = handler(message, sender, sendResponse);
    if (outcome === 'not-handled') continue;
    return outcome === 'handled-async';
  }
  return false;
}
