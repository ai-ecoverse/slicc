/**
 * Sprinkle Discovery — scan the VFS for `.shtml` sprinkle files and
 * build a map of sprinkle names (basename without extension) to metadata.
 *
 * Discovery is **bounded** (issue #2717). It used to walk `/`, which on
 * the page side is one worker RPC per directory and, under a `--mount`ed
 * host folder, one `/api/hostfs/list` request each — a boot-time crawl
 * that descended into `node_modules/…/.build/…` and competed with the
 * cone's own commands for the browser's 6-connection pool. Instead we
 * scan an explicit root set, to a depth cap, never entering build or
 * dot-directories. `/mnt`, `/proc` and `/tmp` are not roots, so a mount
 * is only ever crawled when it sits inside one of the roots below.
 */

import { SPRINKLE_ROOTS } from '../base/sprinkle-roots.js';
import { shouldSkipNoiseDir, walkBounded } from '../fs/bounded-walk.js';
import type { VirtualFS } from '../fs/index.js';

/**
 * Scanned before `SPRINKLE_ROOTS` so the documented home of a sprinkle
 * (`/shared/sprinkles/<name>/<name>.shtml`) wins a basename collision
 * with a stray `.shtml` elsewhere.
 */
const PRIORITY_ROOTS = ['/shared/sprinkles'];

/**
 * Deepest entry — file or directory — a scan may reach below a root,
 * counting the root's own children as depth 1.
 * `/shared/sprinkles/<name>/<name>.shtml` is depth 3 below `/shared`;
 * `/workspace/skills/<skill>/<sub>/<file>.shtml` is 4. Six leaves room
 * without letting a mounted checkout pull the crawl down to depth 11.
 */
const MAX_SCAN_DEPTH = 6;

/**
 * Per-root ceiling on directories read. Real sprinkle roots are far
 * below this; it exists so a mount grafted into a root can't fan the
 * boot crawl out without limit.
 */
const MAX_SCAN_DIRS = 500;

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
   * Raw icon spec from the .shtml. Can be:
   * - a Lucide icon name (kebab-case, e.g. `"music"`, `"calendar-clock"`)
   * - a VFS path to an SVG/PNG (e.g. `/workspace/skills/foo/icon.svg`)
   * - an inline `<svg>...</svg>` markup
   * - a `data:image/svg+xml;...` URL
   * Sourced from `<link rel="icon" href="...">` (preferred) or
   * `data-sprinkle-icon="..."` on any element. Consumers are
   * responsible for resolving the spec into renderable markup.
   */
  icon?: string;
}

/**
 * Discover `.shtml` files under the supported roots and return a map of
 * sprinkle name → Sprinkle. First occurrence of a basename wins, so
 * `PRIORITY_ROOTS` are scanned before the rest of `SPRINKLE_ROOTS`.
 */
export async function discoverSprinkles(fs: VirtualFS): Promise<Map<string, Sprinkle>> {
  const sprinkles = new Map<string, Sprinkle>();

  for (const root of [...PRIORITY_ROOTS, ...SPRINKLE_ROOTS]) {
    if (await fs.exists(root)) {
      await scanDir(fs, root, sprinkles);
    }
  }

  return sprinkles;
}

/**
 * Walk one root and collect `.shtml` files into the map (first wins).
 * Bounded by {@link MAX_SCAN_DEPTH}, {@link MAX_SCAN_DIRS} and
 * {@link shouldSkipNoiseDir} — see the module header for why.
 */
async function scanDir(
  fs: VirtualFS,
  root: string,
  sprinkles: Map<string, Sprinkle>
): Promise<void> {
  const walk = walkBounded(fs, root, {
    maxDepth: MAX_SCAN_DEPTH,
    maxDirs: MAX_SCAN_DIRS,
    skip: shouldSkipNoiseDir,
  });
  for await (const filePath of walk) {
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
 * Returns the raw spec as authored — consumers decide whether
 * it's a Lucide name, a VFS path, an inline SVG, or a data URL.
 *
 * The parser is intentionally quote-aware: a `data:image/svg+xml;...`
 * href can legitimately contain both `"` and `>` characters from
 * inline SVG markup, so we walk the tag manually rather than rely
 * on a `[^>]*` regex that bails at the first `>` inside an
 * attribute value.
 */
export function extractIcon(content: string): string | undefined {
  const tagRe = /<link\b/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(content)) !== null) {
    const attrsStart = m.index + m[0].length;
    const tagEnd = findUnquotedTagEnd(content, attrsStart);
    if (tagEnd < 0) continue;
    const attrs = content.slice(attrsStart, tagEnd);
    if (!/\brel\s*=\s*("|')\s*(?:shortcut\s+)?icon\s*\1/i.test(attrs)) continue;
    const href = matchAttrValue(attrs, 'href');
    if (href !== undefined) return href.trim();
  }
  const dataAttr = matchAttrValue(content, 'data-sprinkle-icon');
  if (dataAttr !== undefined) return dataAttr.trim();
  return undefined;
}

/**
 * Find the index of the closing `>` for a tag whose attributes
 * start at `from`, skipping `>` characters that occur inside
 * quoted attribute values.
 */
function findUnquotedTagEnd(s: string, from: number): number {
  let inDouble = false;
  let inSingle = false;
  for (let i = from; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (inDouble) {
      if (ch === 34 /* " */) inDouble = false;
    } else if (inSingle) {
      if (ch === 39 /* ' */) inSingle = false;
    } else if (ch === 34) inDouble = true;
    else if (ch === 39) inSingle = true;
    else if (ch === 62 /* > */) return i;
  }
  return -1;
}

/**
 * Match `name="value"` or `name='value'` and return the captured
 * value. Inner quotes of the opposite kind are preserved verbatim,
 * so e.g. a single-quoted href can carry an inline-SVG payload that
 * uses double quotes for its own attributes.
 */
function matchAttrValue(haystack: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = haystack.match(re);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? undefined;
}
