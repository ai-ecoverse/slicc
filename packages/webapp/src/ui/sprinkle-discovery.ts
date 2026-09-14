import { SPRINKLE_ROOTS } from '../base/sprinkle-roots.js';
import { isFeatureEnabled } from '../core/feature-flags.js';
import { shouldSkipNoiseDir, walkBounded } from '../fs/bounded-walk.js';
import type { VirtualFS } from '../fs/index.js';

const PRIORITY_ROOTS = ['/shared/sprinkles'];

const MAX_SCAN_DEPTH = 6;

const MAX_SCAN_DIRS = 500;

const HIDDEN_SPRINKLES = new Set<string>(['connect-llm', 'welcome']);

function isHiddenSprinkle(name: string): boolean {
  if (HIDDEN_SPRINKLES.has(name)) return true;
  if (name === 'suggestions') return !isFeatureEnabled('memory-v2');
  return false;
}

export interface Sprinkle {
  name: string;

  path: string;

  title: string;

  autoOpen: boolean;

  icon?: string;
}

export async function discoverSprinkles(fs: VirtualFS): Promise<Map<string, Sprinkle>> {
  const sprinkles = new Map<string, Sprinkle>();

  for (const root of [...PRIORITY_ROOTS, ...SPRINKLE_ROOTS]) {
    if (await fs.exists(root)) {
      await scanDir(fs, root, sprinkles);
    }
  }

  return sprinkles;
}

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
    if (isHiddenSprinkle(name)) continue;
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

function sprinkleName(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.endsWith('.shtml') ? base.slice(0, -6) : base;
}

export function extractTitle(content: string, fallback: string): string {
  const attrMatch = content.match(/data-sprinkle-title=["']([^"']+)["']/);
  if (attrMatch) return attrMatch[1];

  const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) return titleMatch[1].trim();

  return fallback;
}

export function extractAutoOpen(content: string): boolean {
  return /data-sprinkle-autoopen\b/.test(content);
}

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

function findUnquotedTagEnd(s: string, from: number): number {
  let inDouble = false;
  let inSingle = false;
  for (let i = from; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (inDouble) {
      if (ch === 34) inDouble = false;
    } else if (inSingle) {
      if (ch === 39) inSingle = false;
    } else if (ch === 34) inDouble = true;
    else if (ch === 39) inSingle = true;
    else if (ch === 62) return i;
  }
  return -1;
}

function matchAttrValue(haystack: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = haystack.match(re);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? undefined;
}
