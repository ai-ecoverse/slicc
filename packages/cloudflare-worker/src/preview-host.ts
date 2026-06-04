/**
 * Extract a preview capability token from a request host.
 *
 * Token format is `trayId.<18-byte-hex>` (per `shared.ts:127-132`
 * createCapabilityToken), so the host has TWO dots before `.preview` and a
 * naive `host.split('.')[0]` would drop the secret half. We suffix-strip the
 * known `.preview.<env>.sliccy.ai` base instead, then leave token validation
 * to `parseCapabilityToken(token)` at the call site.
 *
 * Returns null when the host doesn't end in a known preview suffix or the
 * token portion is empty.
 */
const PREVIEW_HOST_RE = /^(.+)\.preview\.(staging\.)?sliccy\.ai$/i;

export function previewTokenFromHost(host: string): string | null {
  if (!host) return null;
  const m = host.match(PREVIEW_HOST_RE);
  if (!m) return null;
  const token = m[1];
  if (!token) return null;
  return token;
}
