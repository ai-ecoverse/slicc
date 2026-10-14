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
 * B-SEC1: verify the sender is the extension itself (not a content script or
 * other extension). Returns true when the sender is trusted.
 *
 * Gate: `sender.id === chrome.runtime.id` AND the sender's origin is the
 * extension's own origin (`chrome-extension://<id>`). Content scripts carry
 * the PAGE's origin (e.g. `https://vault.sliccy.ai`), so they fail this
 * check even though they share `sender.id`. Extension pages that open in a
 * tab (e.g. secrets.html with `open_in_tab: true`) pass because their origin
 * is still the extension's.
 */
function isTrustedInternalSender(sender: ChromeMessageSender): boolean {
  if (typeof sender.id !== 'string' || sender.id !== chrome.runtime.id) return false;
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  // sender.origin is always set for extension pages; fall back to sender.url
  // for older Chrome versions or edge cases.
  const senderOrigin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
  return senderOrigin === extensionOrigin;
}

/**
 * Walk `handlers` in order and translate the first non-`'not-handled'`
 * outcome into the boolean Chrome expects from an `onMessage` listener:
 * `true` keeps the `sendResponse` channel open, `false` releases it.
 *
 * B-SEC1: rejects messages from untrusted senders (content scripts, other
 * extensions) before any handler sees them.
 */
export function routeSwMessage(
  handlers: readonly SwMessageHandler[],
  message: unknown,
  sender: ChromeMessageSender,
  sendResponse: (response?: unknown) => void
): boolean {
  // B-SEC1: gate on trusted internal sender.
  if (!isTrustedInternalSender(sender)) {
    return false;
  }
  for (const handler of handlers) {
    const outcome = handler(message, sender, sendResponse);
    if (outcome === 'not-handled') continue;
    return outcome === 'handled-async';
  }
  return false;
}
