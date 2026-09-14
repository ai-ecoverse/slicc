import { createPortBridgeClient } from '../kernel/port-bridge-client.js';

const CALL_TIMEOUT_MS = 10_000;

// biome-ignore lint/plugin: the fields are whatever the named SW secrets handler declares; the bridge relays them without inspecting.
export type SecretsBridgePayload = Record<string, unknown>;

interface SecretsBridgeRequest {
  type: string;
  payload?: SecretsBridgePayload;
}

const call = createPortBridgeClient<SecretsBridgeRequest, unknown>({
  portName: 'secrets.crud',
  panelRpcOp: 'secrets-bridge',
  timeoutMs: CALL_TIMEOUT_MS,
  onUnavailable: 'resolve-undefined',
  makeError: (message) => new Error(message),
  logNamespace: 'secrets-bridge',
  toPortMessage: ({ type, payload }) => ({ type, ...payload }),
  toPanelRpcPayload: ({ type, payload }) => ({ type, payload }),
});

export function callSecretsBridge<T = unknown>(
  type: string,
  payload?: SecretsBridgePayload
): Promise<T> {
  return call({ type, payload }) as Promise<T>;
}
