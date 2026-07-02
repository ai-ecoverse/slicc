/**
 * Extract a preview capability token from a request host.
 *
 * Preview URLs use a single subdomain label on either sliccy.now (prod)
 * or sliccy.dev (staging), plus a `*.localhost[:port]` form for local dev:
 *   `<compactUUID>--<hex>.sliccy.now`      — production
 *   `<compactUUID>--<hex>.sliccy.dev`      — staging
 *   `<compactUUID>--<hex>.localhost:8787`  — local `wrangler dev` (matches the
 *                                            `localhost:8787` row in `buildPreviewUrl`)
 *
 * The subdomain encodes the internal token `<uuid>.<secret>` with two
 * transforms: UUID hyphens stripped (saves 4 chars) and the dot replaced
 * with `--`. This function reverses both so `parseCapabilityToken` gets
 * the original `<uuid-with-hyphens>.<hex>` format back.
 *
 * The `.localhost` branch is a dev-only affordance: the deployed workers only
 * ever receive `*.sliccy.now|dev` hosts (Cloudflare routes by domain, so a
 * `.localhost` host never reaches them), and the extracted token is still
 * verified against the tray Durable Object via `parseCapabilityToken` — so
 * accepting `.localhost` opens no production surface.
 *
 * Returns null when the host doesn't end in a known preview suffix or the
 * token portion is empty.
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

export function previewTokenFromHost(host: string): string | null {
  if (!host) return null;
  const m = host.match(PREVIEW_HOST_RE);
  if (!m) return null;
  const label = m[1];
  if (!label) return null;
  const separatorIndex = label.indexOf('--');
  if (separatorIndex === -1) return null;
  const compactUuid = label.slice(0, separatorIndex);
  const secret = label.slice(separatorIndex + 2);
  if (compactUuid.length !== 32) return null;
  return `${rehyphenateUuid(compactUuid)}.${secret}`;
}
