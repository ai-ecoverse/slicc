import {
  base64ToUint8,
  decodeForbiddenRequestHeaders,
  type FetchProxyRequestMsg,
  type FetchProxyResponseMsg,
  HMAC_SIGN_HEADER,
  PROXY_WWW_AUTHENTICATE_HEADER,
  type SecretsPipeline,
  uint8ToBase64,
} from '@slicc/shared-ts';

export const REQUEST_BODY_CAP = 32 * 1024 * 1024;

function extractSetCookies(headers: Headers): string[] {
  const get = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof get === 'function') {
    return get.call(headers);
  }
  const joined = headers.get('set-cookie');
  return joined ? [joined] : [];
}

function buildResponseHeaders(
  scrubbed: Record<string, string>,
  upstream: Headers,
  pipeline: SecretsPipeline
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scrubbed)) {
    const lower = k.toLowerCase();
    if (lower === 'set-cookie' || lower === 'www-authenticate' || lower.startsWith('x-proxy-')) {
      continue;
    }
    out[k] = v;
  }
  const setCookies = extractSetCookies(upstream);
  if (setCookies.length > 0) {
    out['X-Proxy-Set-Cookie'] = pipeline.scrubResponse(JSON.stringify(setCookies));
  }
  const wwwAuthenticate = upstream.get('www-authenticate');
  if (wwwAuthenticate) {
    out[PROXY_WWW_AUTHENTICATE_HEADER] = pipeline.scrubResponse(wwwAuthenticate);
  }
  return out;
}

export interface PortLike {
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
}

export type RequestMsg = FetchProxyRequestMsg;
export type ResponseMsg = FetchProxyResponseMsg;

function send(port: PortLike, msg: ResponseMsg): void {
  port.postMessage(msg);
}

const decodeBase64Bytes = base64ToUint8;
const encodeBase64Bytes = uint8ToBase64;

function isForbiddenRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'cookie' || lower === 'origin' || lower === 'referer' || lower.startsWith('proxy-')
  );
}

interface DnrRule {
  id: number;
  priority: number;
  condition: { urlFilter: string; resourceTypes?: string[] };
  action: {
    type: 'modifyHeaders';
    requestHeaders: Array<{ header: string; operation: 'set'; value: string }>;
  };
}
interface DnrLike {
  updateSessionRules: (opts: { addRules?: DnrRule[]; removeRuleIds?: number[] }) => Promise<void>;
}

function getDnr(): DnrLike | null {
  const c = (globalThis as { chrome?: { declarativeNetRequest?: DnrLike } }).chrome;
  const dnr = c?.declarativeNetRequest;
  if (!dnr || typeof dnr.updateSessionRules !== 'function') return null;
  return dnr;
}

let nextDnrRuleId = 1_000_000;

function randomFragmentToken(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export async function installForbiddenHeaderRule(
  url: string,
  headers: Record<string, string>
): Promise<{ fetchUrl: string; cleanup: () => Promise<void> }> {
  const dnr = getDnr();
  const requestHeaders: Array<{ header: string; operation: 'set'; value: string }> = [];
  for (const [k, v] of Object.entries(headers)) {
    if (isForbiddenRequestHeader(k)) {
      requestHeaders.push({ header: k.toLowerCase(), operation: 'set', value: v });
    }
  }
  if (!dnr || requestHeaders.length === 0) {
    return { fetchUrl: url, cleanup: async () => {} };
  }
  const id = nextDnrRuleId++;
  const fragment = `slicc-req-${randomFragmentToken()}`;

  const fetchUrl = `${url.split('#')[0]}#${fragment}`;
  const rule: DnrRule = {
    id,
    priority: 100,
    condition: { urlFilter: fetchUrl, resourceTypes: ['xmlhttprequest'] },
    action: { type: 'modifyHeaders', requestHeaders },
  };
  await dnr.updateSessionRules({ addRules: [rule] });
  let removed = false;
  const cleanup = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    try {
      await dnr.updateSessionRules({ removeRuleIds: [id] });
    } catch {}
  };
  return { fetchUrl, cleanup };
}

type PreparedRequest =
  | { cleanedUrl: string; headers: Record<string, string>; body: Uint8Array | undefined }
  | { error: string };

async function prepareUpstreamRequest(
  pipeline: SecretsPipeline,
  msg: RequestMsg
): Promise<PreparedRequest> {
  const credsResult = pipeline.extractAndUnmaskUrlCredentials(msg.url);
  if (credsResult.forbidden) {
    return {
      error: `forbidden: ${credsResult.forbidden.secretName} on ${credsResult.forbidden.hostname}`,
    };
  }
  const cleanedUrl = credsResult.url;
  const host = new URL(cleanedUrl).host;

  const headers: Record<string, string> = decodeForbiddenRequestHeaders(msg.headers);
  let hmacSpec: string | undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === HMAC_SIGN_HEADER) {
      hmacSpec = headers[key];
      delete headers[key];
      break;
    }
  }

  const headersResult = pipeline.unmaskHeaders(headers, host);
  if (headersResult.forbidden) {
    return {
      error: `forbidden: ${headersResult.forbidden.secretName} on ${headersResult.forbidden.hostname}`,
    };
  }
  if (credsResult.syntheticAuthorization && !('authorization' in headers)) {
    headers.authorization = credsResult.syntheticAuthorization;
  }

  if (!headers.origin) {
    try {
      headers.origin = new URL(cleanedUrl).origin;
    } catch {}
  }

  let body: Uint8Array | undefined;
  if (msg.bodyBase64) {
    body = pipeline.unmaskBodyBytes(decodeBase64Bytes(msg.bodyBase64), host).bytes;
  }

  if (hmacSpec) {
    const signResult = await pipeline.signHmac(hmacSpec, body ?? new Uint8Array(0), host);
    if (signResult.forbidden) {
      return {
        error: `forbidden: ${signResult.forbidden.secretName} on ${signResult.forbidden.hostname}`,
      };
    }
    if (signResult.headerName && signResult.signatureHex) {
      headers[signResult.headerName] = signResult.signatureHex;
    }
    if (signResult.timestampHeaderName && signResult.timestampValue) {
      headers[signResult.timestampHeaderName] = signResult.timestampValue;
    }
  }

  return { cleanedUrl, headers, body };
}

async function streamUpstreamResponse(
  port: PortLike,
  pipeline: SecretsPipeline,
  upstream: Response
): Promise<void> {
  const scrubbed = pipeline.scrubHeaders(upstream.headers);
  const respHeaders = buildResponseHeaders(scrubbed, upstream.headers, pipeline);
  send(port, {
    type: 'response-head',
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });

  if (upstream.body) {
    const reader = upstream.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const bodyScrubbed = pipeline.scrubResponseBytes(value);
      send(port, { type: 'response-chunk', dataBase64: encodeBase64Bytes(bodyScrubbed) });
    }
  }
  send(port, { type: 'response-end' });
}

async function processProxyRequest(
  port: PortLike,
  pipeline: SecretsPipeline,
  msg: RequestMsg,
  signal: AbortSignal
): Promise<void> {
  try {
    const prepared = await prepareUpstreamRequest(pipeline, msg);
    if ('error' in prepared) {
      send(port, { type: 'response-error', error: prepared.error });
      return;
    }
    const { cleanedUrl, headers, body } = prepared;

    const dnrRule = await installForbiddenHeaderRule(cleanedUrl, headers);
    try {
      const upstream = await fetch(dnrRule.fetchUrl, {
        method: msg.method,
        headers,
        body: body as BodyInit | undefined,
        signal,
      });
      await streamUpstreamResponse(port, pipeline, upstream);
    } finally {
      await dnrRule.cleanup();
    }
  } catch (err) {
    send(port, {
      type: 'response-error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleProxyMessage(
  port: PortLike,
  pipelinePromise: Promise<SecretsPipeline>,
  raw: unknown,
  signal: AbortSignal
): Promise<void> {
  const msg = raw as RequestMsg;
  if (msg.type !== 'request') return;

  if (msg.requestBodyTooLarge) {
    send(port, {
      type: 'response-head',
      status: 413,
      statusText: 'Payload Too Large',
      headers: {},
    });
    send(port, { type: 'response-end' });
    return;
  }

  let pipeline: SecretsPipeline;
  try {
    pipeline = await pipelinePromise;
  } catch (err) {
    send(port, {
      type: 'response-error',
      error: `fetch-proxy init failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  await processProxyRequest(port, pipeline, msg, signal);
}

export function handleFetchProxyConnectionAsync(
  port: PortLike,
  pipelinePromise: Promise<SecretsPipeline>
): void {
  const ac = new AbortController();
  let started = false;

  port.onDisconnect.addListener(() => ac.abort());

  port.onMessage.addListener((raw) => {
    if (started) return;
    started = true;
    handleProxyMessage(port, pipelinePromise, raw, ac.signal).catch((err) => {
      send(port, {
        type: 'response-error',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

export function handleFetchProxyConnection(port: PortLike, pipeline: SecretsPipeline): void {
  handleFetchProxyConnectionAsync(port, Promise.resolve(pipeline));
}
