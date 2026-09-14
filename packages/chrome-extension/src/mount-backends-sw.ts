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

export function handleMountMessage(
  message: unknown,
  _sender: ChromeMessageSender,
  sendResponse: (response?: unknown) => void
): SwMessageOutcome {
  if (!isMountSignAndForwardRequest(message)) return 'not-handled';

  try {
    handleMountSignAndForward(message)
      .then((reply) => sendResponse(reply))
      .catch((err) => sendResponse(internalErrorReply(err)));
  } catch (err) {
    sendResponse(internalErrorReply(err));
  }
  return 'handled-async';
}

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
