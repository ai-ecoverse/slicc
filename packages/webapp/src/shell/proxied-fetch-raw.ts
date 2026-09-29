import {
  decodeRawResponseFrame,
  encodeRawRequestHead,
  parseRawFetchProbeReply,
  RAW_FETCH_CONTENT_TYPE,
  RAW_FETCH_PORT_CHUNK_BYTES,
  RAW_FETCH_PROBE_HEADER,
  RAW_FETCH_REQUEST_HEADER,
  type RawFetchErrorCode,
  type RawFetchProbeReply,
  rawResponseHasBody,
  rawUploadStreams,
  readerSource,
  supportsRequestStreams,
  withUnsentUploadRetry,
} from '@slicc/shared-ts';
import {
  apiHeaders,
  getChromeExtensionRealm,
  getExtensionDelegateId,
  resolveApiUrl,
} from '../base/api-endpoint.js';
import { probeRawPort, type RawFetchPort, rawFetchViaPort } from './proxied-fetch-raw-port.js';
import {
  type RawFetchCapabilities,
  RawFetchError,
  type RawFetchInit,
  type RawFetchResponse,
  type RawProxiedFetch,
  usesFetchProxyEndpoint,
} from './proxied-fetch-raw-types.js';
import { isProxyError, readProxyErrorMessage } from './proxy-error.js';

export type { RawHeaderList } from '@slicc/shared-ts';

export {
  type RawFetchCapabilities,
  RawFetchError,
  type RawFetchErrorCode,
  type RawFetchInit,
  type RawFetchResponse,
  type RawProxiedFetch,
  usesFetchProxyEndpoint,
} from './proxied-fetch-raw-types.js';

export function extensionPortConnector(): (() => RawFetchPort) | null {
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.connect !== 'function') return null;
  if (getChromeExtensionRealm()) {
    return () => chrome.runtime.connect({ name: 'fetch-proxy.fetch' }) as unknown as RawFetchPort;
  }
  const id = getExtensionDelegateId();
  if (!id) return null;
  const connect = chrome.runtime.connect as unknown as (
    extensionId: string,
    info: { name: string }
  ) => RawFetchPort;
  return () => connect(id, { name: 'fetch-proxy.fetch' });
}

const UNSUPPORTED: RawFetchCapabilities = {
  supported: false,
  requestBodyStreaming: false,
  maxRequestBodyBytes: 0,
};

interface ProbeAnswer {
  capabilities: RawFetchCapabilities;
  keepMs: number;
}

const SILENT_EXTENSION_KEEP_MS = 5 * 60 * 1000;
const PORT_PROBE_TIMEOUT_MS = 5000;

const probed = new Map<string, { answer: Promise<RawFetchCapabilities>; expires: number }>();

function fromReply(reply: RawFetchProbeReply): RawFetchCapabilities {
  return {
    supported: true,
    requestBodyStreaming: reply.requestBodyStreaming,
    maxRequestBodyBytes: reply.maxRequestBodyBytes,
  };
}

async function probeBridge(url: string): Promise<ProbeAnswer> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: apiHeaders({ [RAW_FETCH_PROBE_HEADER]: '1' }),
      cache: 'no-store',
    });
  } catch {
    return { capabilities: UNSUPPORTED, keepMs: 0 };
  }
  const reply = resp.ok ? parseRawFetchProbeReply(await resp.json().catch(() => null)) : null;
  if (!reply) await resp.body?.cancel().catch(() => undefined);
  if (!reply) return { capabilities: UNSUPPORTED, keepMs: Infinity };

  const capabilities = fromReply(reply);
  capabilities.requestBodyStreaming &&= supportsRequestStreams();
  return { capabilities, keepMs: Infinity };
}

async function probeExtension(connect: () => RawFetchPort): Promise<ProbeAnswer> {
  const reply = await probeRawPort(connect, PORT_PROBE_TIMEOUT_MS);
  if (reply === 'silent') return { capabilities: UNSUPPORTED, keepMs: SILENT_EXTENSION_KEEP_MS };
  return { capabilities: reply ? fromReply(reply) : UNSUPPORTED, keepMs: Infinity };
}

async function probeFromWorker(): Promise<ProbeAnswer> {
  const { getPanelRpcClient } = await import('../kernel/panel-rpc.js');
  const client = getPanelRpcClient();
  if (!client) return { capabilities: UNSUPPORTED, keepMs: 0 };
  try {
    const capabilities = await client.call('raw-fetch-probe', {}, { timeoutMs: 15_000 });
    return { capabilities, keepMs: capabilities.supported ? Infinity : SILENT_EXTENSION_KEEP_MS };
  } catch {
    return { capabilities: UNSUPPORTED, keepMs: 0 };
  }
}

function probeTarget(): { key: string; probe: () => Promise<ProbeAnswer> } {
  if (usesFetchProxyEndpoint()) {
    const url = resolveApiUrl('/api/fetch-proxy');
    return { key: `bridge:${url}`, probe: () => probeBridge(url) };
  }
  const connect = extensionPortConnector();
  const extension = getExtensionDelegateId() ?? 'self';
  if (connect) return { key: `port:${extension}`, probe: () => probeExtension(connect) };
  return { key: `worker:${extension}`, probe: probeFromWorker };
}

export function getRawFetchCapabilities(): Promise<RawFetchCapabilities> {
  const { key, probe } = probeTarget();
  const cached = probed.get(key);
  if (cached && cached.expires > Date.now()) return cached.answer;
  const answer = probe().then(({ capabilities, keepMs }) => {
    if (keepMs === 0) probed.delete(key);
    else probed.set(key, { answer, expires: Date.now() + keepMs });
    return capabilities;
  });
  probed.set(key, { answer, expires: Infinity });
  return answer;
}

export function resetRawFetchCapabilities(): void {
  probed.clear();
}

function unsupported(
  message = 'raw fetch: this bridge does not support raw mode; update node-server'
): RawFetchError {
  return new RawFetchError('unsupported', 501, message);
}

function requireSupport(fetchImpl: RawProxiedFetch): RawProxiedFetch {
  return async (url, init) => {
    if (!(await getRawFetchCapabilities()).supported) {
      throw unsupported('raw fetch: this extension does not support raw mode; update it');
    }
    return fetchImpl(url, init);
  };
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function tooLarge(limit: number): RawFetchError {
  return new RawFetchError(
    'request-body-too-large',
    413,
    `raw fetch: request body exceeds the ${limit} byte limit of this float`
  );
}

function readOrAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

async function bufferRequestBody(
  body: RawFetchInit['body'],
  limit: number,
  signal?: AbortSignal
): Promise<Blob | null> {
  if (body === undefined) return null;
  if (body instanceof Blob || body instanceof Uint8Array) {
    const blob = body instanceof Blob ? body : new Blob([body as Uint8Array<ArrayBuffer>]);
    if (blob.size > limit) throw tooLarge(limit);
    return blob;
  }
  const reader = body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await readOrAbort(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw tooLarge(limit);
      parts.push(value as Uint8Array<ArrayBuffer>);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  return new Blob(parts);
}

async function bridgeError(resp: Response): Promise<RawFetchError> {
  const message = await readProxyErrorMessage(resp);
  if (resp.status === 413) return new RawFetchError('request-body-too-large', 413, message);
  if (resp.status === 403) return new RawFetchError('forbidden-secret', 403, message);
  if (resp.status === 400 && /X-Target-URL/i.test(message)) return unsupported();
  if (resp.status === 502) return new RawFetchError('upstream', 502, message);
  return new RawFetchError('bridge', 502, message);
}

async function splitRawResponse(resp: Response, method: string): Promise<RawFetchResponse> {
  if (!resp.body) throw new RawFetchError('bridge', 502, 'raw fetch: bridge sent no body');
  const reader = resp.body.getReader();
  let buffered: Uint8Array = new Uint8Array(0);
  let split: ReturnType<typeof decodeRawResponseFrame> = null;
  try {
    while (!split) {
      const { done, value } = await reader.read();
      if (done) throw new RawFetchError('bridge', 502, 'raw fetch: truncated response head');
      const next = new Uint8Array(buffered.byteLength + value.byteLength);
      next.set(buffered);
      next.set(value, buffered.byteLength);
      buffered = next;
      split = decodeRawResponseFrame(buffered);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    if (err instanceof RawFetchError) throw err;
    throw new RawFetchError('bridge', 502, err instanceof Error ? err.message : String(err));
  }
  const { head, rest } = split;
  if (!rawResponseHasBody(method, head.status)) {
    await reader.cancel().catch(() => undefined);
    return { ...head, body: null };
  }
  let pending: Uint8Array | null = rest.byteLength > 0 ? rest : null;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (pending) {
          controller.enqueue(pending);
          pending = null;
          return;
        }
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (err) {
          controller.error(
            new RawFetchError(
              'upstream',
              502,
              `raw fetch: response body failed: ${err instanceof Error ? err.message : String(err)}`
            )
          );
          return;
        }
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
  return { ...head, body };
}

async function postToBridge(
  request: RequestInit,
  init: RawFetchInit,
  capabilities: RawFetchCapabilities
): Promise<Response> {
  const url = resolveApiUrl('/api/fetch-proxy');
  const body = init.body;
  const streams =
    body !== undefined &&
    rawUploadStreams({
      headers: init.headers ?? [],
      bodyLength:
        body instanceof Uint8Array
          ? body.byteLength
          : body instanceof Blob
            ? body.size
            : init.bodyLength,
      canStream: capabilities.requestBodyStreaming,
    });
  if (!streams || body === undefined) {
    const blob = await bufferRequestBody(body, capabilities.maxRequestBodyBytes, init.signal);
    return fetch(url, blob ? { ...request, body: blob } : request);
  }
  const stream =
    body instanceof Uint8Array
      ? new Blob([body as BlobPart]).stream()
      : body instanceof Blob
        ? body.stream()
        : body;

  return withUnsentUploadRetry(
    readerSource(stream),
    (upload) => fetch(url, { ...request, body: upload, duplex: 'half' } as RequestInit),
    init.signal
  );
}

function bridgeRawFetch(): RawProxiedFetch {
  return async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const capabilities = await getRawFetchCapabilities();
    if (!capabilities.supported) throw unsupported();
    const headers = apiHeaders({
      [RAW_FETCH_REQUEST_HEADER]: encodeRawRequestHead({
        url,
        method,
        headers: init.headers ?? [],
      }),
      'Content-Type': 'application/octet-stream',
      'X-Slicc-Raw-Body': '1',
    });
    const request: RequestInit = { method: 'POST', headers, cache: 'no-store' };
    if (init.signal) request.signal = init.signal;
    let resp: Response;
    try {
      resp = await postToBridge(request, init, capabilities);
    } catch (err) {
      if (init.signal?.aborted || err instanceof RawFetchError) throw err;
      throw new RawFetchError(
        'bridge',
        502,
        `raw fetch: the bridge is unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (isProxyError(resp)) throw await bridgeError(resp);
    if (!(resp.headers.get('content-type') ?? '').startsWith(RAW_FETCH_CONTENT_TYPE)) {
      await resp.body?.cancel().catch(() => undefined);
      throw unsupported();
    }
    return splitRawResponse(resp, method);
  };
}

const RAW_RPC_TIMEOUT_MS = 10 * 60 * 1000;

type PanelRpc = NonNullable<
  ReturnType<typeof import('../kernel/panel-rpc.js')['getPanelRpcClient']>
>;

function rpcFailure<T extends { ok: boolean }>(
  result: T | { ok: false; code: RawFetchErrorCode; status: number; error: string }
): Exclude<T, { ok: false }> {
  if (result.ok) return result as Exclude<T, { ok: false }>;
  const failure = result as { code: RawFetchErrorCode; status: number; error: string };
  throw new RawFetchError(failure.code, failure.status, failure.error);
}

async function pumpUpload(
  client: PanelRpc,
  id: string,
  body: NonNullable<RawFetchInit['body']>,
  signal: AbortSignal | undefined
): Promise<void> {
  const stream = body instanceof ReadableStream ? body : new Blob([body as BlobPart]).stream();
  const reader = stream.getReader();
  const opts = { timeoutMs: RAW_RPC_TIMEOUT_MS, signal };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let off = 0; off < value.byteLength; off += RAW_FETCH_PORT_CHUNK_BYTES) {
      const chunk = value.subarray(off, off + RAW_FETCH_PORT_CHUNK_BYTES);
      rpcFailure(await client.call('raw-fetch-write', { id, chunk }, opts));
    }
  }
  rpcFailure(await client.call('raw-fetch-write', { id, chunk: null }, opts));
}

function workerRawFetch(): RawProxiedFetch {
  return async (url, init = {}) => {
    const { getPanelRpcClient } = await import('../kernel/panel-rpc.js');
    const client = getPanelRpcClient();
    if (!client) throw new RawFetchError('unsupported', 501, 'raw fetch: panel-RPC unavailable');
    const opts = { timeoutMs: RAW_RPC_TIMEOUT_MS, signal: init.signal };
    const { id } = await client.call(
      'raw-fetch-open',
      {
        url,
        method: init.method ?? 'GET',
        headers: init.headers ?? [],
        hasBody: init.body !== undefined,
        bodyLength:
          init.body instanceof Uint8Array
            ? init.body.byteLength
            : init.body instanceof Blob
              ? init.body.size
              : init.bodyLength,
      },
      opts
    );
    const cancel = () => void client.call('raw-fetch-cancel', { id }).catch(() => undefined);
    init.signal?.addEventListener('abort', cancel, { once: true });
    if (init.body !== undefined) pumpUpload(client, id, init.body, init.signal).catch(cancel);
    const { head, hasBody } = rpcFailure(await client.call('raw-fetch-head', { id }, opts));
    if (!hasBody) return { ...head, body: null };
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const { chunk } = rpcFailure(await client.call('raw-fetch-read', { id }, opts));
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    return { ...head, body };
  };
}

export function createRawProxiedFetch(): RawProxiedFetch {
  if (usesFetchProxyEndpoint()) return bridgeRawFetch();
  const connect = extensionPortConnector();
  if (connect) return requireSupport((url, init) => rawFetchViaPort(connect, url, init));
  return requireSupport(workerRawFetch());
}
