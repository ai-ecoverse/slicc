import type { SignAndForwardReply } from '@slicc/shared-ts';
import { isTextContentType, uint8ToBase64 } from '@slicc/shared-ts';
import { SUDO_REQUEST_TYPE } from '../../sudo/types.js';
import { normalizeApprovalDecision } from './approval-decision.js';
import { withTimeout } from './boundary.js';
import type { ExtensionCapabilityBrokerOptions } from './extension-adapter.js';
import { capabilityRequestBytes } from './request-body.js';
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
  type SecretDeleteResult,
  type SecretGetRequest,
  type SecretListResult,
  type SecretMaskedEnvEntry,
  type SecretSetRequest,
} from './types.js';

const RELAY_BACKSTOP_MS = 600_000;

export type SecretsControlMessage =
  | { type: 'secrets.list-masked-entries' }
  | { type: 'secrets.set'; name: string; value: string; domains: string[] }
  | { type: 'secrets.session.set'; name: string; value: string; domains: string[] }
  | { type: 'secrets.delete'; name: string };

export interface ExtensionFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

export interface ExtensionCapabilityTransports {
  callSecrets(message: SecretsControlMessage): Promise<unknown>;
  callMount(
    type: 'mount.s3-sign-and-forward' | 'mount.da-sign-and-forward',
    envelope: unknown
  ): Promise<SignAndForwardReply>;
  crossOriginFetch(request: NetworkFetchRequest): Promise<ExtensionFetchResult>;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface ExtensionOps {
  crossOriginFetch(request: NetworkFetchRequest): Promise<CapabilityResult<NetworkFetchResponse>>;
  secrets: Required<Pick<SecretCapability, 'listMaskedEnv' | 'getMasked' | 'set' | 'delete'>>;
  signRequest(request: MountSignRequest): Promise<CapabilityResult<MountSignResult>>;
  requestApproval(request: ApprovalRequest): Promise<CapabilityResult<ApprovalDecision>>;
}

export function createExtensionOps(options: ExtensionCapabilityBrokerOptions): ExtensionOps {
  const direct = options.adapter === 'extension-direct';
  const transports: ExtensionCapabilityTransports = {
    callSecrets: options.callSecrets ?? ((message) => defaultCallSecrets(direct, message)),
    callMount: options.callMount ?? ((type, envelope) => defaultCallMount(direct, type, envelope)),
    crossOriginFetch: options.crossOriginFetch ?? ((request) => defaultFetch(direct, request)),
    requestApproval:
      options.requestApproval ?? ((request) => defaultRequestApproval(direct, request)),
  };

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
    operation: 'listMaskedEnv' | 'getMasked'
  ): Promise<CapabilityResult<readonly SecretMaskedEnvEntry[]>> {
    const call = await attempt('secrets', operation, () =>
      transports.callSecrets({ type: 'secrets.list-masked-entries' })
    );
    if (!call.ok) return call;
    const reply = call.value as { entries?: SecretMaskedEnvEntry[]; error?: string } | undefined;
    if (reply?.error) return capabilityFailed('secrets', operation, reply.error);
    if (!Array.isArray(reply?.entries)) {
      return capabilityFailed('secrets', operation, 'secrets bridge returned no entries');
    }
    return { ok: true, value: reply.entries };
  }

  async function setSecret(request: SecretSetRequest): Promise<CapabilityResult<void>> {
    const call = await attempt('secrets', 'set', () =>
      transports.callSecrets({
        type: request.scope === 'persisted' ? 'secrets.set' : 'secrets.session.set',
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

  async function deleteSecret(
    request: SecretDeleteRequest
  ): Promise<CapabilityResult<SecretDeleteResult>> {
    const call = await attempt('secrets', 'delete', () =>
      transports.callSecrets({ type: 'secrets.delete', name: request.name })
    );
    if (!call.ok) return call;
    const reply = call.value as
      | { ok?: boolean; removed?: boolean; fromSession?: boolean; error?: string }
      | undefined;
    if (!reply?.ok) {
      return capabilityFailed('secrets', 'delete', reply?.error ?? 'secrets.delete failed');
    }

    return {
      ok: true,
      value: { removed: reply.removed ?? true, fromSession: reply.fromSession === true },
    };
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
      async getMasked(request: SecretGetRequest): Promise<CapabilityResult<SecretMaskedEnvEntry>> {
        const entries = await maskedEntries('getMasked');
        if (!entries.ok) return entries;
        const found = entries.value.find((entry) => entry.name === request.name);
        if (!found) {
          return capabilityFailed('secrets', 'getMasked', `no secret named "${request.name}"`);
        }
        return { ok: true, value: found };
      },
      set: setSecret,
      delete: deleteSecret,
    },
    signRequest,
    requestApproval: (request: ApprovalRequest) =>
      attempt('approvals', 'request', () => transports.requestApproval(request)),
  };
}

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

const DIRECT_MOUNT_SIGN_TIMEOUT_MS = 120_000;

async function defaultCallMount(
  direct: boolean,
  type: 'mount.s3-sign-and-forward' | 'mount.da-sign-and-forward',
  envelope: unknown
): Promise<SignAndForwardReply> {
  if (direct) {
    return (await withTimeout(
      sendToServiceWorker({ type, envelope }),
      DIRECT_MOUNT_SIGN_TIMEOUT_MS
    )) as SignAndForwardReply;
  }
  const { callMountBridge } = await import('../../fs/mount/mount-bridge-client.js');
  return callMountBridge(type, envelope);
}

async function defaultFetch(
  direct: boolean,
  request: NetworkFetchRequest
): Promise<ExtensionFetchResult> {
  const { collectViaExtensionDelegate, collectViaExtensionPort, REQUEST_BODY_CAP } = await import(
    '../../shell/proxied-fetch.js'
  );

  const bytes = capabilityRequestBytes(request);
  if (bytes !== undefined && bytes.byteLength > REQUEST_BODY_CAP) {
    throw new Error(
      `request body is ${bytes.byteLength} bytes, over the ${REQUEST_BODY_CAP}-byte proxy limit`
    );
  }
  const collect = direct ? collectViaExtensionPort : collectViaExtensionDelegate;
  const { head, body } = await collect(request.url, {
    method: request.method ?? 'GET',
    headers: request.headers,
    ...(bytes === undefined ? {} : { body: bytes }),
  });
  return {
    status: head.status,
    statusText: head.statusText,
    headers: head.headers,
    bytes: new Uint8Array(body),
  };
}

function withCallerBudget<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('approval relay cancelled before it was sent'));
      return;
    }
    const onAbort = () => reject(new Error('approval relay did not answer'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function defaultRequestApproval(
  direct: boolean,
  request: ApprovalRequest
): Promise<ApprovalDecision> {
  const suggested = request.suggestedPattern ?? request.detail;
  const relayed = {
    kind: request.kind,
    detail: request.detail,
    suggestedPattern: suggested,
    ...(request.requester ? { requester: request.requester } : {}),
    ...(request.approver ? { approver: request.approver } : {}),
  };
  if (direct) {
    const reply = (await withCallerBudget(
      sendToServiceWorker({
        source: 'offscreen' as const,
        payload: { type: SUDO_REQUEST_TYPE, request: relayed },
      }),
      request.signal
    )) as { ok?: boolean; decision?: unknown; error?: string } | undefined;
    if (!reply?.ok || reply.decision === undefined) {
      throw new Error(reply?.error ?? 'sudo relay returned no decision');
    }
    return normalizeApprovalDecision(reply.decision, suggested);
  }

  const { getPanelRpcClient } = await import('../../kernel/panel-rpc.js');
  const client = getPanelRpcClient();
  if (!client) throw new Error('panel-RPC client unavailable in this realm');
  const { decision } = await withCallerBudget(
    client.call('sudo-request', { request: relayed }, { timeoutMs: RELAY_BACKSTOP_MS }),
    request.signal
  );
  return normalizeApprovalDecision(decision, suggested);
}
