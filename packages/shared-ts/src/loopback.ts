/**
 * Canonical loopback-host detection shared across security gates
 * (bridge-token exemption, localhost-only endpoints, http: allowlists,
 * OAuth redirect branching). One accepted set — do not reimplement.
 *
 * Accepts:
 * - `localhost`
 * - the entire `127.0.0.0/8` block (e.g. `127.0.0.1`, `127.0.0.2`)
 * - IPv6 loopback, bracketed or bare (`[::1]`, `::1`)
 */

/** True when `hostname` is a loopback name (no URL parse — host only). */
export function isLoopbackHostname(hostname: string): boolean {
  if (!hostname) return false;
  // WHATWG URL keeps brackets on IPv6 hostnames (`http://[::1]` → `[::1]`);
  // socket addresses and some callers pass bare `::1`. Accept both.
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (host === 'localhost') return true;
  if (host === '::1') return true;
  // 127.0.0.0/8 — octet shape only (same as the former webapp plugin gate).
  if (/^127(\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

/**
 * True when `origin` parses as a URL whose hostname is loopback.
 * Returns false for missing / empty / unparseable values.
 */
export function isLoopbackOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}
