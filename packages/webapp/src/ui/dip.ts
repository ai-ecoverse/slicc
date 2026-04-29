// dips module
/**
 * Dips — hydrates ```shtml fenced code blocks and ![](/path.shtml) image
 * references in chat messages
 * into sandboxed srcdoc iframes with a minimal lick-only bridge.
 *
 * Cards are ephemeral (no state persistence, no readFile). Lick events
 * route to the cone via the onLick callback. Auto-height via ResizeObserver.
 */

import FS from '@isomorphic-git/lightning-fs';
import { collectThemeCSS } from './sprinkle-renderer.js';
import { isThemeLight, registerSprinkleWindow, unregisterSprinkleWindow } from './theme.js';

const isExtension = typeof chrome !== 'undefined' && !!(chrome as any)?.runtime?.id;

/**
 * Fallback VFS reader for `.shtml` dips. The preview service worker is
 * the canonical way to fetch VFS content (it normalizes mounts, MIME
 * types, etc.), but on the very first install of a page the SW may not
 * be controlling yet — `clients.claim()` happens asynchronously, so
 * `/preview/*` requests fall through to the dev server and 404. This
 * direct reader bypasses the network entirely and reads the same
 * LightningFS database the SW uses, so dips render correctly even on
 * the first uncontrolled boot.
 */
let lfsReader: FS.PromisifiedFS | null = null;
function getLfsReader(): FS.PromisifiedFS {
  if (!lfsReader) lfsReader = new FS('slicc-fs').promises;
  return lfsReader;
}

async function readShtmlFromVFS(vfsPath: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  const lfs = getLfsReader();
  const raw = await lfs.readFile(vfsPath, 'utf8');
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
}

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
    if (!e.data || typeof e.data.type !== 'string') return;
    if (e.data.type === 'slicc-theme') {
      document.documentElement.classList.toggle('theme-light', !!e.data.isLight);
      return;
    }
    /* Forward any other slicc-* message to in-page listeners via a
       CustomEvent. Dips can opt in with
       window.addEventListener('slicc-message', (ev) => ev.detail). */
    if (e.data.type.indexOf('slicc-') === 0) {
      try {
        document.dispatchEvent(new CustomEvent('slicc-message', { detail: e.data }));
      } catch (ex) {}
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
 * Live dip iframes. Used by `broadcastToDips` so the host UI can post
 * a message to every mounted dip — handy for cases where a workflow
 * spans multiple turns (e.g. the onboarding `connect-llm` dip needs
 * to learn whether the parent's API-key probe succeeded).
 */
const liveDipWindows = new Set<Window>();

/**
 * Post a `slicc-*` payload to every live dip iframe. Dips listen for
 * matching `slicc-message` CustomEvents on `document` (see
 * `BRIDGE_SCRIPT`). Closed/detached iframes are ignored automatically
 * because they're removed from the registry on dispose().
 */
export function broadcastToDips(payload: { type: string; [k: string]: unknown }): void {
  if (typeof payload?.type !== 'string' || payload.type.indexOf('slicc-') !== 0) {
    throw new Error("broadcastToDips: payload.type must start with 'slicc-'");
  }
  for (const win of liveDipWindows) {
    try {
      win.postMessage(payload, '*');
    } catch {
      /* Closed iframes throw — ignore. */
    }
  }
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
/* Vertical breathing room around dip content. Horizontal padding is owned
   by the dip's own content (e.g. .sprinkle-action-card__body) so shtml
   widgets that already pad themselves don't end up double-indented. The
   ResizeObserver on document.body reports the post-padding scrollHeight
   correctly, so auto-height continues to work. */
body{padding:12px 0;font-family:var(--s2-font-family, sans-serif);font-size:13px;color:var(--s2-content-default)}</style>
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
  // Register the contentWindow synchronously so dips that emit a
  // `connect-ready`-style lick during their initial inline script can
  // still receive the parent's response. The `load` event fires AFTER
  // the script has run, so waiting for it loses the first round-trip.
  if (iframe.contentWindow) {
    registerSprinkleWindow(iframe.contentWindow);
    liveDipWindows.add(iframe.contentWindow);
  }
  iframe.addEventListener(
    'load',
    () => {
      // Re-register defensively — some browsers swap contentWindow on
      // the first `load` event for srcdoc iframes.
      registerSprinkleWindow(iframe.contentWindow);
      if (iframe.contentWindow) liveDipWindows.add(iframe.contentWindow);
    },
    {
      once: true,
    }
  );

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
      if (iframe.contentWindow) liveDipWindows.delete(iframe.contentWindow);
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
 * Find all `code.language-shtml` blocks and `img[src$=".shtml"]` elements in
 * a container, replace them with sandboxed dip iframes. Image references are
 * loaded asynchronously via the VFS preview path. Returns instances for
 * lifecycle tracking — image-path entries are placeholders whose `dispose()`
 * aborts the in-flight fetch and tears down whatever iframe (if any) was
 * eventually mounted, so callers can rely on disposal even when hydration is
 * still in flight.
 */
export function hydrateDips(
  containerEl: HTMLElement,
  onLick: (action: string, data: unknown) => void
): DipInstance[] {
  const instances: DipInstance[] = [];

  //    Fenced ```shtml code blocks
  const codeEls = containerEl.querySelectorAll<HTMLElement>('pre > code.language-shtml');
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

    // Each pending image becomes a placeholder DipInstance immediately so
    // the caller's lifecycle bookkeeping (chat-panel's per-message map) sees
    // a non-empty array even before the async fetch resolves. The placeholder
    // owns an AbortController + a flag so dispose() cancels the fetch and
    // tears down whatever iframe (if any) was eventually mounted.
    const controller = new AbortController();
    let mounted: DipInstance | null = null;
    let disposed = false;
    const placeholder: DipInstance = {
      dispose() {
        disposed = true;
        controller.abort();
        if (mounted) {
          mounted.dispose();
          mounted = null;
        }
      },
    };
    instances.push(placeholder);

    // Resolve the .shtml content. Prefer the preview service worker
    // (handles mounts, MIME types, project-serve mode, etc.), but fall
    // back to a direct LightningFS read for VFS-rooted paths so dips
    // still render on the very first boot before the SW claims the
    // page. Only paths starting with `/` are read directly; relative
    // / cross-origin URLs always go through the network.
    const isVfsPath = src.startsWith('/');
    const swControlled = typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;
    const fetchUrl = isVfsPath ? `/preview${src}` : src;

    const resolveContent = async (): Promise<string> => {
      if (isVfsPath && !swControlled) {
        // SW isn't controlling — go straight to LightningFS.
        return readShtmlFromVFS(src, controller.signal);
      }
      const resp = await fetch(fetchUrl, { signal: controller.signal });
      if (resp.ok) return resp.text();
      // Some dev-server responses bypass the SW even when it claims to
      // be controlling (e.g. extension boot, stale registration).
      // Retry once via direct LightningFS for VFS paths before failing.
      if (isVfsPath) return readShtmlFromVFS(src, controller.signal);
      throw new Error(`HTTP ${resp.status}`);
    };

    resolveContent()
      .then((shtmlContent) => {
        // Skip mounting if dispose() ran while the fetch was in flight, or
        // if the wrapper was detached from the DOM by some other path.
        if (disposed || !wrapper.isConnected) return;
        mounted = mountDip(wrapper, shtmlContent, onLick);
      })
      .catch((err) => {
        if (disposed || (err as { name?: string })?.name === 'AbortError') return;
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
      if (iframe.contentWindow) liveDipWindows.add(iframe.contentWindow);
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
      if (iframe.contentWindow) liveDipWindows.delete(iframe.contentWindow);
      iframe.remove();
    },
  };
}
