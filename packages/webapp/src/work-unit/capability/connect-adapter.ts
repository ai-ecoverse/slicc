/**
 * `connect` CapabilityBroker adapter (#2276 slice B) — the restricted hosted
 * float.
 *
 * A cone reached over `?connect=1` runs entirely in the hosted origin: there
 * is no local node-server (`/api/*` resolves to the tray hub, which serves
 * none of the privileged routes) and no extension delegate. So every
 * privileged operation is genuinely {@link CapabilityUnavailable} — that is
 * the answer, not a gap waiting to be filled.
 *
 * The one exception is the page-gesture channel: a hosted tab still has a
 * document, so a directory picker or a device chooser opened from a real user
 * gesture works exactly as it does elsewhere. The host injects it; without
 * one, those ops are unavailable too.
 */

import { composeCapabilityBroker } from './compose.js';
import type { CapabilityBroker, PageGestureChannel } from './types.js';

export interface ConnectCapabilityBrokerOptions {
  pageGestures?: PageGestureChannel;
}

/** Create the `connect` broker. */
export function createConnectCapabilityBroker(
  options: ConnectCapabilityBrokerOptions = {}
): CapabilityBroker {
  return composeCapabilityBroker({
    adapter: 'connect',
    pageGestures: options.pageGestures,
  });
}
