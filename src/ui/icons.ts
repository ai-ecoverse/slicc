/**
 * Centralized SVG icon map — Spectrum 2 style icons.
 * All icons use a 20×20 viewBox with 1.5px stroke.
 */

export const ICONS = {
  // Header
  menu: ['M3 5h14', 'M3 10h14', 'M3 15h14'],
  helpCircle: ['M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M7.5 7.5a2.5 2.5 0 0 1 4.6 1.3c0 1.7-2.5 2.3-2.5 2.3', 'M10 14.5h.01'],
  bell: ['M15 7a5 5 0 0 0-10 0c0 5-2 7-2 7h14s-2-2-2-7', 'M8.5 17a1.5 1.5 0 0 0 3 0'],
  grid3x3: ['M3 3h4v4H3z', 'M10 3h4v4h-4z', 'M3 10h4v4H3z', 'M10 10h4v4h-4z', 'M3 17h4', 'M10 17h4'],
  chevronDown: ['M5 7l5 5 5-5'],

  // Scoops
  plusCircle: ['M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M10 6v8', 'M6 10h8'],

  // Chat
  sendArrow: ['M4 10h12', 'M12 5l5 5-5 5'],
  plus: ['M10 4v12', 'M4 10h12'],
  sparkle: ['M10 2l1.5 4.5L16 8l-4.5 1.5L10 14l-1.5-4.5L4 8l4.5-1.5L10 2z'],

  // Tabs
  closeX: ['M5 5l10 10', 'M15 5L5 15'],
  terminal: ['M3 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M6 10l2-2', 'M6 10l2 2', 'M11 12h3'],
  folder: ['M2 5a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z'],
  brain: ['M10 18V8', 'M6 8a4 4 0 0 1 8 0', 'M4 12a6 6 0 0 0 12 0', 'M7 5a3 3 0 0 1 6 0'],

  // Actions
  trash: ['M4 6h12', 'M8 6V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2', 'M6 6v10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6'],
  copy: ['M7 7h9v9H7z', 'M13 7V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2'],
  gear: ['M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M17.4 10a7.46 7.46 0 0 0-.1-1.3l1.5-1.2-1.5-2.6-1.8.7a7.13 7.13 0 0 0-1.9-1.1L13.2 3h-3l-.4 1.5a7.13 7.13 0 0 0-1.9 1.1l-1.8-.7-1.5 2.6 1.5 1.2a7.46 7.46 0 0 0 0 2.6l-1.5 1.2 1.5 2.6 1.8-.7c.6.5 1.2.8 1.9 1.1l.4 1.5h3l.4-1.5c.7-.3 1.3-.6 1.9-1.1l1.8.7 1.5-2.6-1.5-1.2a7.46 7.46 0 0 0 .1-1.3z'],
  expand: ['M4 14l4 4h-4v-4', 'M16 6l-4-4h4v4'],
  collapse: ['M8 18l-4-4h4v4', 'M12 2l4 4h-4V2'],
  chevronRight: ['M7 5l5 5-5 5'],

  // Feedback
  thumbsUp: ['M6 10V17', 'M6 10L8 3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v4h4.5a1.5 1.5 0 0 1 1.45 1.88l-1.5 6A1.5 1.5 0 0 1 14 15.5H6'],
  thumbsDown: ['M6 10V3', 'M6 10l2 7a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-4h4.5a1.5 1.5 0 0 0 1.45-1.88l-1.5-6A1.5 1.5 0 0 0 14 4.5H6'],
  refresh: ['M4 10a6 6 0 0 1 10.3-4.2', 'M16 10a6 6 0 0 1-10.3 4.2', 'M14 2v4h-4', 'M6 18v-4h4'],
  star: ['M10 2l2.4 4.8 5.3.8-3.8 3.7.9 5.3L10 14l-4.8 2.5.9-5.3L2.3 7.5l5.3-.8L10 2z'],
  share: ['M15 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M5 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M15 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M7.5 11.5l5-3', 'M7.5 8.5l5 3'],
} as const;

export type IconName = keyof typeof ICONS;

/** Create an SVG element from an icon name. */
export function createIcon(name: IconName, size = 16): SVGSVGElement {
  const paths = ICONS[name];
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}
