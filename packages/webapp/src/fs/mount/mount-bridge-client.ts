/**
 * Bridge client for the `mount.sign-and-forward` Port (EXT8, thin-extension
 * topology).
 *
 * In the hosted-leader tab / kernel worker the agent realm cannot use the
 * same-extension `chrome.runtime.sendMessage` path (no `chrome.runtime.id`), so
 * S3 / DA mount sign-and-forward envelopes are routed to the extension over an
 * externally-connectable `chrome.runtime.connect(<delegateId>, { name:
 * 'mount.sign-and-forward' })` Port — the SW side mirrors the `secrets.crud`
 * and `fetch-proxy.fetch` handlers.
 *
 * The transport skeleton (cached Port, correlation, panel-RPC fallback) lives
 * in `kernel/port-bridge-client.ts`; this file only owns the per-call-site
 * policy: `mount.sign-and-forward` Port name, 120s timeout (mount fetches
 * whole objects, so align with the proxied-fetch worker leg), reject-on-fail
 * semantics with `FsError('EIO')` (a mount that silently degrades is a bug —
 * `envelopeToResponse` in `signed-fetch.ts` maps envelope-level errors
 * uniformly), and the Port message shape `{ id, type, envelope }`.
 *
 * S3 credentials never cross this bridge (the SW reads `s3.<profile>.*` from
 * chrome.storage); DA envelopes carry only a transient IMS bearer the SW
 * forwards. Only the control `type` is ever logged.
 */

import type { SignAndForwardReply } from '@slicc/shared-ts';
import { createPortBridgeClient } from '../../kernel/port-bridge-client.js';
import { FsError } from '../types.js';

export type MountSignAndForwardType = 'mount.s3-sign-and-forward' | 'mount.da-sign-and-forward';

/**
 * Per-call timeout. Mount sign-and-forward fetches whole objects, so align
 * with the proxied-fetch worker leg (120s) rather than the secrets bridge's
 * 10s — a slow-but-valid transfer must not be converted into a hard failure.
 */
const CALL_TIMEOUT_MS = 120_000;

interface MountBridgeRequest {
  type: MountSignAndForwardType;
  envelope: unknown;
}

const call = createPortBridgeClient<MountBridgeRequest, SignAndForwardReply>({
  portName: 'mount.sign-and-forward',
  panelRpcOp: 'mount-sign-and-forward',
  timeoutMs: CALL_TIMEOUT_MS,
  onUnavailable: 'reject',
  makeError: (message) => new FsError('EIO', `mount transport failed: ${message}`),
  logNamespace: 'mount-bridge',
  toPortMessage: ({ type, envelope }) => ({ type, envelope }),
  toPanelRpcPayload: ({ type, envelope }) => ({ type, envelope }),
});

/**
 * Dispatch a `mount.sign-and-forward` envelope and await the correlated reply.
 * See the module header for the realm-aware routing. Rejects with `FsError`
 * when the bridge is unavailable, the call times out, or the Port disconnects
 * mid-flight — never resolves a degraded result.
 */
export function callMountBridge(
  type: MountSignAndForwardType,
  envelope: unknown
): Promise<SignAndForwardReply> {
  // The reject-mode factory never resolves undefined; the cast is safe.
  return call({ type, envelope }) as Promise<SignAndForwardReply>;
}
