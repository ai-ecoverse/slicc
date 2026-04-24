/**
 * Sprinkle Renderer — loads `.shtml` content from VFS and renders
 * it into a container div. Handles script extraction and re-execution.
 *
 * In extension mode, CSP blocks inline scripts and event handlers.
 * The sprinkle renders inside a sandbox iframe (sprinkle-sandbox.html)
 * which is CSP-exempt. Bridge communication uses postMessage.
 */

import type { SprinkleBridgeAPI } from './sprinkle-bridge.js';
import { isThemeLight, registerSprinkleWindow, unregisterSprinkleWindow } from './theme.js';

declare global {
  interface Window {
    __slicc_sprinkles?: Record<string, SprinkleBridgeAPI>;
  }
}

const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

const EXTERNAL_SCRIPT_RE =
  /<script\b([^>]*)\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']([^>]*)><\/script>/gi;

export async function inlineExternalScripts(html: string): Promise<string> {
  const matches: { full: string; url: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = EXTERNAL_SCRIPT_RE.exec(html)) !== null) {
    matches.push({ full: match[0], url: match[2], index: match.index });
  }
  EXTERNAL_SCRIPT_RE.lastIndex = 0;
  if (matches.length === 0) return html;

  const fetched = await Promise.all(
    matches.map(async (m) => {
      try {
        const resp = await fetch(m.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return { ...m, text: await resp.text() };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...m, text: `console.error('[sprinkle] Failed to load ${m.url}: ${msg}')` };
      }
    })
  );

  let result = html;
  for (let i = fetched.length - 1; i >= 0; i--) {
    const { full, text } = fetched[i];
    const escaped = text.replace(/<\/script/gi, '<\\/script');
    result = result.replace(full, `<script>${escaped}</script>`);
  }

  return result;
}

/** Detect whether content is a full HTML document (has DOCTYPE or <html> tag). */
export function isFullDocument(content: string): boolean {
  const trimmed = content.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

export class SprinkleRenderer {
  private container: HTMLElement;
  private bridge: SprinkleBridgeAPI;
  private scripts: HTMLScriptElement[] = [];
  private iframe: HTMLIFrameElement | null = null;
  private static cachedLucideScript: string | null = null;
  private static lucideScriptPromise: Promise<string> | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;

  constructor(container: HTMLElement, bridge: SprinkleBridgeAPI) {
    this.container = container;
    this.bridge = bridge;
  }

  /** Render SHTML content into the container. */
  async render(content: string, sprinkleName: string): Promise<void> {
    this.dispose();

    if (isExtension) {
      // Extension mode: always route through manifest sandbox (CSP-exempt).
      // Full documents need the fullDoc flag so the sandbox creates a nested iframe.
      await this.renderInSandbox(content, sprinkleName, isFullDocument(content));
    } else if (isFullDocument(content)) {
      await this.renderFullDoc(content, sprinkleName);
    } else {
      this.renderInline(content, sprinkleName);
    }
  }

  /**
   * Extension mode: render inside a sandbox iframe (CSP-exempt).
   * Bridge communication happens via postMessage.
   */
  private async renderInSandbox(
    content: string,
    sprinkleName: string,
    fullDoc = false
  ): Promise<void> {
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('sprinkle-sandbox.html');
    iframe.style.cssText = 'width: 100%; flex: 1; border: none; min-height: 0;';
    this.iframe = iframe;

    // Wait for iframe to load
    console.log('[sprinkle-renderer] creating sandbox iframe', iframe.src);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        console.error('[sprinkle-renderer] iframe load timed out after 5s');
        reject(new Error('sprinkle sandbox iframe load timed out'));
      }, 5000);
      iframe.addEventListener(
        'load',
        () => {
          clearTimeout(timer);
          console.log('[sprinkle-renderer] iframe loaded, contentWindow:', !!iframe.contentWindow);
          registerSprinkleWindow(iframe.contentWindow);
          resolve();
        },
        { once: true }
      );
      iframe.addEventListener(
        'error',
        (e) => {
          clearTimeout(timer);
          console.error('[sprinkle-renderer] iframe error:', e);
          reject(new Error('sprinkle sandbox iframe failed to load'));
        },
        { once: true }
      );
      this.container.appendChild(iframe);
    });

    // Listen for messages from the sandbox
    this.messageHandler = (event: MessageEvent) => {
      // Only accept messages from our iframe
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data;
      if (!msg?.type) return;

      if (msg.type === 'sprinkle-lick') {
        this.bridge.lick({ action: msg.action, data: msg.data });
      } else if (msg.type === 'sprinkle-set-state') {
        this.bridge.setState(msg.data);
      } else if (msg.type === 'sprinkle-close') {
        this.bridge.close();
      } else if (msg.type === 'sprinkle-stop-cone') {
        this.bridge.stopCone();
      } else if (msg.type === 'sprinkle-storage-set') {
        try {
          localStorage.setItem(`slicc-sprinkle-ls:${sprinkleName}:${msg.key}`, msg.value);
        } catch (e) {
          console.warn('[sprinkle-renderer] localStorage setItem failed:', msg.key, e);
        }
      } else if (msg.type === 'sprinkle-storage-remove') {
        try {
          localStorage.removeItem(`slicc-sprinkle-ls:${sprinkleName}:${msg.key}`);
        } catch (e) {
          console.warn('[sprinkle-renderer] localStorage removeItem failed:', msg.key, e);
        }
      } else if (msg.type === 'sprinkle-storage-clear') {
        const prefix = `slicc-sprinkle-ls:${sprinkleName}:`;
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k?.startsWith(prefix)) localStorage.removeItem(k);
        }
      } else if (msg.type === 'sprinkle-open') {
        this.bridge.open(msg.path, msg.projectRoot ? { projectRoot: msg.projectRoot } : undefined);
      } else if (msg.type === 'sprinkle-readfile') {
        this.bridge.readFile(msg.path).then(
          (fileContent) =>
            iframe.contentWindow?.postMessage(
              { type: 'sprinkle-readfile-response', id: msg.id, content: fileContent },
              '*'
            ),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-readfile-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      } else if (msg.type === 'sprinkle-writefile') {
        this.bridge.writeFile(msg.path, msg.content).then(
          () =>
            iframe.contentWindow?.postMessage(
              { type: 'sprinkle-writefile-response', id: msg.id },
              '*'
            ),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-writefile-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      } else if (msg.type === 'sprinkle-readdir') {
        this.bridge.readDir(msg.path).then(
          (entries) =>
            iframe.contentWindow?.postMessage(
              { type: 'sprinkle-readdir-response', id: msg.id, entries },
              '*'
            ),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-readdir-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      } else if (msg.type === 'sprinkle-exists') {
        this.bridge.exists(msg.path).then(
          (exists) =>
            iframe.contentWindow?.postMessage(
              { type: 'sprinkle-exists-response', id: msg.id, exists },
              '*'
            ),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-exists-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      } else if (msg.type === 'sprinkle-stat') {
        this.bridge.stat(msg.path).then(
          (stat) =>
            iframe.contentWindow?.postMessage(
              { type: 'sprinkle-stat-response', id: msg.id, stat },
              '*'
            ),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-stat-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      } else if (msg.type === 'sprinkle-mkdir') {
        this.bridge.mkdir(msg.path).then(
          () =>
            iframe.contentWindow?.postMessage({ type: 'sprinkle-mkdir-response', id: msg.id }, '*'),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-mkdir-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      } else if (msg.type === 'sprinkle-rm') {
        this.bridge.rm(msg.path).then(
          () =>
            iframe.contentWindow?.postMessage({ type: 'sprinkle-rm-response', id: msg.id }, '*'),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-rm-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      } else if (msg.type === 'sprinkle-fetch-script') {
        const url = msg.url as string;
        const id = msg.id as string;
        fetch(url)
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((text) => {
            iframe.contentWindow?.postMessage(
              { type: 'sprinkle-fetch-script-response', id, url, text },
              '*'
            );
          })
          .catch((err: unknown) => {
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-fetch-script-response',
                id,
                url,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            );
          });
      }
    };
    window.addEventListener('message', this.messageHandler);

    const themeCSS = this.collectThemeCSS();

    // Collect persisted localStorage entries for this sprinkle
    const savedStorage: Record<string, string> = {};
    const lsPrefix = `slicc-sprinkle-ls:${sprinkleName}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(lsPrefix)) {
        savedStorage[k.slice(lsPrefix.length)] = localStorage.getItem(k) ?? '';
      }
    }

    // Send content to the sandbox for rendering, including saved state + localStorage
    const savedState = this.bridge.getState();

    // For full-doc sprinkles in extension mode, the nested iframe can't load external
    // scripts (no allow-same-origin). Fetch custom element bundles and pass inline.
    let editorScript = '';
    let diffScript = '';
    if (fullDoc) {
      const fetches: Promise<void>[] = [];
      if (content.includes('<slicc-editor')) {
        fetches.push(
          fetch(chrome.runtime.getURL('slicc-editor.js'))
            .then((r) => (r.ok ? r.text() : ''))
            .then((t) => {
              editorScript = t;
            })
            .catch(() => {})
        );
      }
      if (content.includes('<slicc-diff')) {
        fetches.push(
          fetch(chrome.runtime.getURL('slicc-diff.js'))
            .then((r) => (r.ok ? r.text() : ''))
            .then((t) => {
              diffScript = t;
            })
            .catch(() => {})
        );
      }
      await Promise.all(fetches);
    }

    // Always fetch lucide-icons.js for sprinkles (icons are used in most sprinkles)
    // Cache the bundle to avoid repeated fetches
    const lucideScript = await this.getLucideScript();

    // Inline external CDN scripts (CSP blocks remote src in sandbox)
    const processedContent = fullDoc ? await inlineExternalScripts(content) : content;

    iframe.contentWindow!.postMessage(
      {
        type: 'sprinkle-render',
        content: processedContent,
        name: sprinkleName,
        themeCSS,
        savedState,
        savedStorage,
        fullDoc,
        editorScript,
        diffScript,
        lucideScript,
        isLight: isThemeLight(),
      },
      '*'
    );
  }

  /** Push an update to the sprinkle (agent -> sprinkle). */
  pushUpdate(data: unknown): void {
    if (this.iframe?.contentWindow) {
      this.iframe.contentWindow.postMessage({ type: 'sprinkle-update', data }, '*');
    }
  }

  /** Collect CSS custom properties and sprinkle component rules from the parent page. */
  private collectThemeCSS(): string {
    return collectThemeCSS();
  }

  /** Generate the postMessage bridge script injected into full-document iframes. */
  private generateBridgeScript(): string {
    return `(function() {
  var _updateListeners = new Set();
  var _sprinkleName = '';
  var _state = null;
  var _cbId = 0;
  var _callbacks = {};

  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'sprinkle-init') {
      _sprinkleName = msg.name || '';
      _state = msg.savedState || null;
      if (window.slicc) window.slicc.name = _sprinkleName;
    } else if (msg.type === 'sprinkle-update') {
      _updateListeners.forEach(function(cb) { try { cb(msg.data); } catch(e) { console.error(e); } });
    } else if (msg.type === 'slicc-theme') {
      document.documentElement.classList.toggle('theme-light', !!msg.isLight);
    } else if (msg.id && _callbacks[msg.id]) {
      var cb = _callbacks[msg.id];
      delete _callbacks[msg.id];
      cb(msg);
    }
  });

  function _vfsCall(type, params, extractResult) {
    return new Promise(function(resolve, reject) {
      var id = ++_cbId;
      _callbacks[id] = function(msg) {
        if (msg.error) reject(new Error(msg.error));
        else resolve(extractResult ? extractResult(msg) : undefined);
      };
      var m = { type: type, id: id };
      if (params) { for (var k in params) m[k] = params[k]; }
      parent.postMessage(m, '*');
    });
  }

  var api = {
    lick: function(event) {
      var action, data;
      if (typeof event === 'string') { action = event; } else { action = event.action; data = event.data; }
      parent.postMessage({ type: 'sprinkle-lick', action: action, data: data }, '*');
    },
    on: function(event, callback) { if (event === 'update') _updateListeners.add(callback); },
    off: function(event, callback) { if (event === 'update') _updateListeners.delete(callback); },
    readFile: function(path) {
      return _vfsCall('sprinkle-readfile', { path: path }, function(m) { return m.content; });
    },
    writeFile: function(path, content) {
      return _vfsCall('sprinkle-writefile', { path: path, content: content });
    },
    readDir: function(path) {
      return _vfsCall('sprinkle-readdir', { path: path }, function(m) { return m.entries; });
    },
    exists: function(path) {
      return _vfsCall('sprinkle-exists', { path: path }, function(m) { return m.exists; });
    },
    stat: function(path) {
      return _vfsCall('sprinkle-stat', { path: path }, function(m) { return m.stat; });
    },
    mkdir: function(path) {
      return _vfsCall('sprinkle-mkdir', { path: path });
    },
    rm: function(path) {
      return _vfsCall('sprinkle-rm', { path: path });
    },
    screenshot: function(selector) {
      return new Promise(function(resolve, reject) {
        try {
          var target = selector ? document.querySelector(selector) : document.body;
          if (!target) { reject(new Error('Element not found: ' + selector)); return; }
          var rect = target.getBoundingClientRect();
          var w = Math.ceil(rect.width);
          var h = Math.ceil(rect.height);
          if (w === 0 || h === 0) { reject(new Error('Element has zero dimensions')); return; }
          var canvas = document.createElement('canvas');
          var dpr = window.devicePixelRatio || 1;
          canvas.width = w * dpr;
          canvas.height = h * dpr;
          var ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          var clone = target.cloneNode(true);
          var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
            '<foreignObject width="100%" height="100%">' +
            new XMLSerializer().serializeToString(clone) +
            '</foreignObject></svg>';
          var img = new Image();
          img.onload = function() { ctx.drawImage(img, 0, 0); resolve(canvas.toDataURL('image/png')); };
          img.onerror = function() { reject(new Error('Screenshot rendering failed')); };
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        } catch(e) { reject(e); }
      });
    },
    setState: function(data) { _state = data; parent.postMessage({ type: 'sprinkle-set-state', data: data }, '*'); },
    getState: function() { return _state; },
    close: function() { parent.postMessage({ type: 'sprinkle-close' }, '*'); },
    stopCone: function() { parent.postMessage({ type: 'sprinkle-stop-cone' }, '*'); },
    name: ''
  };
  window.slicc = api;
  window.bridge = api;
})();`;
  }

  /**
   * Full document mode: render a complete HTML document in an srcdoc iframe.
   * Works in both CLI and extension mode.
   */
  private async renderFullDoc(content: string, sprinkleName: string): Promise<void> {
    const bridgeScript = `<script>${this.generateBridgeScript()}</script>`;
    const themeCSS = this.collectThemeCSS();
    const themeTag = themeCSS ? `<style>${themeCSS}</style>` : '';
    // Inject custom element bundles only when the sprinkle uses them
    const editorTag = content.includes('<slicc-editor')
      ? '<script src="/slicc-editor.js"></script>'
      : '';
    const diffTag = content.includes('<slicc-diff') ? '<script src="/slicc-diff.js"></script>' : '';
    // Always inject Lucide icons for sprinkles
    const lucideTag = '<script src="/lucide-icons.js"></script>';
    // Bootstrap the current theme class on <html> so CSS vars resolve correctly
    // before any content paints. Runs synchronously inside the iframe.
    const themeBootstrap = `<script>(function(){try{if(${isThemeLight() ? 'true' : 'false'})document.documentElement.classList.add('theme-light');}catch(e){}})();</script>`;
    const injection = themeBootstrap + bridgeScript + themeTag + editorTag + diffTag + lucideTag;

    // Inject bridge script + theme CSS after <head> tag, or before first <script> if no <head>
    let modified: string;
    const headMatch = content.match(/<head\b[^>]*>/i);
    if (headMatch) {
      const insertPos = headMatch.index! + headMatch[0].length;
      modified = content.slice(0, insertPos) + injection + content.slice(insertPos);
    } else {
      const scriptMatch = content.match(/<script\b/i);
      if (scriptMatch) {
        modified =
          content.slice(0, scriptMatch.index!) + injection + content.slice(scriptMatch.index!);
      } else {
        // Fallback: inject right after <html> or at the start
        const htmlMatch = content.match(/<html\b[^>]*>/i);
        if (htmlMatch) {
          const insertPos = htmlMatch.index! + htmlMatch[0].length;
          modified = content.slice(0, insertPos) + injection + content.slice(insertPos);
        } else {
          modified = injection + content;
        }
      }
    }

    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.style.cssText = 'width: 100%; flex: 1; border: none; min-height: 0;';
    iframe.srcdoc = modified;
    this.iframe = iframe;

    // Wait for iframe to load
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('full-doc iframe load timed out'));
      }, 5000);
      iframe.addEventListener(
        'load',
        () => {
          clearTimeout(timer);
          // Register with theme broadcaster so prefers-color-scheme changes flip CSS vars live
          registerSprinkleWindow(iframe.contentWindow);
          // Send init message with name and saved state
          const savedState = this.bridge.getState();
          iframe.contentWindow?.postMessage(
            { type: 'sprinkle-init', name: sprinkleName, savedState },
            '*'
          );
          resolve();
        },
        { once: true }
      );
      iframe.addEventListener(
        'error',
        (e) => {
          clearTimeout(timer);
          reject(new Error('full-doc iframe failed to load'));
        },
        { once: true }
      );
      this.container.appendChild(iframe);
    });

    // Listen for messages from the iframe
    this.messageHandler = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data;
      if (!msg?.type) return;

      if (msg.type === 'sprinkle-lick') {
        this.bridge.lick({ action: msg.action, data: msg.data });
      } else if (msg.type === 'sprinkle-set-state') {
        this.bridge.setState(msg.data);
      } else if (msg.type === 'sprinkle-close') {
        this.bridge.close();
      } else if (msg.type === 'sprinkle-stop-cone') {
        this.bridge.stopCone();
      } else if (msg.type === 'sprinkle-readfile') {
        this.bridge.readFile(msg.path).then(
          (fileContent) =>
            iframe.contentWindow?.postMessage(
              { type: 'sprinkle-readfile-response', id: msg.id, content: fileContent },
              '*'
            ),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-readfile-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      } else if (msg.type === 'sprinkle-writefile') {
        this.bridge.writeFile(msg.path, msg.content).then(
          () =>
            iframe.contentWindow?.postMessage(
              { type: 'sprinkle-writefile-response', id: msg.id },
              '*'
            ),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-writefile-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      } else if (msg.type === 'sprinkle-readdir') {
        this.bridge.readDir(msg.path).then(
          (entries) =>
            iframe.contentWindow?.postMessage(
              { type: 'sprinkle-readdir-response', id: msg.id, entries },
              '*'
            ),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-readdir-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      } else if (msg.type === 'sprinkle-exists') {
        this.bridge.exists(msg.path).then(
          (exists) =>
            iframe.contentWindow?.postMessage(
              { type: 'sprinkle-exists-response', id: msg.id, exists },
              '*'
            ),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-exists-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      } else if (msg.type === 'sprinkle-stat') {
        this.bridge.stat(msg.path).then(
          (stat) =>
            iframe.contentWindow?.postMessage(
              { type: 'sprinkle-stat-response', id: msg.id, stat },
              '*'
            ),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-stat-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      } else if (msg.type === 'sprinkle-mkdir') {
        this.bridge.mkdir(msg.path).then(
          () =>
            iframe.contentWindow?.postMessage({ type: 'sprinkle-mkdir-response', id: msg.id }, '*'),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-mkdir-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      } else if (msg.type === 'sprinkle-rm') {
        this.bridge.rm(msg.path).then(
          () =>
            iframe.contentWindow?.postMessage({ type: 'sprinkle-rm-response', id: msg.id }, '*'),
          (err: unknown) =>
            iframe.contentWindow?.postMessage(
              {
                type: 'sprinkle-rm-response',
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              },
              '*'
            )
        );
      }
    };
    window.addEventListener('message', this.messageHandler);
  }

  /**
   * CLI mode: render directly in the page DOM (no CSP restrictions).
   */
  private renderInline(content: string, sprinkleName: string): void {
    // Lazy-load the <slicc-editor> custom element when a sprinkle uses it
    if (content.includes('<slicc-editor') && !customElements.get('slicc-editor')) {
      void import('./slicc-editor.js');
    }
    if (content.includes('<slicc-diff') && !customElements.get('slicc-diff')) {
      // Load via script tag (not Vite import) so the IIFE bundle includes
      // @pierre/diffs' web-components.js which isn't in the package exports map.
      const s = document.createElement('script');
      s.src = '/slicc-diff.js';
      document.head.appendChild(s);
    }

    // Ensure the global sprinkle registry exists
    if (!window.__slicc_sprinkles) window.__slicc_sprinkles = {};
    window.__slicc_sprinkles[sprinkleName] = this.bridge;

    // Give the bridge a reference to the container so screenshot() works in inline mode.
    this.bridge._container = this.container;

    // Parse HTML and set content (scripts won't execute via innerHTML).
    // Content is user/agent-authored .shtml — trusted, not external input.
    const wrapper = document.createElement('div');
    wrapper.className = 'sprinkle-content';
    wrapper.innerHTML = content;
    this.container.appendChild(wrapper);

    // Auto-set width on .fill elements from data-value attribute
    for (const fill of wrapper.querySelectorAll<HTMLElement>('.fill[data-value]')) {
      const v = parseFloat(fill.dataset.value || '0');
      if (v >= 0 && v <= 100) fill.style.width = `${v}%`;
    }

    // Rewrite onclick `slicc` or `bridge` references to use the sprinkle-specific bridge.
    const bridgeExpr = `window.__slicc_sprinkles[${JSON.stringify(sprinkleName)}]`;
    for (const el of wrapper.querySelectorAll('[onclick]')) {
      const attr = el.getAttribute('onclick') || '';
      if (/\b(slicc|bridge)\b/.test(attr)) {
        el.setAttribute('onclick', attr.replace(/\b(slicc|bridge)\b/g, bridgeExpr));
      }
    }

    // Extract <script> tags and re-create them as live elements.
    const deadScripts = Array.from(wrapper.querySelectorAll('script'));
    for (const dead of deadScripts) {
      dead.remove();
      const live = document.createElement('script');
      for (const attr of dead.attributes) {
        live.setAttribute(attr.name, attr.value);
      }
      if (!dead.src) {
        const onclickFns = new Set<string>();
        for (const el of wrapper.querySelectorAll('[onclick]')) {
          const attr = el.getAttribute('onclick') || '';
          for (const m of attr.matchAll(/\b(\w+)\s*\(/g)) {
            const name = m[1];
            if (!['slicc', 'bridge', 'lick', 'close'].includes(name)) onclickFns.add(name);
          }
        }
        const hoists = [...onclickFns]
          .map((fn) => `if (typeof ${fn} === 'function') window.${fn} = ${fn};`)
          .join('\n');

        live.textContent =
          `(function() { var slicc = ${bridgeExpr}; var bridge = slicc;\n` +
          dead.textContent +
          (hoists ? '\n' + hoists : '') +
          '\n})();';
      }
      wrapper.appendChild(live);
      this.scripts.push(live);
    }
  }

  /** Clean up scripts and content. */
  dispose(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    if (this.iframe) {
      unregisterSprinkleWindow(this.iframe.contentWindow);
      this.iframe.remove();
      this.iframe = null;
    }
    for (const script of this.scripts) {
      script.remove();
    }
    this.scripts = [];
    const wrapper = this.container.querySelector('.sprinkle-content');
    if (wrapper) wrapper.remove();
    if (window.__slicc_sprinkles) {
      delete window.__slicc_sprinkles[this.bridge.name];
    }
  }

  /**
   * Get Lucide icons bundle, using cache to avoid repeated fetches.
   * Returns empty string if bundle is unavailable.
   */
  private async getLucideScript(): Promise<string> {
    // Return cached value if available
    if (SprinkleRenderer.cachedLucideScript !== null) {
      return SprinkleRenderer.cachedLucideScript;
    }

    // If a fetch is already in progress, wait for it
    if (SprinkleRenderer.lucideScriptPromise !== null) {
      return SprinkleRenderer.lucideScriptPromise;
    }

    // Start new fetch and cache the promise
    SprinkleRenderer.lucideScriptPromise = (async () => {
      try {
        const resp = await fetch(chrome.runtime.getURL('lucide-icons.js'));
        if (resp.ok) {
          const text = await resp.text();
          SprinkleRenderer.cachedLucideScript = text;
          return text;
        }
      } catch {
        // Lucide unavailable — sprinkle will render without icons
      }
      SprinkleRenderer.cachedLucideScript = '';
      return '';
    })();

    return SprinkleRenderer.lucideScriptPromise;
  }
}

/** Resolve relative url() references in a CSS rule to absolute URLs. */
function resolveUrls(cssText: string, baseHref: string): string {
  return cssText.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (_match, url: string) => {
    if (/^(https?:|data:|blob:)/i.test(url)) return `url('${url}')`;
    try {
      return `url('${new URL(url, baseHref).href}')`;
    } catch {
      return `url('${url}')`;
    }
  });
}

/**
 * Collect @font-face rules, theme rule bodies (:root + :root.theme-light
 * + .theme-light descendants), and sprinkle component rules from the
 * parent page. Theme rules are emitted verbatim — not snapshotted —
 * so toggling `.theme-light` on the iframe's <html> swaps the variable
 * set in lockstep with the parent.
 */
export function collectThemeCSS(): string {
  if (typeof getComputedStyle !== 'function') return '';
  const fontFaceRules: string[] = [];
  const themeRules: string[] = [];
  const sprinkleRules: string[] = [];
  const baseHref = location.href;
  const isThemeSelector = (sel: string): boolean =>
    sel === ':root' ||
    sel === ':root.theme-light' ||
    sel.startsWith('.theme-light ') ||
    sel === '.theme-light' ||
    // Handle comma-joined selectors where any part matches.
    sel.split(',').some((s) => {
      const t = s.trim();
      return (
        t === ':root' ||
        t === ':root.theme-light' ||
        t.startsWith('.theme-light ') ||
        t === '.theme-light'
      );
    });
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSFontFaceRule) {
          fontFaceRules.push(resolveUrls(rule.cssText, baseHref));
        } else if (rule instanceof CSSStyleRule) {
          const sel = rule.selectorText;
          if (isThemeSelector(sel)) {
            themeRules.push(rule.cssText);
          }
          if (sel.includes('.sprinkle-') || sel.includes('.fill')) {
            sprinkleRules.push(rule.cssText);
          }
        }
      }
    } catch {
      /* cross-origin sheet, skip */
    }
  }
  return fontFaceRules.join('\n') + '\n' + themeRules.join('\n') + '\n' + sprinkleRules.join('\n');
}
