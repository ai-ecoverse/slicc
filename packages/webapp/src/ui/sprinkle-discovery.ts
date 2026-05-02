/**
 * Sprinkle Discovery — scan VirtualFS for `.shtml` sprinkle files and
 * build a map of sprinkle names (basename without extension) to metadata.
 *
 * Priority: `/workspace/skills/` is scanned first.
 */

import type { VirtualFS } from '../fs/index.js';

/** Priority roots to scan first (in order). */
const PRIORITY_ROOTS = ['/shared/sprinkles'];

/**
 * Sprinkle names that are part of the deterministic onboarding flow
 * and only ever rendered as inline dips in chat. Excluded from
 * `discoverSprinkles` so they never appear in the rail's [+] picker,
 * the panel registry, or anywhere else that lists pickable sprinkles.
 */
const HIDDEN_SPRINKLES = new Set<string>(['welcome', 'connect-llm']);

export interface Sprinkle {
  /** basename without .shtml */
  name: string;
  /** VFS path */
  path: string;
  /** Display title (from <title> tag, data-sprinkle-title, or name) */
  title: string;
  /** Whether this sprinkle should auto-open on first run */
  autoOpen: boolean;
  /**
   * Raw icon spec from the .shtml. Resolved by `sprinkle-icon.ts`.
   * Can be:
   * - a Lucide icon name (kebab-case, e.g. `"music"`, `"calendar-clock"`)
   * - a VFS path to an SVG/PNG (e.g. `/workspace/skills/foo/icon.svg`)
   * - an inline `<svg>...</svg>` markup
   * - a `data:image/svg+xml;...` URL
   * Sourced from `<link rel="icon" href="...">` (preferred) or
   * `data-sprinkle-icon="..."` on any element.
   */
  icon?: string;
}

/**
 * Discover all `.shtml` files in the VFS and return a map of
 * sprinkle name → Sprinkle. First occurrence of a basename wins.
 * Priority roots are scanned before the general `/` walk.
 */
export async function discoverSprinkles(fs: VirtualFS): Promise<Map<string, Sprinkle>> {
  const sprinkles = new Map<string, Sprinkle>();

  // Scan priority roots first
  for (const root of PRIORITY_ROOTS) {
    if (await fs.exists(root)) {
      await scanDir(fs, root, sprinkles);
    }
  }

  // Scan everything from root, skipping already-found basenames
  await scanDir(fs, '/', sprinkles);

  return sprinkles;
}

/** Walk a directory and collect .shtml files into the map (first wins). */
async function scanDir(
  fs: VirtualFS,
  root: string,
  sprinkles: Map<string, Sprinkle>
): Promise<void> {
  for await (const filePath of fs.walk(root)) {
    if (!filePath.endsWith('.shtml')) continue;
    const name = sprinkleName(filePath);
    if (HIDDEN_SPRINKLES.has(name)) continue;
    if (!sprinkles.has(name)) {
      let content: string;
      try {
        content = ((await fs.readFile(filePath, { encoding: 'utf-8' })) as string) ?? '';
      } catch {
        content = '';
      }
      sprinkles.set(name, {
        name,
        path: filePath,
        title: extractTitle(content, name),
        autoOpen: extractAutoOpen(content),
        icon: extractIcon(content),
      });
    }
  }
}

/** Extract sprinkle name from a .shtml file path (basename minus extension). */
function sprinkleName(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.endsWith('.shtml') ? base.slice(0, -6) : base;
}

/** Extract title from HTML content: <title>, data-sprinkle-title, or fallback to name. */
export function extractTitle(content: string, fallback: string): string {
  // Check data-sprinkle-title attribute
  const attrMatch = content.match(/data-sprinkle-title=["']([^"']+)["']/);
  if (attrMatch) return attrMatch[1];

  // Check <title> tag
  const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) return titleMatch[1].trim();

  return fallback;
}

/** Check if content has data-sprinkle-autoopen attribute. */
export function extractAutoOpen(content: string): boolean {
  return /data-sprinkle-autoopen\b/.test(content);
}

/**
 * Extract the sprinkle icon spec.
 *
 * Priority:
 *   1. `<link rel="icon" href="...">` (the conventional favicon hook).
 *   2. `data-sprinkle-icon="..."` attribute on any element.
 *
 * Returns the raw spec as authored — the resolver in
 * `sprinkle-icon.ts` decides whether it's a Lucide name, a VFS
 * path, an inline SVG, or a data URL.
 */
export function extractIcon(content: string): string | undefined {
  const link = content.match(
    /<link\b[^>]*\brel\s*=\s*["'](?:icon|shortcut icon)["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i
  );
  if (link?.[1]) return link[1].trim();
  const reverseLink = content.match(
    /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["'](?:icon|shortcut icon)["']/i
  );
  if (reverseLink?.[1]) return reverseLink[1].trim();
  const attr = content.match(/data-sprinkle-icon\s*=\s*["']([^"']+)["']/);
  if (attr?.[1]) return attr[1].trim();
  return undefined;
}
