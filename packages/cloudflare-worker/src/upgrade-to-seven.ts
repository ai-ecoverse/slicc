/**
 * `/upgrade-to-seven.html`: six's in-place exporter for the upgrade to seven
 * on www.sliccy.ai (slicc#4051). Seven's BIOS at `/7/` frames it, so unlike
 * every other six page it may be framed, but only by its own origin
 * (`frame-ancestors 'self'`). It is never cached, and it gets no
 * Document-Isolation-Policy: it runs no realms.
 */

/** The exporter's public path. */
export const UPGRADE_TO_SEVEN_PATH = '/upgrade-to-seven.html';

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

/** Serve the exporter page, or null for any other request. */
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
  // Assets' HTML handling may answer `/x.html` with a redirect to `/x`;
  // follow it once so the frame keeps the canonical URL.
  const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
  const final = location
    ? await assets.fetch(new Request(new URL(location, request.url), { method: request.method }))
    : res;
  const headers = new Headers(final.headers);
  headers.set('Content-Security-Policy', "frame-ancestors 'self'");
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('Cache-Control', 'no-store');
  headers.delete('Document-Isolation-Policy');
  return new Response(request.method === 'HEAD' ? null : final.body, {
    status: final.status,
    statusText: final.statusText,
    headers,
  });
}
