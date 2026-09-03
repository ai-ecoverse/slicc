/**
 * Standard `Link` header set emitted on every worker HTTP response.
 *
 * Implements the discovery side of issue #476 — RFC 8288 (Web Linking)
 * with RFC 9727 (`api-catalog`) and RFC 8631 (`service-desc`,
 * `service-doc`, `status`). The handoff-specific rels live in
 * `handoff-page.ts` because they are payload-bearing (verb + target +
 * instruction) and not appropriate for a blanket emission.
 */

const STANDARD_RELS_TEMPLATE = (origin: string): string[] => [
  `<${origin}/.well-known/api-catalog>; rel="api-catalog"`,
  `<${origin}/.well-known/api-catalog>; rel="service-desc"; type="application/linkset+json"`,
  `<https://github.com/ai-ecoverse/slicc>; rel="service-doc"`,
  `<${origin}/status>; rel="status"; type="application/json"`,
  `<${origin}/llms.txt>; rel="https://llmstxt.org/rel/llms-txt"; type="text/markdown"`,
  `<https://github.com/ai-ecoverse/slicc/blob/main/LICENSE>; rel="license"`,
  `<https://github.com/ai-ecoverse/slicc#readme>; rel="terms-of-service"`,
];

/**
 * Append SLICC's standard `Link` header set to a response, preserving any
 * Link headers the response already carries (e.g. handoff-specific links
 * emitted by `/handoff`). The response status, body, and other headers are
 * left intact.
 *
 * Skips 101 (WebSocket upgrade) and 3xx redirects — clients ignore link
 * relations on redirect responses, and adding ~500 bytes of headers to a
 * tiny redirect just bloats them.
 */
export function applySliccLinks(response: Response, request: Request): Response {
  if (response.status === 101) return response;
  if (response.status >= 300 && response.status < 400) return response;
  // Don't mutate an immutable response; clone via the constructor.
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const headers = new Headers(response.headers);
  for (const value of STANDARD_RELS_TEMPLATE(origin)) {
    headers.append('Link', value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * RFC 8288 `Link` header value pointing at the tray that replaced a
 * superseded one, using the `successor-version` relation registered by
 * RFC 5829 §3.4 ("points to a resource containing the successor version in
 * the version history").
 *
 * Emitted alongside the existing 409 + JSON body on supersede responses
 * (issue #1957) so a follower can read one header instead of pattern-matching
 * a `fail` code out of the body. Purely additive — clients that don't know the
 * rel ignore it.
 *
 * The target is normalized through `URL` before it is embedded so a stored
 * join URL can never smuggle a header delimiter (`>`, CR/LF) into the field
 * value. Returns `null` when the stored value doesn't parse as a URL, in which
 * case the caller emits no header at all.
 */
export function successorVersionLink(joinUrl: string): string | null {
  try {
    return `<${new URL(joinUrl).href}>; rel="successor-version"`;
  } catch {
    return null;
  }
}

/**
 * Headers to merge into a tray-supersede response: the `successor-version`
 * link, or nothing when the replacement URL is unusable. Status and body are
 * the caller's business and stay untouched.
 */
export function supersededLinkHeaders(joinUrl: string): Record<string, string> {
  const link = successorVersionLink(joinUrl);
  return link ? { Link: link } : {};
}

/**
 * `Location` value for the 308 a superseded tray answers with (#1957).
 *
 * Carries `json=true` over from the superseded request when it had it. Every
 * client platform follows a 308 by default, and a followed request that lost
 * the parameter lands on the worker's SPA fallback — which answers 200 + HTML
 * for a `GET` probe (`index.ts` serveSPA short-circuit), making a live
 * replacement look dead to any follower that has not yet learned to suppress
 * redirects. The `successor-version` link deliberately keeps the bare URL: it
 * is what clients persist as the session's join URL, and a stored `json=true`
 * would leak the probe parameter into every later use.
 *
 * Returns `null` when the stored replacement does not parse, in which case the
 * caller must not emit a redirect at all — a 3xx without a target is worse
 * than the terminal response it replaced. `URL.href` is percent-encoded, so
 * the result can never smuggle CR/LF into the field value.
 */
export function supersededLocation(joinUrl: string, requestUrl: URL): string | null {
  let target: URL;
  try {
    target = new URL(joinUrl);
  } catch {
    return null;
  }
  if (requestUrl.searchParams.get('json') === 'true') {
    target.searchParams.set('json', 'true');
  }
  return target.href;
}

/**
 * Whether the caller asked to be told about a supersede instead of redirected
 * through it — `?redirect=manual`, spelled after `RequestInit.redirect`.
 *
 * Exists for exactly one client: a browser. Every other follower suppresses
 * redirect-following itself and counts hops one at a time, but `fetch` cannot
 * be made to hand a 308 back (`redirect: 'manual'` yields an opaque-redirect
 * filtered response — no status, headers, or body, even same-origin). Left to
 * the platform, a chain of superseded trays is followed end to end and arrives
 * as ONE observable hop, so `MAX_SUPERSEDE_REDIRECTS` counts 1 for a chain of
 * any length and a cycle burns the browser's own redirect limit in immediate
 * re-POSTs before failing as a generic network error.
 *
 * A client that sets it gets the pre-#1957 terminal shape (409 + the
 * `successor-version` link + the body), which is exactly enough to take one hop
 * and come back for the next. The parameter is a per-request probe detail: it
 * is never stored, never copied onto `Location`, and a client must strip it
 * from any URL it persists.
 */
export function prefersManualRedirect(requestUrl: URL): boolean {
  return requestUrl.searchParams.get('redirect') === 'manual';
}
