/**
 * Inline Sprinkles — hydrates ```shtml fenced code blocks in chat messages
 * into sandboxed srcdoc iframes with a minimal lick-only bridge.
 *
 * Cards are ephemeral (no state persistence, no readFile). Lick events
 * route to the cone via the onLick callback. Auto-height via ResizeObserver.
 */

import { collectThemeCSS } from './sprinkle-renderer.js';

/** Minimal bridge script: lick-only + auto-height reporting. */
const BRIDGE_SCRIPT = `(function() {
  window.slicc = window.bridge = {
    lick: function(event) {
      var action = typeof event === 'string' ? event : event.action;
      var data = typeof event === 'string' ? undefined : event.data;
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
})();`;

export interface InlineSprinkleInstance {
  dispose(): void;
}

/**
 * Mount an inline sprinkle iframe in the given container element.
 */
function mountInlineSprinkle(
  container: HTMLElement,
  content: string,
  onLick: (action: string, data: unknown) => void,
): InlineSprinkleInstance {
  const themeCSS = collectThemeCSS();

  const srcdoc = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>${themeCSS}</style>
<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}
body{font-family:var(--s2-font-family, sans-serif);font-size:13px;color:var(--s2-content-default)}</style>
<style>.sprinkle-inline{padding:var(--s2-spacing-200)}
.sprinkle-inline .sprinkle-btn{padding:4px 12px;font-size:12px;height:28px}
.sprinkle-inline .sprinkle-card{box-shadow:none;margin:0}</style>
<script>${BRIDGE_SCRIPT}</script>
</head>
<body class="sprinkle-inline">${content}</body></html>`;

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
    inst.dispose();
  }
  instances.length = 0;
}
