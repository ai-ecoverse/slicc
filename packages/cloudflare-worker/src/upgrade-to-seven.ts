export const UPGRADE_TO_SEVEN_PATH = '/upgrade-to-seven.html';

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export async function tryHandleUpgradeToSeven(
  url: URL,
  request: Request,
  assets: AssetsBinding
): Promise<Response | null> {
  if (url.pathname !== UPGRADE_TO_SEVEN_PATH) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const asset = new Request(new URL(UPGRADE_TO_SEVEN_PATH, request.url), {
    method: request.method,
  });
  const res = await assets.fetch(asset);

  const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
  const final = location
    ? await assets.fetch(new Request(new URL(location, request.url), { method: request.method }))
    : res;
  const headers = new Headers(final.headers);
  headers.set('Content-Security-Policy', "frame-ancestors 'self'");
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('Cache-Control', 'no-store');
  headers.delete('Document-Isolation-Policy');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(request.method === 'HEAD' ? null : final.body, {
    status: final.status,
    statusText: final.statusText,
    headers,
  });
}
