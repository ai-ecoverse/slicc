/**
 * upskill — shared fetch-boundary error describer.
 *
 * Extracted from `upskill-command.ts` so both the monolith and the catalog
 * HTTP fetchers (`catalog/catalog-fetch.ts`) can wrap network failures with a
 * host-named message without importing the monolith (which would create a
 * runtime import cycle). A later wave can fold this into the GitHub backend.
 */

/**
 * Build a host-named description for a failed fetch boundary.
 *
 * Bare network / CORS failures surface as opaque `TypeError: Failed to fetch`
 * in the browser, which gives the user no signal about which host actually
 * went down. Appending the parsed host makes failures actionable (e.g. the
 * user can tell that `codeload.github.com` is unreachable rather than
 * suspecting `api.tessl.io`). Already-host-named messages are returned
 * unchanged so wrapping is idempotent across nested boundaries.
 */
export function describeFetchError(err: unknown, url: string): string {
  const base = err instanceof Error ? err.message : String(err);
  let host: string | undefined;
  try {
    host = new URL(url).host;
  } catch {
    return base;
  }
  if (!host || base.includes(host)) return base;
  return `${base} (host: ${host} — network or CORS error)`;
}
