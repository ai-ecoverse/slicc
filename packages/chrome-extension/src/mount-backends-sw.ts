/**
 * Mount sign-and-forward — keep credentials out of the offscreen agent.
 *
 * Browser-side mount backends (running in the offscreen document for the
 * agent's bash tool, or the side panel for terminal-typed `mount` commands)
 * post envelopes here. The service worker owns the credential channel:
 *
 *   - S3: reads `s3.<profile>.*` from chrome.storage.local
 *   - DA: takes a transient IMS bearer in the envelope (Adobe LLM provider's
 *         token, browser-side; v2 will move OAuth here)
 *
 * The agent's tools never reach chrome.storage (their `bash` runs in a WASM
 * context with no chrome APIs; `node -e` runs in a CSP-locked sandbox iframe
 * with an opaque origin) so secrets stay out of the agent's reach.
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

import {
  type DaSignAndForwardEnvelope,
  executeDaSignAndForward,
  executeS3SignAndForward,
  type S3SignAndForwardEnvelope,
  type SecretGetter,
  type SignAndForwardReply,
} from '@slicc/shared-ts';
import type { SwMessageOutcome } from './sw-message-router.js';
import { beginPortPin, type PortPinDeps } from './sw-pinned-port.js';

interface MountSignAndForwardRequest {
  type: 'mount.s3-sign-and-forward' | 'mount.da-sign-and-forward';
  envelope: unknown;
}

function isMountSignAndForwardRequest(msg: unknown): msg is MountSignAndForwardRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    'envelope' in msg &&
    ((msg as { type: string }).type === 'mount.s3-sign-and-forward' ||
      (msg as { type: string }).type === 'mount.da-sign-and-forward')
  );
}

const chromeStorageSecretGetter: SecretGetter = {
  async get(key: string): Promise<string | undefined> {
    const result = await chrome.storage.local.get(key);
    const value = result[key];
    return typeof value === 'string' ? value : undefined;
  },
};

async function handleMountSignAndForward(
  msg: MountSignAndForwardRequest
): Promise<SignAndForwardReply> {
  if (msg.type === 'mount.s3-sign-and-forward') {
    return executeS3SignAndForward(
      msg.envelope as Partial<S3SignAndForwardEnvelope> | undefined,
      chromeStorageSecretGetter
    );
  }
  return executeDaSignAndForward(msg.envelope as Partial<DaSignAndForwardEnvelope> | undefined);
}

function internalErrorReply(err: unknown): { ok: false; error: string; errorCode: 'internal' } {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    errorCode: 'internal',
  };
}

/**
 * `chrome.runtime.onMessage` branch for mount sign-and-forward. Keeps the reply
 * channel open so `sendResponse` can be called asynchronously, which is what
 * makes the client side awaitable.
 */
export function handleMountMessage(
  message: unknown,
  _sender: ChromeMessageSender,
  sendResponse: (response?: unknown) => void
): SwMessageOutcome {
  if (!isMountSignAndForwardRequest(message)) return 'not-handled';
  // Wrap the handler call in a sync try/catch in addition to the promise
  // .catch. If the handler throws synchronously *before* returning a promise
  // (e.g. a cast on a malformed envelope that passed the type guard but fails
  // at first access), the .then().catch() chain never runs and sendResponse is
  // never called → the caller hangs forever on chrome.runtime.sendMessage.
  // Belt-and-suspenders.
  try {
    handleMountSignAndForward(message)
      .then((reply) => sendResponse(reply))
      .catch((err) => sendResponse(internalErrorReply(err)));
  } catch (err) {
    sendResponse(internalErrorReply(err));
  }
  return 'handled-async';
}

/**
 * `mount.sign-and-forward` Port handler. The hosted leader tab proxies S3 / DA
 * sign-and-forward through this Port: `chrome.storage` (S3 creds) is unreachable
 * from a non-extension origin, and DA envelopes carry a transient IMS bearer the
 * SW forwards server-side. Gated by the same three-factor pin as the bridge.
 */
export function handleMountSignAndForwardPort(port: ChromeRuntimePort, deps: PortPinDeps): void {
  const pinPromise = beginPortPin(port, deps, 'mount.sign-and-forward');
  port.onMessage.addListener(async (raw) => {
    const id = (raw as { id?: unknown } | null)?.id;
    const reply = (response: unknown): void => port.postMessage({ id, response });
    const replyError = (message: string): void =>
      reply({ ok: false, error: message, errorCode: 'internal' });

    const pin = await pinPromise;
    if (!pin.ok) {
      replyError(pin.error);
      return;
    }
    if (!isMountSignAndForwardRequest(raw)) {
      replyError('invalid mount.sign-and-forward request');
      return;
    }
    try {
      reply(await handleMountSignAndForward(raw));
    } catch (err) {
      replyError(err instanceof Error ? err.message : String(err));
    }
  });
}
