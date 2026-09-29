export type RawHeaderList = Array<[string, string]>;

export interface RawFetchRequestHead {
  url: string;
  method: string;
  headers: RawHeaderList;
}

export interface RawFetchResponseHead {
  status: number;
  statusText: string;
  headers: RawHeaderList;

  url: string;
}

export const RAW_FETCH_REQUEST_HEADER = 'X-Slicc-Raw-Request';

export const RAW_FETCH_PROBE_HEADER = 'X-Slicc-Raw-Probe';

export const RAW_FETCH_PROTOCOL_VERSION = 1;

export interface RawFetchProbeReply {
  rawFetch: number;
  requestBodyStreaming: boolean;
  maxRequestBodyBytes: number;
}

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

export const RAW_FETCH_CONTENT_TYPE = 'application/vnd.slicc.raw-fetch';

export const RAW_FETCH_BRIDGE_REQUEST_BODY_CAP = 256 * 1024 * 1024;

export const RAW_FETCH_MAX_HEAD_BYTES = 1024 * 1024;

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

const RAW_RESPONSE_SKIP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const NODE_DECODED_CODINGS: ReadonlySet<string> = new Set([
  'gzip',
  'x-gzip',
  'deflate',
  'br',
]);

export const BROWSER_DECODED_CODINGS: ReadonlySet<string> = new Set([
  ...NODE_DECODED_CODINGS,
  'zstd',
]);

export const RAW_FETCH_ACCEPT_ENCODING = 'gzip, deflate, br';

export function rawAcceptEncoding(headers: Record<string, string>): string | undefined {
  return headers.range !== undefined || headers['if-range'] !== undefined
    ? undefined
    : RAW_FETCH_ACCEPT_ENCODING;
}

export function isDecodedPartialResponse(input: {
  status: number;
  headers: RawHeaderList;

  decodedCodings?: ReadonlySet<string>;
}): boolean {
  if (input.status !== 206) return false;
  const encoding = input.headers
    .filter(([name]) => name.toLowerCase() === 'content-encoding')
    .map(([, value]) => value)
    .join(',');
  return codingsWereDecoded(encoding, input.decodedCodings ?? NODE_DECODED_CODINGS);
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function isHeaderPair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  );
}

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

export function stripRawRequestHeaders(headers: RawHeaderList): RawHeaderList {
  const named = connectionTokens(headers);
  return headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return !RAW_REQUEST_SKIP_HEADERS.has(lower) && !named.has(lower);
  });
}

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

  bodyRewritten: boolean;

  decodedCodings?: ReadonlySet<string>;
}

export function rawResponseHasBody(method: string, status: number): boolean {
  return method.toUpperCase() !== 'HEAD' && !NULL_BODY_STATUSES.has(status);
}

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

export function encodeRawRequestHead(head: RawFetchRequestHead): string {
  return JSON.stringify(head).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

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

export type RawFetchErrorCode =
  | 'unsupported'
  | 'request-body-too-large'
  | 'forbidden-secret'
  | 'upstream'
  | 'bridge';

export const RAW_FETCH_TAG_PREFIX = 'slicc-raw-';

export const RAW_FETCH_PORT_CHUNK_BYTES = 256 * 1024;

export const RAW_FETCH_PORT_WINDOW = 4;

export const RAW_FETCH_BUFFERED_REQUEST_BODY_CAP = 256 * 1024 * 1024;

export const RAW_FETCH_STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024;

export type RawPortRequestMsg =
  | { type: 'raw-probe' }
  | {
      type: 'raw-request';
      head: RawFetchRequestHead;

      hasBody: boolean;

      bodyLength?: number;

      credits: number;
    }
  | { type: 'raw-body-chunk'; dataBase64: string }
  | { type: 'raw-body-end' }
  | { type: 'raw-credit'; chunks: number };

export type RawPortResponseMsg =
  | { type: 'raw-probe-reply'; reply: RawFetchProbeReply }
  | { type: 'raw-body-credit'; chunks: number }
  | { type: 'raw-response-head'; head: RawFetchResponseHead; hasBody: boolean }
  | { type: 'raw-response-chunk'; dataBase64: string }
  | { type: 'raw-response-end' }
  | { type: 'raw-response-error'; code: RawFetchErrorCode; status: number; error: string };

export function reasonFromStatusLine(statusLine: string | undefined): string {
  const match = /^HTTP\/\S+\s+\d{3}\s*(.*)$/.exec(statusLine ?? '');
  return match?.[1]?.trim() ?? '';
}
