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
  params?: Record<string, unknown>;
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

function buildUrl(
  baseUrl: string | undefined,
  path: string,
  params?: Record<string, unknown>
): string {
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
        const tok = await config.token({ method, path, url });
        if (tok) {
          const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
          if (!hasAuth) headers['Authorization'] = `Bearer ${tok}`;
        }
      }
      const body = serializeBody(opts.body, headers);
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = body;

      let lastResponse: Response | null = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const timeoutCtl = config.timeoutMs ? new AbortController() : null;
        const timeoutId = timeoutCtl
          ? setTimeout(() => timeoutCtl.abort(new Error('timeout')), config.timeoutMs!)
          : null;
        // Combine caller signal + per-attempt timeout signal.
        const combinedSignal =
          opts.signal && timeoutCtl?.signal
            ? AbortSignal.any([opts.signal, timeoutCtl.signal])
            : (opts.signal ?? timeoutCtl?.signal);
        const attemptInit: RequestInit = combinedSignal
          ? { ...init, signal: combinedSignal }
          : init;
        let resp: Response;
        try {
          resp = await deps.fetch(url, attemptInit);
        } finally {
          if (timeoutId !== null) clearTimeout(timeoutId);
        }
        lastResponse = resp;
        if (resp.ok) {
          const respBody = await readBody(resp);
          if (opts.raw) {
            return {
              body: respBody,
              headers: Object.fromEntries(resp.headers.entries()),
              status: resp.status,
            } satisfies HttpResponse;
          }
          return respBody;
        }
        const willRetry = attempt + 1 < maxAttempts && retryOn.has(resp.status);
        if (!willRetry) {
          const errBody = await readBody(resp).catch(() => null);
          throw new HttpError(resp.status, resp.statusText, url, errBody);
        }
        const retryAfter = parseRetryAfter(resp.headers.get('retry-after'));
        const exp = DEFAULT_BACKOFF_BASE_MS * 2 ** attempt;
        const wait = retryAfter !== null ? retryAfter : exp;
        await sleep(wait);
      }
      // Unreachable in practice — the loop either returns or throws — but
      // keeps the type-checker honest if maxAttempts somehow falls to 0.
      if (lastResponse) {
        const errBody = await readBody(lastResponse).catch(() => null);
        throw new HttpError(lastResponse.status, lastResponse.statusText, url, errBody);
      }
      throw new Error(`http: no attempts made for ${method} ${url}`);
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
