// dips module
/**
 * Dips — hydrates ```shtml fenced code blocks and ![](/path.shtml) image
 * references in chat messages
 * into sandboxed srcdoc iframes with a minimal lick-only bridge.
 *
 * Cards are ephemeral (no state persistence, no readFile). Lick events
 * route to the cone via the onLick callback. Auto-height via ResizeObserver.
 */

import { collectThemeCSS } from './sprinkle-renderer.js';
import { isThemeLight, registerSprinkleWindow, unregisterSprinkleWindow } from './theme.js';

const isExtension = typeof chrome !== 'undefined' && !!(chrome as any)?.runtime?.id;

/** Minimal bridge script: lick-only + auto-height reporting. */
const BRIDGE_SCRIPT = `(function() {
  window.slicc = window.bridge = {
    lick: function(event) {
      var action = typeof event === 'string' ? event : event.action;
      var data = typeof event === 'string' ? undefined : ('data' in event ? event.data : event);
      parent.postMessage({ type: 'dip-lick', action: action, data: data }, '*');
    }
  };
  function reportHeight() {
    parent.postMessage({ type: 'dip-height',
      height: document.documentElement.scrollHeight }, '*');
  }
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'slicc-theme') {
      document.documentElement.classList.toggle('theme-light', !!e.data.isLight);
    }
  });
  window.addEventListener('load', function() {
    reportHeight();
    new ResizeObserver(reportHeight).observe(document.body);
  });
  /* Support data-action attributes (Tool UI compat) — auto-lick on click.
     Also intercept <a href> clicks and relay to the parent so links open
     despite the iframe sandbox blocking top-level navigation. */
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.action) {
        var actionData = el.dataset.actionData;
        if (actionData) { try { actionData = JSON.parse(actionData); } catch(ex) {} }
        window.slicc.lick({ action: el.dataset.action, data: actionData || null });
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (el.tagName === 'A' && el.getAttribute('href')) {
        var href = el.getAttribute('href');
        /* Allow in-iframe anchor navigation (#foo). Skip javascript: for safety. */
        if (href.charAt(0) === '#') return;
        if (/^javascript:/i.test(href)) { e.preventDefault(); return; }
        /* Resolve relative URLs against the iframe's base. */
        var resolved;
        try { resolved = new URL(href, document.baseURI).href; } catch(ex) { resolved = href; }
        parent.postMessage({ type: 'dip-open-link', url: resolved }, '*');
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      el = el.parentElement;
    }
  });
})();`;

export interface DipInstance {
  dispose(): void;
}

/**
 * Mount an dip iframe in the given container element.
 * Exported for reuse by tool-ui-renderer (sprinkle chat).
 */
export function mountDip(
  container: HTMLElement,
  content: string,
  onLick: (action: string, data: unknown) => void
): DipInstance {
  const themeCSS = collectThemeCSS();
  const htmlClass = isThemeLight() ? ' class="theme-light"' : '';

  const srcdoc = `<!DOCTYPE html>
<html${htmlClass}><head>
<meta charset="utf-8">
<style>${themeCSS}</style>
<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;box-sizing:border-box}
*,*::before,*::after{box-sizing:inherit}
body{font-family:var(--s2-font-family, sans-serif);font-size:13px;color:var(--s2-content-default)}</style>
<style>.sprinkle-inline{padding:var(--s2-spacing-100) 0}
.sprinkle-inline .sprinkle-btn{padding:4px 12px;font-size:12px;height:28px;box-shadow:none}
.sprinkle-inline .sprinkle-btn:not([class*="sprinkle-btn--"]){background:var(--s2-bg-elevated)}
.sprinkle-inline .sprinkle-card{box-shadow:none;margin:0}
.sprinkle-inline .sprinkle-action-card{margin:0;width:100%}
.sprinkle-inline .sprinkle-action-card .sprinkle-table{width:100%}
.sprinkle-inline .sprinkle-grid{width:100%}
/* Pre-styled form elements for inline widgets */
input[type="range"]{width:100%;height:4px;-webkit-appearance:none;appearance:none;background:var(--s2-gray-300);border-radius:2px;outline:none;cursor:default}
input[type="range"]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:var(--s2-accent);cursor:default;border:2px solid var(--s2-bg-base)}
input[type="range"]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--s2-accent);cursor:default;border:2px solid var(--s2-bg-base)}
input[type="text"],input[type="number"],textarea{width:100%;padding:7px 12px;font-size:13px;font-family:var(--s2-font-family,sans-serif);color:var(--s2-content-default);background:var(--s2-bg-layer-2);border:1px solid var(--s2-border-subtle,var(--s2-gray-300));border-radius:8px;outline:none;box-sizing:border-box}
input[type="text"]:focus,input[type="number"]:focus,textarea:focus{border-color:var(--s2-accent);box-shadow:0 0 0 1px var(--s2-accent)}
input[type="text"]::placeholder,textarea::placeholder{color:var(--s2-content-disabled,var(--s2-gray-400))}
select{padding:6px 12px;font-size:13px;font-family:var(--s2-font-family,sans-serif);color:var(--s2-content-default);background:var(--s2-bg-layer-2);border:1px solid var(--s2-border-subtle,var(--s2-gray-300));border-radius:8px;outline:none;cursor:default}
select:focus{border-color:var(--s2-accent);box-shadow:0 0 0 1px var(--s2-accent)}
button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:4px 12px;border:1px solid var(--s2-border-default,var(--s2-gray-300));border-radius:9999px;background:transparent;color:var(--s2-content-default);font-size:12px;font-weight:700;font-family:var(--s2-font-family,sans-serif);cursor:default;transition:background 130ms ease}
button:hover{background:color-mix(in srgb,var(--s2-content-default) 6%,transparent)}
button:disabled{opacity:0.4;pointer-events:none}
canvas{display:block;width:100%;border-radius:8px}
mark{background:color-mix(in srgb,var(--s2-accent) 25%,transparent);color:inherit;border-radius:2px;padding:0 2px}
/* Categorical color palette for charts/diagrams */
.c-purple{background:#3C3489;color:#EEEDFE}.c-teal{background:#085041;color:#E1F5EE}
.c-coral{background:#712B13;color:#FAECE7}.c-pink{background:#72243E;color:#FBEAF0}
.c-gray{background:#444441;color:#F1EFE8}.c-blue{background:#0C447C;color:#E6F1FB}
.c-amber{background:#633806;color:#FAEEDA}.c-red{background:#791F1F;color:#FCEBEB}
.c-green{background:#27500A;color:#EAF3DE}
</style>
<script>${BRIDGE_SCRIPT}</script>
${
  // Custom element bundles are loaded via src in CLI mode (same-origin).
  // In extension mode, dips route through sprinkle-sandbox.html
  // which handles lazy-loading for fragment content. Full custom element
  // support in extension dips requires the full-doc inlining path.
  content.includes('<slicc-editor') ? '<script src="/slicc-editor.js"></script>' : ''
}
${content.includes('<slicc-diff') ? '<script src="/slicc-diff.js"></script>' : ''}
<script src="/lucide-icons.js"></script>
</head>
<body class="sprinkle-inline">${content}</body></html>`;

  if (isExtension) {
    return mountDipExtension(container, srcdoc, onLick);
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.style.cssText = 'width:100%;border:none;overflow:hidden;display:block;';
  iframe.srcdoc = srcdoc;
  container.appendChild(iframe);
  iframe.addEventListener('load', () => registerSprinkleWindow(iframe.contentWindow), {
    once: true,
  });

  const messageHandler = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data;
    if (!msg?.type) return;

    if (msg.type === 'dip-lick') {
      onLick(msg.action, msg.data);
    } else if (msg.type === 'dip-height') {
      iframe.style.height = msg.height + 'px';
    } else if (msg.type === 'dip-open-link') {
      openDipLink(msg.url);
    }
  };
  window.addEventListener('message', messageHandler);

  return {
    dispose() {
      window.removeEventListener('message', messageHandler);
      unregisterSprinkleWindow(iframe.contentWindow);
      iframe.remove();
    },
  };
}

/**
 * Open a link from a sandboxed dip in a new tab. Only http(s)
 * and mailto: URLs are allowed to avoid navigating the host page through
 * javascript:/data: schemes relayed from the iframe.
 */
function openDipLink(url: unknown): void {
  if (typeof url !== 'string' || !url) return;
  if (!/^(https?:|mailto:)/i.test(url)) return;
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    /* extension window.open may return null — fire and forget */
  }
}

/**
 * Find all `code.language-shtml` blocks in a container, replace them with
 * sandboxed dip iframes. Returns instances for lifecycle tracking.
 */
export function hydrateDips(
  containerEl: HTMLElement,
  onLick: (action: string, data: unknown) => void
): DipInstance[] {
  const codeEls = containerEl.querySelectorAll<HTMLElement>('pre > code.language-shtml');
  if (codeEls.length === 0) return [];

  const instances: DipInstance[] = [];

  for (const codeEl of codeEls) {
    const preEl = codeEl.parentElement!;
    const shtmlContent = codeEl.textContent ?? '';

    const wrapper = document.createElement('div');
    wrapper.className = 'msg__dip';
    preEl.replaceWith(wrapper);

    instances.push(mountDip(wrapper, shtmlContent, onLick));
  }


  //    ![alt](/path/to/file.shtml) image references                  
  const imgEls = containerEl.querySelectorAll<HTMLImageElement>('img[src$=".shtml"]');
  for (const imgEl of imgEls) {
    const src = imgEl.getAttribute('src');
    if (!src) continue;

    const wrapper = document.createElement('div');
    wrapper.className = 'msg__dip';
    if (imgEl.alt) wrapper.setAttribute('title', imgEl.alt);
    imgEl.replaceWith(wrapper);

    // Fetch the .shtml content from VFS via the preview service worker
    const fetchUrl = src.startsWith('/') ? `/preview${src}` : src;
    fetch(fetchUrl)
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.text();
      })
      .then((shtmlContent) => {
        instances.push(mountDip(wrapper, shtmlContent, onLick));
      })
      .catch((err) => {
        wrapper.textContent = `Failed to load dip: ${src}`;
        wrapper.style.cssText =
          'padding:8px;font-size:12px;color:var(--s2-negative);font-family:var(--s2-font-mono)';
      });
  }

  return instances;
}

/** Dispose all dip instances and clear the array. */
export function disposeDips(instances: DipInstance[]): void {
  for (const inst of instances) {
    try {
      inst.dispose();
    } catch {
      /* best-effort cleanup */
    }
  }
  instances.length = 0;
}

/**
 * Extension mode: route dip through the manifest sandbox (CSP-exempt).
 * The sandbox creates a nested srcdoc iframe and relays messages back.
 */
function mountDipExtension(
  container: HTMLElement,
  srcdoc: string,
  onLick: (action: string, data: unknown) => void
): DipInstance {
  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('sprinkle-sandbox.html');
  iframe.style.cssText = 'width:100%;border:none;overflow:hidden;display:block;';
  container.appendChild(iframe);

  const messageHandler = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data;
    if (!msg?.type) return;

    if (msg.type === 'dip-lick') {
      onLick(msg.action, msg.data);
    } else if (msg.type === 'dip-height') {
      iframe.style.height = msg.height + 'px';
    } else if (msg.type === 'dip-open-link') {
      openDipLink(msg.url);
    }
  };
  window.addEventListener('message', messageHandler);

  iframe.addEventListener(
    'load',
    () => {
      registerSprinkleWindow(iframe.contentWindow);
      iframe.contentWindow?.postMessage(
        { type: 'dip-render', srcdoc, isLight: isThemeLight() },
        '*'
      );
    },
    { once: true }
  );

  return {
    dispose() {
      window.removeEventListener('message', messageHandler);
      unregisterSprinkleWindow(iframe.contentWindow);
      iframe.remove();
    },
  };
}
