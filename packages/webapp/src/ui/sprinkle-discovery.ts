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
