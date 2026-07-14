/**
 * Sprinkle Renderer — loads `.shtml` content from VFS and renders it into a
 * container div: fragments via direct DOM injection, full documents via a
 * `srcdoc` iframe (bridge over postMessage). Handles script extraction and
 * re-execution.
 *
 * In the thin extension this same standalone path runs in the hosted
 * `?cherry=1` follower on the `sliccy.ai` origin — there is no extension sandbox.
 */

import { isNestedInAnotherFrame, nudgeIframeRepaint } from './iframe-repaint.js';
import type { SprinkleBridgeAPI } from './sprinkle-bridge.js';
import { isThemeLight, registerSprinkleWindow, unregisterSprinkleWindow } from './theme.js';

declare global {
  interface Window {
    __slicc_sprinkles?: Record<string, SprinkleBridgeAPI>;
  }
}

/** Detect whether content is a full HTML document (has DOCTYPE or <html> tag). */
export function isFullDocument(content: string): boolean {
  const trimmed = content.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

/** A message the sprinkle iframe posted up to the renderer. */
type SprinkleInboundMessage = Record<string, unknown> & { type: string };

/** A handler for one inbound message type. */
type BridgeMessageHandler = (iframe: HTMLIFrameElement, msg: SprinkleInboundMessage) => void;

function postToIframe(
  iframe: HTMLIFrameElement,
  type: string,
  id: unknown,
  extra: Record<string, unknown> = {}
): void {
  iframe.contentWindow?.postMessage({ type, id, ...extra }, '*');
}

/**
 * Resolve `promise` and post a `<responseType>` message back to the iframe —
 * `mapResult(value)` on success, `{ error }` on rejection. Factors out the
 * `.then(success, error)` postMessage pattern repeated for every VFS/exec/
 * device bridge call in `renderFullDoc`.
 */
function respondToIframe<T>(
  iframe: HTMLIFrameElement,
  responseType: string,
  id: unknown,
  promise: Promise<T>,
  mapResult: (value: T) => Record<string, unknown>
): void {
  promise.then(
    (value) => postToIframe(iframe, responseType, id, mapResult(value)),
    (err: unknown) =>
      postToIframe(iframe, responseType, id, {
        error: err instanceof Error ? err.message : String(err),
      })
  );
}

/**
 * Bridge message handlers for the CLI/standalone full-document iframe
 * (`renderFullDoc`) — every VFS/exec/device/lifecycle call the sprinkle-side
 * bridge script (`generateBridgeScript`) can send.
 */
function createSharedBridgeHandlers(
  bridge: SprinkleBridgeAPI
): Record<string, BridgeMessageHandler> {
  return {
    'sprinkle-lick': (_iframe, msg) =>
      bridge.lick({ action: msg.action as string, data: msg.data }),
    'sprinkle-set-state': (_iframe, msg) => bridge.setState(msg.data),
    'sprinkle-close': () => bridge.close(),
    'sprinkle-minimize': () => bridge.minimize(),
    'sprinkle-stop-cone': () => bridge.stopCone(),
    'sprinkle-attach-image': (_iframe, msg) =>
      bridge.attachImage(msg.base64 as string, msg.name as string, msg.mimeType as string),
    'sprinkle-readfile': (iframe, msg) =>
      respondToIframe(
        iframe,
        'sprinkle-readfile-response',
        msg.id,
        bridge.readFile(msg.path as string),
        (content) => ({
          content,
        })
      ),
    'sprinkle-writefile': (iframe, msg) =>
      respondToIframe(
        iframe,
        'sprinkle-writefile-response',
        msg.id,
        bridge.writeFile(msg.path as string, msg.content as string),
        () => ({})
      ),
    'sprinkle-readdir': (iframe, msg) =>
      respondToIframe(
        iframe,
        'sprinkle-readdir-response',
        msg.id,
        bridge.readDir(msg.path as string),
        (entries) => ({
          entries,
        })
      ),
    'sprinkle-exists': (iframe, msg) =>
      respondToIframe(
        iframe,
        'sprinkle-exists-response',
        msg.id,
        bridge.exists(msg.path as string),
        (exists) => ({
          exists,
        })
      ),
    'sprinkle-stat': (iframe, msg) =>
      respondToIframe(
        iframe,
        'sprinkle-stat-response',
        msg.id,
        bridge.stat(msg.path as string),
        (stat) => ({ stat })
      ),
    'sprinkle-mkdir': (iframe, msg) =>
      respondToIframe(
        iframe,
        'sprinkle-mkdir-response',
        msg.id,
        bridge.mkdir(msg.path as string),
        () => ({})
      ),
    'sprinkle-rm': (iframe, msg) =>
      respondToIframe(
        iframe,
        'sprinkle-rm-response',
        msg.id,
        bridge.rm(msg.path as string),
        () => ({})
      ),
    'sprinkle-capture-screen': (iframe, msg) =>
      respondToIframe(
        iframe,
        'sprinkle-capture-screen-response',
        msg.id,
        bridge.captureScreen(),
        (result) => ({
          base64: result.base64,
          width: result.width,
          height: result.height,
          mimeType: result.mimeType,
        })
      ),
    'sprinkle-exec': (iframe, msg) =>
      respondToIframe(
        iframe,
        'sprinkle-exec-response',
        msg.id,
        bridge.exec(msg.cmd as string),
        (result) => ({
          result,
        })
      ),
    'sprinkle-agent': (iframe, msg) =>
      respondToIframe(
        iframe,
        'sprinkle-agent-response',
        msg.id,
        bridge.agent(msg.prompt as string, msg.opts as Parameters<typeof bridge.agent>[1]),
        (result) => ({ result })
      ),
    'sprinkle-jsh': (iframe, msg) =>
      respondToIframe(
        iframe,
        'sprinkle-jsh-response',
        msg.id,
        bridge._jsh(msg.op as string, msg.args as unknown[]),
        (result) => ({ result })
      ),
    'sprinkle-device-op': (iframe, msg) =>
      respondToIframe(
        iframe,
        'sprinkle-device-op-response',
        msg.id,
        bridge._device(
          msg.channel as Parameters<typeof bridge._device>[0],
          msg.op as string,
          (msg.args as unknown[]) ?? []
        ),
        (result) => ({ result })
      ),
  };
}

/** Build a `window` `message` listener that dispatches through `handlers` for messages from `iframe`. */
function createIframeMessageListener(
  iframe: HTMLIFrameElement,
  handlers: Record<string, BridgeMessageHandler>
): (event: MessageEvent) => void {
  return (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data as SprinkleInboundMessage | undefined;
    if (!msg?.type) return;
    handlers[msg.type]?.(iframe, msg);
  };
}

/** Lazily load custom-element bundles a CLI-inline sprinkle's markup references. */
function lazyLoadInlineCustomElements(content: string): void {
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
}

/** Auto-set width on `.fill[data-value]` elements from their `data-value` attribute. */
function applyFillWidths(wrapper: HTMLElement): void {
  for (const fill of wrapper.querySelectorAll<HTMLElement>('.fill[data-value]')) {
    const v = parseFloat(fill.dataset.value || '0');
    if (v >= 0 && v <= 100) fill.style.width = `${v}%`;
  }
}

/**
 * Rewrite onclick `slicc`/`bridge` references to the sprinkle-specific bridge
 * global, so multiple inline sprinkles on one page don't collide on a shared
 * `window.slicc`. Returns the bridge expression, reused by script revival.
 */
function rewriteOnclickBridgeReferences(wrapper: HTMLElement, sprinkleName: string): string {
  const bridgeExpr = `window.__slicc_sprinkles[${JSON.stringify(sprinkleName)}]`;
  for (const el of wrapper.querySelectorAll('[onclick]')) {
    const attr = el.getAttribute('onclick') || '';
    if (/\b(slicc|bridge)\b/.test(attr)) {
      el.setAttribute('onclick', attr.replace(/\b(slicc|bridge)\b/g, bridgeExpr));
    }
  }
  return bridgeExpr;
}

/** Function names an onclick handler calls, excluding known bridge methods. */
function collectOnclickFunctionNames(wrapper: HTMLElement): Set<string> {
  const names = new Set<string>();
  for (const el of wrapper.querySelectorAll('[onclick]')) {
    const attr = el.getAttribute('onclick') || '';
    for (const m of attr.matchAll(/\b(\w+)\s*\(/g)) {
      const name = m[1];
      if (!['slicc', 'bridge', 'lick', 'close', 'exec', 'agent'].includes(name)) names.add(name);
    }
  }
  return names;
}

/**
 * Extract `<script>` tags from `wrapper` and re-create them as live elements
 * (scripts set via `innerHTML` never execute). Non-`src` scripts are wrapped
 * in an IIFE binding `slicc`/`bridge` to this sprinkle's bridge instance, and
 * any onclick-referenced function they define is hoisted onto `window` so
 * inline `onclick="fn()"` handlers can still find it.
 */
function reviveInlineScripts(wrapper: HTMLElement, bridgeExpr: string): HTMLScriptElement[] {
  const live: HTMLScriptElement[] = [];
  for (const dead of Array.from(wrapper.querySelectorAll('script'))) {
    dead.remove();
    const script = document.createElement('script');
    for (const attr of dead.attributes) {
      script.setAttribute(attr.name, attr.value);
    }
    if (!dead.src) {
      const hoists = [...collectOnclickFunctionNames(wrapper)]
        .map((fn) => `if (typeof ${fn} === 'function') window.${fn} = ${fn};`)
        .join('\n');
      script.textContent =
        `(function() { var slicc = ${bridgeExpr}; var bridge = slicc;\n` +
        dead.textContent +
        (hoists ? '\n' + hoists : '') +
        '\n})();';
    }
    wrapper.appendChild(script);
    live.push(script);
  }
  return live;
}

export class SprinkleRenderer {
  private container: HTMLElement;
  private bridge: SprinkleBridgeAPI;
  private scripts: HTMLScriptElement[] = [];
  private iframe: HTMLIFrameElement | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private visibilityObserver: IntersectionObserver | null = null;

  constructor(container: HTMLElement, bridge: SprinkleBridgeAPI) {
    this.container = container;
    this.bridge = bridge;
  }

  /** Render SHTML content into the container. */
  async render(content: string, sprinkleName: string): Promise<void> {
    this.dispose();

    if (isFullDocument(content)) {
      await this.renderFullDoc(content, sprinkleName);
    } else {
      this.renderInline(content, sprinkleName);
    }
  }

  /** Push an update to the sprinkle (agent -> sprinkle). */
  pushUpdate(data: unknown): void {
    if (this.iframe?.contentWindow) {
      this.iframe.contentWindow.postMessage({ type: 'sprinkle-update', data }, '*');
    }
  }

  /**
   * Push a host-side device event (e.g. `hid:inputreport`) into the
   * sprinkle's iframe. The iframe-side bridge fans the payload out to
   * the listener set registered via `slicc.hid.on('inputreport', cb)`.
   * Inline-mode sprinkles never go through this path — their listeners
   * are invoked directly inside the bridge.
   */
  pushDeviceEvent(channel: string, payload: unknown): void {
    if (this.iframe?.contentWindow) {
      this.iframe.contentWindow.postMessage(
        { type: 'sprinkle-device-event', channel, payload },
        '*'
      );
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
  var _hidInputReportListeners = new Set();
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
    } else if (msg.type === 'sprinkle-device-event') {
      if (msg.channel === 'hid:inputreport') {
        _hidInputReportListeners.forEach(function(cb) {
          try { cb(msg.payload); } catch(e) { console.error(e); }
        });
      }
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

  function _jshCall(op, args) {
    return _vfsCall('sprinkle-jsh', { op: op, args: args }, function(m) { return m.result; });
  }
  function _deviceCall(channel, op, args) {
    return _vfsCall('sprinkle-device-op', { channel: channel, op: op, args: args || [] },
      function(m) { return m.result; });
  }
  function _b64ToU8(b64) {
    var bin = atob(b64); var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function _u8ToB64(bytes) {
    var bin = ''; for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
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
    minimize: function() { parent.postMessage({ type: 'sprinkle-minimize' }, '*'); },
    stopCone: function() { parent.postMessage({ type: 'sprinkle-stop-cone' }, '*'); },
    attachImage: function(base64, name, mimeType) { parent.postMessage({ type: 'sprinkle-attach-image', base64: base64, name: name, mimeType: mimeType }, '*'); },
    captureScreen: function() {
      return _vfsCall('sprinkle-capture-screen', {}, function(m) {
        return { base64: m.base64, width: m.width, height: m.height, mimeType: m.mimeType };
      });
    },
    exec: Object.assign(function(cmd) {
      return _vfsCall('sprinkle-exec', { cmd: cmd }, function(m) { return m.result; });
    }, { spawn: function(argv) { return _jshCall('spawn', [argv]); } }),
    agent: function(prompt, opts) {
      return _vfsCall('sprinkle-agent', { prompt: prompt, opts: opts }, function(m) { return m.result; });
    },
    fetch: function(url, init) { return _jshCall('fetch', [url, init || null]); },
    http: {
      client: function(cfg) {
        function mk(method) { return function(path, opts) { return _jshCall('http', [cfg, method, path, opts || null]); }; }
        return { get: mk('get'), post: mk('post'), put: mk('put'), patch: mk('patch'), 'delete': mk('delete') };
      }
    },
    browser: {
      findTab: function(q) { return _jshCall('browser', ['findTab', q]); },
      ensureTab: function(url, options) { return _jshCall('browser', ['ensureTab', url, options || {}]); },
      eval: function(tab, code) { return _jshCall('browser', ['eval', tab, code]); },
      evalAsync: function(tab, code) { return _jshCall('browser', ['evalAsync', tab, code]); },
      cookie: function(tab, name) { return _jshCall('browser', ['cookie', tab, name]); },
      localStorage: function(tab, key) { return _jshCall('browser', ['localStorage', tab, key]); },
      fetch: function(tab, url, opts) { return _jshCall('browser', ['fetch', tab, url, opts || {}]); }
    },
    hid: {
      list: function() { return _deviceCall('hid', 'list', []); },
      request: function(filters) { return _deviceCall('hid', 'request', [filters || []]); },
      open: function(handle) { return _deviceCall('hid', 'open', [handle]).then(function() {}); },
      close: function(handle) { return _deviceCall('hid', 'close', [handle]).then(function() {}); },
      sendReport: function(handle, reportId, data) {
        return _deviceCall('hid', 'sendReport', [handle, reportId, data]).then(function() {});
      },
      on: function(event, cb) { if (event === 'inputreport') _hidInputReportListeners.add(cb); },
      off: function(event, cb) { if (event === 'inputreport') _hidInputReportListeners['delete'](cb); }
    },
    serial: {
      list: function() { return _deviceCall('serial', 'list', []); },
      request: function(filters) { return _deviceCall('serial', 'request', [filters || []]); },
      open: function(handle, options) { return _deviceCall('serial', 'open', [handle, options]).then(function() {}); },
      close: function(handle) { return _deviceCall('serial', 'close', [handle]).then(function() {}); }
    },
    usb: {
      list: function() { return _deviceCall('usb', 'list', []); },
      request: function(filters) { return _deviceCall('usb', 'request', [filters || []]); },
      open: function(handle) { return _deviceCall('usb', 'open', [handle]).then(function() {}); },
      close: function(handle) { return _deviceCall('usb', 'close', [handle]).then(function() {}); }
    },
    readFileBinary: function(path) { return _jshCall('readFileBinary', [path]).then(function(r) { return _b64ToU8(r.base64); }); },
    writeFileBinary: function(path, bytes) { return _jshCall('writeFileBinary', [path, _u8ToB64(bytes)]); },
    fetchToFile: function(url, path) { return _jshCall('fetchToFile', [url, path]); },
    _jsh: function(op, args) { return _jshCall(op, args); },
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
    // `allow-popups` only for cherry: a sprinkle's own srcdoc iframe sits one
    // level deeper there (host page → cherry iframe → sprinkle iframe), and
    // content that opens a link via `target="_blank"`/`window.open()` instead
    // of the `slicc.open()` bridge hits Chromium's "Unsafe attempt to
    // initiate navigation" block without it. Scoped to cherry only — it does
    // NOT grant `allow-top-navigation`, so the sprinkle still can't replace
    // the whole window/host page.
    const sandboxTokens = isNestedInAnotherFrame()
      ? 'allow-scripts allow-same-origin allow-popups'
      : 'allow-scripts allow-same-origin';
    iframe.setAttribute('sandbox', sandboxTokens);
    iframe.style.cssText =
      'width: 100%; flex: 1; border: none; min-height: 0;' +
      (isNestedInAnotherFrame() ? ' transform: translateZ(0);' : '');
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
          if (isNestedInAnotherFrame()) nudgeIframeRepaint(iframe);
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

    // Listen for messages from the iframe — the full-doc bridge script only
    // sends the shared VFS/exec/device/lifecycle messages (no localStorage
    // proxying, `sprinkle-open`, or `sprinkle-fetch-script` — those are
    // sandbox-only, injected via extension-runtime-only script tags).
    this.messageHandler = createIframeMessageListener(
      iframe,
      createSharedBridgeHandlers(this.bridge)
    );
    window.addEventListener('message', this.messageHandler);

    // The sprinkle's `<slicc-surface>` host stays mounted and toggles
    // `display:none`/`display:flex` on tab switches instead of destroying the
    // iframe — no new `load` event fires on re-show, so the one-shot nudge
    // above can't catch a re-show that resurfaces the Chromium compositor
    // bug. Re-nudge on every hidden→visible transition after the first.
    //
    // The initial nudge (on load) can also miss when the workbench is still
    // mid-transition (width:0 → full width takes ~380ms) — the iframe has
    // zero visible area at that point so the display toggle has nothing to
    // composite. The observer catches BOTH cases: a first-paint that arrives
    // while the container is still expanding, and subsequent tab-switch
    // re-shows.
    //
    // `nudgeIframeRepaint` itself toggles the iframe's `display`, which is
    // exactly what this observer watches. A "skip while nudging" flag isn't
    // enough — the nudge's own display:none→restore flip is still a real
    // hidden→visible transition that fires AFTER the flag resets, so it
    // re-triggers another nudge forever. Actually unobserve for the duration
    // of the nudge and re-observe once it settles, so the nudge's own
    // display flicker never reaches this callback.
    if (isNestedInAnotherFrame() && typeof IntersectionObserver !== 'undefined') {
      let skipNextVisible = false;
      const observer = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry.isIntersecting) return;
        if (skipNextVisible) {
          skipNextVisible = false;
          return;
        }
        observer.unobserve(iframe);
        nudgeIframeRepaint(iframe, () => {
          // Re-observing fires a new initial callback with isIntersecting:true
          // (the iframe is visible right after the nudge restored display).
          // Skip that one — it's not a real visibility change.
          skipNextVisible = true;
          observer.observe(iframe);
        });
      });
      this.visibilityObserver = observer;
      observer.observe(iframe);
    }
  }

  /**
   * CLI mode: render directly in the page DOM (no CSP restrictions).
   */
  private renderInline(content: string, sprinkleName: string): void {
    lazyLoadInlineCustomElements(content);

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

    applyFillWidths(wrapper);
    const bridgeExpr = rewriteOnclickBridgeReferences(wrapper, sprinkleName);
    this.scripts = reviveInlineScripts(wrapper, bridgeExpr);
  }

  /** Clean up scripts and content. */
  dispose(): void {
    if (this.visibilityObserver) {
      this.visibilityObserver.disconnect();
      this.visibilityObserver = null;
    }
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
