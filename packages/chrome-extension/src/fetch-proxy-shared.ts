import { base64ToUint8, type SecretsPipeline, uint8ToBase64 } from '@slicc/shared-ts';
import { decodeForbiddenRequestHeaders } from '../../webapp/src/shell/proxy-headers.js';

export const REQUEST_BODY_CAP = 32 * 1024 * 1024;

/**
 * Extract `Set-Cookie` values from upstream response headers as a list.
 * `Headers.forEach` joins multi-value `set-cookie` entries with a comma
 * (per WHATWG fetch — undefined behavior for set-cookie), so use the dedicated
 * `getSetCookie()` accessor when available. Falls back to a single
 * comma-joined string for older runtimes that don't implement it.
 */
function extractSetCookies(headers: Headers): string[] {
  const get = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof get === 'function') {
    return get.call(headers);
  }
  const joined = headers.get('set-cookie');
  return joined ? [joined] : [];
}

/**
 * Build the response-head headers map the way the CLI proxy does:
 *   - drop `set-cookie` and any `x-proxy-*` from the scrubbed map
 *   - if there were any `set-cookie` values, repack them as a JSON array
 *     under `X-Proxy-Set-Cookie` so the page side can recover them via
 *     `decodeForbiddenResponseHeaders`.
 */
function buildResponseHeaders(
  scrubbed: Record<string, string>,
  upstream: Headers,
  pipeline: SecretsPipeline
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scrubbed)) {
    const lower = k.toLowerCase();
    if (lower === 'set-cookie' || lower.startsWith('x-proxy-')) continue;
    out[k] = v;
  }
  const setCookies = extractSetCookies(upstream);
  if (setCookies.length > 0) {
    out['X-Proxy-Set-Cookie'] = pipeline.scrubResponse(JSON.stringify(setCookies));
  }
  return out;
}

export interface PortLike {
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
}

export interface RequestMsg {
  type: 'request';
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64?: string;
  requestBodyTooLarge?: boolean;
}

/**
 * Port-streamed response protocol. The SW emits exactly one `response-head`
 * followed by 0..N `response-chunk`s + a terminating `response-end`, OR a
 * single `response-error` (terminal). Discriminated union so both the SW
 * emitters AND the page consumer narrow on `type` exhaustively — typos like
 * `response-haed` no longer compile, and adding a new variant forces an
 * update at both ends.
 */
export type ResponseMsg =
  | {
      type: 'response-head';
      status: number;
      statusText: string;
      headers: Record<string, string>;
    }
  | { type: 'response-chunk'; dataBase64: string }
  | { type: 'response-end' }
  | { type: 'response-error'; error: string };

function send(port: PortLike, msg: ResponseMsg): void {
  port.postMessage(msg);
}

const decodeBase64Bytes = base64ToUint8;
const encodeBase64Bytes = uint8ToBase64;

/**
 * Headers that Chrome silently strips or overrides on any `fetch()` call —
 * including from an extension service worker. The decode-from-`X-Proxy-*`
 * step writes them under their real names, but Chrome then erases them on
 * the wire (Cookie/Referer/Proxy-* dropped; Origin rewritten to the
 * extension's chrome-extension:// origin). The DNR shim below restores them.
 */
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

// Monotonic counter for DNR session-rule IDs. Session rules live for the
// SW's lifetime; we always remove the rule before the response resolves,
// but a unique id per request prevents collisions if cleanup is delayed
// for any reason (concurrent in-flight requests, retried install).
let nextDnrRuleId = 1_000_000;

function randomFragmentToken(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Forbidden request headers (Cookie/Origin/Referer/Proxy-*) are stripped or
 * overridden by Chrome on any extension-SW `fetch()` — even when the
 * `headers` init dict lists them under their real names. Restore them on
 * the wire by installing a one-shot `chrome.declarativeNetRequest` session
 * rule keyed to a unique URL fragment, then removing the rule after the
 * fetch settles.
 *
 * URL fragments are never sent to the upstream server but DNR `urlFilter`
 * DOES see them (empirically verified against Chrome for Testing 146), so
 * the keying is leak-free for concurrent requests.
 *
 * Falls back to a no-op when `chrome.declarativeNetRequest` is unavailable
 * (vitest / non-extension runtimes / older Chrome). In that case the
 * forbidden headers are still passed to `fetch()` under their real names,
 * matching the pre-DNR behavior — useful for unit tests that mock `fetch`.
 */
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
  // Strip any caller-supplied fragment so the DNR urlFilter matches exactly
  // one in-flight request. The upstream never sees either fragment.
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
    } catch {
      // Best-effort — a leaked session rule expires when the SW unloads.
    }
  };
  return { fetchUrl, cleanup };
}

/** A prepared upstream request, or a terminal `forbidden:` error string. */
type PreparedRequest =
  | { cleanedUrl: string; headers: Record<string, string>; body: Uint8Array | undefined }
  | { error: string };

/**
 * Unmask the request the way the CLI proxy does: extract URL credentials,
 * decode the `X-Proxy-*` forbidden-header transport BEFORE unmask so the
 * pipeline sees real header names, synthesize Authorization / default Origin,
 * and unmask the body bytes. Returns `{ error }` for a forbidden secret so the
 * caller can emit a single `response-error`.
 */
function prepareUpstreamRequest(pipeline: SecretsPipeline, msg: RequestMsg): PreparedRequest {
  const credsResult = pipeline.extractAndUnmaskUrlCredentials(msg.url);
  if (credsResult.forbidden) {
    return {
      error: `forbidden: ${credsResult.forbidden.secretName} on ${credsResult.forbidden.hostname}`,
    };
  }
  const cleanedUrl = credsResult.url;
  const host = new URL(cleanedUrl).host;

  const headers: Record<string, string> = decodeForbiddenRequestHeaders(msg.headers);
  const headersResult = pipeline.unmaskHeaders(headers, host);
  if (headersResult.forbidden) {
    return {
      error: `forbidden: ${headersResult.forbidden.secretName} on ${headersResult.forbidden.hostname}`,
    };
  }
  if (credsResult.syntheticAuthorization && !('authorization' in headers)) {
    headers.authorization = credsResult.syntheticAuthorization;
  }

  // Default-Origin fallback: when no caller Origin survives the X-Proxy-Origin
  // decode step above, synthesize one from the target URL so upstream
  // CORS-protected APIs see a real Origin instead of nothing. Caller-supplied
  // Origin still wins because the decode step ran first. Matches CLI server.
  if (!headers.origin) {
    try {
      headers.origin = new URL(cleanedUrl).origin;
    } catch {
      // Malformed cleanedUrl — leave origin unset; upstream fetch will fail anyway.
    }
  }

  let body: Uint8Array | undefined;
  if (msg.bodyBase64) {
    body = pipeline.unmaskBodyBytes(decodeBase64Bytes(msg.bodyBase64), host).bytes;
  }

  return { cleanedUrl, headers, body };
}

/**
 * Emit the `response-head` + 0..N `response-chunk`s + `response-end` sequence
 * for a settled upstream response. Body bytes are scrubbed per-chunk
 * (byte-safe — no TextDecoder round-trip, so binary chunks like git packfiles,
 * ZIPs, and images survive intact). Chunk-boundary scrub limitation matches
 * CLI behavior: a real value straddling a chunk boundary leaks through.
 */
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

/**
 * Unmask, fetch upstream (with the DNR forbidden-header shim installed for the
 * duration of the fetch), and stream the scrubbed response back over the Port.
 */
async function processProxyRequest(
  port: PortLike,
  pipeline: SecretsPipeline,
  msg: RequestMsg,
  signal: AbortSignal
): Promise<void> {
  try {
    const prepared = prepareUpstreamRequest(pipeline, msg);
    if ('error' in prepared) {
      send(port, { type: 'response-error', error: prepared.error });
      return;
    }
    const { cleanedUrl, headers, body } = prepared;

    // Re-inject forbidden request headers via declarativeNetRequest because
    // Chrome strips/overrides them on extension-SW fetch() — see the helper.
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

/**
 * Variant that accepts a Promise for the pipeline so the caller can attach
 * the onMessage listener SYNCHRONOUSLY in the onConnect callback — Chrome
 * drops port messages that arrive before any listener exists, and the
 * page-side caller posts its request immediately after connect (before
 * the async pipeline build completes). The listener awaits the pipeline
 * before processing.
 */
export function handleFetchProxyConnectionAsync(
  port: PortLike,
  pipelinePromise: Promise<SecretsPipeline>
): void {
  const ac = new AbortController();
  let started = false;

  port.onDisconnect.addListener(() => ac.abort());

  port.onMessage.addListener(async (raw) => {
    if (started) return;
    started = true;
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

    await processProxyRequest(port, pipeline, msg, ac.signal);
  });
}

/**
 * Synchronous-pipeline entry point. Thin wrapper over
 * `handleFetchProxyConnectionAsync` so there is exactly one implementation of
 * the Port/DNR/fetch/scrub orchestration. `Promise.resolve(pipeline)` is
 * microtask-only, so the synchronous-listener-attach contract is preserved
 * verbatim and callers that already hold a built pipeline pay no extra cost.
 */
export function handleFetchProxyConnection(port: PortLike, pipeline: SecretsPipeline): void {
  handleFetchProxyConnectionAsync(port, Promise.resolve(pipeline));
}
