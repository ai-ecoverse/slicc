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
