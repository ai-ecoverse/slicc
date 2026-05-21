/**
 * Shared transport interfaces and helpers for panel↔offscreen bridges
 * in the Chrome extension.
 *
 * `follower-sprinkle-bridge.ts` and `leader-sync-bridge.ts` both stand
 * up panel↔offscreen wiring on top of `chrome.runtime.sendMessage` /
 * `chrome.runtime.onMessage`. The transport surfaces they need are
 * identical, so they live here to prevent drift.
 *
 * Both bridges trust same-build endpoints: an envelope's `type`
 * discriminator is verified at runtime, but the rest of the payload
 * shape is trusted because both ends are compiled together. See the
 * `discriminateMsg` JSDoc below for the trust-boundary explanation.
 */

/**
 * Sends panel→offscreen envelopes. The `source: 'panel'` literal is
 * locked at the type level so callers can't accidentally tag traffic
 * with the wrong source.
 */
export interface PanelMessageSender {
  send(envelope: { source: 'panel'; payload: unknown }): void;
}

/**
 * Subscribes to incoming envelopes on the panel side. The handler
 * receives every envelope; callers filter by `source` and `payload.type`.
 */
export interface PanelMessageSubscriber {
  onMessage(handler: (envelope: { source: string; payload: unknown }) => void): () => void;
}

/**
 * Bidirectional offscreen-side surface: send to panel, subscribe to
 * panel inbound. Tests substitute an in-memory pipe; production wires
 * this to `chrome.runtime.sendMessage` / `chrome.runtime.onMessage`.
 */
export interface OffscreenMessageHub {
  /** Send an envelope to the side panel (and any other panel-like consumers). */
  sendToPanel(envelope: { source: 'offscreen'; payload: unknown }): void;
  /** Subscribe to incoming panel envelopes. */
  onPanelMessage(handler: (envelope: { source: string; payload: unknown }) => void): () => void;
}

/**
 * Discriminate an `unknown` runtime payload by checking only its `type`
 * tag. Returns `null` for any payload that doesn't match — never throws.
 *
 * **The cast is a type assertion, not a type guard.** Only the
 * discriminator is verified at runtime; the rest of `T`'s shape is
 * trusted. This is safe for messages crossing the intra-extension
 * `chrome.runtime` channel — both endpoints are in the same build and
 * the trust domain is the same. NOT sufficient for messages crossing a
 * real network/process boundary (e.g. the WebRTC tray wire); those need
 * full shape validation. Bridge consumers narrow further on the result
 * (e.g. `result.ok === true | false | other`) when the extra fields
 * matter.
 */
export function discriminateMsg<T extends { type: string }>(
  payload: unknown,
  type: T['type']
): T | null {
  if (!payload || typeof payload !== 'object') return null;
  if ((payload as { type?: unknown }).type !== type) return null;
  return payload as T;
}
