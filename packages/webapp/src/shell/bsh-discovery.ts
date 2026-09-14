import type { FileContent, ReadFileOptions } from '../fs/types.js';

export interface BshDiscoveryFS {
  exists(path: string): Promise<boolean>;
  walk(path: string): AsyncGenerator<string>;
  readFile(path: string, options?: ReadFileOptions): Promise<FileContent>;
}

export interface BshEntry {
  path: string;

  hostnamePattern: string;

  matchPatterns: string[];
}

const SCAN_ROOTS = ['/workspace', '/shared'];

export async function discoverBshScripts(fs: BshDiscoveryFS): Promise<BshEntry[]> {
  const entries: BshEntry[] = [];
  const seen = new Set<string>();

  for (const root of SCAN_ROOTS) {
    if (await fs.exists(root)) {
      await scanDir(fs, root, entries, seen);
    }
  }

  return entries;
}

async function scanDir(
  fs: BshDiscoveryFS,
  root: string,
  entries: BshEntry[],
  seen: Set<string>
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

export function extractHostnamePattern(filePath: string): string | null {
  const base = filePath.split('/').pop() ?? '';
  if (!base.endsWith('.bsh')) return null;

  const name = base.slice(0, -4);
  if (!name) return null;

  if (name.startsWith('-.')) {
    return '*' + name.slice(1);
  }

  return name;
}

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

export function hostnameMatches(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    const bareDomain = pattern.slice(2);
    return (
      hostname === bareDomain || (hostname.endsWith(suffix) && hostname.length > suffix.length)
    );
  }
  return hostname === pattern;
}

export function urlMatchesPattern(url: string, pattern: string): boolean {
  try {
    const parsed = new URL(url);
    const patternMatch = pattern.match(/^(\*|https?):\/\/([^/]+)(\/.*)?$/);
    if (!patternMatch) return false;

    const [, schemePattern, hostPattern, pathPattern] = patternMatch;

    if (schemePattern !== '*') {
      const urlScheme = parsed.protocol.slice(0, -1);
      if (urlScheme !== schemePattern) return false;
    }

    if (!hostnameMatches(parsed.hostname, hostPattern)) return false;

    if (pathPattern) {
      return pathGlobMatches(parsed.pathname + parsed.search, pathPattern);
    }

    return true;
  } catch {
    return false;
  }
}

function pathGlobMatches(path: string, pattern: string): boolean {
  const regexStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr).test(path);
}

export function findMatchingScripts(entries: BshEntry[], url: string): BshEntry[] {
  try {
    const parsed = new URL(url);
    return entries.filter((entry) => {
      if (!hostnameMatches(parsed.hostname, entry.hostnamePattern)) return false;
      if (entry.matchPatterns.length > 0) {
        return entry.matchPatterns.some((p) => urlMatchesPattern(url, p));
      }
      return true;
    });
  } catch {
    return [];
  }
}
