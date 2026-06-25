/**
 * Maps a tray's worker base URL to its preview-subdomain base host.
 *
 * Critical: this is a LOOKUP TABLE, not a hostname suffix-strip. The staging
 * worker lives on `slicc-tray-hub-staging.minivelos.workers.dev` which has no
 * string relationship to `sliccy.dev`. Adding a new env means adding a row
 * here AND ensuring infra has both routes bound to the same worker /
 * DurableObject namespace.
 *
 * Token encoding: capability tokens are `<trayId>.<36-hex>` (dot separator).
 * A dot creates a two-level wildcard that requires paid Advanced Certificate
 * Manager. We encode the separator as `--` (double-dash) for the subdomain
 * label so the URL is a single-label `<trayId>--<hex>.sliccy.now`, covered
 * by free Cloudflare universal SSL. UUIDs use single dashes, hex has none,
 * so `--` is unambiguous. The reverse transform lives in `preview-host.ts`.
 */
const PREVIEW_BASE_BY_WORKER: Record<string, string> = {
  // Production — sliccy.now
  'www.sliccy.ai': 'sliccy.now',
  'sliccy.ai': 'sliccy.now',
  // Staging — sliccy.dev
  'slicc-tray-hub-staging.minivelos.workers.dev': 'sliccy.dev',
  // Local dev
  'localhost:8787': 'localhost:8787',
};

export function previewBaseHost(workerBaseUrl: string): string {
  const host = new URL(workerBaseUrl).host.toLowerCase();
  const mapped = PREVIEW_BASE_BY_WORKER[host];
  if (!mapped) {
    throw new Error(`No preview base configured for worker host ${host}`);
  }
  return mapped;
}

/** Encode a capability token `trayId.hex` for use as a single subdomain label.
 * Strips UUID hyphens to save 4 chars: `abcd1234-...-5678.hex` → `abcd12345678--hex`. */
function encodeTokenForSubdomain(previewToken: string): string {
  const dotIndex = previewToken.indexOf('.');
  if (dotIndex === -1) return previewToken;
  const trayId = previewToken.slice(0, dotIndex).replace(/-/g, '');
  const secret = previewToken.slice(dotIndex + 1);
  return `${trayId}--${secret}`;
}

export function buildPreviewUrl(workerBaseUrl: string, previewToken: string, path = '/'): string {
  const base = previewBaseHost(workerBaseUrl);
  const label = encodeTokenForSubdomain(previewToken);
  const p = path.startsWith('/') ? path : '/' + path;
  // ponytail: localhost uses http, everything else https
  const scheme = base.startsWith('localhost') ? 'http' : 'https';
  return `${scheme}://${label}.${base}${p}`;
}
