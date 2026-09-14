import type { SignAndForwardReply } from '@slicc/shared-ts';
import { createPortBridgeClient } from '../../kernel/port-bridge-client.js';
import { FsError } from '../types.js';

export type MountSignAndForwardType = 'mount.s3-sign-and-forward' | 'mount.da-sign-and-forward';

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

export function callMountBridge(
  type: MountSignAndForwardType,
  envelope: unknown
): Promise<SignAndForwardReply> {
  return call({ type, envelope }) as Promise<SignAndForwardReply>;
}
