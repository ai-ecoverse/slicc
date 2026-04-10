/**
 * Domain glob matching for secret domain allowlists.
 *
 * Supports patterns like:
 * - `api.github.com` — exact match
 * - `*.github.com`   — matches any subdomain of github.com
 * - `*`              — matches any domain
 */

/**
 * Check if a hostname matches a domain glob pattern.
 *
 * @param hostname - The hostname to check (e.g., "api.github.com")
 * @param pattern  - The glob pattern (e.g., "*.github.com")
 * @returns true if the hostname matches the pattern
 */
export function matchDomain(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();

  // Wildcard matches everything
  if (p === '*') return true;

  // Exact match
  if (h === p) return true;

  // Glob match: *.example.com matches sub.example.com but not example.com
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }

  return false;
}

/**
 * Check if a hostname matches any pattern in a list of domain globs.
 */
export function matchesDomains(hostname: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchDomain(hostname, pattern));
}
