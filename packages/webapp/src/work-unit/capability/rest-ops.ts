/**
 * The `node-rest` adapter's wire implementation (#2276 slice B).
 *
 * Split from `rest-adapter.ts` and reached only through a dynamic import so
 * none of it joins the kernel worker's eager boot closure: the broker's
 * SHAPE (which operations exist) is needed at composition time, the bytes
 * that talk HTTP are not needed until an operation is actually called.
 *
 * Every operation is fail-closed: a non-2xx status, an unreachable transport
 * or a malformed body is a {@link CapabilityFailure}, never a
 * silently-degraded success and never a throw.
 */

import { base64ToUint8, isTextContentType, uint8ToBase64 } from '@slicc/shared-ts';
import { apiHeaders, resolveApiUrl } from '../../base/api-endpoint.js';
import {
  decodeForbiddenResponseHeaders,
  encodeForbiddenRequestHeaders,
} from '../../shell/proxy-headers.js';
import type { RestCapabilityBrokerOptions } from './rest-adapter.js';
import { REST_CAPABILITY_PATHS } from './rest-paths.js';
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

interface JsonCall {
  /** HTTP status, or `0` when the request never reached the server. */
  status: number;
  ok: boolean;
  body: unknown;
}

/** The bound HTTP surface every operation below shares. */
interface RestTransport {
  callJson(method: string, path: string, body?: unknown): Promise<JsonCall>;
  send(path: string, init: RequestInit): Promise<Response | Error>;
  headers(extra?: Record<string, string>): Record<string, string>;
}

function createTransport(options: RestCapabilityBrokerOptions): RestTransport {
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const resolveUrl = options.resolveUrl ?? resolveApiUrl;
  const headers = options.headers ?? apiHeaders;

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
    async callJson(method, path, body) {
      const init: RequestInit = {
        method,
        headers: headers({ 'Content-Type': 'application/json' }),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const resp = await send(path, init);
      if (resp instanceof Error) {
        return { status: 0, ok: false, body: { error: resp.message } };
      }
      return { status: resp.status, ok: resp.ok, body: await resp.json().catch(() => undefined) };
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

async function maskedEntries(
  transport: RestTransport,
  operation: 'listMaskedEnv' | 'get'
): Promise<CapabilityResult<readonly SecretMaskedEnvEntry[]>> {
  const call = await transport.callJson('GET', REST_CAPABILITY_PATHS.secretsMasked);
  if (!call.ok) {
    return capabilityFailed(
      'secrets',
      operation,
      errorText(call, 'masked secrets request failed'),
      statusOf(call)
    );
  }
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
    async get(request: SecretGetRequest): Promise<CapabilityResult<SecretValue>> {
      const entries = await maskedEntries(transport, 'get');
      if (!entries.ok) return entries;
      const found = entries.value.find((entry) => entry.name === request.name);
      if (!found) {
        return capabilityFailed('secrets', 'get', `no secret named "${request.name}"`, 404);
      }
      return { ok: true, value: { name: found.name, maskedValue: found.maskedValue } };
    },
    async set(request: SecretSetRequest): Promise<CapabilityResult<void>> {
      const path =
        request.scope === 'session'
          ? REST_CAPABILITY_PATHS.secretsSession
          : REST_CAPABILITY_PATHS.secretsPersisted;
      const call = await transport.callJson('POST', path, {
        name: request.name,
        value: request.value,
        domains: [...(request.domains ?? [])],
      });
      if (!call.ok) {
        return capabilityFailed(
          'secrets',
          'set',
          errorText(call, 'set secret failed'),
          statusOf(call)
        );
      }
      return { ok: true, value: undefined };
    },
    async delete(request: SecretDeleteRequest): Promise<CapabilityResult<void>> {
      const call = await transport.callJson(
        'DELETE',
        `${REST_CAPABILITY_PATHS.secretsPersisted}/${encodeURIComponent(request.name)}`
      );
      // Deleting what is already gone is the requested end state.
      if (call.ok || call.status === 404) return { ok: true, value: undefined };
      return capabilityFailed(
        'secrets',
        'delete',
        errorText(call, 'delete secret failed'),
        statusOf(call)
      );
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
  if (request.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body =
      request.bodyEncoding === 'base64' ? (base64ToUint8(request.body) as BodyInit) : request.body;
  }
  const resp = await transport.send(REST_CAPABILITY_PATHS.fetchProxy, init);
  if (resp instanceof Error) {
    return capabilityFailed('network', 'crossOriginFetch', resp.message);
  }
  // `X-Proxy-Error` marks a failure of the PROXY, not of the upstream — an
  // upstream 4xx/5xx is a legitimate result the caller must still see.
  if (resp.headers.get('x-proxy-error') === '1') {
    return capabilityFailed(
      'network',
      'crossOriginFetch',
      await resp.text().catch(() => 'fetch-proxy reported an error'),
      resp.status
    );
  }
  const raw: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    raw[key] = value;
  });
  const responseHeaders = decodeForbiddenResponseHeaders(raw);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const textual = isTextContentType(responseHeaders['content-type'] ?? '');
  return {
    ok: true,
    value: {
      status: resp.status,
      ok: resp.ok,
      statusText: resp.statusText,
      headers: responseHeaders,
      body: textual ? new TextDecoder().decode(bytes) : uint8ToBase64(bytes),
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
  return capabilityFailed(
    'mounts',
    'signRequest',
    errorText(call, 'sign-and-forward response is not an envelope'),
    statusOf(call)
  );
}

async function restRequestApproval(
  transport: RestTransport,
  request: ApprovalRequest
): Promise<CapabilityResult<ApprovalDecision>> {
  const suggestedPattern = request.suggestedPattern ?? request.detail;
  const call = await transport.callJson('POST', REST_CAPABILITY_PATHS.sudoApprove, {
    kind: request.kind,
    detail: request.detail,
    suggestedPattern,
    // Authenticated identity. Dropping it leaves the OS / TTY prompt showing
    // nothing but `detail`, which for a guest message is prose the requester
    // wrote about themselves.
    ...(request.requester ? { requester: request.requester } : {}),
  });
  if (!call.ok) {
    return capabilityFailed(
      'approvals',
      'request',
      errorText(call, 'approval endpoint returned non-OK'),
      statusOf(call)
    );
  }
  return { ok: true, value: normalizeDecision(call.body, suggestedPattern) };
}

/**
 * Coerce an untrusted endpoint body into an {@link ApprovalDecision}. Anything
 * that is not a recognized `allow` / `always` shape becomes `deny` (fail
 * closed); an `always` without a pattern falls back to the suggested default.
 * Mirrors `sudo/http-broker.ts` so the two cannot drift.
 */
function normalizeDecision(body: unknown, suggested: string): ApprovalDecision {
  if (!body || typeof body !== 'object') return { decision: 'deny' };
  const decision = (body as { decision?: unknown }).decision;
  if (decision === 'allow') return { decision: 'allow' };
  if (decision === 'always') {
    const pattern = (body as { pattern?: unknown }).pattern;
    const resolved =
      typeof pattern === 'string' && pattern.trim().length > 0 ? pattern.trim() : suggested;
    return { decision: 'always', pattern: resolved };
  }
  return { decision: 'deny' };
}

/** Everything `rest-adapter.ts` defers until an operation is first called. */
export interface RestOps {
  crossOriginFetch(request: NetworkFetchRequest): Promise<CapabilityResult<NetworkFetchResponse>>;
  secrets: Required<Pick<SecretCapability, 'listMaskedEnv' | 'get' | 'set' | 'delete'>>;
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
