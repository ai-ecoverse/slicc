/**
 * BSH Discovery — scan VirtualFS for `.bsh` browser shell script files and
 * build a registry of hostname patterns to VFS paths.
 *
 * `.bsh` files use the same execution engine as `.jsh` files (jsh-executor.ts).
 * They are JavaScript, NOT bash. The difference is the filename convention:
 *
 * - `-.okta.com.bsh` → matches `*.okta.com` (dash-dot prefix = wildcard)
 * - `login.okta.com.bsh` → matches `login.okta.com` exactly
 *
 * Optional `// @match` directives in the first 10 lines further restrict URLs
 * using glob-style patterns (like Greasemonkey userscripts).
 */

import type { VirtualFS } from '../fs/index.js';

/** A discovered .bsh script with its hostname pattern and optional URL match patterns. */
export interface BshEntry {
  /** VFS path to the .bsh file. */
  path: string;
  /** Hostname glob extracted from the filename (e.g. `*.okta.com` or `login.okta.com`). */
  hostnamePattern: string;
  /** Optional `@match` URL patterns parsed from the file header. */
  matchPatterns: string[];
}

/** Directories to scan first (in order). */
const SCAN_ROOTS = ['/workspace', '/shared'];

/**
 * Discover all `.bsh` files on the VFS and return an array of BshEntry objects.
 * Scans `/workspace` and `/shared` directories.
 */
export async function discoverBshScripts(fs: VirtualFS): Promise<BshEntry[]> {
  const entries: BshEntry[] = [];
  const seen = new Set<string>();

  for (const root of SCAN_ROOTS) {
    if (await fs.exists(root)) {
      await scanDir(fs, root, entries, seen);
    }
  }

  return entries;
}

/** Walk a directory tree and collect .bsh files. */
async function scanDir(
  fs: VirtualFS,
  root: string,
  entries: BshEntry[],
  seen: Set<string>,
): Promise<void> {
  for await (const filePath of fs.walk(root)) {
    if (!filePath.endsWith('.bsh')) continue;
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    const hostnamePattern = extractHostnamePattern(filePath);
    if (!hostnamePattern) continue;

    const raw = await fs.readFile(filePath, { encoding: 'utf-8' });
    const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const matchPatterns = parseMatchDirectives(content);

    entries.push({ path: filePath, hostnamePattern, matchPatterns });
  }
}

/**
 * Extract a hostname pattern from a .bsh filename.
 *
 * Convention:
 * - `-.okta.com.bsh` → `*.okta.com` (dash-dot prefix means wildcard)
 * - `login.okta.com.bsh` → `login.okta.com` (exact match)
 */
export function extractHostnamePattern(filePath: string): string | null {
  const base = filePath.split('/').pop() ?? '';
  if (!base.endsWith('.bsh')) return null;

  const name = base.slice(0, -4); // strip .bsh
  if (!name) return null;

  // Dash-dot prefix: `-.example.com` → `*.example.com`
  if (name.startsWith('-.')) {
    return '*' + name.slice(1);
  }

  return name;
}

/**
 * Parse `// @match` directives from the first 10 lines of a .bsh file.
 * Returns an array of URL match patterns (glob-style).
 *
 * Example:
 * ```
 * // @match *://login.okta.com/*
 * // @match https://example.com/app/*
 * ```
 */
export function parseMatchDirectives(content: string): string[] {
  const lines = content.split('\n').slice(0, 10);
  const patterns: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*\/\/\s*@match\s+(.+)$/);
    if (match) {
      patterns.push(match[1].trim());
    }
  }

  return patterns;
}

/**
 * Test whether a hostname matches a hostname pattern.
 *
 * Patterns:
 * - `*.okta.com` → matches `login.okta.com`, `foo.bar.okta.com`, etc.
 * - `login.okta.com` → exact match only
 */
export function hostnameMatches(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // `.okta.com`
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === pattern;
}

/**
 * Test whether a full URL matches a `@match` pattern (glob-style).
 *
 * Pattern format: `scheme://host/path` where:
 * - `*` in scheme matches any scheme (http, https)
 * - `*` in host means wildcard subdomain (like hostname patterns)
 * - `*` in path matches any path segment(s)
 *
 * Examples:
 * - `*://login.okta.com/*` → matches any scheme, exact host, any path
 * - `https://*.example.com/app/*` → https only, wildcard subdomain, /app/ prefix
 */
export function urlMatchesPattern(url: string, pattern: string): boolean {
  try {
    const parsed = new URL(url);
    const patternMatch = pattern.match(/^(\*|https?):\/\/([^/]+)(\/.*)?$/);
    if (!patternMatch) return false;

    const [, schemePattern, hostPattern, pathPattern] = patternMatch;

    // Check scheme
    if (schemePattern !== '*') {
      const urlScheme = parsed.protocol.slice(0, -1); // strip trailing ':'
      if (urlScheme !== schemePattern) return false;
    }

    // Check host
    if (!hostnameMatches(parsed.hostname, hostPattern)) return false;

    // Check path
    if (pathPattern) {
      return pathGlobMatches(parsed.pathname + parsed.search, pathPattern);
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Simple glob match for URL paths. Supports `*` as a wildcard.
 *
 * - `/app/*` → matches `/app/anything`
 * - `/*` → matches everything
 * - `/exact/path` → exact match
 */
function pathGlobMatches(path: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr).test(path);
}

/**
 * Find all .bsh scripts that match a given URL.
 *
 * For each entry:
 * 1. Check if the URL's hostname matches the entry's hostnamePattern
 * 2. If the entry has @match patterns, also check that the URL matches at least one
 */
export function findMatchingScripts(entries: BshEntry[], url: string): BshEntry[] {
  try {
    const parsed = new URL(url);
    return entries.filter(entry => {
      if (!hostnameMatches(parsed.hostname, entry.hostnamePattern)) return false;
      if (entry.matchPatterns.length > 0) {
        return entry.matchPatterns.some(p => urlMatchesPattern(url, p));
      }
      return true;
    });
  } catch {
    return [];
  }
}
