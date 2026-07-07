/**
 * Extract a preview capability token and optional user hash from a request host.
 *
 * Two URL formats are supported for backward compatibility:
 *
 * Old format (no user hash):
 *   `<compactUUID>--<secret>.sliccy.now`
 *   The segment after `--` is pure hex with no interior `-`.
 *
 * New format (with user hash):
 *   `<compactUUID>--<userHash8>-<secret20>.sliccy.now`
 *   The segment after `--` has a `-` at position 8, discriminating it from the
 *   old format. userHash is the first 8 hex chars of SHA-256(providerId:userName).
 *
 * Supported suffixes:
 *   `*.sliccy.now`     — production
 *   `*.sliccy.dev`     — staging
 *   `*.localhost:8787` — local `wrangler dev`
 *
 * The `.localhost` branch is a dev-only affordance: deployed workers only ever
 * receive `*.sliccy.now|dev` hosts, so accepting `.localhost` opens no
 * production surface.
 *
 * Returns null when the host doesn't match a known preview suffix.
 */
const PREVIEW_HOST_RE = /^([^.]+)\.(?:sliccy\.(?:now|dev)|localhost(?::\d+)?)$/i;

/** Re-insert hyphens into a 32-char compact UUID → `8-4-4-4-12` format. */
function rehyphenateUuid(compact: string): string {
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
}

export interface PreviewHostResult {
  token: string;
  userHash: string | null;
}

export function previewTokenFromHost(host: string): PreviewHostResult | null {
  if (!host) return null;
  const m = host.match(PREVIEW_HOST_RE);
  if (!m) return null;
  const label = m[1];
  if (!label) return null;
  const separatorIndex = label.indexOf('--');
  if (separatorIndex === -1) return null;
  const compactUuid = label.slice(0, separatorIndex);
  if (compactUuid.length !== 32) return null;
  const remainder = label.slice(separatorIndex + 2);

  // Discriminate new format (userHash8-secret) from old (pure hex secret).
  // New: remainder[8] === '-'; old: remainder is pure hex (no '-').
  if (remainder.length > 8 && remainder[8] === '-') {
    const userHash = remainder.slice(0, 8);
    const secret = remainder.slice(9);
    return { token: `${rehyphenateUuid(compactUuid)}.${secret}`, userHash };
  }

  return { token: `${rehyphenateUuid(compactUuid)}.${remainder}`, userHash: null };
}
