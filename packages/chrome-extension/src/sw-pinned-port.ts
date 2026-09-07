/**
 * Shared three-factor pin plumbing for the SW's externally-connectable Ports.
 *
 * `fetch-proxy.fetch`, `secrets.crud` and `mount.sign-and-forward` are all
 * gated by the SAME pin as the CDP bridge (origin allowlist + `sender.tab.id`
 * === stored leader tab id + `sender.frameId === 0`). Each branch previously
 * repeated the identical "kick off validateBridgePin, log the rejection, await
 * it inside the message handler" dance; this module owns it once.
 *
 * INVARIANT: the pin is started here but awaited INSIDE the Port's
 * `onMessage` handler, so the listener attaches SYNCHRONOUSLY in `onConnect`.
 * Chrome drops Port messages that arrive before any listener exists, and the
 * leader posts its first request immediately after connect — an "await the pin,
 * then add the listener" shape silently loses it.
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

import { validateBridgePin } from './bridge-sw.js';

/** The subset of `bridgeSwDeps` `validateBridgePin` needs. */
export interface PortPinDeps {
  readStoredLeaderTabId: () => Promise<number | undefined>;
  writeStoredLeaderTabId: (tabId: number) => Promise<void>;
  allowedOrigins: readonly string[];
}

/** Pin verdict, with the rejection reason already folded into a reply string. */
export type PortPinResult = { ok: true } | { ok: false; error: string };

/**
 * Start the pin check for `port` and return its verdict promise. `label` names
 * the Port in the error string the caller replies with (tests match on
 * `"<label> pin failed"`). Never rejects — a thrown pin check becomes
 * `{ ok: false }`.
 */
export function beginPortPin(
  port: ChromeRuntimePort,
  deps: PortPinDeps,
  label: string
): Promise<PortPinResult> {
  const verdict = validateBridgePin(port.sender, {
    readStoredLeaderTabId: deps.readStoredLeaderTabId,
    writeStoredLeaderTabId: deps.writeStoredLeaderTabId,
    allowedOrigins: deps.allowedOrigins,
  }).then(
    (pin): PortPinResult =>
      pin.ok
        ? { ok: true }
        : { ok: false, error: `${label} pin failed: ${pin.reason ?? 'pin-failed'}` },
    (err): PortPinResult => ({
      ok: false,
      error: `${label} pin failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  );
  void verdict.then((result) => {
    if (!result.ok) console.error(`[sw] external ${label} pin check failed`, result.error);
  });
  return verdict;
}
