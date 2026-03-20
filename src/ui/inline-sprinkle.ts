/**
 * Inline Sprinkles — hydrates ```shtml fenced code blocks in chat messages
 * into sandboxed srcdoc iframes with a minimal lick-only bridge.
 *
 * Cards are ephemeral (no state persistence, no readFile). Lick events
 * route to the cone via the onLick callback. Auto-height via ResizeObserver.
 */

import { collectThemeCSS } from './sprinkle-renderer.js';

const isExtension = typeof chrome !== 'undefined' && !!(chrome as any)?.runtime?.id;

/** Minimal bridge script: lick-only + auto-height reporting. */
const BRIDGE_SCRIPT = `(function() {
  window.slicc = window.bridge = {
    lick: function(event) {
      var action = typeof event === 'string' ? event : event.action;
      var data = typeof event === 'string' ? undefined : ('data' in event ? event.data : event);
      parent.postMessage({ type: 'inline-sprinkle-lick', action: action, data: data }, '*');
    }
  };
  function reportHeight() {
    parent.postMessage({ type: 'inline-sprinkle-height',
      height: document.documentElement.scrollHeight }, '*');
  }
  window.addEventListener('load', function() {
    reportHeight();
    new ResizeObserver(reportHeight).observe(document.body);
  });
  /* Support data-action attributes (Tool UI compat) — auto-lick on click */
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
      el = el.parentElement;
    }
  });
})();`;

export interface InlineSprinkleInstance {
  dispose(): void;
}

/**
 * Mount an inline sprinkle iframe in the given container element.
 * Exported for reuse by tool-ui-renderer (sprinkle chat).
 */
export function mountInlineSprinkle(
  container: HTMLElement,
  content: string,
  onLick: (action: string, data: unknown) => void,
): InlineSprinkleInstance {
  const themeCSS = collectThemeCSS();

  const srcdoc = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>${themeCSS}</style>
<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;box-sizing:border-box}
*,*::before,*::after{box-sizing:inherit}
body{font-family:var(--s2-font-family, sans-serif);font-size:13px;color:var(--s2-content-default)}</style>
<style>.sprinkle-inline{padding:var(--s2-spacing-100) 0}
.sprinkle-inline .sprinkle-btn{padding:4px 12px;font-size:12px;height:28px}
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
</head>
<body class="sprinkle-inline">${content}</body></html>`;

  if (isExtension) {
    return mountInlineSprinkleExtension(container, srcdoc, onLick);
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.cssText = 'width:100%;border:none;overflow:hidden;display:block;';
  iframe.srcdoc = srcdoc;
  container.appendChild(iframe);

  const messageHandler = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data;
    if (!msg?.type) return;

    if (msg.type === 'inline-sprinkle-lick') {
      onLick(msg.action, msg.data);
    } else if (msg.type === 'inline-sprinkle-height') {
      iframe.style.height = msg.height + 'px';
    }
  };
  window.addEventListener('message', messageHandler);

  return {
    dispose() {
      window.removeEventListener('message', messageHandler);
      iframe.remove();
    },
  };
}

/**
 * Find all `code.language-shtml` blocks in a container, replace them with
 * sandboxed inline sprinkle iframes. Returns instances for lifecycle tracking.
 */
export function hydrateInlineSprinkles(
  containerEl: HTMLElement,
  onLick: (action: string, data: unknown) => void,
): InlineSprinkleInstance[] {
  const codeEls = containerEl.querySelectorAll<HTMLElement>('pre > code.language-shtml');
  if (codeEls.length === 0) return [];

  const instances: InlineSprinkleInstance[] = [];

  for (const codeEl of codeEls) {
    const preEl = codeEl.parentElement!;
    const shtmlContent = codeEl.textContent ?? '';

    const wrapper = document.createElement('div');
    wrapper.className = 'msg__inline-sprinkle';
    preEl.replaceWith(wrapper);

    instances.push(mountInlineSprinkle(wrapper, shtmlContent, onLick));
  }

  return instances;
}

/** Dispose all inline sprinkle instances and clear the array. */
export function disposeInlineSprinkles(instances: InlineSprinkleInstance[]): void {
  for (const inst of instances) {
    try { inst.dispose(); } catch { /* best-effort cleanup */ }
  }
  instances.length = 0;
}

/**
 * Extension mode: route inline sprinkle through the manifest sandbox (CSP-exempt).
 * The sandbox creates a nested srcdoc iframe and relays messages back.
 */
function mountInlineSprinkleExtension(
  container: HTMLElement,
  srcdoc: string,
  onLick: (action: string, data: unknown) => void,
): InlineSprinkleInstance {
  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('sprinkle-sandbox.html');
  iframe.style.cssText = 'width:100%;border:none;overflow:hidden;display:block;';
  container.appendChild(iframe);

  const messageHandler = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data;
    if (!msg?.type) return;

    if (msg.type === 'inline-sprinkle-lick') {
      onLick(msg.action, msg.data);
    } else if (msg.type === 'inline-sprinkle-height') {
      iframe.style.height = msg.height + 'px';
    }
  };
  window.addEventListener('message', messageHandler);

  iframe.addEventListener('load', () => {
    iframe.contentWindow?.postMessage(
      { type: 'inline-sprinkle-render', srcdoc }, '*',
    );
  }, { once: true });

  return {
    dispose() {
      window.removeEventListener('message', messageHandler);
      iframe.remove();
    },
  };
}
