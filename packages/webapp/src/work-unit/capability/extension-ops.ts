/**
 * The extension adapters' wire implementation (#2276 slice B).
 *
 * Split from `extension-adapter.ts` and reached only through a dynamic
 * import so none of it — nor the bridge clients and sudo brokers it reaches
 * for — joins the kernel worker's eager boot closure.
 *
 * `extension-direct` and `extension-delegate` differ ONLY in how a message
 * reaches the service worker: same-extension `chrome.runtime.sendMessage`
 * when the realm has a `chrome.runtime.id`, an externally-connectable named
 * Port (or its panel-RPC leg) when it does not. The handler set, the message
 * shapes and the reply shapes are identical, so one implementation covers
 * both and the topology is only a default-transport choice.
 *
 * Every transport is injectable so the conformance suite can drive the
 * adapter over a scripted port instead of a real service worker.
 */

import type { SignAndForwardReply } from '@slicc/shared-ts';
import { isTextContentType, uint8ToBase64 } from '@slicc/shared-ts';
import type { ExtensionCapabilityBrokerOptions } from './extension-adapter.js';
import {
  type ApprovalDecision,
  type ApprovalRequest,
  type CapabilityResult,
  capabilityFailed,
  type MountSignRequest,
  type MountSignResult,
  type NetworkFetchRequest,
  type NetworkFetchResponse,
  type SecretCapability,
  type SecretDeleteRequest,
  type SecretGetRequest,
  type SecretListResult,
  type SecretMaskedEnvEntry,
  type SecretSetRequest,
  type SecretValue,
} from './types.js';

/** The `SECRETS_HANDLERS` control messages this adapter sends. */
export type SecretsControlMessage =
  | { type: 'secrets.list-masked-entries' }
  | { type: 'secrets.set'; name: string; value: string; domains: string[] }
  | { type: 'secrets.session.set'; name: string; value: string; domains: string[] }
  | { type: 'secrets.delete'; name: string };

/** Raw head + bytes of a `fetch-proxy.fetch` Port response. */
export interface ExtensionFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

/** The four service-worker channels the adapter needs. */
export interface ExtensionCapabilityTransports {
  callSecrets(message: SecretsControlMessage): Promise<unknown>;
  callMount(
    type: 'mount.s3-sign-and-forward' | 'mount.da-sign-and-forward',
    envelope: unknown
  ): Promise<SignAndForwardReply>;
  crossOriginFetch(request: NetworkFetchRequest): Promise<ExtensionFetchResult>;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

/** Everything `extension-adapter.ts` defers until an operation is first called. */
export interface ExtensionOps {
  crossOriginFetch(request: NetworkFetchRequest): Promise<CapabilityResult<NetworkFetchResponse>>;
  secrets: Required<Pick<SecretCapability, 'listMaskedEnv' | 'get' | 'set' | 'delete'>>;
  signRequest(request: MountSignRequest): Promise<CapabilityResult<MountSignResult>>;
  requestApproval(request: ApprovalRequest): Promise<CapabilityResult<ApprovalDecision>>;
}

/** Bind every operation to the transports for one extension topology. */
export function createExtensionOps(options: ExtensionCapabilityBrokerOptions): ExtensionOps {
  const direct = options.adapter === 'extension-direct';
  const transports: ExtensionCapabilityTransports = {
    callSecrets: options.callSecrets ?? ((message) => defaultCallSecrets(direct, message)),
    callMount: options.callMount ?? ((type, envelope) => defaultCallMount(direct, type, envelope)),
    crossOriginFetch: options.crossOriginFetch ?? ((request) => defaultFetch(direct, request)),
    requestApproval:
      options.requestApproval ?? ((request) => defaultRequestApproval(direct, request)),
  };

  /**
   * Run one transport call. A rejected Port (disconnect, timeout, no
   * `chrome`) becomes a {@link CapabilityFailure}: conformance forbids an
   * escaping exception, and a caller must be able to tell "this float cannot"
   * from "that attempt broke".
   */
  async function attempt<T>(
    capability: 'secrets' | 'mounts' | 'network' | 'approvals',
    operation: string,
    call: () => Promise<T>
  ): Promise<CapabilityResult<T>> {
    try {
      return { ok: true, value: await call() };
    } catch (err) {
      return capabilityFailed(
        capability,
        operation,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  async function maskedEntries(
    operation: 'listMaskedEnv' | 'get'
  ): Promise<CapabilityResult<readonly SecretMaskedEnvEntry[]>> {
    const call = await attempt('secrets', operation, () =>
      transports.callSecrets({ type: 'secrets.list-masked-entries' })
    );
    if (!call.ok) return call;
    const reply = call.value as { entries?: SecretMaskedEnvEntry[]; error?: string } | undefined;
    if (reply?.error) return capabilityFailed('secrets', operation, reply.error);
    if (!reply?.entries) {
      return capabilityFailed('secrets', operation, 'secrets bridge returned no entries');
    }
    return { ok: true, value: reply.entries };
  }

  async function setSecret(request: SecretSetRequest): Promise<CapabilityResult<void>> {
    const call = await attempt('secrets', 'set', () =>
      transports.callSecrets({
        type: request.scope === 'session' ? 'secrets.session.set' : 'secrets.set',
        name: request.name,
        value: request.value,
        domains: [...(request.domains ?? [])],
      })
    );
    if (!call.ok) return call;
    const reply = call.value as { ok?: boolean; error?: string } | undefined;
    if (!reply?.ok) {
      return capabilityFailed('secrets', 'set', reply?.error ?? 'secrets.set failed');
    }
    return { ok: true, value: undefined };
  }

  async function deleteSecret(request: SecretDeleteRequest): Promise<CapabilityResult<void>> {
    const call = await attempt('secrets', 'delete', () =>
      transports.callSecrets({ type: 'secrets.delete', name: request.name })
    );
    if (!call.ok) return call;
    const reply = call.value as { ok?: boolean; error?: string } | undefined;
    if (!reply?.ok) {
      return capabilityFailed('secrets', 'delete', reply?.error ?? 'secrets.delete failed');
    }
    return { ok: true, value: undefined };
  }

  async function crossOriginFetch(
    request: NetworkFetchRequest
  ): Promise<CapabilityResult<NetworkFetchResponse>> {
    const call = await attempt('network', 'crossOriginFetch', () =>
      transports.crossOriginFetch(request)
    );
    if (!call.ok) return call;
    const result = call.value;
    const textual = isTextContentType(result.headers['content-type'] ?? '');
    return {
      ok: true,
      value: {
        status: result.status,
        ok: result.status >= 200 && result.status < 300,
        statusText: result.statusText,
        headers: result.headers,
        body: textual ? new TextDecoder().decode(result.bytes) : uint8ToBase64(result.bytes),
        bodyEncoding: textual ? 'text' : 'base64',
        url: request.url,
      },
    };
  }

  async function signRequest(
    request: MountSignRequest
  ): Promise<CapabilityResult<MountSignResult>> {
    const call = await attempt('mounts', 'signRequest', () =>
      transports.callMount(
        request.backend === 's3' ? 'mount.s3-sign-and-forward' : 'mount.da-sign-and-forward',
        request.envelope
      )
    );
    if (!call.ok) return call;
    if (call.value && typeof call.value.ok === 'boolean') return { ok: true, value: call.value };
    return capabilityFailed('mounts', 'signRequest', 'mount bridge returned no envelope');
  }

  return {
    crossOriginFetch,
    secrets: {
      async listMaskedEnv(): Promise<CapabilityResult<SecretListResult>> {
        const entries = await maskedEntries('listMaskedEnv');
        return entries.ok ? { ok: true, value: { entries: entries.value } } : entries;
      },
      async get(request: SecretGetRequest): Promise<CapabilityResult<SecretValue>> {
        const entries = await maskedEntries('get');
        if (!entries.ok) return entries;
        const found = entries.value.find((entry) => entry.name === request.name);
        if (!found) return capabilityFailed('secrets', 'get', `no secret named "${request.name}"`);
        return { ok: true, value: { name: found.name, maskedValue: found.maskedValue } };
      },
      set: setSecret,
      delete: deleteSecret,
    },
    signRequest,
    requestApproval: (request: ApprovalRequest) =>
      attempt('approvals', 'request', () => transports.requestApproval(request)),
  };
}

/** Same-extension `sendMessage`, promisified. Only reachable with a `chrome.runtime.id`. */
function sendToServiceWorker(message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: unknown) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message ?? 'chrome.runtime.lastError'));
      else resolve(response);
    });
  });
}

async function defaultCallSecrets(direct: boolean, message: SecretsControlMessage) {
  if (direct) return sendToServiceWorker(message);
  const { callSecretsBridge } = await import('../../shell/secrets-bridge-client.js');
  const { type, ...payload } = message;
  return callSecretsBridge(type, payload);
}

async function defaultCallMount(
  direct: boolean,
  type: 'mount.s3-sign-and-forward' | 'mount.da-sign-and-forward',
  envelope: unknown
): Promise<SignAndForwardReply> {
  if (direct) return (await sendToServiceWorker({ type, envelope })) as SignAndForwardReply;
  const { callMountBridge } = await import('../../fs/mount/mount-bridge-client.js');
  return callMountBridge(type, envelope);
}

async function defaultFetch(
  direct: boolean,
  request: NetworkFetchRequest
): Promise<ExtensionFetchResult> {
  const { collectViaExtensionDelegate, collectViaExtensionPort } = await import(
    '../../shell/proxied-fetch.js'
  );
  const collect = direct ? collectViaExtensionPort : collectViaExtensionDelegate;
  const { head, body } = await collect(request.url, {
    method: request.method ?? 'GET',
    headers: request.headers,
    body: request.body,
  });
  return {
    status: head.status,
    statusText: head.statusText,
    headers: head.headers,
    bytes: new Uint8Array(body),
  };
}

async function defaultRequestApproval(
  direct: boolean,
  request: ApprovalRequest
): Promise<ApprovalDecision> {
  const broker = direct
    ? (await import('../../sudo/extension-broker.js')).createExtensionSudoBroker()
    : (await import('../../sudo/panel-rpc-broker.js')).createPanelRpcSudoBroker();
  const decision = await broker.requestApproval({
    kind: request.kind,
    detail: request.detail,
    ...(request.requester ? { requester: request.requester } : {}),
    ...(request.suggestedPattern ? { suggestedPattern: request.suggestedPattern } : {}),
  });
  return {
    decision: decision.decision,
    ...(decision.pattern ? { pattern: decision.pattern } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
  };
}
