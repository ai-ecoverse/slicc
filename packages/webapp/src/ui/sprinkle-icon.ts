/**
 * Sprinkle icon resolver.
 *
 * Sprinkles can specify a rail icon via `<link rel="icon" href="...">`
 * or `data-sprinkle-icon="..."`. The raw spec captured by
 * `sprinkle-discovery.ts` is one of:
 *
 * - a Lucide icon name in kebab-case (e.g. `music`, `calendar-clock`)
 * - a VFS path to an SVG or PNG (e.g. `/workspace/skills/foo/icon.svg`)
 * - an inline SVG (`<svg ...>...</svg>`)
 * - a `data:image/...` URL
 *
 * `resolveSprinkleIconHtml(spec, fs)` returns SVG/HTML markup ready
 * to drop into `RailItem.icon`, or `null` if the spec is missing or
 * unresolvable. Callers fall back to their own default glyph.
 */

import { icons as lucideIcons } from 'lucide';
import type { VirtualFS } from '../fs/index.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('sprinkle-icon');

type LucideAttrs = Record<string, string | number | undefined>;
type LucideNode = [tag: string, attrs: LucideAttrs];
type IconRegistry = Record<string, LucideNode[]>;

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const SVG_CLOSE = '</svg>';

/** kebab-case → PascalCase: "calendar-clock" → "CalendarClock". */
function kebabToPascal(name: string): string {
  return name
    .split('-')
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('');
}

function escapeAttr(value: string | number): string {
  return String(value).replace(/"/g, '&quot;');
}

/** Render a lucide IconNode array to inline SVG markup. */
function renderLucideToSvg(nodes: LucideNode[]): string {
  const inner = nodes
    .map(([tag, attrs]) => {
      const parts = Object.entries(attrs)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}="${escapeAttr(v as string | number)}"`);
      return parts.length ? `<${tag} ${parts.join(' ')}/>` : `<${tag}/>`;
    })
    .join('');
  return `${SVG_OPEN}${inner}${SVG_CLOSE}`;
}

/** Look up a Lucide icon by kebab-case name. Returns the SVG HTML or null. */
export function lucideIconHtml(name: string): string | null {
  const key = kebabToPascal(name);
  const node = (lucideIcons as IconRegistry)[key];
  if (!node) return null;
  return renderLucideToSvg(node);
}

function isInlineSvg(spec: string): boolean {
  return /^\s*<svg\b/i.test(spec);
}

function isDataUrl(spec: string): boolean {
  return /^data:/i.test(spec);
}

function looksLikeVfsPath(spec: string): boolean {
  return spec.startsWith('/');
}

function isImagePath(spec: string): boolean {
  return /\.(svg|png|jpe?g|webp|gif|ico)$/i.test(spec);
}

function isLucideName(spec: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(spec);
}

/** Wrap a URL/data URL as a 16×16 `<img>` for the rail. */
function imgTag(src: string): string {
  return `<img src="${escapeAttr(src)}" width="16" height="16" alt="" style="display:block;width:16px;height:16px;object-fit:contain"/>`;
}

/**
 * Resolve a sprinkle icon spec to inline HTML the rail can render.
 * Returns `null` when the spec is missing or unresolvable so the
 * caller can fall back to its default glyph.
 */
export async function resolveSprinkleIconHtml(
  spec: string | undefined,
  fs: VirtualFS | null | undefined
): Promise<string | null> {
  if (!spec) return null;

  // 1. Inline SVG — return verbatim. Authors are responsible for
  //    producing a 16×16-friendly viewBox; we don't rewrite their
  //    markup here so they keep full control.
  if (isInlineSvg(spec)) return spec;

  // 2. data: URL — wrap as <img>.
  if (isDataUrl(spec)) return imgTag(spec);

  // 3. VFS path — read and inline (SVG) or wrap as data URL (raster).
  if (looksLikeVfsPath(spec) && fs) {
    try {
      if (isImagePath(spec) && spec.toLowerCase().endsWith('.svg')) {
        const raw = await fs.readFile(spec, { encoding: 'utf-8' });
        const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
        const svg = extractFirstSvg(text);
        return svg ?? null;
      }
      if (isImagePath(spec)) {
        const raw = await fs.readFile(spec, { encoding: 'binary' });
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(0);
        const mime = mimeForPath(spec);
        return imgTag(`data:${mime};base64,${bytesToBase64(bytes)}`);
      }
      // Path doesn't end with a known image extension — try as text SVG.
      const raw = await fs.readFile(spec, { encoding: 'utf-8' });
      const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
      const svg = extractFirstSvg(text);
      if (svg) return svg;
    } catch (err) {
      log.warn('Failed to read sprinkle icon from VFS', {
        path: spec,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  // 4. Lucide icon name.
  if (isLucideName(spec)) {
    const html = lucideIconHtml(spec);
    if (html) return html;
    log.warn('Unknown Lucide icon name', { spec });
  }

  return null;
}

/** Pull the first `<svg>...</svg>` block out of a text blob. */
function extractFirstSvg(text: string): string | null {
  const match = text.match(/<svg\b[\s\S]*?<\/svg>/i);
  return match ? match[0] : null;
}

function mimeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]
    );
  }
  if (typeof btoa !== 'undefined') return btoa(binary);
  // Node fallback (tests).
  return Buffer.from(binary, 'binary').toString('base64');
}
