/**
 * Raw-mode fetch-proxy contract (#3571). The default proxied fetch behaves like
 * a browser (follows redirects, folds Set-Cookie into an out-of-band header,
 * buffers bodies). Raw mode behaves like an HTTP client, so the wasm realm's
 * HTTP proxy can hand each response to curl or git as the origin sent it:
 *
 *   - redirects are NOT followed; the 3xx, `Location` and `Set-Cookie` reach
 *     the caller;
 *   - headers travel as an ordered name/value list, so every `Set-Cookie`
 *     stays a separate entry;
 *   - the body is always delivered DECODED: `Content-Encoding` is removed
 *     whenever a coding was undone, and `Content-Length` survives only when
 *     it still counts the delivered bytes (see {@link rawResponseHeaders});
 *   - the body streams, and nothing is read from the float's hop until the
 *     caller asks. Chrome's own `fetch` still reads a response off the
 *     network ahead of the reader (measured on Chrome 146: 400 MiB drained
 *     while a page held one chunk), so the upstream itself is not throttled.
 *
 * Every float speaks this contract; each one frames it for its own hop. The
 * CLI/cloud node-server route reads the request head from
 * {@link RAW_FETCH_REQUEST_HEADER} and answers `200` with
 * {@link RAW_FETCH_CONTENT_TYPE}, whose body is one response-head frame
 * ({@link encodeRawResponseFrame}) followed by the upstream body bytes.
 */

/** Ordered header list. Names keep their case; repeats stay separate. */
export type RawHeaderList = Array<[string, string]>;

/** What the caller wants sent upstream. */
export interface RawFetchRequestHead {
  url: string;
  method: string;
  headers: RawHeaderList;
}

/** What the upstream answered, before the body. */
export interface RawFetchResponseHead {
  status: number;
  statusText: string;
  headers: RawHeaderList;
  /** The URL that answered; with manual redirects always the request URL. */
  url: string;
}

/**
 * Request header carrying the JSON {@link RawFetchRequestHead} on the
 * node-server hop. The hop itself is always `POST` so neither the method nor
 * the caller's headers are subject to the browser's forbidden-name filter.
 * Its presence (instead of `X-Target-URL`) is what selects raw mode, so a
 * bridge that predates raw mode answers 400 rather than sending the request
 * the default way.
 */
export const RAW_FETCH_REQUEST_HEADER = 'X-Slicc-Raw-Request';

/**
 * Capability probe on the node-server hop: a `POST /api/fetch-proxy` carrying
 * only this header (no `X-Target-URL`, no request head). A bridge with raw
 * mode answers `200` JSON {@link RawFetchProbeReply}; one without it answers
 * 400 (node-server before raw mode, swift-server) or 404 (no bridge at all),
 * and nothing is fetched upstream either way.
 */
export const RAW_FETCH_PROBE_HEADER = 'X-Slicc-Raw-Probe';

/** Raw-mode protocol revision a bridge reports in its probe reply. */
export const RAW_FETCH_PROTOCOL_VERSION = 1;

/** What a raw-capable bridge reports about itself. */
export interface RawFetchProbeReply {
  rawFetch: number;
  requestBodyStreaming: boolean;
  maxRequestBodyBytes: number;
}

/** Validate a probe reply; `null` when it is not one. */
export function parseRawFetchProbeReply(value: unknown): RawFetchProbeReply | null {
  if (!value || typeof value !== 'object') return null;
  const reply = value as Partial<RawFetchProbeReply>;
  if (typeof reply.rawFetch !== 'number' || reply.rawFetch < 1) return null;
  if (typeof reply.requestBodyStreaming !== 'boolean') return null;
  if (typeof reply.maxRequestBodyBytes !== 'number') return null;
  return {
    rawFetch: reply.rawFetch,
    requestBodyStreaming: reply.requestBodyStreaming,
    maxRequestBodyBytes: reply.maxRequestBodyBytes,
  };
}

/** Content type of a raw-mode answer on the node-server hop. */
export const RAW_FETCH_CONTENT_TYPE = 'application/vnd.slicc.raw-fetch';

/**
 * Request-body ceiling on the node-server hop (CLI and cloud). This hop
 * buffers the upload on both ends for now; past this size the bridge answers
 * 413 and the webapp refuses before sending.
 */
export const RAW_FETCH_BRIDGE_REQUEST_BODY_CAP = 256 * 1024 * 1024;

/** Upper bound on one encoded response-head frame. */
export const RAW_FETCH_MAX_HEAD_BYTES = 1024 * 1024;

/**
 * Hop-by-hop request headers (RFC 9110 §7.6.1) plus the ones the forwarding
 * fetch owns: `host` and `content-length` are derived from the URL and body,
 * `accept-encoding` is chosen by the float so it can decode what it asked for,
 * and `expect` is answered by the realm proxy, not the origin.
 */
const RAW_REQUEST_SKIP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
  'expect',
]);

/** Hop-by-hop response headers; never part of the delivered head. */
const RAW_RESPONSE_SKIP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Content codings Node's fetch (undici) decodes on its own: the bridge floats. */
export const NODE_DECODED_CODINGS: ReadonlySet<string> = new Set([
  'gzip',
  'x-gzip',
  'deflate',
  'br',
]);

/**
 * Content codings Chrome's fetch decodes on its own: the extension float.
 * Chrome advertises `zstd` itself and cannot be told otherwise.
 */
export const BROWSER_DECODED_CODINGS: ReadonlySet<string> = new Set([
  ...NODE_DECODED_CODINGS,
  'zstd',
]);

/** `Accept-Encoding` a float sends upstream: exactly the codings it decodes. */
export const RAW_FETCH_ACCEPT_ENCODING = 'gzip, deflate, br';

/**
 * The `Accept-Encoding` a float sets for a request with these (folded,
 * lowercase) headers, or `undefined` to set none. A ranged request (`Range`,
 * `If-Range`) must not offer a compressed coding: a 206 over a compressed
 * representation carries `Content-Range` offsets into the compressed bytes,
 * which no longer describe the body once the float decodes it, so a resumed
 * or ranged download would assemble corrupt data. With no `Accept-Encoding`
 * set, `fetch` itself sends `identity` for a request carrying `Range` (Fetch
 * standard, HTTP-network-or-cache fetch), in Node and in Chrome alike.
 */
export function rawAcceptEncoding(headers: Record<string, string>): string | undefined {
  return headers.range !== undefined || headers['if-range'] !== undefined
    ? undefined
    : RAW_FETCH_ACCEPT_ENCODING;
}

/**
 * Whether a partial response came back with a coding the float undid
 * (an origin that ignored `Accept-Encoding: identity`). Its `Content-Range`
 * counts encoded bytes the caller never sees, so the float must refuse it
 * rather than deliver it.
 */
export function isDecodedPartialResponse(input: {
  status: number;
  headers: RawHeaderList;
  /** Codings the float's fetch undid; defaults to {@link NODE_DECODED_CODINGS}. */
  decodedCodings?: ReadonlySet<string>;
}): boolean {
  if (input.status !== 206) return false;
  const encoding = input.headers
    .filter(([name]) => name.toLowerCase() === 'content-encoding')
    .map(([, value]) => value)
    .join(',');
  return codingsWereDecoded(encoding, input.decodedCodings ?? NODE_DECODED_CODINGS);
}

/** Statuses whose responses never carry a body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function isHeaderPair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  );
}

/** Tokens a `Connection` header names, lowercased. */
function connectionTokens(headers: RawHeaderList): Set<string> {
  const tokens = new Set<string>();
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== 'connection') continue;
    for (const token of value.split(',')) {
      const trimmed = token.trim().toLowerCase();
      if (trimmed) tokens.add(trimmed);
    }
  }
  return tokens;
}

/** Drop hop-by-hop and float-owned request headers, keeping order. */
export function stripRawRequestHeaders(headers: RawHeaderList): RawHeaderList {
  const named = connectionTokens(headers);
  return headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return !RAW_REQUEST_SKIP_HEADERS.has(lower) && !named.has(lower);
  });
}

/**
 * Fold a raw list into the name → value record `fetch` sends. Repeats join
 * with `, ` (RFC 9110 §5.3), except `Cookie`, which joins with `; `. No float
 * can put two lines with one name on the wire: `fetch` folds them the same way.
 */
export function foldRawRequestHeaders(headers: RawHeaderList): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    const prior = out[lower];
    if (prior === undefined) out[lower] = value;
    else out[lower] = `${prior}${lower === 'cookie' ? '; ' : ', '}${value}`;
  }
  return out;
}

/** True when every listed coding is one the float's fetch undid. */
function codingsWereDecoded(contentEncoding: string, decodedCodings: ReadonlySet<string>): boolean {
  const codings = contentEncoding
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== '' && c !== 'identity');
  return codings.length > 0 && codings.every((c) => decodedCodings.has(c));
}

export interface RawResponseHeaderInput {
  method: string;
  status: number;
  headers: RawHeaderList;
  /**
   * The float may rewrite the body (secret scrub, gunzip sniff), so the
   * upstream `Content-Length` would no longer count the delivered bytes.
   */
  bodyRewritten: boolean;
  /** Codings the float's fetch undid; defaults to {@link NODE_DECODED_CODINGS}. */
  decodedCodings?: ReadonlySet<string>;
}

/** Whether a response to `method` with `status` carries a body at all. */
export function rawResponseHasBody(method: string, status: number): boolean {
  return method.toUpperCase() !== 'HEAD' && !NULL_BODY_STATUSES.has(status);
}

/**
 * The head a raw caller sees. Hop-by-hop headers go, and so do the fields
 * the response's `Connection` header names (RFC 9110 §7.6.1). A bodiless response
 * (HEAD, 1xx/204/205/304) keeps `Content-Encoding` and `Content-Length` as
 * sent, since they describe the representation, not bytes on this hop.
 * Otherwise a decoded coding drops both headers, and `Content-Length` also
 * goes when the float rewrote the body. An unknown coding stays with its
 * encoded bytes.
 */
export function rawResponseHeaders(input: RawResponseHeaderInput): RawHeaderList {
  const named = connectionTokens(input.headers);
  const withoutHop = input.headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return !RAW_RESPONSE_SKIP_HEADERS.has(lower) && !named.has(lower);
  });
  if (!rawResponseHasBody(input.method, input.status)) return withoutHop;
  const encoding = withoutHop
    .filter(([name]) => name.toLowerCase() === 'content-encoding')
    .map(([, value]) => value)
    .join(',');
  const decoded = codingsWereDecoded(encoding, input.decodedCodings ?? NODE_DECODED_CODINGS);
  const dropLength = decoded || input.bodyRewritten;
  return withoutHop.filter(([name]) => {
    const lower = name.toLowerCase();
    if (lower === 'content-length') return !dropLength;
    if (lower === 'content-encoding')
      return !decoded && encoding.trim().toLowerCase() !== 'identity';
    return true;
  });
}

/**
 * JSON for {@link RAW_FETCH_REQUEST_HEADER}. Non-ASCII is `\u`-escaped so the
 * value is a valid header ByteString whatever the caller's headers hold.
 */
export function encodeRawRequestHead(head: RawFetchRequestHead): string {
  return JSON.stringify(head).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/** Parse a {@link RAW_FETCH_REQUEST_HEADER} value; `null` when malformed. */
export function decodeRawRequestHead(value: string): RawFetchRequestHead | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { url, method, headers } = parsed as Partial<RawFetchRequestHead>;
  if (
    typeof url !== 'string' ||
    typeof method !== 'string' ||
    !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(method)
  ) {
    return null;
  }
  if (!Array.isArray(headers) || !headers.every(isHeaderPair)) return null;
  return { url, method, headers };
}

/** One response-head frame: a big-endian u32 length, then UTF-8 JSON. */
export function encodeRawResponseFrame(head: RawFetchResponseHead): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(head));
  const frame = new Uint8Array(4 + json.byteLength);
  new DataView(frame.buffer).setUint32(0, json.byteLength);
  frame.set(json, 4);
  return frame;
}

function isRawResponseHead(value: unknown): value is RawFetchResponseHead {
  if (!value || typeof value !== 'object') return false;
  const head = value as Partial<RawFetchResponseHead>;
  return (
    typeof head.status === 'number' &&
    typeof head.statusText === 'string' &&
    typeof head.url === 'string' &&
    Array.isArray(head.headers) &&
    head.headers.every(isHeaderPair)
  );
}

/**
 * Split a response-head frame off the front of `buffer`. Returns `null` while
 * the frame is still incomplete, and throws when it is malformed or larger
 * than {@link RAW_FETCH_MAX_HEAD_BYTES}.
 */
export function decodeRawResponseFrame(
  buffer: Uint8Array
): { head: RawFetchResponseHead; rest: Uint8Array } | null {
  if (buffer.byteLength < 4) return null;
  const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
  if (length > RAW_FETCH_MAX_HEAD_BYTES) {
    throw new Error(`raw fetch: response head of ${length} bytes exceeds the limit`);
  }
  if (buffer.byteLength < 4 + length) return null;
  let head: unknown;
  try {
    head = JSON.parse(new TextDecoder().decode(buffer.subarray(4, 4 + length)));
  } catch {
    throw new Error('raw fetch: malformed response head');
  }
  if (!isRawResponseHead(head)) throw new Error('raw fetch: malformed response head');
  return { head, rest: buffer.subarray(4 + length) };
}

/**
 * Why a raw fetch failed without an upstream HTTP response. The accompanying
 * status is the one a proxy should answer its own client with.
 */
export type RawFetchErrorCode =
  /** The float has no raw mode (a bridge that predates it, or swift-server). */
  | 'unsupported'
  /** The request body is past the float's ceiling. */
  | 'request-body-too-large'
  /** A masked secret was used against a domain it is not scoped to. */
  | 'forbidden-secret'
  /** The upstream could not be reached, or the stream broke. */
  | 'upstream'
  /** The float's own transport answered with something raw mode cannot read. */
  | 'bridge';

// ── Extension Port leg ─────────────────────────────────────────────────
//
// On the extension float the page talks to the service worker over the
// pinned `fetch-proxy.fetch` Port; raw mode rides it with the messages
// below. Port messages are JSON, so bytes travel as base64, and the Port
// has no backpressure of its own, so each direction is credit-based: a
// sender may have at most as many chunks outstanding as the receiver granted.

/** URL-fragment prefix that tags one raw request for `webRequest` correlation. */
export const RAW_FETCH_TAG_PREFIX = 'slicc-raw-';

/** Largest body chunk one Port message carries. */
export const RAW_FETCH_PORT_CHUNK_BYTES = 256 * 1024;

/** Chunks a receiver grants up front, in each direction. */
export const RAW_FETCH_PORT_WINDOW = 4;

/**
 * Uploads a float buffers before sending. Past it the answer is 413. The
 * extension streams large non-text bodies instead (see
 * `RAW_FETCH_STREAM_THRESHOLD_BYTES`), so there the ceiling bounds only the
 * bodies it must hold whole: text bodies (secret unmask) and HMAC-signed ones.
 */
export const RAW_FETCH_BUFFERED_REQUEST_BODY_CAP = 256 * 1024 * 1024;

/** Non-text uploads at least this large (or of unknown length) are streamed. */
export const RAW_FETCH_STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** Page → service worker. */
export type RawPortRequestMsg =
  /**
   * Capability probe, answered with `raw-probe-reply`. A service worker
   * that predates raw mode ignores it, so the page treats silence as
   * unsupported rather than sending a `raw-request` nobody will answer.
   */
  | { type: 'raw-probe' }
  | {
      type: 'raw-request';
      head: RawFetchRequestHead;
      /** Whether `raw-body-chunk`s follow, ended by `raw-body-end`. */
      hasBody: boolean;
      /** Upload size when the caller knows it. */
      bodyLength?: number;
      /** Response chunks the page grants up front. */
      credits: number;
    }
  | { type: 'raw-body-chunk'; dataBase64: string }
  | { type: 'raw-body-end' }
  | { type: 'raw-credit'; chunks: number };

/** Service worker → page. */
export type RawPortResponseMsg =
  | { type: 'raw-probe-reply'; reply: RawFetchProbeReply }
  | { type: 'raw-body-credit'; chunks: number }
  | { type: 'raw-response-head'; head: RawFetchResponseHead; hasBody: boolean }
  | { type: 'raw-response-chunk'; dataBase64: string }
  | { type: 'raw-response-end' }
  | { type: 'raw-response-error'; code: RawFetchErrorCode; status: number; error: string };

/** `HTTP/1.1 302 Found` → `Found`; HTTP/2 status lines carry no reason. */
export function reasonFromStatusLine(statusLine: string | undefined): string {
  const match = /^HTTP\/\S+\s+\d{3}\s*(.*)$/.exec(statusLine ?? '');
  return match?.[1]?.trim() ?? '';
}
