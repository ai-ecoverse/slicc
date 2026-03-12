/**
 * SHTML Discovery — scan VirtualFS for `.shtml` panel files and
 * build a map of panel names (basename without extension) to metadata.
 *
 * Priority: `/workspace/skills/` is scanned first.
 */

import type { VirtualFS } from '../fs/index.js';

/** Priority roots to scan first (in order). */
const PRIORITY_ROOTS = ['/workspace/skills'];

export interface ShtmlPanel {
  /** basename without .shtml */
  name: string;
  /** VFS path */
  path: string;
  /** Display title (from <title> tag, data-shtml-title, or name) */
  title: string;
}

/**
 * Discover all `.shtml` files in the VFS and return a map of
 * panel name → ShtmlPanel. First occurrence of a basename wins.
 * Priority roots are scanned before the general `/` walk.
 */
export async function discoverShtmlPanels(
  fs: VirtualFS,
): Promise<Map<string, ShtmlPanel>> {
  const panels = new Map<string, ShtmlPanel>();

  // Scan priority roots first
  for (const root of PRIORITY_ROOTS) {
    if (await fs.exists(root)) {
      await scanDir(fs, root, panels);
    }
  }

  // Scan everything from root, skipping already-found basenames
  await scanDir(fs, '/', panels);

  return panels;
}

/** Walk a directory and collect .shtml files into the map (first wins). */
async function scanDir(
  fs: VirtualFS,
  root: string,
  panels: Map<string, ShtmlPanel>,
): Promise<void> {
  for await (const filePath of fs.walk(root)) {
    if (!filePath.endsWith('.shtml')) continue;
    const name = panelName(filePath);
    if (!panels.has(name)) {
      let content: string;
      try {
        content = await fs.readFile(filePath, { encoding: 'utf-8' }) as string;
      } catch {
        content = '';
      }
      panels.set(name, {
        name,
        path: filePath,
        title: extractTitle(content, name),
      });
    }
  }
}

/** Extract panel name from a .shtml file path (basename minus extension). */
function panelName(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.endsWith('.shtml') ? base.slice(0, -6) : base;
}

/** Extract title from HTML content: <title>, data-shtml-title, or fallback to name. */
export function extractTitle(content: string, fallback: string): string {
  // Check data-shtml-title attribute
  const attrMatch = content.match(/data-shtml-title=["']([^"']+)["']/);
  if (attrMatch) return attrMatch[1];

  // Check <title> tag
  const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) return titleMatch[1].trim();

  return fallback;
}
