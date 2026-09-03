/**
 * The `node-rest` adapter's wire implementation (#2276 slice B).
 *
 * Split from `rest-adapter.ts` and reached only through a dynamic import so
 * none of it joins the kernel worker's eager boot closure: the broker's
 * SHAPE (which operations exist) is needed at composition time, the bytes
 * that talk HTTP are not needed until an operation is actually called.
 *
 * Every operation is fail-closed and total: a non-2xx status, an unreachable
 * or wedged transport, a body that fails mid-read, or a malformed reply is a
 * {@link CapabilityFailure} — never a silently-degraded success, and never a
 * throw.
 */

import { isTextContentType, uint8ToBase64 } from '@slicc/shared-ts';
import { apiHeaders, resolveApiUrl } from '../../base/api-endpoint.js';
import { getResponseBodyCap, REQUEST_BODY_CAP } from '../../shell/proxied-fetch.js';
import {
  decodeForbiddenResponseHeaders,
  encodeForbiddenRequestHeaders,
} from '../../shell/proxy-headers.js';
import { normalizeApprovalDecision } from './approval-decision.js';
import { capabilityRequestBytes } from './request-body.js';
import type { RestCapabilityBrokerOptions } from './rest-adapter.js';
import { REST_CAPABILITY_PATHS, REST_CONTROL_CALL_TIMEOUT_MS } from './rest-paths.js';
import {
  type ApprovalDecision,
  type ApprovalRequest,
  type CapabilityDomain,
  type CapabilityResult,
  capabilityFailed,
  capabilityUnavailable,
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
 * Deadline on a MACHINE-paced control-plane call — secrets and
 * sign-and-forward, where the server answers as fast as it can.
 *
 * A wedged server does not reject, it simply never answers, so without a
 * deadline `callJson` waits until the tab dies and a scoop that asked for its
 * masked env at shell init never finishes mounting. Matches
 * `MASKED_SECRETS_TIMEOUT_MS` in `core/secret-env.ts`.
 *
 * Two operations deliberately do NOT take it, both because a slow answer is
 * not a broken one:
 *
 *   - `network.crossOriginFetch` — a multi-MB download is not a hang.
 *   - `approvals.request` — `/api/sudo-approve` returns only once the OS
 *     dialog has been ANSWERED, so this deadline would deny every approval a
 *     person took more than ten seconds to think about. Its budget is the
 *     caller's `signal` (the 5-minute `withApprovalTimeout` in `sudo/`),
 *     exactly as `sudo/http-broker.ts` does it today.
 */
const CONTROL_CALL_TIMEOUT_MS = REST_CONTROL_CALL_TIMEOUT_MS;

/** Whether a rejection is a cancellation rather than a transport error. */
function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * The signal for one call: the machine deadline, cancelled early if the
 * caller aborts. `AbortSignal.any` is unavailable in older runtimes, in which
 * case the fixed deadline alone still bounds the call.
 *
 * `humanPaced` drops the deadline entirely and honours only the caller — see
 * {@link CONTROL_CALL_TIMEOUT_MS}.
 */
function callSignal(
  timeoutMs: number,
  caller: AbortSignal | undefined,
  humanPaced: boolean
): AbortSignal | undefined {
  if (humanPaced) return caller;
  const deadline = AbortSignal.timeout(timeoutMs);
  if (!caller) return deadline;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([deadline, caller]) : deadline;
}

interface JsonCall {
  /** HTTP status, or `0` when the request never reached the server. */
  status: number;
  ok: boolean;
  body: unknown;
}

/** Per-call knobs for {@link RestTransport.callJson}. */
interface JsonCallOptions {
  /** The caller's own cancellation, if it has one. */
  signal?: AbortSignal;
  /**
   * True when the reply waits on a PERSON, so the machine deadline must not
   * apply. Only `approvals.request` sets it.
   */
  humanPaced?: boolean;
}

/** The bound HTTP surface every operation below shares. */
interface RestTransport {
  callJson(
    method: string,
    path: string,
    body?: unknown,
    options?: JsonCallOptions
  ): Promise<JsonCall>;
  send(path: string, init: RequestInit): Promise<Response | Error>;
  headers(extra?: Record<string, string>): Record<string, string>;
}

function createTransport(options: RestCapabilityBrokerOptions): RestTransport {
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const resolveUrl = options.resolveUrl ?? resolveApiUrl;
  const headers = options.headers ?? apiHeaders;
  const timeoutMs = options.controlTimeoutMs ?? CONTROL_CALL_TIMEOUT_MS;

  async function send(path: string, init: RequestInit): Promise<Response | Error> {
    try {
      return await fetchImpl(resolveUrl(path), init);
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  return {
    headers,
    send,
    async callJson(method, path, body, options) {
      const signal = callSignal(timeoutMs, options?.signal, options?.humanPaced === true);
      const init: RequestInit = {
        method,
        headers: headers({ 'Content-Type': 'application/json' }),
        ...(signal ? { signal } : {}),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const resp = await send(path, init);
      if (resp instanceof Error) {
        return {
          status: 0,
          ok: false,
          body: {
            error: isAbort(resp) ? `no answer within ${timeoutMs}ms` : resp.message,
          },
        };
      }
      // A body that fails mid-read is a failed call, not a thrown one.
      const parsed = await resp.json().catch(() => undefined);
      return { status: resp.status, ok: resp.ok, body: parsed };
    },
  };
}

/** Message from a `{ error }` body, falling back to the status line. */
function errorText(call: JsonCall, fallback: string): string {
  const error = (call.body as { error?: unknown } | undefined)?.error;
  if (typeof error === 'string' && error.length > 0) return error;
  return call.status === 0
    ? `${fallback} (transport unreachable)`
    : `${fallback} (HTTP ${call.status})`;
}

/** `undefined` for a request that never reached the server. */
function statusOf(call: JsonCall): number | undefined {
  return call.status === 0 ? undefined : call.status;
}

/** The typed miss for a call that did not succeed. */
function failed(
  capability: CapabilityDomain,
  operation: string,
  call: JsonCall,
  fallback: string
): CapabilityResult<never> {
  return capabilityFailed(capability, operation, errorText(call, fallback), statusOf(call));
}

async function maskedEntries(
  transport: RestTransport,
  operation: 'listMaskedEnv' | 'getMasked'
): Promise<CapabilityResult<readonly SecretMaskedEnvEntry[]>> {
  const call = await transport.callJson('GET', REST_CAPABILITY_PATHS.secretsMasked);
  if (!call.ok) return failed('secrets', operation, call, 'masked secrets request failed');
  if (!Array.isArray(call.body)) {
    return capabilityFailed('secrets', operation, 'masked secrets response is not an array');
  }
  return { ok: true, value: call.body as SecretMaskedEnvEntry[] };
}

/** Only the masked route is ever read: a real secret value never leaves the server. */
function restSecrets(transport: RestTransport): Partial<SecretCapability> {
  return {
    async listMaskedEnv(): Promise<CapabilityResult<SecretListResult>> {
      const entries = await maskedEntries(transport, 'listMaskedEnv');
      return entries.ok ? { ok: true, value: { entries: entries.value } } : entries;
    },
    async getMasked(request: SecretGetRequest): Promise<CapabilityResult<SecretMaskedEnvEntry>> {
      const entries = await maskedEntries(transport, 'getMasked');
      if (!entries.ok) return entries;
      const found = entries.value.find((entry) => entry.name === request.name);
      if (!found) {
        return capabilityFailed('secrets', 'getMasked', `no secret named "${request.name}"`, 404);
      }
      return { ok: true, value: found };
    },
    async set(request: SecretSetRequest): Promise<CapabilityResult<void>> {
      const persisted = request.scope === 'persisted';
      const path = persisted
        ? REST_CAPABILITY_PATHS.secretsPersisted
        : REST_CAPABILITY_PATHS.secretsSession;
      const call = await transport.callJson('POST', path, {
        name: request.name,
        value: request.value,
        domains: [...(request.domains ?? [])],
      });
      // swift-server does not register `POST /api/secrets` (issue #2806), so
      // its 404 means "this float can never persist a secret" — permanent,
      // not retryable. Reporting it as a failure would have a caller retry
      // forever. The session route exists on both servers, which is why the
      // operation stays on the allowlist.
      if (persisted && call.status === 404) {
        return capabilityUnavailable(
          'secrets',
          'set',
          'this server has no persisted-secret write route (see issue #2806); ' +
            "retry with scope: 'session'"
        );
      }
      if (!call.ok) return failed('secrets', 'set', call, 'set secret failed');
      return { ok: true, value: undefined };
    },
    async delete(request: SecretDeleteRequest): Promise<CapabilityResult<SecretDeleteResult>> {
      const call = await transport.callJson(
        'DELETE',
        `${REST_CAPABILITY_PATHS.secretsPersisted}/${encodeURIComponent(request.name)}`
      );
      // A 404 is the server saying "no such secret" — surfaced, not swallowed.
      // Whether that is acceptable is the CALLER's policy (`secret rm` may
      // want it to be idempotent; a scrub may not), and a broker that decided
      // it here would take the choice away.
      if (!call.ok) return failed('secrets', 'delete', call, 'delete secret failed');
      const body = call.body as { removed?: boolean; fromSession?: boolean } | undefined;
      return {
        ok: true,
        value: { removed: body?.removed ?? true, fromSession: body?.fromSession === true },
      };
    },
  };
}

async function restCrossOriginFetch(
  transport: RestTransport,
  request: NetworkFetchRequest
): Promise<CapabilityResult<NetworkFetchResponse>> {
  const method = request.method ?? 'GET';
  const headers = transport.headers({
    ...encodeForbiddenRequestHeaders(request.headers),
    'X-Target-URL': request.url,
  });
  const init: RequestInit = { method, headers, cache: 'no-store' };
  if (request.signal) init.signal = request.signal;

  // Same ceilings the Port legs enforce (`proxied-fetch.ts`): a body past
  // them is far likelier to take the tab down than to finish.
  const bytes = capabilityRequestBytes(request);
  if (bytes !== undefined) {
    if (bytes.byteLength > REQUEST_BODY_CAP) {
      return capabilityFailed(
        'network',
        'crossOriginFetch',
        `request body is ${bytes.byteLength} bytes, over the ${REQUEST_BODY_CAP}-byte proxy limit`
      );
    }
    init.body = bytes as BodyInit;
  }

  const resp = await transport.send(REST_CAPABILITY_PATHS.fetchProxy, init);
  if (resp instanceof Error) {
    return capabilityFailed(
      'network',
      'crossOriginFetch',
      isAbort(resp) ? 'request cancelled' : resp.message
    );
  }
  // `X-Proxy-Error` marks a failure of the PROXY, not of the upstream — an
  // upstream 4xx/5xx is a legitimate result the caller must still see.
  if (resp.headers.get('x-proxy-error') === '1') {
    const detail = await resp.text().catch(() => '');
    return capabilityFailed(
      'network',
      'crossOriginFetch',
      detail || 'fetch-proxy reported an error',
      resp.status
    );
  }

  const cap = getResponseBodyCap();
  const hinted = Number(resp.headers.get('content-length') ?? '');
  if (Number.isFinite(hinted) && hinted > cap) {
    return capabilityFailed(
      'network',
      'crossOriginFetch',
      `response body is ${hinted} bytes, over the ${cap}-byte download limit`,
      resp.status
    );
  }
  // A body can stall or reset after the headers land, so consuming it is
  // inside the non-throwing contract too.
  let body: Uint8Array;
  try {
    body = new Uint8Array(await resp.arrayBuffer());
  } catch (err) {
    return capabilityFailed(
      'network',
      'crossOriginFetch',
      isAbort(err)
        ? 'response body cancelled'
        : `response body failed: ${err instanceof Error ? err.message : String(err)}`,
      resp.status
    );
  }
  // The hint can be absent or wrong, so re-check against what actually arrived.
  if (body.byteLength > cap) {
    return capabilityFailed(
      'network',
      'crossOriginFetch',
      `response body is ${body.byteLength} bytes, over the ${cap}-byte download limit`,
      resp.status
    );
  }

  const raw: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    raw[key] = value;
  });
  const responseHeaders = decodeForbiddenResponseHeaders(raw);
  const textual = isTextContentType(responseHeaders['content-type'] ?? '');
  return {
    ok: true,
    value: {
      status: resp.status,
      ok: resp.ok,
      statusText: resp.statusText,
      headers: responseHeaders,
      body: textual ? new TextDecoder().decode(body) : uint8ToBase64(body),
      bodyEncoding: textual ? 'text' : 'base64',
      url: request.url,
    },
  };
}

async function restSignRequest(
  transport: RestTransport,
  request: MountSignRequest
): Promise<CapabilityResult<MountSignResult>> {
  const path =
    request.backend === 's3'
      ? REST_CAPABILITY_PATHS.s3SignAndForward
      : REST_CAPABILITY_PATHS.daSignAndForward;
  const call = await transport.callJson('POST', path, request.envelope);
  const reply = call.body as MountSignResult | undefined;
  // A refusal the server encoded as an envelope is a VALUE, not a capability
  // miss — the transport worked, the request did not.
  if (reply && typeof reply === 'object' && typeof reply.ok === 'boolean') {
    return { ok: true, value: reply };
  }
  return failed('mounts', 'signRequest', call, 'sign-and-forward response is not an envelope');
}

async function restRequestApproval(
  transport: RestTransport,
  request: ApprovalRequest
): Promise<CapabilityResult<ApprovalDecision>> {
  const suggestedPattern = request.suggestedPattern ?? request.detail;
  const call = await transport.callJson(
    'POST',
    REST_CAPABILITY_PATHS.sudoApprove,
    {
      kind: request.kind,
      detail: request.detail,
      suggestedPattern,
      // Authenticated identity. Dropping it leaves the OS / TTY prompt showing
      // nothing but `detail`, which for a guest message is prose the requester
      // wrote about themselves.
      ...(request.requester ? { requester: request.requester } : {}),
      ...(request.approver ? { approver: request.approver } : {}),
    },
    // The reply IS the human's decision, so the only budget is the caller's.
    { humanPaced: true, ...(request.signal ? { signal: request.signal } : {}) }
  );
  if (!call.ok) {
    return failed('approvals', 'request', call, 'approval endpoint returned non-OK');
  }
  return { ok: true, value: normalizeApprovalDecision(call.body, suggestedPattern) };
}

/** Everything `rest-adapter.ts` defers until an operation is first called. */
export interface RestOps {
  crossOriginFetch(request: NetworkFetchRequest): Promise<CapabilityResult<NetworkFetchResponse>>;
  secrets: Required<Pick<SecretCapability, 'listMaskedEnv' | 'getMasked' | 'set' | 'delete'>>;
  signRequest(request: MountSignRequest): Promise<CapabilityResult<MountSignResult>>;
  requestApproval(request: ApprovalRequest): Promise<CapabilityResult<ApprovalDecision>>;
}

/** Bind every operation to one transport built from the broker's options. */
export function createRestOps(options: RestCapabilityBrokerOptions): RestOps {
  const transport = createTransport(options);
  return {
    crossOriginFetch: (request) => restCrossOriginFetch(transport, request),
    secrets: restSecrets(transport) as RestOps['secrets'],
    signRequest: (request) => restSignRequest(transport, request),
    requestApproval: (request) => restRequestApproval(transport, request),
  };
}
