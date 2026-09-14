import { isNestedInAnotherFrame, nudgeIframeRepaint } from '@slicc/shared-ts';
import type { EntryType } from '../fs/index.js';
import { iframeThemeBridgeSource } from './iframe-theme.js';
import {
  iframeFetchResponseSource,
  type SprinkleAgentOptions,
  type SprinkleBridgeAPI,
} from './sprinkle-bridge.js';
import { iframeScreenshotHelpersSource } from './sprinkle-screenshot.js';
import { isThemeLight, registerSprinkleWindow, unregisterSprinkleWindow } from './theme.js';

declare global {
  interface Window {
    __slicc_sprinkles?: Record<string, SprinkleBridgeAPI>;
  }
}

export function isFullDocument(content: string): boolean {
  const trimmed = content.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

export function fullDocIframeStyle(nested: boolean): string {
  return (
    'width: 100%; height: 100%; flex: 1; border: none; min-height: 0;' +
    (nested ? ' transform: translateZ(0);' : '')
  );
}

export function pinFullDocIframeToHost(iframe: HTMLIFrameElement, container: HTMLElement): boolean {
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (width <= 0 || height <= 0) return false;
  iframe.style.width = `${width}px`;
  iframe.style.height = `${height}px`;
  return true;
}

export function restoreFullDocIframeFlex(iframe: HTMLIFrameElement): void {
  iframe.style.width = '100%';
  iframe.style.height = '100%';
}

function injectFullDocAssets(content: string, injection: string): string {
  const headMatch = content.match(/<head\b[^>]*>/i);
  if (headMatch) {
    const insertPos = headMatch.index! + headMatch[0].length;
    return content.slice(0, insertPos) + injection + content.slice(insertPos);
  }
  const scriptMatch = content.match(/<script\b/i);
  if (scriptMatch) {
    return content.slice(0, scriptMatch.index!) + injection + content.slice(scriptMatch.index!);
  }
  const htmlMatch = content.match(/<html\b[^>]*>/i);
  if (htmlMatch) {
    const insertPos = htmlMatch.index! + htmlMatch[0].length;
    return content.slice(0, insertPos) + injection + content.slice(insertPos);
  }
  return injection + content;
}

function waitForIframeLoad(iframe: HTMLIFrameElement, onLoad: () => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('full-doc iframe load timed out'));
    }, 5000);
    iframe.addEventListener(
      'load',
      () => {
        clearTimeout(timer);
        onLoad();
        resolve();
      },
      { once: true }
    );
    iframe.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('full-doc iframe failed to load'));
      },
      { once: true }
    );
  });
}

interface SprinkleInboundMessage {
  type: string;
  id?: unknown;
  action?: string;
  data?: unknown;
  path?: string;
  content?: string;
  cmd?: string;
  prompt?: string;
  opts?: SprinkleAgentOptions;
  op?: string;
  args?: unknown[];
  channel?: string;
  base64?: string;
  name?: string;
  mimeType?: string;
}

interface SprinkleIframeResponseBody {
  error?: string;
  content?: string;
  entries?: Array<{ name: string; type: EntryType }>;
  exists?: boolean;
  stat?: { type: EntryType; size: number };
  base64?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  result?: unknown;
}

type BridgeMessageHandler = (iframe: HTMLIFrameElement, msg: SprinkleInboundMessage) => void;

function postToIframe(
  iframe: HTMLIFrameElement,
  type: string,
  id: unknown,
  extra: SprinkleIframeResponseBody = {}
): void {
  const win = iframe.contentWindow;
  if (!win) return;
  try {
    win.postMessage({ type, id, ...extra }, '*');
  } catch (err) {
    if (extra.error !== undefined) return;
    const message = err instanceof Error ? err.message : String(err);
    try {
      win.postMessage({ type, id, error: message }, '*');
    } catch {}
  }
}

function respondToIframe<T>(
  iframe: HTMLIFrameElement,
  responseType: string,
  id: unknown,
  promise: Promise<T>,
  mapResult: (value: T) => SprinkleIframeResponseBody
): void {
  promise.then(
    (value) => postToIframe(iframe, responseType, id, mapResult(value)),
    (err: unknown) =>
      postToIframe(iframe, responseType, id, {
        error: err instanceof Error ? err.message : String(err),
      })
  );
}

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

function lazyLoadInlineCustomElements(content: string): void {
  if (content.includes('<slicc-editor') && !customElements.get('slicc-editor')) {
    void import('./slicc-editor.js');
  }
  if (content.includes('<slicc-diff') && !customElements.get('slicc-diff')) {
    const s = document.createElement('script');
    s.src = '/slicc-diff.js';
    document.head.appendChild(s);
  }
}

function applyFillWidths(wrapper: HTMLElement): void {
  for (const fill of wrapper.querySelectorAll<HTMLElement>('.fill[data-value]')) {
    const v = parseFloat(fill.dataset.value || '0');
    if (v >= 0 && v <= 100) fill.style.width = `${v}%`;
  }
}

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
  private iframeLoadHandler: (() => void) | null = null;
  private registeredWindow: Window | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private visibilityObserver: IntersectionObserver | null = null;
  private bridgeLifecycleReady = false;
  private pendingBridgeLifecycle: Array<() => void> = [];

  constructor(container: HTMLElement, bridge: SprinkleBridgeAPI) {
    this.container = container;
    this.bridge = bridge;
  }

  async render(content: string, sprinkleName: string): Promise<void> {
    this.dispose();

    if (isFullDocument(content)) {
      try {
        await this.renderFullDoc(content, sprinkleName);
      } catch (err) {
        this.dispose();
        throw err;
      }
    } else {
      this.renderInline(content, sprinkleName);
    }
  }

  activateBridgeLifecycle(): void {
    this.bridgeLifecycleReady = true;
    while (this.bridgeLifecycleReady && this.pendingBridgeLifecycle.length > 0) {
      this.pendingBridgeLifecycle.shift()!();
    }
  }

  pushUpdate(data: unknown): void {
    if (this.iframe?.contentWindow) {
      this.iframe.contentWindow.postMessage({ type: 'sprinkle-update', data }, '*');
    }
  }

  pushDeviceEvent(channel: string, payload: unknown): void {
    if (this.iframe?.contentWindow) {
      this.iframe.contentWindow.postMessage(
        { type: 'sprinkle-device-event', channel, payload },
        '*'
      );
    }
  }

  private collectThemeCSS(): string {
    return collectThemeCSS();
  }

  private generateBridgeScript(): string {
    return `(function() {
  var _updateListeners = new Set();
  var _hidInputReportListeners = new Set();
  var _sprinkleName = '';
  var _state = null;
  var _cbId = 0;
  var _callbacks = {};
  ${iframeThemeBridgeSource}

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
      applyIframeTheme(event);
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

  ${iframeScreenshotHelpersSource()}
  ${iframeFetchResponseSource()}

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
      // Keep in lockstep with captureSprinkleScreenshot in sprinkle-screenshot.ts.
      return new Promise(function(resolve, reject) {
        try {
          var target = selector ? document.querySelector(selector) : document.body;
          var label = screenshotTargetLabel(selector, target);
          if (!target) { reject(new Error('Element not found: ' + (selector || label))); return; }
          var rect = target.getBoundingClientRect();
          var w = Math.ceil(rect.width);
          var h = Math.ceil(rect.height);
          if (w === 0 || h === 0) {
            reject(new Error(screenshotZeroDimensionError(label, rect.width, rect.height)));
            return;
          }
          var canvas = document.createElement('canvas');
          var dpr = window.devicePixelRatio || 1;
          canvas.width = w * dpr;
          canvas.height = h * dpr;
          var ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error(screenshotRasteriseError('canvas context unavailable', label, w, h)));
            return;
          }
          ctx.scale(dpr, dpr);
          var clone = target.cloneNode(true);
          if (clone.querySelectorAll) {
            var junk = clone.querySelectorAll('script, link[rel="stylesheet"]');
            for (var i = 0; i < junk.length; i++) {
              if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
            }
          }
          var xhtml;
          try {
            xhtml = new XMLSerializer().serializeToString(clone);
          } catch (serErr) {
            var serMsg = serErr && serErr.message ? serErr.message : String(serErr);
            reject(new Error(screenshotRasteriseError('XMLSerializer threw: ' + serMsg, label, w, h)));
            return;
          }
          var svg = buildScreenshotSvg(xhtml, w, h);
          var svgBytes = svg.length;
          var dataUrl;
          try {
            dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
          } catch (encErr) {
            reject(new Error(screenshotRasteriseError('data-URL too large', label, w, h, svgBytes)));
            return;
          }
          var dataUrlBytes = dataUrl.length;
          var src = dataUrl;
          var blobUrl = null;
          if (typeof URL !== 'undefined' && URL.createObjectURL) {
            try {
              blobUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
              src = blobUrl;
            } catch (blobErr) {
              if (dataUrlBytes > 2097152) {
                reject(new Error(screenshotRasteriseError('data-URL too large', label, w, h, svgBytes, dataUrlBytes)));
                return;
              }
            }
          } else if (dataUrlBytes > 2097152) {
            reject(new Error(screenshotRasteriseError('data-URL too large', label, w, h, svgBytes, dataUrlBytes)));
            return;
          }
          var img = new Image();
          img.onload = function() {
            if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/png'));
          };
          img.onerror = function() {
            if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }
            var reason = !blobUrl && dataUrlBytes > 2097152 ? 'data-URL too large' : 'image decode failed';
            reject(new Error(screenshotRasteriseError(reason, label, w, h, svgBytes, dataUrlBytes)));
          };
          img.src = src;
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
    fetch: function(url, init) {
      return _jshCall('fetch', [url, init || null]).then(function(v) { return buildFetchResponse(v); });
    },
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
      close: function(handle) { return _deviceCall('usb', 'close', [handle]).then(function() {}); },
      reset: function(handle) { return _deviceCall('usb', 'reset', [handle]).then(function() {}); },
      selectConfiguration: function(handle, value) {
        return _deviceCall('usb', 'selectConfig', [handle, value]).then(function() {});
      },
      claimInterface: function(handle, n) {
        return _deviceCall('usb', 'claim', [handle, n]).then(function() {});
      },
      releaseInterface: function(handle, n) {
        return _deviceCall('usb', 'release', [handle, n]).then(function() {});
      },
      clearHalt: function(handle, direction, ep) {
        return _deviceCall('usb', 'clearHalt', [handle, direction, ep]).then(function() {});
      },
      // Payloads cross as base64 — see the note on SprinkleUsbApi.
      controlTransferIn: function(handle, setup, length) {
        return _deviceCall('usb', 'controlIn', [handle, setup, length]).then(function(r) {
          return { status: r.status, bytes: _b64ToU8(r.base64) };
        });
      },
      controlTransferOut: function(handle, setup, bytes) {
        return _deviceCall('usb', 'controlOut', [handle, setup, _u8ToB64(bytes)]);
      },
      transferIn: function(handle, ep, length) {
        return _deviceCall('usb', 'transferIn', [handle, ep, length]).then(function(r) {
          return { status: r.status, bytes: _b64ToU8(r.base64) };
        });
      },
      transferOut: function(handle, ep, bytes) {
        return _deviceCall('usb', 'transferOut', [handle, ep, _u8ToB64(bytes)]);
      }
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

  private async renderFullDoc(content: string, sprinkleName: string): Promise<void> {
    const bridgeScript = `<script>${this.generateBridgeScript()}</script>`;
    const themeCSS = this.collectThemeCSS();
    const themeTag = themeCSS ? `<style>${themeCSS}</style>` : '';

    const editorTag = content.includes('<slicc-editor')
      ? '<script src="/slicc-editor.js"></script>'
      : '';
    const diffTag = content.includes('<slicc-diff') ? '<script src="/slicc-diff.js"></script>' : '';

    const lucideTag = '<script src="/lucide-icons.js"></script>';

    const themeBootstrap = `<script>(function(){try{if(${isThemeLight() ? 'true' : 'false'})document.documentElement.classList.add('theme-light');}catch(e){}})();</script>`;
    const injection = themeBootstrap + bridgeScript + themeTag + editorTag + diffTag + lucideTag;
    const modified = injectFullDocAssets(content, injection);

    const iframe = document.createElement('iframe');

    const nested = isNestedInAnotherFrame();
    const sandboxTokens = nested
      ? 'allow-scripts allow-same-origin allow-popups'
      : 'allow-scripts allow-same-origin';
    iframe.setAttribute('sandbox', sandboxTokens);
    iframe.style.cssText = fullDocIframeStyle(nested);

    const pinnedToHost = pinFullDocIframeToHost(iframe, this.container);
    iframe.srcdoc = modified;
    this.iframe = iframe;

    const handlers = createSharedBridgeHandlers(this.bridge);
    for (const type of ['sprinkle-close', 'sprinkle-minimize']) {
      const handler = handlers[type];
      handlers[type] = (target, msg) => {
        if (!this.bridgeLifecycleReady) {
          this.pendingBridgeLifecycle.push(() => handler(target, msg));
          return;
        }
        handler(target, msg);
      };
    }
    this.messageHandler = createIframeMessageListener(iframe, handlers);
    window.addEventListener('message', this.messageHandler);

    this.iframeLoadHandler = () => {
      unregisterSprinkleWindow(this.registeredWindow);
      this.registeredWindow = iframe.contentWindow;
      registerSprinkleWindow(this.registeredWindow);
      const savedState = this.bridge.getState();
      iframe.contentWindow?.postMessage(
        { type: 'sprinkle-init', name: sprinkleName, savedState },
        '*'
      );
    };
    iframe.addEventListener('load', this.iframeLoadHandler);

    const loaded = waitForIframeLoad(iframe, () => {
      void iframe.getBoundingClientRect();
      if (pinnedToHost) restoreFullDocIframeFlex(iframe);
      if (nested) nudgeIframeRepaint(iframe);
    });
    this.container.appendChild(iframe);
    await loaded;

    if (nested && typeof IntersectionObserver !== 'undefined') {
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
          skipNextVisible = true;
          observer.observe(iframe);
        });
      });
      this.visibilityObserver = observer;
      observer.observe(iframe);
    }
  }

  private renderInline(content: string, sprinkleName: string): void {
    lazyLoadInlineCustomElements(content);

    if (!window.__slicc_sprinkles) window.__slicc_sprinkles = {};
    window.__slicc_sprinkles[sprinkleName] = this.bridge;

    this.bridge._container = this.container;

    const wrapper = document.createElement('div');
    wrapper.className = 'sprinkle-content';
    wrapper.innerHTML = content;
    this.container.appendChild(wrapper);

    applyFillWidths(wrapper);
    const bridgeExpr = rewriteOnclickBridgeReferences(wrapper, sprinkleName);
    this.scripts = reviveInlineScripts(wrapper, bridgeExpr);
  }

  dispose(): void {
    this.bridgeLifecycleReady = false;
    this.pendingBridgeLifecycle = [];
    if (this.visibilityObserver) {
      this.visibilityObserver.disconnect();
      this.visibilityObserver = null;
    }
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    if (this.iframe) {
      if (this.iframeLoadHandler) {
        this.iframe.removeEventListener('load', this.iframeLoadHandler);
        this.iframeLoadHandler = null;
      }
      unregisterSprinkleWindow(this.registeredWindow);
      this.registeredWindow = null;
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
    if ((sheet.ownerNode as HTMLElement | null)?.id === 'slicc-theme-overrides') continue;
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
    } catch {}
  }
  return fontFaceRules.join('\n') + '\n' + themeRules.join('\n') + '\n' + sprinkleRules.join('\n');
}
