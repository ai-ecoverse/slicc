/**
 * Turn parsed `curlwright` options plus a resolved body into the
 * `browser.fetch` request the page will actually issue.
 *
 * `responseType` is pinned to `'binary'` here for every request. That is
 * the load-bearing decision of the whole command: the body comes back as
 * base64 bytes, so `-o` is byte-exact and stdout is decoded exactly once
 * from known bytes — never JSON-parsed and re-serialized into something
 * the server never sent.
 */

import type { BrowserFetchOptions } from '../../../kernel/realm/realm-browser-fetch.js';
import type { ResolvedBody } from './body.js';
import type { CurlwrightOptions, ParseFailure } from './parse-args.js';

export interface PreparedRequest {
  url: string;
  method: string;
  fetchOptions: BrowserFetchOptions;
  /** Request body size, for `%{size_upload}`. */
  uploadSize: number;
}

/** Case-insensitive lookup over the headers the user supplied. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

function collectHeaders(opts: CurlwrightOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of opts.headers) {
    // `-H 'Name:'` is curl's "drop this internal header". A page fetch
    // adds none of the headers that form is used to remove, so honoring
    // it means sending nothing — not sending an empty value.
    if (header.unset || header.name === '') continue;
    headers[header.name] = header.value;
  }
  return headers;
}

function applyDerivedHeaders(
  headers: Record<string, string>,
  opts: CurlwrightOptions,
  body: ResolvedBody
): void {
  if (opts.user !== null && !hasHeader(headers, 'authorization')) {
    headers['Authorization'] = `Basic ${btoa(opts.user)}`;
  }
  if (opts.range !== null && !hasHeader(headers, 'range')) headers['Range'] = opts.range;
  if (body.contentType && !hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = body.contentType;
  }
  if (body.accept && !hasHeader(headers, 'accept')) headers['Accept'] = body.accept;
}

/** Append `-d` content to the query string for `-G`. */
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

/**
 * Assemble the page-context request. Returns a {@link ParseFailure} for
 * combinations curl accepts but this surface cannot honor.
 */
export function prepareRequest(
  opts: CurlwrightOptions,
  body: ResolvedBody
): PreparedRequest | ParseFailure {
  if (opts.url === null) {
    return { message: 'curlwright: no URL specified', exitCode: 2 };
  }
  const headers = collectHeaders(opts);
  const usingQuery = opts.get && body.bytes !== null;
  const effectiveBody: ResolvedBody = usingQuery
    ? { ...body, bytes: null, contentType: null }
    : body;
  applyDerivedHeaders(headers, opts, effectiveBody);

  const url = usingQuery
    ? appendQuery(opts.url, new TextDecoder().decode(body.bytes ?? new Uint8Array(0)))
    : opts.url;
  const hasBody = effectiveBody.bytes !== null || effectiveBody.form !== null;
  const method = resolveMethod(opts, hasBody);

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

/** The `-v` request trace curl prints with `> ` prefixes. */
export function formatRequestTrace(request: PreparedRequest): string {
  const headers = request.fetchOptions.headers ?? {};
  const lines = [`> ${request.method} ${request.url}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`> ${name}: ${value}`);
  lines.push('> ');
  return `${lines.join('\n')}\n`;
}

/** The `-v` response trace curl prints with `< ` prefixes. */
export function formatResponseTrace(
  statusLineText: string,
  headers: Record<string, string>
): string {
  const lines = [`< ${statusLineText}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`< ${name}: ${value}`);
  lines.push('< ');
  return `${lines.join('\n')}\n`;
}
