/**
 * Maps a tray's worker base URL to its preview-subdomain base host.
 *
 * Critical: this is a LOOKUP TABLE, not a hostname suffix-strip. The staging
 * worker lives on `slicc-tray-hub-staging.minivelos.workers.dev` which has no
 * string relationship to `sliccy.dev`. Adding a new env means adding a row
 * here AND ensuring infra has both routes bound to the same worker /
 * DurableObject namespace.
 *
 * Token encoding: capability tokens are `<trayId>.<hex>` (dot separator).
 * A dot creates a two-level wildcard that requires paid Advanced Certificate
 * Manager. We encode the separator as `--` (double-dash) for the subdomain
 * label so the URL is a single-label `<trayId>--<hex>.sliccy.now`, covered
 * by free Cloudflare universal SSL. UUIDs use single dashes, hex has none,
 * so `--` is unambiguous. The reverse transform lives in `preview-host.ts`.
 *
 * With a userHash the label becomes `<compactUUID>--<userHash8>-<secret20>`,
 * exactly 63 chars (the DNS label limit). The `-` at position 8 of the
 * post-separator segment discriminates the new format from the old (which is
 * pure hex with no `-`). See `preview-host.ts` for the reverse transform.
 */
import { SLICC_HOSTED_ORIGIN } from './bridge-protocol.js';

const SLICC_HOSTED_HOSTNAME = new URL(SLICC_HOSTED_ORIGIN).hostname;

const PREVIEW_BASE_BY_WORKER: Record<string, string> = {
  // Production — sliccy.now
  [SLICC_HOSTED_HOSTNAME]: 'sliccy.now',
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

/**
 * Encode a capability token for use as a single subdomain label.
 *
 * Old format (no userHash): `<compactUUID>--<secret>`
 * New format (with userHash): `<compactUUID>--<userHash8>-<secret>`
 *
 * The `-` between userHash and secret is the format discriminator; old-format
 * secrets are pure hex with no interior `-`.
 */
function encodeTokenForSubdomain(previewToken: string, userHash?: string): string {
  const dotIndex = previewToken.indexOf('.');
  if (dotIndex === -1) return previewToken;
  const trayId = previewToken.slice(0, dotIndex).replace(/-/g, '');
  const secret = previewToken.slice(dotIndex + 1);
  if (userHash) {
    return `${trayId}--${userHash}-${secret}`;
  }
  return `${trayId}--${secret}`;
}

export function buildPreviewUrl(
  workerBaseUrl: string,
  previewToken: string,
  path = '/',
  userHash?: string
): string {
  const base = previewBaseHost(workerBaseUrl);
  const label = encodeTokenForSubdomain(previewToken, userHash);
  const p = path.startsWith('/') ? path : '/' + path;
  // ponytail: localhost uses http, everything else https
  const scheme = base.startsWith('localhost') ? 'http' : 'https';
  return `${scheme}://${label}.${base}${p}`;
}
