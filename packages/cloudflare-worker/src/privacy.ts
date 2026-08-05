/**
 * `/privacy` on sliccy.ai redirects to the canonical SLICC privacy policy
 * at https://www.sliccy.com/privacy (the page's own `rel=canonical`).
 *
 * App Store Connect requires a working privacy-policy URL before
 * TestFlight external testing can be enabled, and links on sliccy.ai
 * surfaces naturally point at this host. The SPA fallback used to answer
 * this path with the dashboard shell, which is not a policy. A redirect
 * (rather than a copy) keeps exactly one policy text in existence.
 */
export const CANONICAL_PRIVACY_URL = 'https://www.sliccy.com/privacy';

export function buildPrivacyResponse(_request: Request): Response {
  return new Response(null, {
    status: 301,
    headers: {
      location: CANONICAL_PRIVACY_URL,
      'cache-control': 'public, max-age=3600',
    },
  });
}
