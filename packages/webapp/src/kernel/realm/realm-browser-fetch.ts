/**
 * `realm-browser-fetch.ts` — `browser.fetch` request/response serialization:
 * builds the self-contained page-context script injected via `evalAsync`,
 * handling binary bodies and FormData over the bridge. Extracted from
 * `js-realm-shared.ts`; no behavior change.
 */

/**
 * Options accepted by `browser.fetch(tab, url, opts)`. Mirrors the
 * `RequestInit` subset the page-context bridge can carry. `body` may be:
 * - a string — sent verbatim, no Content-Type forced;
 * - a `URLSearchParams` — serialized to a form-urlencoded string with a
 *   default `application/x-www-form-urlencoded` Content-Type (caller wins);
 * - an `ArrayBuffer` / typed array / `Blob` — base64-encoded across the
 *   bridge and reconstructed as real binary in the page before `fetch`
 *   (caller Content-Type preserved; a `Blob`'s own type carries over);
 * - a `FormData` — string fields and `File`/`Blob` parts are carried
 *   (files base64-encoded) and rebuilt as a real `FormData` in the page
 *   so `fetch` sets the multipart boundary itself;
 * - any other JSON-encodable value — stringified with a default
 *   `application/json` Content-Type (caller wins).
 * `AbortSignal` / `ReadableStream` bodies are still out of scope.
 */
/**
 * An arbitrary JSON-encodable object body. The shape is genuinely the
 * caller's — it is `JSON.stringify`d verbatim with a default
 * `application/json` Content-Type — so this names the contract rather
 * than pretending to know the keys.
 */
export type JsonEncodableObject = { [key: string]: unknown };

export interface BrowserFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?:
    | string
    | URLSearchParams
    | ArrayBuffer
    | ArrayBufferView
    | Blob
    | FormData
    | JsonEncodableObject
    | unknown[]
    | number
    | boolean
    | null;
  credentials?: 'include' | 'same-origin' | 'omit';
  mode?: string;
  cache?: string;
  redirect?: string;
  referrer?: string;
  referrerPolicy?: string;
  integrity?: string;
  keepalive?: boolean;
  /**
   * How the response body should be decoded:
   * - `'text'` — always return the raw text body (no JSON parse);
   * - `'json'` — always `JSON.parse` the text body (null on empty);
   * - `'binary'` — return the body base64-encoded with
   *   `bodyEncoding: 'base64'` on the result;
   * - omitted (default) — auto-detect: JSON Content-Type → parsed JSON,
   *   a conservative binary Content-Type allowlist → base64, else text.
   */
  responseType?: 'text' | 'json' | 'binary';
  /**
   * Abort the request after this many milliseconds, via a page-side
   * `AbortSignal.timeout()`. The rejection surfaces as a `TimeoutError`
   * from the injected script, which callers (e.g. `curlwright --max-time`)
   * map onto their own timeout exit code. Omitted / non-positive → no
   * timeout, matching plain `fetch`.
   */
  timeoutMs?: number;
}

/**
 * Structured result returned by `browser.fetch`. `body` is parsed
 * JSON when the response Content-Type contains `application/json`,
 * otherwise raw text. Binary responses (via `responseType: 'binary'`
 * or a binary Content-Type) return the body base64-encoded with
 * `bodyEncoding: 'base64'` set; the caller decodes with `atob`.
 */
export interface BrowserFetchResult {
  ok: boolean;
  status: number;
  /** HTTP reason phrase (`Response.statusText`); often `''` over HTTP/2+. */
  statusText: string;
  /** Final URL after any redirects (`Response.url`) — curl's `url_effective`. */
  url: string;
  /** Whether the page-side `fetch` followed at least one redirect. */
  redirected: boolean;
  headers: Record<string, string>;
  body: unknown;
  /** Set to `'base64'` when `body` is a base64-encoded binary payload. */
  bodyEncoding?: 'base64';
}

/**
 * Wire descriptor for a request body that cannot ride the bridge as
 * plain JSON. Binary payloads are base64-encoded here and rebuilt as
 * real `Uint8Array` / `Blob` / `FormData` in the page (see
 * `buildBrowserFetchScript`). Kept minimal + JSON-safe on purpose.
 */
type BrowserFetchBodyDescriptor =
  | { kind: 'bytes'; data: string }
  | { kind: 'blob'; data: string; type: string }
  | { kind: 'formdata'; entries: BrowserFetchFormEntry[] };

type BrowserFetchFormEntry =
  | { name: string; value: string }
  | { name: string; file: { data: string; filename: string; type: string } };

/**
 * Base64-encode bytes without blowing the argument stack on large
 * payloads (`String.fromCharCode(...bytes)` throws past ~100K). Runs
 * in the builder (realm/worker/page) context, where `btoa` exists.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

/** Serialize a `FormData` into JSON-safe entries (files base64-encoded). */
async function serializeBrowserFetchFormData(form: FormData): Promise<BrowserFetchBodyDescriptor> {
  const entries: BrowserFetchFormEntry[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      entries.push({ name, value });
      continue;
    }
    const bytes = new Uint8Array(await value.arrayBuffer());
    entries.push({
      name,
      file: {
        data: bytesToBase64(bytes),
        filename: typeof (value as File).name === 'string' ? (value as File).name : 'blob',
        type: value.type || '',
      },
    });
  }
  return { kind: 'formdata', entries };
}

/**
 * Turn a request body into either an inline `body` string or a base64
 * `descriptor` the page reconstructs. Default Content-Type headers are
 * set in place; a caller-provided Content-Type always wins.
 */
async function serializeBrowserFetchBody(
  raw: NonNullable<BrowserFetchOptions['body']>,
  headers: Record<string, string>
): Promise<{ body?: string; descriptor?: BrowserFetchBodyDescriptor }> {
  const hasContentType = (): boolean =>
    Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (typeof raw === 'string') return { body: raw };
  if (raw instanceof URLSearchParams) {
    if (!hasContentType()) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    return { body: raw.toString() };
  }
  if (raw instanceof Blob) {
    const bytes = new Uint8Array(await raw.arrayBuffer());
    return { descriptor: { kind: 'blob', data: bytesToBase64(bytes), type: raw.type || '' } };
  }
  if (raw instanceof ArrayBuffer) {
    return { descriptor: { kind: 'bytes', data: bytesToBase64(new Uint8Array(raw)) } };
  }
  if (ArrayBuffer.isView(raw)) {
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    return { descriptor: { kind: 'bytes', data: bytesToBase64(bytes) } };
  }
  if (raw instanceof FormData) {
    return { descriptor: await serializeBrowserFetchFormData(raw) };
  }
  if (!hasContentType()) headers['Content-Type'] = 'application/json';
  return { body: JSON.stringify(raw) };
}

/**
 * Page-side reconstruction snippet for a binary/FormData body. Returns
 * the empty string when there's no descriptor so string/object/
 * URLSearchParams scripts stay byte-identical to the pre-binary shape
 * (no `atob`). Rebuilds bytes/Blob/FormData onto `__init.body`.
 */
function buildBodyReconstructionScript(descriptor: BrowserFetchBodyDescriptor | undefined): string {
  if (!descriptor) return '';
  return (
    'const __b64 = (s) => { const bin = atob(s); const n = bin.length; ' +
    'const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = bin.charCodeAt(i); return u; };' +
    'const __body = ' +
    JSON.stringify(descriptor) +
    ';' +
    "if (__body.kind === 'bytes') { __init.body = __b64(__body.data); }" +
    "else if (__body.kind === 'blob') { __init.body = new Blob([__b64(__body.data)], { type: __body.type }); }" +
    "else if (__body.kind === 'formdata') { const __fd = new FormData(); " +
    'for (const e of __body.entries) { ' +
    'if (e.file) { __fd.append(e.name, new Blob([__b64(e.file.data)], { type: e.file.type }), e.file.filename); } ' +
    'else { __fd.append(e.name, e.value); } } __init.body = __fd; }'
  );
}

/**
 * Page-side response-assembly snippet. Follows the `fetch(...)` line and
 * consumes `r` (the Response). Handles three body shapes driven by
 * `responseType` and, when omitted, a conservative Content-Type
 * allowlist:
 * - binary (`responseType: 'binary'` OR an allowlisted binary
 *   Content-Type) → read `arrayBuffer`, base64-encode with `btoa`, and
 *   return `{ ..., body: <base64>, bodyEncoding: 'base64' }`. The
 *   allowlist NEVER matches `text/*`, `application/json`, `*+json`,
 *   `application/xml`, or `*+xml`, so text payloads are never corrupted;
 * - JSON (`responseType: 'json'` OR a JSON Content-Type when not forced
 *   to text) → `JSON.parse` the text (null on empty body);
 * - text (everything else, or `responseType: 'text'`) → raw text.
 *
 * The body is read exactly once (either `arrayBuffer` or `text`, never
 * both) so the single-consumption stream is respected. Kept stringly
 * typed so `JSON.stringify` stays the only escape boundary.
 */
function buildResponseHandlingScript(responseType: BrowserFetchOptions['responseType']): string {
  return (
    'const h = {};' +
    'r.headers.forEach((v, k) => { h[k] = v; });' +
    "const ct = r.headers.get('content-type') || '';" +
    'const __rt = ' +
    JSON.stringify(responseType ?? null) +
    ';' +
    'const __ctl = ct.toLowerCase();' +
    "const __binPrefixes = ['image/','audio/','video/','application/octet-stream'," +
    "'application/pdf','application/protobuf','application/x-protobuf','application/wasm','application/zip'];" +
    "const __isXml = __ctl.indexOf('+xml') !== -1 || __ctl.indexOf('application/xml') === 0 || __ctl.indexOf('text/xml') === 0;" +
    "const __isBinary = __rt === 'binary' || (__rt !== 'text' && __rt !== 'json' && !__isXml && " +
    '__binPrefixes.some((p) => __ctl.indexOf(p) === 0));' +
    'const __meta = { ok: r.ok, status: r.status, statusText: r.statusText, ' +
    'url: r.url, redirected: !!r.redirected, headers: h };' +
    'if (__isBinary) {' +
    'const __u = new Uint8Array(await r.arrayBuffer());' +
    "let __s = ''; const __cs = 0x8000;" +
    'for (let __i = 0; __i < __u.length; __i += __cs) { ' +
    '__s += String.fromCharCode.apply(null, __u.subarray(__i, __i + __cs)); }' +
    "return Object.assign(__meta, { body: btoa(__s), bodyEncoding: 'base64' });" +
    '}' +
    'const t = await r.text();' +
    'let b;' +
    "const __jsonWanted = __rt === 'json' || (__rt !== 'text' && ct.indexOf('application/json') !== -1);" +
    'if (__jsonWanted) { if (!t) { b = null; } else { try { b = JSON.parse(t); } catch (e) { b = t; } } }' +
    'else { b = t; }' +
    'return Object.assign(__meta, { body: b });'
  );
}

/**
 * The `RequestInit` subset baked into the injected script as JSON. Only
 * structured-clone-safe fields live here: a binary/FormData body is
 * rebuilt page-side and `signal` is minted page-side, because neither
 * survives `JSON.stringify`.
 */
interface InjectedRequestInit {
  method: string;
  credentials: string;
  headers: Record<string, string>;
  body?: string;
  mode?: string;
  cache?: string;
  redirect?: string;
  referrer?: string;
  referrerPolicy?: string;
  integrity?: string;
  keepalive?: boolean;
}

/**
 * Build the self-contained page-context script that `browser.fetch`
 * injects via `evalAsync`. All request shaping (method/credentials/
 * headers/body) is baked into the script via `JSON.stringify` so the
 * page side does nothing but call `fetch()` and assemble the
 * structured response. Credentials default to `'include'` so session
 * cookies travel automatically — that's the whole reason
 * `browser.fetch` exists rather than the realm-side `fetch`.
 *
 * Body handling: plain strings pass through verbatim; `URLSearchParams`
 * becomes a form-urlencoded string (default Content-Type, caller wins);
 * `ArrayBuffer` / typed arrays / `Blob` are base64-encoded and rebuilt
 * as real binary in the page (caller Content-Type preserved); `FormData`
 * is carried entry-by-entry (files base64-encoded) and rebuilt as a real
 * `FormData` so `fetch` sets the multipart boundary; any other value is
 * JSON-stringified with a default `application/json` Content-Type. The
 * function is async because reading `Blob`/`File` bytes is async.
 *
 * Response handling honors `opts.responseType` (`'text'`/`'json'`/
 * `'binary'`); when omitted it auto-detects JSON vs. a conservative
 * binary Content-Type allowlist (see {@link buildResponseHandlingScript}).
 * Binary bodies come back base64-encoded with `bodyEncoding: 'base64'`.
 *
 * Exported so tests can assert the injected script is a single
 * function (no temp file, no base64 chunking). The
 * only escape boundary is `JSON.stringify`; base64 uses `btoa`/`atob`,
 * never a VFS temp file or `fs.` write.
 */
export async function buildBrowserFetchScript(
  url: string,
  opts: BrowserFetchOptions = {}
): Promise<string> {
  const headers: Record<string, string> = {};
  const rawHeaders = opts.headers ?? {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (typeof v === 'string') headers[k] = v;
  }
  const method = typeof opts.method === 'string' ? opts.method : 'GET';
  const credentials =
    opts.credentials === 'same-origin' || opts.credentials === 'omit'
      ? opts.credentials
      : 'include';
  const raw = opts.body;
  const { body, descriptor } =
    raw === undefined || raw === null ? {} : await serializeBrowserFetchBody(raw, headers);
  const init: InjectedRequestInit = { method, credentials, headers };
  if (body !== undefined) init.body = body;
  if (opts.mode !== undefined) init.mode = opts.mode;
  if (opts.cache !== undefined) init.cache = opts.cache;
  if (opts.redirect !== undefined) init.redirect = opts.redirect;
  if (opts.referrer !== undefined) init.referrer = opts.referrer;
  if (opts.referrerPolicy !== undefined) init.referrerPolicy = opts.referrerPolicy;
  if (opts.integrity !== undefined) init.integrity = opts.integrity;
  if (opts.keepalive !== undefined) init.keepalive = opts.keepalive;
  const reconstruct = buildBodyReconstructionScript(descriptor);
  const responseHandling = buildResponseHandlingScript(opts.responseType);
  // `AbortSignal` cannot ride the JSON init, so the timeout is minted
  // page-side. The value is rounded to an integer before interpolation,
  // which is what keeps this the one non-JSON.stringify substitution.
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? Math.round(opts.timeoutMs)
      : 0;
  const timeoutScript = timeoutMs > 0 ? `__init.signal = AbortSignal.timeout(${timeoutMs});` : '';
  // Single self-contained async IIFE — runs entirely in the page,
  // returns a structured-cloneable object that CDP returnByValue
  // round-trips back to the realm host as-is. Keep this stringly
  // typed (no template-literal substitutions inside the function
  // body) so JSON.stringify is the only escape boundary.
  return (
    '(async () => {' +
    'const __init = ' +
    JSON.stringify(init) +
    ';' +
    timeoutScript +
    reconstruct +
    'const r = await fetch(' +
    JSON.stringify(url) +
    ', __init);' +
    responseHandling +
    '})()'
  );
}
