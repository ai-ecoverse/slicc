import { icons } from 'lucide';

/**
 * Shared icon helper — every SLICC component renders icons from the `lucide`
 * library (the same set the webapp uses, `packages/webapp/src/ui/lucide-icons.ts`),
 * NOT emoji or bespoke glyphs. Call `iconSvg('arrow-up')` and interpolate the
 * returned `<svg>` string into the component's markup.
 *
 * Icons inherit color via `stroke: currentColor`, so set `color` on the host /
 * a wrapper to tint them; size and stroke width are options.
 */
export interface IconOptions {
  /** Square pixel size (default 16). */
  size?: number;
  /** Stroke width (default 2 — lucide's default). */
  strokeWidth?: number;
  /** Extra class on the `<svg>`. */
  class?: string;
  /** `part` attribute on the `<svg>` (so hosts can style it via ::part). */
  part?: string;
}

/** One lucide child element: `[tagName, attributes]`. */
type LucideChild = [string, Record<string, string | number>];

/** `arrow-up` / `arrowUp` → `ArrowUp` (lucide's PascalCase registry key). */
function toPascal(name: string): string {
  return name
    .replace(/[-_ ]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

function serializeAttrs(attrs: Record<string, string | number>): string {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
    .join(' ');
}

const REGISTRY = icons as unknown as Record<string, LucideChild[]>;

/** Whether a lucide icon exists for `name` (kebab/camel/Pascal accepted). */
export function hasIcon(name: string): boolean {
  return toPascal(name) in REGISTRY;
}

/**
 * Render a lucide icon as an `<svg>` string. Unknown names yield an empty,
 * correctly-sized `<svg>` (and warn in dev) so layout never breaks.
 */
export function iconSvg(name: string, opts: IconOptions = {}): string {
  const size = opts.size ?? 16;
  const strokeWidth = opts.strokeWidth ?? 2;
  const cls = opts.class ? ` class="${opts.class}"` : '';
  const part = opts.part ? ` part="${opts.part}"` : '';
  const node = REGISTRY[toPascal(name)];
  if (!node) {
    console.warn(`[slicc-webcomponents] unknown lucide icon: ${name}`);
    return `<svg width="${size}" height="${size}"${cls}${part} aria-hidden="true"></svg>`;
  }
  const children = node.map(([tag, attrs]) => `<${tag} ${serializeAttrs(attrs)} />`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" ` +
    `stroke-linecap="round" stroke-linejoin="round"${cls}${part} aria-hidden="true">${children}</svg>`
  );
}
