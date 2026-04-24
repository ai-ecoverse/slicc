/**
 * Lucide Icons Bundle
 *
 * This file is bundled separately for use in sprinkle iframes.
 * It provides a global `LucideIcons` object with icon rendering utilities.
 */

import { createIcons, icons } from 'lucide';

// Export all icons and the createIcons function globally for sprinkles
(window as any).LucideIcons = {
  createIcons,
  icons,

  /**
   * Render all icons in the current document.
   * Call this after DOM is ready or after dynamically adding icon elements.
   */
  render() {
    createIcons({ icons });
  },

  /**
   * Create a single icon element programmatically.
   * @param name - Icon name (e.g., 'check', 'alert-circle')
   * @param options - Options: size, color, strokeWidth, class, etc.
   * @returns SVG element
   */
  createElement(
    name: string,
    options: {
      size?: number | string;
      color?: string;
      strokeWidth?: number | string;
      class?: string;
    } = {}
  ) {
    const iconData = (icons as any)[this.toCamelCase(name)];
    if (!iconData) {
      console.warn(`Lucide icon not found: ${name}`);
      return document.createElement('div');
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', String(options.size || 24));
    svg.setAttribute('height', String(options.size || 24));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', options.color || 'currentColor');
    svg.setAttribute('stroke-width', String(options.strokeWidth || 2));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    if (options.class) {
      svg.setAttribute('class', options.class);
    }

    svg.innerHTML = iconData[0];
    return svg;
  },

  /**
   * Convert kebab-case to camelCase for icon lookup.
   * e.g., 'alert-circle' -> 'AlertCircle'
   */
  toCamelCase(str: string): string {
    return str
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  },
};

// Auto-render on DOMContentLoaded if icons are already in the DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    (window as any).LucideIcons.render();
  });
} else {
  (window as any).LucideIcons.render();
}

// Watch for dynamic content changes and auto-render new icons
const observer = new MutationObserver((mutations) => {
  let hasNewIcons = false;
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (el.hasAttribute?.('data-lucide') || el.querySelector?.('[data-lucide]')) {
          hasNewIcons = true;
          break;
        }
      }
    }
    if (hasNewIcons) break;
  }
  if (hasNewIcons) {
    (window as any).LucideIcons.render();
  }
});

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  });
}
