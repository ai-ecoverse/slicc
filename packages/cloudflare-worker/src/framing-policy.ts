/**
 * Deny framing by default for responses without a framing policy.
 *
 * `worker.fetch` in `index.ts` applies this to every HTTP response, so a new
 * route is covered without doing anything. A page that is framed on purpose
 * says so itself by setting `frame-ancestors`; the rule below then leaves it
 * alone. Full list of those pages: docs/cloudflare-worker-details.md.
 */

const DENY_FRAME_ANCESTORS = "frame-ancestors 'none'";

/**
 * The sources of every `frame-ancestors` directive in a CSP header value, or
 * `null` when it has none. Commas separate policies and semicolons separate
 * directives; neither can appear inside a source expression, so one split
 * covers both, including a header that combines several policies.
 */
function frameAncestorSources(csp: string): string[] | null {
  const directives = csp
    .split(/[;,]/)
    .map((directive) => directive.trim().toLowerCase().split(/\s+/))
    .filter(([name]) => name === 'frame-ancestors');
  return directives.length > 0 ? directives.flatMap(([, ...sources]) => sources) : null;
}

/** Append the deny directive to an existing policy, or start one. */
function withDenyDirective(csp: string): string {
  const existing = csp.trim().replace(/[;\s]+$/, '');
  return existing ? `${existing}; ${DENY_FRAME_ANCESTORS}` : DENY_FRAME_ANCESTORS;
}

/**
 * Add `frame-ancestors 'none'` and `X-Frame-Options: DENY` to a response that
 * carries no framing policy, merging into an existing CSP.
 *
 * - `frame-ancestors` that only denies gets the matching `X-Frame-Options`.
 * - Any other `frame-ancestors` is an allowlist and gets no `X-Frame-Options`,
 *   which would override the allowlist in some browsers.
 * - `X-Frame-Options` is itself a policy: whatever the response set stays.
 * - A 101 is returned as is. It is not a mutable HTTP response, and rebuilding
 *   one would drop its `webSocket`.
 *
 * Only headers change; the status and body stream carry over. Responses that
 * need no change are returned without being rebuilt.
 */
export function withDefaultFramingPolicy(response: Response): Response {
  if (response.status === 101 || response.headers.has('x-frame-options')) return response;
  const csp = response.headers.get('content-security-policy') ?? '';
  const sources = frameAncestorSources(csp);
  if (sources?.some((source) => source !== "'none'")) return response;
  const out = new Response(response.body, response);
  if (sources === null) out.headers.set('Content-Security-Policy', withDenyDirective(csp));
  out.headers.set('X-Frame-Options', 'DENY');
  return out;
}
