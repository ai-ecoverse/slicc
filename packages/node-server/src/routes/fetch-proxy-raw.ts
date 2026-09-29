import {
  decodeRawRequestHead,
  encodeRawResponseFrame,
  foldRawRequestHeaders,
  HMAC_SIGN_HEADER,
  isDecodedPartialResponse,
  isTextContentType,
  RAW_FETCH_BRIDGE_REQUEST_BODY_CAP,
  RAW_FETCH_CONTENT_TYPE,
  RAW_FETCH_PROBE_HEADER,
  RAW_FETCH_PROTOCOL_VERSION,
  RAW_FETCH_REQUEST_HEADER,
  type RawFetchProbeReply,
  type RawFetchRequestHead,
  type RawHeaderList,
  rawAcceptEncoding,
  rawResponseHasBody,
  rawResponseHeaders,
  stripRawRequestHeaders,
} from '@slicc/shared-ts';
import type { Express, Request, Response } from 'express';
import type { SecretProxyManager } from '../secrets/proxy-manager.js';
import type { AgentActivityTracker } from './agent-activity.js';
import {
  applyHmacSigning,
  attachUpstreamAbort,
  injectRequestSecrets,
  streamUpstreamBody,
  unmaskRequestBody,
} from './fetch-proxy.js';

const RAW_REQUEST_HEADER_LOWER = RAW_FETCH_REQUEST_HEADER.toLowerCase();
const RAW_PROBE_HEADER_LOWER = RAW_FETCH_PROBE_HEADER.toLowerCase();

export interface RawFetchProxyDeps {
  secretProxy: SecretProxyManager;
  activityTracker: AgentActivityTracker;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;

  maxRequestBodyBytes?: number;
}

class RequestBodyTooLargeError extends Error {}

function sendProxyError(res: Response, status: number, error: string): void {
  res.setHeader('X-Proxy-Error', '1');
  res.status(status).json({ error });
}

async function readBoundedBody(req: Request, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new RequestBodyTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Uint8Array);
    size += buf.byteLength;
    if (size > limit) throw new RequestBodyTooLargeError();
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function upstreamHeaderList(upstream: globalThis.Response): RawHeaderList {
  const list: RawHeaderList = [];
  upstream.headers.forEach((value, name) => {
    if (name !== 'set-cookie') list.push([name, value]);
  });
  for (const cookie of upstream.headers.getSetCookie()) list.push(['set-cookie', cookie]);
  return list;
}

type PreparedUpstream =
  | { forbidden: { secretName: string; hostname: string } }
  | { url: string; init: RequestInit };

async function prepareUpstream(
  secretProxy: SecretProxyManager,
  head: RawFetchRequestHead,
  rawBody: Buffer
): Promise<PreparedUpstream> {
  const headers = foldRawRequestHeaders(stripRawRequestHeaders(head.headers));
  const hmacSpec = headers[HMAC_SIGN_HEADER];
  delete headers[HMAC_SIGN_HEADER];
  const acceptEncoding = rawAcceptEncoding(headers);
  if (acceptEncoding !== undefined) headers['accept-encoding'] = acceptEncoding;

  let hostname = '';
  try {
    hostname = new URL(head.url).hostname;
  } catch {}
  const injection = injectRequestSecrets(secretProxy, headers, head.url, hostname);
  if ('forbidden' in injection) return injection;

  const method = head.method.toUpperCase();
  let body: Buffer | undefined;
  if (rawBody.length > 0 && method !== 'GET' && method !== 'HEAD') {
    body = unmaskRequestBody(secretProxy, headers, rawBody, hostname);
  }
  const signing = await applyHmacSigning(secretProxy, headers, hmacSpec, body, hostname);
  if (signing) return signing;

  const init: RequestInit = { method: head.method, headers, redirect: 'manual' };
  if (body) init.body = body as unknown as RequestInit['body'];
  return { url: injection.cleanedUrl, init };
}

function relayUpstream(
  res: Response,
  head: RawFetchRequestHead,
  upstream: globalThis.Response,
  secretProxy: SecretProxyManager,
  detachClientClose: () => void
): void {
  const hasBody = rawResponseHasBody(head.method, upstream.status) && upstream.body !== null;

  const bodyRewritten = isTextContentType(upstream.headers.get('content-type') ?? '');
  const headers = rawResponseHeaders({
    method: head.method,
    status: upstream.status,
    headers: upstreamHeaderList(upstream),
    bodyRewritten,
  }).map(([name, value]): [string, string] => [name, secretProxy.scrubResponse(value)]);

  res.status(200);
  res.setHeader('Content-Type', RAW_FETCH_CONTENT_TYPE);
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.write(
    encodeRawResponseFrame({
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
      url: head.url,
    })
  );
  if (!hasBody || !upstream.body) {
    void upstream.body?.cancel().catch(() => undefined);
    res.end();
    detachClientClose();
    return;
  }
  streamUpstreamBody(res, upstream, secretProxy, detachClientClose);
}

export function isRawFetchProxyRequest(req: Request): boolean {
  return typeof req.headers[RAW_REQUEST_HEADER_LOWER] === 'string';
}

export function isRawFetchProbe(req: Request): boolean {
  return req.headers[RAW_PROBE_HEADER_LOWER] !== undefined;
}

export function answerRawFetchProbe(res: Response, maxRequestBodyBytes: number): void {
  const reply: RawFetchProbeReply = {
    rawFetch: RAW_FETCH_PROTOCOL_VERSION,
    requestBodyStreaming: false,
    maxRequestBodyBytes,
  };
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(reply);
}

export async function handleRawFetchProxy(
  req: Request,
  res: Response,
  deps: RawFetchProxyDeps
): Promise<void> {
  const { secretProxy, logger = console } = deps;
  const limit = deps.maxRequestBodyBytes ?? RAW_FETCH_BRIDGE_REQUEST_BODY_CAP;
  const head = decodeRawRequestHead(String(req.headers[RAW_REQUEST_HEADER_LOWER]));
  if (!head) {
    sendProxyError(res, 400, `Malformed ${RAW_FETCH_REQUEST_HEADER} header`);
    return;
  }
  let rawBody: Buffer;
  try {
    rawBody = await readBoundedBody(req, limit);
  } catch (err) {
    if (!(err instanceof RequestBodyTooLargeError)) throw err;
    logger.warn(`[fetch-proxy:raw] ${head.method} ${head.url} → 413`);
    res.setHeader('Connection', 'close');
    sendProxyError(res, 413, `Request body exceeds the ${limit} byte limit of this float`);
    return;
  }
  logger.log(`[fetch-proxy:raw] ${head.method} ${head.url}`);

  const prepared = await prepareUpstream(secretProxy, head, rawBody);
  if ('forbidden' in prepared) {
    const { secretName, hostname } = prepared.forbidden;
    logger.warn(`[fetch-proxy:raw] ${head.method} ${head.url} → 403 (secret "${secretName}")`);
    sendProxyError(res, 403, `Secret "${secretName}" is not allowed for domain "${hostname}"`);
    return;
  }

  const upstreamAbort = attachUpstreamAbort(res);
  prepared.init.signal = upstreamAbort.controller.signal;
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(prepared.url, prepared.init);
  } catch (err) {
    upstreamAbort.detach();
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[fetch-proxy:raw] ${head.method} ${head.url} ← 502 (${message})`);
    sendProxyError(res, 502, `Proxy fetch failed: ${message}`);
    return;
  }
  logger.log(`[fetch-proxy:raw] ${head.method} ${head.url} ← ${upstream.status}`);
  if (
    isDecodedPartialResponse({ status: upstream.status, headers: upstreamHeaderList(upstream) })
  ) {
    upstreamAbort.detach();
    await upstream.body?.cancel().catch(() => undefined);
    logger.warn(`[fetch-proxy:raw] ${head.method} ${head.url} ← 206 encoded despite identity`);
    sendProxyError(res, 502, 'Upstream answered a range request with an encoded partial body');
    return;
  }
  relayUpstream(res, head, upstream, secretProxy, upstreamAbort.detach);
}

export function registerRawFetchProxyRoute(app: Express, deps: RawFetchProxyDeps): void {
  app.post('/api/fetch-proxy', (req, res, next) => {
    if (isRawFetchProbe(req) && !isRawFetchProxyRequest(req)) {
      answerRawFetchProbe(res, deps.maxRequestBodyBytes ?? RAW_FETCH_BRIDGE_REQUEST_BODY_CAP);
      return;
    }
    if (!isRawFetchProxyRequest(req)) {
      next();
      return;
    }
    deps.activityTracker.recordActivity();
    handleRawFetchProxy(req, res, deps).catch(next);
  });
}
