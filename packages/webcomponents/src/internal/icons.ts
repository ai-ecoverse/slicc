import { icons } from 'lucide';
import { escapeHtml } from './html.js';

export interface IconOptions {
  size?: number;

  strokeWidth?: number;

  class?: string;

  part?: string;
}

type LucideChild = [string, Record<string, string | number>];

function toPascal(name: string): string {
  return name
    .replace(/[-_ ]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

function serializeAttrs(attrs: Record<string, string | number>): string {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeHtml(String(v))}"`)
    .join(' ');
}

const REGISTRY = icons as unknown as Record<string, LucideChild[]>;

export function hasIcon(name: string): boolean {
  return toPascal(name) in REGISTRY;
}

export function iconSvg(name: string, opts: IconOptions = {}): string {
  const size = opts.size ?? 16;
  const strokeWidth = opts.strokeWidth ?? 2;
  const cls = opts.class ? ` class="${escapeHtml(opts.class)}"` : '';
  const part = opts.part ? ` part="${escapeHtml(opts.part)}"` : '';
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

const SVG_NS = 'http://www.w3.org/2000/svg';

export function iconEl(name: string, opts: IconOptions = {}): SVGSVGElement {
  const size = opts.size ?? 16;
  const svg = document.createElementNS(SVG_NS, 'svg');
  const set = (k: string, v: string | number) => svg.setAttribute(k, String(v));
  set('xmlns', SVG_NS);
  set('width', size);
  set('height', size);
  set('viewBox', '0 0 24 24');
  set('fill', 'none');
  set('stroke', 'currentColor');
  set('stroke-width', opts.strokeWidth ?? 2);
  set('stroke-linecap', 'round');
  set('stroke-linejoin', 'round');
  set('aria-hidden', 'true');
  if (opts.class) set('class', opts.class);
  if (opts.part) set('part', opts.part);
  const node = REGISTRY[toPascal(name)];
  if (!node) {
    console.warn(`[slicc-webcomponents] unknown lucide icon: ${name}`);
    return svg;
  }
  for (const [tag, attrs] of node) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, String(v));
    svg.appendChild(child);
  }
  return svg;
}
