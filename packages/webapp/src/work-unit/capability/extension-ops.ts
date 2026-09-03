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
import { SUDO_REQUEST_TYPE } from '../../sudo/types.js';
import { normalizeApprovalDecision } from './approval-decision.js';
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

/**
 * Transport backstop on the panel-RPC approval relay.
 *
 * NOT a decision deadline. On this wire the reply IS the human's answer, so
 * any budget short enough to catch a dead relay would also deny a person who
 * took a moment to read the prompt — the two are indistinguishable from here.
 * The real budget is the caller's `signal` (`withApprovalTimeout` in `sudo/`,
 * five minutes), which settles first in practice.
 *
 * This exists only because `PanelRpcClient.call` has its own 15s default,
 * which WOULD deny a slow human. Ten minutes matches
 * `createPanelRpcSudoBroker`'s `DEFAULT_SUDO_RPC_TIMEOUT_MS` and releases a
 * request whose page realm has gone away for good.
 */
const RELAY_BACKSTOP_MS = 600_000;

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
  secrets: Required<Pick<SecretCapability, 'listMaskedEnv' | 'getMasked' | 'set' | 'delete'>>;
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
    operation: 'listMaskedEnv' | 'getMasked'
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
        // Session unless the caller explicitly asked for a durable write.
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
    // Older service workers answer `{ ok: true }` with no `removed`; the end
    // state they report is "gone", so treat the omission as removed.
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
  const { collectViaExtensionDelegate, collectViaExtensionPort, REQUEST_BODY_CAP } = await import(
    '../../shell/proxied-fetch.js'
  );
  // Bytes are resolved HERE, by the same helper the REST leg uses, so the two
  // adapters send identical bytes for identical requests. Handing the raw
  // string to the collector would re-decide the encoding from the content
  // type and diverge.
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

/**
 * Settle `work` when the CALLER gives up, since neither relay wire below
 * accepts an `AbortSignal` of its own. With no caller signal the relay waits
 * as long as the human does, which is the point.
 */
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

/**
 * Relay one approval to whoever raises the native modal on this topology.
 *
 * Speaks the two relay wires directly rather than going through
 * `createExtensionSudoBroker` / `createPanelRpcSudoBroker`, for two reasons —
 * both of which follow from this being the gesture hop and nothing else:
 *
 *   - Those brokers fail CLOSED to `{ decision: 'deny' }` on a transport
 *     error, which is right for `sudo/` but wrong here: an enforcement layer
 *     that reads a broken relay as a refusal tells the agent it was REFUSED
 *     and stops retrying, when nobody was ever asked. A dead relay is a
 *     `CapabilityFailure`, so this throws and lets `attempt` classify it.
 *   - They call `suggestPattern`, which can cost an LLM round trip. Pattern
 *     suggestion is policy; the broker forwards what it is given.
 *
 * There is no default deadline. On all three approval wires the transport
 * reply IS the human's decision — the `sendMessage` callback fires once
 * `panel-responder.ts` has resolved the native modals — so a dead relay is
 * indistinguishable from a slow human, and any timeout short enough to catch
 * the first would deny the second. The only budget is the caller's `signal`,
 * which is `withApprovalTimeout`'s five minutes.
 */
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
    // Offscreen → side panel. `panel-responder.ts` answers
    // `{ ok, decision, error }`; only `ok` with a decision is an answer.
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

  // Kernel worker → page realm, where the native modal lives.
  const { getPanelRpcClient } = await import('../../kernel/panel-rpc.js');
  const client = getPanelRpcClient();
  if (!client) throw new Error('panel-RPC client unavailable in this realm');
  const { decision } = await withCallerBudget(
    client.call('sudo-request', { request: relayed }, { timeoutMs: RELAY_BACKSTOP_MS }),
    request.signal
  );
  return normalizeApprovalDecision(decision, suggested);
}
