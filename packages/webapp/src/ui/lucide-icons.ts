






import { createIcons, icons } from 'lucide';


(window as any).LucideIcons = {
  createIcons,
  icons,

  



  render() {
    createIcons({ icons });
  },

  





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

  



  toCamelCase(str: string): string {
    return str
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  },
};


if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    (window as any).LucideIcons.render();
  });
} else {
  (window as any).LucideIcons.render();
}


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

try {
  observer.observe(document.body, { childList: true, subtree: true });
} catch {
  
  
  
  
  
}
