/**
 * `http-global.ts` — the `http` realm global. Standardizes the
 * `build URL → merge headers → resolve auth → fetch → unwrap JSON
 * → throw on !ok` boilerplate that 18 of the 23 surveyed skills
 * each reinvented (see the workspace spec at `analyze-skills`),
 * and builds in the 429/503 Retry-After backoff that only one
 * skill (`teams.jsh`) actually got right.
 *
 * Surface:
 *  - `http.client({ baseUrl, token, headers, retry })` →
 *    `{ get, post, put, delete }`
 *  - `token` is lazy: resolved freshly per request so token
 *    rotation / refresh hooks are picked up without recreating
 *    the client.
 *  - `retry.on` is the closed status set that triggers a retry;
 *    `retry.maxAttempts` is the total attempt count (including
 *    the first). Backoff is exponential, but `Retry-After` (when
 *    present and parseable) takes precedence — the server knows
 *    its own rate limit better than the client.
 */

/** Scalar serialized into a query string via `encodeURIComponent(String(v))`. */
export type HttpQueryScalar = string | number | boolean;

/** Query value accepted by `buildUrl` / `HttpRequestOpts.params`. */
export type HttpQueryParamValue = HttpQueryScalar | null | undefined | HttpQueryScalar[];

export type HttpQueryParams = Record<string, HttpQueryParamValue>;

export interface HttpRetryConfig {
  on: number[];
  maxAttempts: number;
}

export interface HttpTokenRequest {
  method: string;
  path: string;
  url: string;
}

export interface HttpClientConfig {
  baseUrl?: string;
  token?: (
    req?: HttpTokenRequest
  ) => string | undefined | null | Promise<string | undefined | null>;
  headers?: Record<string, string>;
  retry?: HttpRetryConfig;
  timeoutMs?: number;
}

export interface HttpRequestOpts {
  params?: HttpQueryParams;
  headers?: Record<string, string>;
  body?: unknown;
  raw?: boolean;
  signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  body: T;
  headers: Record<string, string>;
  status: number;
}

export interface HttpClient {
  get(path: string, opts: HttpRequestOpts & { raw: true }): Promise<HttpResponse>;
  get(path: string, opts?: HttpRequestOpts & { raw?: false }): Promise<unknown>;
  post(path: string, opts: HttpRequestOpts & { raw: true }): Promise<HttpResponse>;
  post(path: string, opts?: HttpRequestOpts & { raw?: false }): Promise<unknown>;
  put(path: string, opts: HttpRequestOpts & { raw: true }): Promise<HttpResponse>;
  put(path: string, opts?: HttpRequestOpts & { raw?: false }): Promise<unknown>;
  patch(path: string, opts: HttpRequestOpts & { raw: true }): Promise<HttpResponse>;
  patch(path: string, opts?: HttpRequestOpts & { raw?: false }): Promise<unknown>;
  delete(path: string, opts: HttpRequestOpts & { raw: true }): Promise<HttpResponse>;
  delete(path: string, opts?: HttpRequestOpts & { raw?: false }): Promise<unknown>;
}

export interface HttpGlobal {
  client(config: HttpClientConfig): HttpClient;
}

export interface HttpGlobalDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string,
    public readonly body: unknown
  ) {
    const detail =
      typeof body === 'string' && body
        ? `: ${body.slice(0, 200)}`
        : body && typeof body === 'object'
          ? `: ${safeJson(body).slice(0, 200)}`
          : '';
    super(`HTTP ${status} ${statusText} ${url}${detail}`);
    this.name = 'HttpError';
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const DEFAULT_BACKOFF_BASE_MS = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendQueryParams(url: string, params: HttpQueryParams): string {
  const qs: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === undefined || item === null) continue;
        qs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
      }
    } else {
      qs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  if (qs.length === 0) return url;
  return url + (url.includes('?') ? '&' : '?') + qs.join('&');
}

function buildUrl(baseUrl: string | undefined, path: string, params?: HttpQueryParams): string {
  let url: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    url = path;
  } else if (baseUrl) {
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const rel = path.startsWith('/') ? path : `/${path}`;
    url = `${base}${rel}`;
  } else {
    url = path;
  }
  if (!params) return url;
  return appendQueryParams(url, params);
}

function mergeHeaders(
  base: Record<string, string> | undefined,
  perCall: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (base) for (const [k, v] of Object.entries(base)) out[k] = v;
  if (perCall) for (const [k, v] of Object.entries(perCall)) out[k] = v;
  return out;
}

function isJsonContentType(ct: string | null): boolean {
  if (!ct) return false;
  const lower = ct.toLowerCase();
  return lower.startsWith('application/json') || /[+/]json(;|$|\s)/.test(lower);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

async function readBody(resp: Response): Promise<unknown> {
  const ct = resp.headers.get('content-type');
  if (isJsonContentType(ct)) {
    const text = await resp.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return resp.text();
}

function serializeBody(body: unknown, headers: Record<string, string>): BodyInit | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
  ) {
    // Pass through opaque payloads unchanged — caller owns Content-Type.
    return body as BodyInit;
  }
  if (typeof body === 'object') {
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    return JSON.stringify(body);
  }
  return String(body);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
}

async function applyBearerToken(
  headers: Record<string, string>,
  token: NonNullable<HttpClientConfig['token']>,
  req: HttpTokenRequest
): Promise<void> {
  const tok = await token(req);
  if (tok && !hasHeader(headers, 'authorization')) {
    headers['Authorization'] = `Bearer ${tok}`;
  }
}

function combineRequestSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal: AbortSignal | undefined; clearTimeout: (() => void) | null } {
  if (!timeoutMs) {
    return { signal: callerSignal, clearTimeout: null };
  }
  const timeoutCtl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtl.abort(new Error('timeout')), timeoutMs);
  const clear = () => clearTimeout(timeoutId);
  if (callerSignal) {
    return { signal: AbortSignal.any([callerSignal, timeoutCtl.signal]), clearTimeout: clear };
  }
  return { signal: timeoutCtl.signal, clearTimeout: clear };
}

function toHttpResponse(resp: Response, body: unknown): HttpResponse {
  return {
    body,
    headers: Object.fromEntries(resp.headers.entries()),
    status: resp.status,
  };
}

async function unwrapOkResponse(resp: Response, raw: boolean | undefined): Promise<unknown> {
  const respBody = await readBody(resp);
  if (raw) return toHttpResponse(resp, respBody);
  return respBody;
}

async function throwForResponse(resp: Response, url: string): Promise<never> {
  const errBody = await readBody(resp).catch(() => null);
  throw new HttpError(resp.status, resp.statusText, url, errBody);
}

function retryWaitMs(resp: Response, attempt: number): number {
  const retryAfter = parseRetryAfter(resp.headers.get('retry-after'));
  if (retryAfter !== null) return retryAfter;
  return DEFAULT_BACKOFF_BASE_MS * 2 ** attempt;
}

interface HttpRequestLoopContext {
  fetch: HttpGlobalDeps['fetch'];
  sleep: (ms: number) => Promise<void>;
  maxAttempts: number;
  retryOn: Set<number>;
  timeoutMs?: number;
}

async function executeRequestLoop(
  ctx: HttpRequestLoopContext,
  url: string,
  init: RequestInit,
  opts: HttpRequestOpts
): Promise<unknown> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < ctx.maxAttempts; attempt++) {
    const { signal, clearTimeout: clearAttemptTimeout } = combineRequestSignals(
      opts.signal,
      ctx.timeoutMs
    );
    const attemptInit: RequestInit = signal ? { ...init, signal } : init;
    let resp: Response;
    try {
      resp = await ctx.fetch(url, attemptInit);
    } finally {
      clearAttemptTimeout?.();
    }
    lastResponse = resp;
    if (resp.ok) return unwrapOkResponse(resp, opts.raw);
    const willRetry = attempt + 1 < ctx.maxAttempts && ctx.retryOn.has(resp.status);
    if (!willRetry) return throwForResponse(resp, url);
    await ctx.sleep(retryWaitMs(resp, attempt));
  }
  if (lastResponse) return throwForResponse(lastResponse, url);
  throw new Error(`http: no attempts made for ${init.method ?? 'GET'} ${url}`);
}

export function createHttpGlobal(deps: HttpGlobalDeps): HttpGlobal {
  const sleep = deps.sleep ?? defaultSleep;

  function makeClient(config: HttpClientConfig): HttpClient {
    const retryOn = new Set(config.retry?.on ?? []);
    const maxAttempts = Math.max(1, Math.trunc(config.retry?.maxAttempts ?? 1));

    async function request(
      method: string,
      path: string,
      opts: HttpRequestOpts = {}
    ): Promise<unknown> {
      const url = buildUrl(config.baseUrl, path, opts.params);
      const headers = mergeHeaders(config.headers, opts.headers);
      if (config.token) {
        await applyBearerToken(headers, config.token, { method, path, url });
      }
      const body = serializeBody(opts.body, headers);
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = body;

      return executeRequestLoop(
        {
          fetch: deps.fetch,
          sleep,
          maxAttempts,
          retryOn,
          timeoutMs: config.timeoutMs,
        },
        url,
        init,
        opts
      );
    }

    const client: HttpClient = {
      get: ((path: string, opts?: HttpRequestOpts) =>
        request('GET', path, opts)) as HttpClient['get'],
      post: ((path: string, opts?: HttpRequestOpts) =>
        request('POST', path, opts)) as HttpClient['post'],
      put: ((path: string, opts?: HttpRequestOpts) =>
        request('PUT', path, opts)) as HttpClient['put'],
      patch: ((path: string, opts?: HttpRequestOpts) =>
        request('PATCH', path, opts)) as HttpClient['patch'],
      delete: ((path: string, opts?: HttpRequestOpts) =>
        request('DELETE', path, opts)) as HttpClient['delete'],
    };
    return Object.freeze(client);
  }

  return Object.freeze({ client: makeClient });
}
