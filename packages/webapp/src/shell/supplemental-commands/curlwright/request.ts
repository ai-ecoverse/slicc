import type { BrowserFetchOptions } from '../../../kernel/realm/realm-browser-fetch.js';
import type { ResolvedBody } from './body.js';
import type { CurlwrightOptions, ParseFailure } from './parse-args.js';

export interface PreparedRequest {
  url: string;
  method: string;
  fetchOptions: BrowserFetchOptions;

  uploadSize: number;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

function collectHeaders(opts: CurlwrightOptions): {
  headers: Record<string, string>;
  suppressed: Set<string>;
} {
  const headers: Record<string, string> = {};
  const suppressed = new Set<string>();
  for (const header of opts.headers) {
    if (header.name === '') continue;
    if (header.unset) {
      suppressed.add(header.name.toLowerCase());
      continue;
    }
    headers[header.name] = header.value;
  }
  return { headers, suppressed };
}

function wantsDefault(
  headers: Record<string, string>,
  suppressed: Set<string>,
  name: string
): boolean {
  return !hasHeader(headers, name) && !suppressed.has(name);
}

function rangeHeaderValue(range: string): string {
  return /^[a-zA-Z]+=/.test(range) ? range : `bytes=${range}`;
}

function applyDerivedHeaders(
  headers: Record<string, string>,
  suppressed: Set<string>,
  opts: CurlwrightOptions,
  body: ResolvedBody
): void {
  if (opts.user !== null && wantsDefault(headers, suppressed, 'authorization')) {
    headers['Authorization'] = `Basic ${btoa(opts.user)}`;
  }
  if (opts.range !== null && wantsDefault(headers, suppressed, 'range')) {
    headers['Range'] = rangeHeaderValue(opts.range);
  }
  if (body.contentType && wantsDefault(headers, suppressed, 'content-type')) {
    headers['Content-Type'] = body.contentType;
  }
  if (body.accept && wantsDefault(headers, suppressed, 'accept')) {
    headers['Accept'] = body.accept;
  }
}

function appendQuery(url: string, query: string): string {
  if (query === '') return url;
  const [base, fragment] = splitFragment(url);
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}${query}${fragment}`;
}

function splitFragment(url: string): [string, string] {
  const hash = url.indexOf('#');
  return hash === -1 ? [url, ''] : [url.slice(0, hash), url.slice(hash)];
}

function resolveMethod(opts: CurlwrightOptions, hasBody: boolean): string {
  if (opts.requestMethod) return opts.requestMethod;
  if (opts.head) return 'HEAD';
  return hasBody ? 'POST' : 'GET';
}

function bodilessMethodWithBody(
  method: string,
  hasBody: boolean,
  opts: CurlwrightOptions
): ParseFailure | null {
  const upper = method.toUpperCase();
  if (!hasBody || (upper !== 'GET' && upper !== 'HEAD')) return null;
  const cause = opts.requestMethod ? `-X ${opts.requestMethod}` : '-I';
  return {
    message:
      `curlwright: ${cause} cannot carry a request body — a page fetch rejects a ` +
      `${upper} with one. Drop the data, or use -G to send it as a query string.`,
    exitCode: 2,
  };
}

export function prepareRequest(
  opts: CurlwrightOptions,
  body: ResolvedBody
): PreparedRequest | ParseFailure {
  if (opts.url === null) {
    return { message: 'curlwright: no URL specified', exitCode: 2 };
  }
  const { headers, suppressed } = collectHeaders(opts);
  const usingQuery = opts.get && body.bytes !== null;
  const effectiveBody: ResolvedBody = usingQuery
    ? { ...body, bytes: null, contentType: null }
    : body;
  applyDerivedHeaders(headers, suppressed, opts, effectiveBody);

  const url = usingQuery
    ? appendQuery(opts.url, new TextDecoder().decode(body.bytes ?? new Uint8Array(0)))
    : opts.url;
  const hasBody = effectiveBody.bytes !== null || effectiveBody.form !== null;
  const method = resolveMethod(opts, hasBody);
  const bodilessConflict = bodilessMethodWithBody(method, hasBody, opts);
  if (bodilessConflict) return bodilessConflict;

  const fetchOptions: BrowserFetchOptions = {
    method,
    headers,
    credentials: opts.credentials,
    responseType: 'binary',
  };
  if (effectiveBody.form) fetchOptions.body = effectiveBody.form;
  else if (effectiveBody.bytes) fetchOptions.body = effectiveBody.bytes;
  if (opts.referer !== null) fetchOptions.referrer = opts.referer;
  if (opts.maxTimeSeconds !== null) fetchOptions.timeoutMs = opts.maxTimeSeconds * 1000;

  return {
    url,
    method,
    fetchOptions,
    uploadSize: effectiveBody.bytes?.length ?? 0,
  };
}

export function formatRequestTrace(request: PreparedRequest): string {
  const headers = request.fetchOptions.headers ?? {};
  const lines = [`> ${request.method} ${request.url}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`> ${name}: ${value}`);
  lines.push('> ');
  return `${lines.join('\n')}\n`;
}

export function formatResponseTrace(
  statusLineText: string,
  headers: Record<string, string>
): string {
  const lines = [`< ${statusLineText}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`< ${name}: ${value}`);
  lines.push('< ');
  return `${lines.join('\n')}\n`;
}
