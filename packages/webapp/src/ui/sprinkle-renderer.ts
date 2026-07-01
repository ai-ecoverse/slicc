/**
 * Sprinkle Renderer — loads `.shtml` content from VFS and renders
 * it into a container div. Handles script extraction and re-execution.
 *
 * In extension mode, CSP blocks inline scripts and event handlers.
 * The sprinkle renders inside a sandbox iframe (sprinkle-sandbox.html)
 * which is CSP-exempt. Bridge communication uses postMessage.
 */

import { createLogger } from '../core/logger.js';
import type { SprinkleBridgeAPI } from './sprinkle-bridge.js';
import { isThemeLight, registerSprinkleWindow, unregisterSprinkleWindow } from './theme.js';

const log = createLogger('sprinkle-renderer');

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
    result = result.replace(full, () => `<script>${escaped}</script>`);
  }

  return result;
}

/** Detect whether content is a full HTML document (has DOCTYPE or <html> tag). */
export function isFullDocument(content: string): boolean {
  const trimmed = content.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

type MessageWithFields = { type: string; [key: string]: unknown };

/** Message-types that map to a fire-and-forget bridge call. */
type SyncBridgeOp = (bridge: SprinkleBridgeAPI, msg: MessageWithFields) => void;

/** Message-types that map to an async bridge call whose result is posted back. */
type AsyncBridgeOp = {
  responseType: string;
  invoke: (bridge: SprinkleBridgeAPI, msg: MessageWithFields) => Promise<unknown>;
  buildResponse?: (result: unknown) => Record<string, unknown>;
};

const SYNC_BRIDGE_OPS: Record<string, SyncBridgeOp> = {
  'sprinkle-lick': (b, m) => b.lick({ action: m.action as string, data: m.data }),
  'sprinkle-set-state': (b, m) => b.setState(m.data),
  'sprinkle-close': (b) => b.close(),
  'sprinkle-minimize': (b) => b.minimize(),
  'sprinkle-stop-cone': (b) => b.stopCone(),
  'sprinkle-attach-image': (b, m) =>
    b.attachImage(
      m.base64 as string,
      m.name as string | undefined,
      m.mimeType as string | undefined
    ),
};

const ASYNC_BRIDGE_OPS: Record<string, AsyncBridgeOp> = {
  'sprinkle-readfile': {
    responseType: 'sprinkle-readfile-response',
    invoke: (b, m) => b.readFile(m.path as string),
    buildResponse: (content) => ({ content }),
  },
  'sprinkle-writefile': {
    responseType: 'sprinkle-writefile-response',
    invoke: (b, m) => b.writeFile(m.path as string, m.content as string),
  },
  'sprinkle-readdir': {
    responseType: 'sprinkle-readdir-response',
    invoke: (b, m) => b.readDir(m.path as string),
    buildResponse: (entries) => ({ entries }),
  },
  'sprinkle-exists': {
    responseType: 'sprinkle-exists-response',
    invoke: (b, m) => b.exists(m.path as string),
    buildResponse: (exists) => ({ exists }),
  },
  'sprinkle-stat': {
    responseType: 'sprinkle-stat-response',
    invoke: (b, m) => b.stat(m.path as string),
    buildResponse: (stat) => ({ stat }),
  },
  'sprinkle-mkdir': {
    responseType: 'sprinkle-mkdir-response',
    invoke: (b, m) => b.mkdir(m.path as string),
  },
  'sprinkle-rm': {
    responseType: 'sprinkle-rm-response',
    invoke: (b, m) => b.rm(m.path as string),
  },
  'sprinkle-capture-screen': {
    responseType: 'sprinkle-capture-screen-response',
    invoke: (b) => b.captureScreen(),
    buildResponse: (r) => {
      const cap = r as { base64: string; width: number; height: number; mimeType: string };
      return {
        base64: cap.base64,
        width: cap.width,
        height: cap.height,
        mimeType: cap.mimeType,
      };
    },
  },
  'sprinkle-exec': {
    responseType: 'sprinkle-exec-response',
    invoke: (b, m) => b.exec(m.cmd as string),
    buildResponse: (result) => ({ result }),
  },
  'sprinkle-agent': {
    responseType: 'sprinkle-agent-response',
    invoke: (b, m) =>
      b.agent(m.prompt as string, m.opts as Parameters<SprinkleBridgeAPI['agent']>[1]),
    buildResponse: (result) => ({ result }),
  },
  'sprinkle-jsh': {
    responseType: 'sprinkle-jsh-response',
    invoke: (b, m) => b._jsh(m.op as string, m.args as unknown[]),
    buildResponse: (result) => ({ result }),
  },
  'sprinkle-device-op': {
    responseType: 'sprinkle-device-op-response',
    invoke: (b, m) =>
      b._device(m.channel as 'hid' | 'serial' | 'usb', m.op as string, (m.args as unknown[]) ?? []),
    buildResponse: (result) => ({ result }),
  },
};

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
   * Post an async bridge result back to the iframe as `{ type, id, ...body }`,
   * or `{ type, id, error }` on rejection.
   */
  private forwardAsync(
    iframe: HTMLIFrameElement,
    id: unknown,
    responseType: string,
    promise: Promise<unknown>,
    buildResponse?: (result: unknown) => Record<string, unknown>
  ): void {
    promise.then(
      (result) => {
        const body = buildResponse ? buildResponse(result) : {};
        iframe.contentWindow?.postMessage({ type: responseType, id, ...body }, '*');
      },
      (err: unknown) => {
        iframe.contentWindow?.postMessage(
          {
            type: responseType,
            id,
            error: err instanceof Error ? err.message : String(err),
          },
          '*'
        );
      }
    );
  }

  /**
   * Dispatch a bridge message shared by both the sandbox and full-doc
   * message handlers. Returns true when the message was recognized.
   */
  private handleBridgeMessage(msg: MessageWithFields, iframe: HTMLIFrameElement): boolean {
    const sync = SYNC_BRIDGE_OPS[msg.type];
    if (sync) {
      sync(this.bridge, msg);
      return true;
    }
    const async_ = ASYNC_BRIDGE_OPS[msg.type];
    if (async_) {
      this.forwardAsync(
        iframe,
        msg.id,
        async_.responseType,
        async_.invoke(this.bridge, msg),
        async_.buildResponse
      );
      return true;
    }
    return false;
  }

  /**
   * Handle sandbox-only messages (proxied localStorage, `open`, and inline
   * script fetches). Returns true when the message was recognized.
   */
  private handleSandboxOnlyMessage(
    msg: MessageWithFields,
    sprinkleName: string,
    iframe: HTMLIFrameElement
  ): boolean {
    if (msg.type === 'sprinkle-storage-set') {
      this.setSprinkleStorage(sprinkleName, msg.key as string, msg.value as string);
      return true;
    }
    if (msg.type === 'sprinkle-storage-remove') {
      this.removeSprinkleStorage(sprinkleName, msg.key as string);
      return true;
    }
    if (msg.type === 'sprinkle-storage-clear') {
      this.clearSprinkleStorage(sprinkleName);
      return true;
    }
    if (msg.type === 'sprinkle-open') {
      this.bridge.open(
        msg.path as string,
        msg.projectRoot ? { projectRoot: msg.projectRoot as string } : undefined
      );
      return true;
    }
    if (msg.type === 'sprinkle-fetch-script') {
      this.forwardScriptFetch(iframe, msg.url as string, msg.id as string);
      return true;
    }
    return false;
  }

  private setSprinkleStorage(sprinkleName: string, key: string, value: string): void {
    try {
      localStorage.setItem(`slicc-sprinkle-ls:${sprinkleName}:${key}`, value);
    } catch (e) {
      console.warn('[sprinkle-renderer] localStorage setItem failed:', key, e);
    }
  }

  private removeSprinkleStorage(sprinkleName: string, key: string): void {
    try {
      localStorage.removeItem(`slicc-sprinkle-ls:${sprinkleName}:${key}`);
    } catch (e) {
      console.warn('[sprinkle-renderer] localStorage removeItem failed:', key, e);
    }
  }

  private clearSprinkleStorage(sprinkleName: string): void {
    const prefix = `slicc-sprinkle-ls:${sprinkleName}:`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) localStorage.removeItem(k);
    }
  }

  private forwardScriptFetch(iframe: HTMLIFrameElement, url: string, id: string): void {
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

  /**
   * Create the CSP-exempt sandbox iframe and wait for it to load.
   * Rejects if the load times out or errors.
   */
  private async createSandboxIframe(): Promise<HTMLIFrameElement> {
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('sprinkle-sandbox.html');
    iframe.style.cssText = 'width: 100%; flex: 1; border: none; min-height: 0;';
    this.iframe = iframe;

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
    return iframe;
  }

  /** Collect prefixed localStorage entries so the sandbox can restore them. */
  private collectPersistedStorage(sprinkleName: string): Record<string, string> {
    const savedStorage: Record<string, string> = {};
    const lsPrefix = `slicc-sprinkle-ls:${sprinkleName}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(lsPrefix)) {
        savedStorage[k.slice(lsPrefix.length)] = localStorage.getItem(k) ?? '';
      }
    }
    return savedStorage;
  }

  /**
   * In extension full-doc mode the nested iframe can't load external
   * scripts. Fetch custom element bundles here so they can be inlined.
   */
  private async fetchInlineElementBundles(
    content: string,
    fullDoc: boolean
  ): Promise<{ editorScript: string; diffScript: string }> {
    let editorScript = '';
    let diffScript = '';
    if (!fullDoc) return { editorScript, diffScript };
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
    return { editorScript, diffScript };
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
    const iframe = await this.createSandboxIframe();

    this.messageHandler = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data as MessageWithFields | undefined;
      if (!msg?.type) return;
      if (this.handleBridgeMessage(msg, iframe)) return;
      this.handleSandboxOnlyMessage(msg, sprinkleName, iframe);
    };
    window.addEventListener('message', this.messageHandler);

    const themeCSS = this.collectThemeCSS();
    const savedStorage = this.collectPersistedStorage(sprinkleName);
    const savedState = this.bridge.getState();
    const { editorScript, diffScript } = await this.fetchInlineElementBundles(content, fullDoc);
    const lucideScript = await this.getLucideScript();
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
    const modified = this.buildFullDocSrcdoc(content);
    const iframe = await this.createFullDocIframe(modified, sprinkleName);

    this.messageHandler = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data as MessageWithFields | undefined;
      if (!msg?.type) return;
      this.handleBridgeMessage(msg, iframe);
    };
    window.addEventListener('message', this.messageHandler);
  }

  /** Assemble the srcdoc for a full-document sprinkle iframe. */
  private buildFullDocSrcdoc(content: string): string {
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
    return this.insertInjection(content, injection);
  }

  /**
   * Splice `injection` into `content` after the first available anchor:
   * `<head>`, otherwise before the first `<script>`, otherwise after `<html>`,
   * otherwise at the very start.
   */
  private insertInjection(content: string, injection: string): string {
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

  /**
   * Create the full-document srcdoc iframe and wait for it to load.
   * On load, register the window for theme broadcasts and post the init
   * message with the sprinkle name + saved state.
   */
  private async createFullDocIframe(
    srcdoc: string,
    sprinkleName: string
  ): Promise<HTMLIFrameElement> {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.style.cssText = 'width: 100%; flex: 1; border: none; min-height: 0;';
    iframe.srcdoc = srcdoc;
    this.iframe = iframe;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('full-doc iframe load timed out'));
      }, 5000);
      iframe.addEventListener(
        'load',
        () => {
          clearTimeout(timer);
          registerSprinkleWindow(iframe.contentWindow);
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
        () => {
          clearTimeout(timer);
          reject(new Error('full-doc iframe failed to load'));
        },
        { once: true }
      );
      this.container.appendChild(iframe);
    });
    return iframe;
  }

  /**
   * CLI mode: render directly in the page DOM (no CSP restrictions).
   */
  private renderInline(content: string, sprinkleName: string): void {
    this.ensureCustomElementsLoaded(content);

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

    this.applyFillWidths(wrapper);

    const bridgeExpr = `window.__slicc_sprinkles[${JSON.stringify(sprinkleName)}]`;
    this.rewriteBridgeReferences(wrapper, bridgeExpr);
    this.hydrateInlineScripts(wrapper, bridgeExpr);
  }

  /** Lazy-load `<slicc-editor>` / `<slicc-diff>` bundles when the content uses them. */
  private ensureCustomElementsLoaded(content: string): void {
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

  /** Auto-set width on `.fill[data-value]` elements. */
  private applyFillWidths(wrapper: HTMLElement): void {
    for (const fill of wrapper.querySelectorAll<HTMLElement>('.fill[data-value]')) {
      const v = parseFloat(fill.dataset.value || '0');
      if (v >= 0 && v <= 100) fill.style.width = `${v}%`;
    }
  }

  /** Rewrite onclick `slicc` / `bridge` references to the sprinkle-specific bridge. */
  private rewriteBridgeReferences(wrapper: HTMLElement, bridgeExpr: string): void {
    for (const el of wrapper.querySelectorAll('[onclick]')) {
      const attr = el.getAttribute('onclick') || '';
      if (/\b(slicc|bridge)\b/.test(attr)) {
        el.setAttribute('onclick', attr.replace(/\b(slicc|bridge)\b/g, bridgeExpr));
      }
    }
  }

  /**
   * Collect function names referenced by onclick attributes that need
   * hoisting to `window` so the inline script's IIFE bodies can find them.
   */
  private collectOnclickFunctionNames(wrapper: HTMLElement): Set<string> {
    const RESERVED = new Set(['slicc', 'bridge', 'lick', 'close', 'exec', 'agent']);
    const onclickFns = new Set<string>();
    for (const el of wrapper.querySelectorAll('[onclick]')) {
      const attr = el.getAttribute('onclick') || '';
      for (const m of attr.matchAll(/\b(\w+)\s*\(/g)) {
        const name = m[1];
        if (!RESERVED.has(name)) onclickFns.add(name);
      }
    }
    return onclickFns;
  }

  /**
   * Re-create each `<script>` tag as a live element so inline bodies actually
   * execute (they don't when set via `innerHTML`). Inline bodies are wrapped
   * in an IIFE that supplies `slicc` / `bridge` locals and hoists onclick
   * handler functions to `window` so the rewritten attributes resolve.
   */
  private hydrateInlineScripts(wrapper: HTMLElement, bridgeExpr: string): void {
    const deadScripts = Array.from(wrapper.querySelectorAll('script'));
    for (const dead of deadScripts) {
      dead.remove();
      const live = document.createElement('script');
      for (const attr of dead.attributes) {
        live.setAttribute(attr.name, attr.value);
      }
      if (!dead.src) {
        const hoists = [...this.collectOnclickFunctionNames(wrapper)]
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
        log.warn('lucide-icons.js fetch returned non-ok status', { status: resp.status });
      } catch (err) {
        log.warn('lucide-icons.js fetch failed', err);
      } finally {
        // Reset the in-flight promise so the next sprinkle render can retry,
        // rather than caching '' permanently after one transient failure.
        SprinkleRenderer.lucideScriptPromise = null;
      }
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
