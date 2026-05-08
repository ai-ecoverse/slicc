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
 * Skips 101 (WebSocket upgrade) and 3xx responses that have an empty body —
 * adding headers to redirects is allowed but rarely useful and inflates
 * tiny responses.
 */
export function applySliccLinks(response: Response, request: Request): Response {
  if (response.status === 101) return response;
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
