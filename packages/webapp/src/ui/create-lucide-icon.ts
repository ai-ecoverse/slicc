/**
 * Build an SVG element from a lucide icon node. lucide ships each icon as a
 * `[tag, attrs][]` array; this renders it into a styled `<svg>` that inherits
 * `currentColor`. Shared by the composer and the add-menu so the SVG-builder
 * isn't duplicated.
 */

export type IconNode = [tag: string, attrs: Record<string, string | number>][];

export function createLucideIcon(node: IconNode, size = 18): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const [tag, attrs] of node) {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) {
      child.setAttribute(key, String(value));
    }
    svg.appendChild(child);
  }
  return svg;
}
