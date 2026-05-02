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
 *
 * Security: only Lucide-registry SVGs (which we ship and trust) are
 * inlined as raw markup. Author-supplied SVG (inline spec or VFS
 * file) is rendered through an `<img src="data:image/svg+xml;base64,...">`
 * tag so it lands in the browser's script-disabled SVG context and
 * cannot escape the rail back into the parent UI.
 */

import type { VirtualFS } from '../fs/index.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('sprinkle-icon');

type LucideAttrs = Record<string, string | number | undefined>;
type LucideNode = [tag: string, attrs: LucideAttrs];
type IconRegistry = Record<string, LucideNode[]>;

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const SVG_CLOSE = '</svg>';

/**
 * Lazy-load the Lucide icon registry. Lucide ships ~1500 SVG glyphs
 * and pulling the whole `icons` map at module-eval time would bloat
 * the main UI bundle even for sprinkles that use a VFS file or no
 * icon at all. We import on first lookup and cache the promise.
 */
let lucideRegistryPromise: Promise<IconRegistry> | null = null;
function loadLucideRegistry(): Promise<IconRegistry> {
  if (!lucideRegistryPromise) {
    lucideRegistryPromise = import('lucide').then((mod) => mod.icons as unknown as IconRegistry);
  }
  return lucideRegistryPromise;
}

/** kebab-case → PascalCase: "calendar-clock" → "CalendarClock". */
function kebabToPascal(name: string): string {
  return name
    .split('-')
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('');
}

/**
 * Escape a value for safe insertion inside an HTML attribute.
 * Escapes the full set of attribute-breaking characters — escaping
 * only `"` lets entity-encoded payloads (e.g. `&quot;`) close the
 * attribute and inject new ones such as `onerror=`.
 */
function escapeAttr(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

/**
 * Look up a Lucide icon by kebab-case name. Returns the SVG HTML or
 * null. Async because it lazy-loads the Lucide registry on first
 * use to keep the main bundle slim.
 */
export async function lucideIconHtml(name: string): Promise<string | null> {
  const key = kebabToPascal(name);
  const icons = await loadLucideRegistry();
  const node = icons[key];
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
 *
 * Author-supplied SVG (inline spec, VFS file) is wrapped as
 * `<img src="data:image/svg+xml;base64,...">` so it renders in the
 * browser's script-disabled SVG context. Lucide-registry SVGs are
 * inlined verbatim because we own the registry and inline rendering
 * lets `stroke="currentColor"` inherit the rail's foreground color.
 */
export async function resolveSprinkleIconHtml(
  spec: string | undefined,
  fs: VirtualFS | null | undefined
): Promise<string | null> {
  if (!spec) return null;

  // 1. Inline SVG — wrap as a data URL <img>. Direct innerHTML of
  //    author-supplied SVG would let `<svg onload=…>`, embedded
  //    `<script>`, or `<foreignObject>` execute in the parent UI
  //    context.
  if (isInlineSvg(spec)) return imgTag(svgToDataUrl(spec));

  // 2. data: URL — wrap as <img>. Same script-disabled rendering.
  if (isDataUrl(spec)) return imgTag(spec);

  // 3. VFS path — read and wrap as a data URL <img>.
  if (looksLikeVfsPath(spec) && fs) {
    try {
      if (isImagePath(spec) && spec.toLowerCase().endsWith('.svg')) {
        const raw = await fs.readFile(spec, { encoding: 'utf-8' });
        const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
        const svg = extractFirstSvg(text);
        return svg ? imgTag(svgToDataUrl(svg)) : null;
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
      if (svg) return imgTag(svgToDataUrl(svg));
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
    const html = await lucideIconHtml(spec);
    if (html) return html;
    log.warn('Unknown Lucide icon name', { spec });
  }

  return null;
}

function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  return `data:image/svg+xml;base64,${bytesToBase64(bytes)}`;
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
